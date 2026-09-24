import { OAuthErrorResponseSchema, OAuthTokensSchema } from '@modelcontextprotocol/core';
import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import {
  chooseRedirectUri,
  type RegisteredClient,
  redirectProblem,
  registerClient,
  resolveClient,
} from './clients.js';
import { sealWithExpiry, unsealWithExpiry } from './signing.js';

/**
 * Zammad's own OAuth2 provider is Doorkeeper (`/oauth/authorize`, `/oauth/token`,
 * `/oauth/revoke`, default scope `full`, refresh tokens enabled). Doorkeeper
 * implements neither client ID metadata documents nor dynamic registration, and
 * a Zammad "third-party application" is registered with a fixed set of redirect
 * URIs — none of which fits MCP clients that identify themselves on the fly and
 * listen on an ephemeral localhost port.
 *
 * In proxy mode this server is the authorization server MCP clients see, and it
 * bridges the gap without server-side state:
 *
 *  - Clients are resolved from their `client_id` alone (see `clients.ts`).
 *  - `/authorize` swaps the client's redirect URI for this server's single
 *    `/oauth/callback` (the one URI that has to be registered in Zammad) and
 *    packs the original URI plus the client's `state` into a signed `state`.
 *  - `/oauth/callback` verifies that signature and bounces the authorization
 *    code back to the client's own redirect URI.
 *  - `/token` and `/revoke` swap in the real Zammad client credentials. PKCE
 *    flows straight through: the client's `code_challenge` reaches Doorkeeper
 *    untouched and its `code_verifier` is forwarded on exchange, so this proxy
 *    never has to be trusted with proof of possession.
 *
 * The result is that every replica can serve every leg of the flow, provided
 * they share OAUTH_STATE_SECRET.
 */

interface SignedStatePayload {
  /** The MCP client's own redirect URI. */
  redirect_uri: string;
  /** The MCP client's original `state`, if it sent one. */
  state?: string;
  exp?: number;
}

export interface OAuthLayer {
  /** Hono app exposing the OAuth endpoints and metadata documents. */
  router: Hono;
  /** Absolute URL of this server's protected-resource metadata. */
  resourceMetadataUrl: string;
}

export function createOAuthLayer(config: Config, logger: Logger): OAuthLayer | undefined {
  if (config.ZAMMAD_OAUTH_MODE === 'disabled') return undefined;

  const log = logger.child({ component: 'oauth' });
  const router = new Hono();

  if (config.ZAMMAD_OAUTH_MODE === 'passthrough') {
    // The MCP client talks to Zammad directly. Doorkeeper does not publish
    // authorization-server metadata, so this server publishes it on Zammad's
    // behalf and the client is expected to accept an issuer whose metadata is
    // hosted here. Every client redirect URI must be registered in Zammad.
    // Everything here is consumed by the client, which is not on this server's
    // network, so every endpoint has to be the browser-facing one.
    const resourceMetadataUrl = publishDiscovery(router, config, 'ZAMMAD_PUBLIC_URL', {
      issuer: config.zammadPublicUrl,
      authorization_endpoint: config.zammadAuthorizeUrl,
      token_endpoint: config.zammadPublicTokenUrl,
      revocation_endpoint: config.zammadPublicRevokeUrl,
      scopes_supported: config.ZAMMAD_OAUTH_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    });

    log.info('oauth passthrough mode: clients authorize against Zammad directly', {
      authorization_endpoint: config.zammadAuthorizeUrl,
    });
    return { router, resourceMetadataUrl };
  }

  // ------------------------------------------------------------- proxy mode
  const issuer = config.publicUrl;
  const resourceMetadataUrl = publishDiscovery(router, config, 'PUBLIC_URL', {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    scopes_supported: config.ZAMMAD_OAUTH_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: config.OAUTH_CLIENT_ID_METADATA_DOCUMENTS,
    // RFC 9207: every redirect back to a client names this issuer, so a client
    // talking to several authorization servers can tell whose code it holds.
    authorization_response_iss_parameter_supported: true,
  });

  router.on(['GET', 'POST'], '/authorize', async (c) => {
    c.header('Cache-Control', 'no-store');
    const params = c.req.method === 'POST' ? await formParams(c) : c.req.query();

    // Until the client and its redirect URI are established, an error must not
    // be sent to the redirect URI — that would be the open redirect these
    // checks exist to prevent — so it is shown to the user agent instead.
    let client: RegisteredClient;
    let redirectUri: string;
    try {
      client = await requireClient(config, params.client_id);
      redirectUri = chooseRedirectUri(config, client, params.redirect_uri);
    } catch (error) {
      return errorResponse(c, error, log);
    }

    const refuse = (code: OAuthErrorCode, description: string) =>
      c.redirect(
        authorizationResponse(redirectUri, issuer, params.state, {
          error: code,
          error_description: description,
        }),
      );

    if (params.response_type !== 'code') {
      return refuse(
        OAuthErrorCode.UnsupportedResponseType,
        'Only the authorization code flow (response_type=code) is supported.',
      );
    }
    if (!params.code_challenge || params.code_challenge_method !== 'S256') {
      return refuse(
        OAuthErrorCode.InvalidRequest,
        'PKCE is required: send code_challenge with code_challenge_method=S256.',
      );
    }
    if (params.resource !== undefined && !URL.canParse(params.resource)) {
      return refuse(OAuthErrorCode.InvalidRequest, 'resource must be an absolute URI.');
    }

    const requested = params.scope?.split(' ').filter(Boolean) ?? [];
    const permitted = new Set(client.scope.split(' '));
    const unregistered = requested.find((scope) => !permitted.has(scope));
    if (unregistered)
      return refuse(OAuthErrorCode.InvalidScope, `The client was not registered with scope ${unregistered}.`);

    const search = new URLSearchParams({
      client_id: config.ZAMMAD_OAUTH_CLIENT_ID!,
      response_type: 'code',
      redirect_uri: config.oauthCallbackUrl,
      // Doorkeeper stores the challenge against the issued code and verifies it
      // at exchange time — this server only relays it.
      code_challenge: params.code_challenge,
      code_challenge_method: 'S256',
      state: await sealWithExpiry(
        config.OAUTH_STATE_SECRET!,
        { redirect_uri: redirectUri, state: params.state } satisfies Omit<SignedStatePayload, 'exp'>,
        config.OAUTH_STATE_TTL_SECONDS,
      ),
    });
    // Doorkeeper's default scope is `full`; honour what the client asked for
    // and otherwise fall back to the configured default.
    const scopes = requested.length ? requested : config.ZAMMAD_OAUTH_SCOPES;
    if (scopes.length) search.set('scope', scopes.join(' '));

    const target = new URL(config.zammadAuthorizeUrl);
    target.search = search.toString();

    log.debug('redirecting to Zammad authorization endpoint', {
      client_id: client.client_id,
      redirect_uri: redirectUri,
    });
    return c.redirect(target.toString());
  });

  // The single redirect URI that must be registered on the Zammad side.
  router.get('/oauth/callback', async (c) => {
    const query = c.req.query();
    if (!query.state) {
      return errorResponse(c, new OAuthError(OAuthErrorCode.InvalidRequest, 'Missing state parameter'), log);
    }

    let payload: SignedStatePayload;
    try {
      payload = await unsealWithExpiry<SignedStatePayload>(config.OAUTH_STATE_SECRET!, query.state);
    } catch (error) {
      log.warn('rejected oauth callback with an unverifiable state', {
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResponse(
        c,
        new OAuthError(
          OAuthErrorCode.InvalidRequest,
          'The state parameter is invalid or expired. Restart the authorization flow. ' +
            'If this persists across restarts, make sure OAUTH_STATE_SECRET is stable and shared by all replicas.',
        ),
        log,
      );
    }

    const problem = redirectProblem(config, payload.redirect_uri);
    if (problem) return errorResponse(c, new OAuthError(OAuthErrorCode.InvalidRequest, problem), log);

    // Relay whatever Zammad sent — success (`code`) or failure (`error`).
    const relayed: Record<string, string> = {};
    for (const key of ['code', 'error', 'error_description', 'error_uri'] as const) {
      const value = query[key];
      if (value) relayed[key] = value;
    }
    return c.redirect(authorizationResponse(payload.redirect_uri, issuer, payload.state, relayed));
  });

  router.post('/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const params = await requestParams(c);
      await requireClient(config, params.client_id);

      let fields: Record<string, string> & { grant_type: string };
      switch (params.grant_type) {
        case 'authorization_code':
          if (!params.code || !params.code_verifier) {
            throw new OAuthError(OAuthErrorCode.InvalidRequest, 'code and code_verifier are required.');
          }
          fields = {
            grant_type: 'authorization_code',
            code: params.code,
            // Must match the redirect URI Doorkeeper recorded with the code —
            // this server's callback, never the MCP client's.
            redirect_uri: config.oauthCallbackUrl,
            code_verifier: params.code_verifier,
          };
          break;
        case 'refresh_token':
          if (!params.refresh_token) {
            throw new OAuthError(OAuthErrorCode.InvalidRequest, 'refresh_token is required.');
          }
          fields = {
            grant_type: 'refresh_token',
            refresh_token: params.refresh_token,
            ...(params.scope ? { scope: params.scope } : {}),
          };
          break;
        default:
          throw new OAuthError(
            OAuthErrorCode.UnsupportedGrantType,
            'Supported grant types: authorization_code, refresh_token.',
          );
      }
      if (params.resource) fields.resource = params.resource;
      return c.json(await zammadToken(config, log, fields));
    } catch (error) {
      return errorResponse(c, error, log);
    }
  });

  router.post('/register', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const body: unknown = await c.req.json().catch(() => undefined);
      const registered = await registerClient(config, body);
      log.info('registered MCP oauth client', {
        client_name: registered.client_name,
        redirect_uris: registered.redirect_uris,
      });
      return c.json(registered, 201);
    } catch (error) {
      return errorResponse(c, error, log);
    }
  });

  router.post('/revoke', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const params = await requestParams(c);
      await requireClient(config, params.client_id);
      if (!params.token) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'token is required.');

      await zammadRequest(config, log, config.zammadRevokeUrl, 'revocation', {
        token: params.token,
        ...(params.token_type_hint ? { token_type_hint: params.token_type_hint } : {}),
      });
      return c.json({});
    } catch (error) {
      return errorResponse(c, error, log);
    }
  });

  log.info('oauth proxy mode enabled', {
    issuer,
    callback: config.oauthCallbackUrl,
    upstream: config.zammadAuthorizeUrl,
  });

  return { router, resourceMetadataUrl };
}

/**
 * Serve the discovery documents and return the protected-resource metadata URL.
 *
 * The RFC 9728 document is built by the SDK, which also refuses an issuer that
 * is not HTTPS outside loopback or that carries a query or fragment — metadata
 * conforming clients would reject. Building it here, once, turns that into a
 * startup failure naming the setting instead of a broken login later.
 */
function publishDiscovery(
  router: Hono,
  config: Config,
  issuerSetting: string,
  metadata: OAuthMetadata,
): string {
  const resourceServerUrl = new URL(config.resourceIdentifier);
  let protectedResource: ReturnType<typeof buildOAuthProtectedResourceMetadata>;
  try {
    protectedResource = buildOAuthProtectedResourceMetadata({
      oauthMetadata: metadata,
      resourceServerUrl,
      scopesSupported: config.ZAMMAD_OAUTH_SCOPES,
      resourceName: 'Zammad MCP',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${issuerSetting} cannot be the OAuth issuer (${metadata.issuer}): ${reason}`);
  }
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  router.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata));
  router.get(new URL(resourceMetadataUrl).pathname, (c) => c.json(protectedResource));
  // Some clients probe the unsuffixed path; mirror the document there too.
  router.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResource));
  return resourceMetadataUrl;
}

async function requireClient(config: Config, clientId: string | undefined): Promise<RegisteredClient> {
  if (!clientId) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'client_id is required.');
  const client = await resolveClient(config, clientId);
  if (!client) {
    throw new OAuthError(OAuthErrorCode.InvalidClient, 'Unknown client_id. Register the client again.');
  }
  return client;
}

/** A redirect back to the client, carrying `iss` and the client's own `state` (RFC 9207 §2). */
function authorizationResponse(
  redirectUri: string,
  issuer: string,
  state: string | undefined,
  fields: Record<string, string>,
): string {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
  if (state) target.searchParams.set('state', state);
  target.searchParams.set('iss', issuer);
  return target.toString();
}

/**
 * Forward a token request to Doorkeeper with the real Zammad client credentials.
 *
 * Doorkeeper's own verdict on the grant is passed through, because it is the one
 * the client acts on: `invalid_grant` for an expired or reused code or refresh
 * token sends the client back to authorize. A refusal of *this server's*
 * credentials is a deployment fault the client cannot fix, so it is logged and
 * reported as a gateway failure instead.
 */
async function zammadToken(
  config: Config,
  log: Logger,
  fields: Record<string, string> & { grant_type: string },
): Promise<OAuthTokens> {
  const kind = fields.grant_type;
  const text = await zammadRequest(config, log, config.zammadTokenUrl, kind, fields);
  const tokens = OAuthTokensSchema.safeParse(parseJson(text));
  if (tokens.success) return tokens.data;

  log.warn('zammad token endpoint returned no usable tokens', { kind, body: text.slice(0, 300) });
  throw new OAuthError(
    OAuthErrorCode.ServerError,
    `Zammad's token endpoint returned no access token for the ${kind} exchange.`,
  );
}

const RELAYED_GRANT_ERRORS = new Set<string>([
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidRequest,
  OAuthErrorCode.InvalidScope,
  OAuthErrorCode.UnsupportedGrantType,
]);

async function zammadRequest(
  config: Config,
  log: Logger,
  url: string,
  kind: string,
  fields: Record<string, string>,
): Promise<string> {
  const body = new URLSearchParams({ ...fields, client_id: config.ZAMMAD_OAUTH_CLIENT_ID! });
  if (config.ZAMMAD_OAUTH_CLIENT_SECRET) body.set('client_secret', config.ZAMMAD_OAUTH_CLIENT_SECRET);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(config.ZAMMAD_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn('zammad oauth endpoint unreachable', {
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new OAuthError(OAuthErrorCode.ServerError, `Zammad could not be reached for the ${kind} request.`);
  }

  const text = await response.text();
  if (response.ok) return text;

  const upstream = OAuthErrorResponseSchema.safeParse(parseJson(text));
  if (upstream.success && RELAYED_GRANT_ERRORS.has(upstream.data.error)) {
    throw new OAuthError(
      upstream.data.error,
      upstream.data.error_description ?? `Zammad refused the ${kind} request.`,
    );
  }

  log.warn('zammad oauth endpoint rejected the request', {
    kind,
    status: response.status,
    body: text.slice(0, 500),
  });
  throw new OAuthError(
    OAuthErrorCode.ServerError,
    `Zammad rejected the ${kind} request with HTTP ${response.status}. Check ZAMMAD_OAUTH_CLIENT_ID and ` +
      'ZAMMAD_OAUTH_CLIENT_SECRET against the application registered in Zammad.',
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Token and revocation requests are form-encoded (RFC 6749 §4.1.3); JSON is accepted too. */
async function requestParams(c: Context): Promise<Record<string, string | undefined>> {
  if (c.req.header('Content-Type')?.includes('application/json')) {
    const body: unknown = await c.req.json().catch(() => undefined);
    return typeof body === 'object' && body !== null ? stringFields(body) : {};
  }
  return formParams(c);
}

async function formParams(c: Context): Promise<Record<string, string | undefined>> {
  return stringFields(await c.req.parseBody().catch(() => ({})));
}

/** OAuth parameters are strings; an uploaded file or a nested JSON value is not one. */
function stringFields(body: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/**
 * The RFC 6749 §5.2 error response. Every `server_error` this module raises is
 * Zammad or a client's host failing upstream, hence 502; anything that is not
 * an `OAuthError` is a fault of this server.
 */
function errorResponse(c: Context, error: unknown, log: Logger): Response {
  if (error instanceof OAuthError) {
    return c.json(error.toResponseObject(), error.code === OAuthErrorCode.ServerError ? 502 : 400);
  }
  log.error('oauth request failed', { error: error instanceof Error ? error.message : String(error) });
  return c.json({ error: OAuthErrorCode.ServerError, error_description: 'Internal Server Error' }, 500);
}
