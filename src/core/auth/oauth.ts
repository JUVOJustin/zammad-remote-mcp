import { mcpAuthRouter, ProxyOAuthServerProvider } from '@hono/mcp/auth';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { type Context, Hono } from 'hono';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { SignatureError, seal, sealWithExpiry, unseal, unsealWithExpiry } from './signing.js';

/**
 * Zammad's own OAuth2 provider is Doorkeeper (`/oauth/authorize`, `/oauth/token`,
 * `/oauth/revoke`, default scope `full`, refresh tokens enabled). Doorkeeper does
 * not implement RFC 7591 dynamic client registration, and a Zammad "third-party
 * application" is registered with a fixed set of redirect URIs — neither of which
 * fits MCP clients that register themselves and listen on an ephemeral localhost
 * port.
 *
 * This module bridges the gap without introducing server-side state:
 *
 *  - Dynamic registration mints a *signed* `client_id` that carries the client's
 *    redirect URIs in its payload, so `getClient` can reconstruct the
 *    registration later from the ID alone.
 *  - `/authorize` swaps the client's redirect URI for this server's single
 *    `/oauth/callback` (the one URI that has to be registered in Zammad) and
 *    packs the original URI plus the client's `state` into a signed `state`.
 *  - `/oauth/callback` verifies that signature and bounces the authorization
 *    code back to the client's own redirect URI.
 *  - `/token` swaps in the real Zammad client credentials. PKCE flows straight
 *    through: the client's `code_challenge` reaches Doorkeeper untouched and its
 *    `code_verifier` is forwarded on exchange, so this proxy never has to be
 *    trusted with proof of possession.
 *
 * The result is that every replica can serve every leg of the flow, provided
 * they share OAUTH_STATE_SECRET.
 */

const CLIENT_ID_PREFIX = 'zmcp_';

interface SignedClientPayload {
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
  iat: number;
}

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

class ZammadProxyProvider extends ProxyOAuthServerProvider {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    super({
      endpoints: {
        authorizationUrl: config.zammadAuthorizeUrl,
        tokenUrl: config.zammadTokenUrl,
        revocationUrl: config.zammadRevokeUrl,
      },
      verifyAccessToken: async (token) => verifyZammadToken(config, token),
      getClient: async (clientId) => resolveClient(config, clientId),
    });

    // The MCP client's PKCE challenge is created for, and verified by, Doorkeeper.
    // This proxy never sees the verifier's counterpart, so it must not try to
    // check it locally.
    this.skipLocalPkceValidation = true;
  }

  /**
   * Stateless dynamic client registration.
   *
   * The base class only exposes `registerClient` when an upstream registration
   * URL is configured, and Doorkeeper has none — so the store is overridden
   * here. The minted `client_id` *is* the registration record: it carries the
   * client's redirect URIs in a signed payload that `resolveClient` reads back,
   * which is why no database is needed.
   *
   * Note this must be an override of the getter rather than a mutation of the
   * base class's return value: `ProxyOAuthServerProvider.clientsStore` builds a
   * fresh object on every access, so an assigned property would be discarded.
   */
  override get clientsStore(): OAuthRegisteredClientsStore {
    const config = this.config;
    const logger = this.logger;

    return {
      getClient: (clientId: string) => resolveClient(config, clientId),
      registerClient: async (client: OAuthClientInformationFull) => {
        const redirectUris = client.redirect_uris ?? [];
        if (redirectUris.length === 0) {
          throw new Error('At least one redirect_uri is required to register a client');
        }
        for (const uri of redirectUris) assertRedirectAllowed(config, uri);

        const payload: SignedClientPayload = {
          redirect_uris: redirectUris,
          client_name: client.client_name,
          scope: client.scope ?? config.ZAMMAD_OAUTH_SCOPES.join(' '),
          iat: Math.floor(Date.now() / 1000),
        };

        logger.info('registered MCP oauth client', {
          client_name: client.client_name,
          redirect_uris: redirectUris,
        });

        return {
          ...client,
          client_id: await seal(config.OAUTH_STATE_SECRET!, payload, CLIENT_ID_PREFIX),
          client_id_issued_at: payload.iat,
          // The real Zammad secret stays on the server; MCP clients authenticate
          // with PKCE alone. Advertising a secret that cannot be verified
          // statelessly would only break the token exchange.
          client_secret: undefined,
          client_secret_expires_at: undefined,
          token_endpoint_auth_method: 'none',
          scope: payload.scope,
        };
      },
    };
  }

  /**
   * Redirect the user agent to Zammad, substituting the redirect URI and
   * client ID for the ones Zammad actually knows about.
   */
  override async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    c: Context,
  ): Promise<void> {
    const target = new URL(this.config.zammadAuthorizeUrl);
    const search = new URLSearchParams({
      client_id: this.config.ZAMMAD_OAUTH_CLIENT_ID!,
      response_type: 'code',
      redirect_uri: this.config.oauthCallbackUrl,
      // Doorkeeper stores the challenge against the issued code and verifies it
      // at exchange time — we only relay it.
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state: await sealWithExpiry(
        this.config.OAUTH_STATE_SECRET!,
        { redirect_uri: params.redirectUri, state: params.state } satisfies Omit<SignedStatePayload, 'exp'>,
        this.config.OAUTH_STATE_TTL_SECONDS,
      ),
    });

    // Doorkeeper's default scope is `full`; honour what the client asked for and
    // otherwise fall back to the configured default.
    const scopes = params.scopes?.length ? params.scopes : this.config.ZAMMAD_OAUTH_SCOPES;
    if (scopes.length) search.set('scope', scopes.join(' '));

    target.search = search.toString();

    this.logger.debug('redirecting to Zammad authorization endpoint', {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
    });

    c.res = c.redirect(target.toString());
  }

  override async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // `redirect_uri` must match the one Doorkeeper recorded with the code — our
    // callback, never the MCP client's.
    return this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: this.config.oauthCallbackUrl,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        ...(resource ? { resource: resource.href } : {}),
      },
      'authorization_code',
    );
  }

  override async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.tokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
        ...(resource ? { resource: resource.href } : {}),
      },
      'refresh_token',
    );
  }

  private async tokenRequest(fields: Record<string, string>, kind: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      ...fields,
      client_id: this.config.ZAMMAD_OAUTH_CLIENT_ID!,
    });
    if (this.config.ZAMMAD_OAUTH_CLIENT_SECRET) {
      body.set('client_secret', this.config.ZAMMAD_OAUTH_CLIENT_SECRET);
    }

    const response = await fetch(this.config.zammadTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const text = await response.text();
    if (!response.ok) {
      this.logger.warn('zammad token endpoint rejected the request', {
        kind,
        status: response.status,
        body: text.slice(0, 500),
      });
      throw new Error(`Zammad ${kind} exchange failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text) as OAuthTokens;
    } catch {
      throw new Error(`Zammad token endpoint returned a non-JSON response: ${text.slice(0, 300)}`);
    }
  }
}

/**
 * Reconstruct a client registration from its ID.
 *
 * Signed IDs carry their own redirect URIs. The plain, pre-configured Zammad
 * client ID is also accepted so that clients which skip dynamic registration
 * still work; its redirect URIs come from the configured allowlist.
 */
async function resolveClient(
  config: Config,
  clientId: string,
): Promise<OAuthClientInformationFull | undefined> {
  const scope = config.ZAMMAD_OAUTH_SCOPES.join(' ');

  if (clientId.startsWith(CLIENT_ID_PREFIX)) {
    try {
      const payload = await unseal<SignedClientPayload>(
        config.OAUTH_STATE_SECRET!,
        clientId,
        CLIENT_ID_PREFIX,
      );
      return {
        client_id: clientId,
        redirect_uris: payload.redirect_uris,
        client_name: payload.client_name,
        scope: payload.scope ?? scope,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: payload.iat,
      };
    } catch (error) {
      if (error instanceof SignatureError) return undefined;
      throw error;
    }
  }

  if (clientId === config.ZAMMAD_OAUTH_CLIENT_ID) {
    return {
      client_id: clientId,
      // The proxy always sends its own callback upstream, so this list only
      // governs where *we* are willing to bounce the code back to.
      redirect_uris: [config.oauthCallbackUrl],
      scope,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  return undefined;
}

/**
 * Guard against the proxy being turned into an open redirector.
 *
 * The allowlist is the only thing standing between this endpoint and a real
 * attack: anyone may register a client, so an unrestricted redirect URI would
 * let an attacker register one pointing at themselves, walk a victim through a
 * genuine Zammad login, and receive the victim's authorization code — which
 * they can exchange, because they created the PKCE challenge.
 *
 * Failures are reported as `InvalidClientMetadataError`, which the SDK's
 * registration handler renders as a 400 naming the offending value. A plain
 * `Error` here becomes an opaque 500 that tells the operator nothing.
 */
function assertRedirectAllowed(config: Config, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidClientMetadataError(`redirect_uri "${raw}" is not a valid absolute URI`);
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!config.OAUTH_ALLOWED_REDIRECT_SCHEMES.includes(scheme)) {
    throw new InvalidClientMetadataError(
      `redirect_uri scheme "${scheme}" is not allowed. Permitted schemes: ${config.OAUTH_ALLOWED_REDIRECT_SCHEMES.join(', ')}. ` +
        'Add it to OAUTH_ALLOWED_REDIRECT_SCHEMES if this client is trusted.',
    );
  }

  if (scheme === 'http' || scheme === 'https') {
    const host = url.hostname.toLowerCase();
    const allowed = config.OAUTH_ALLOWED_REDIRECT_HOSTS.map((h) => h.toLowerCase().replace(/^\[|\]$/g, ''));
    if (!allowed.includes(host)) {
      throw new InvalidClientMetadataError(
        `redirect_uri host "${host}" is not allowed. Permitted hosts: ${config.OAUTH_ALLOWED_REDIRECT_HOSTS.join(', ')}. ` +
          `Add "${host}" to OAUTH_ALLOWED_REDIRECT_HOSTS if this client is trusted.`,
      );
    }
  }
}

export function createOAuthLayer(config: Config, logger: Logger): OAuthLayer | undefined {
  if (config.ZAMMAD_OAUTH_MODE === 'disabled') return undefined;

  const log = logger.child({ component: 'oauth' });
  const router = new Hono();
  const resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource${config.MCP_PATH}`;

  if (config.ZAMMAD_OAUTH_MODE === 'passthrough') {
    // The MCP client talks to Zammad directly. Doorkeeper does not publish
    // authorization-server metadata, so this server publishes it on Zammad's
    // behalf and the client is expected to accept an issuer whose metadata is
    // hosted here. Every client redirect URI must be registered in Zammad.
    const metadata = {
      issuer: config.ZAMMAD_URL,
      authorization_endpoint: config.zammadAuthorizeUrl,
      token_endpoint: config.zammadTokenUrl,
      revocation_endpoint: config.zammadRevokeUrl,
      scopes_supported: config.ZAMMAD_OAUTH_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    };
    const protectedResource = {
      resource: config.resourceIdentifier,
      authorization_servers: [config.ZAMMAD_URL],
      scopes_supported: config.ZAMMAD_OAUTH_SCOPES,
      resource_name: 'Zammad MCP',
    };

    router.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata));
    router.get(`/.well-known/oauth-protected-resource${config.MCP_PATH}`, (c) => c.json(protectedResource));
    router.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResource));

    log.info('oauth passthrough mode: clients authorize against Zammad directly', {
      authorization_endpoint: config.zammadAuthorizeUrl,
    });
    return { router, resourceMetadataUrl };
  }

  // ------------------------------------------------------------- proxy mode
  const provider = new ZammadProxyProvider(config, log);

  // `clientIdGeneration: false` keeps the SDK from assigning a random UUID that
  // would then have to be remembered — the signed ID minted by the provider's
  // `registerClient` is self-describing instead.
  router.route(
    '/',
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      baseUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(config.resourceIdentifier),
      scopesSupported: config.ZAMMAD_OAUTH_SCOPES,
      resourceName: 'Zammad MCP',
      clientRegistrationOptions: { clientIdGeneration: false },
    }),
  );

  // Some clients probe the unsuffixed path; mirror the document there too.
  router.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: config.resourceIdentifier,
      authorization_servers: [config.publicUrl],
      scopes_supported: config.ZAMMAD_OAUTH_SCOPES,
      resource_name: 'Zammad MCP',
    }),
  );

  // The single redirect URI that must be registered on the Zammad side.
  router.get('/oauth/callback', async (c) => {
    const query = c.req.query();
    const sealedState = query.state;

    if (!sealedState) {
      return c.json({ error: 'invalid_request', error_description: 'Missing state parameter' }, 400);
    }

    let payload: SignedStatePayload;
    try {
      payload = await unsealWithExpiry<SignedStatePayload>(config.OAUTH_STATE_SECRET!, sealedState);
    } catch (error) {
      log.warn('rejected oauth callback with an unverifiable state', {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'The state parameter is invalid or expired. Restart the authorization flow. ' +
            'If this persists across restarts, make sure OAUTH_STATE_SECRET is stable and shared by all replicas.',
        },
        400,
      );
    }

    let target: URL;
    try {
      assertRedirectAllowed(config, payload.redirect_uri);
      target = new URL(payload.redirect_uri);
    } catch (error) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }

    // Relay whatever Zammad sent — success (`code`) or failure (`error`).
    for (const key of ['code', 'error', 'error_description', 'error_uri'] as const) {
      const value = query[key];
      if (value) target.searchParams.set(key, value);
    }
    if (payload.state) target.searchParams.set('state', payload.state);

    return c.redirect(target.toString());
  });

  log.info('oauth proxy mode enabled', {
    issuer: config.publicUrl,
    callback: config.oauthCallbackUrl,
    upstream: config.zammadAuthorizeUrl,
  });

  return { router, resourceMetadataUrl };
}

/** Validate a Zammad access token by asking Zammad who it belongs to. */
export async function verifyZammadToken(config: Config, token: string): Promise<AuthInfo> {
  const response = await fetch(`${config.ZAMMAD_URL}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(config.ZAMMAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Zammad rejected the access token (HTTP ${response.status})`);
  }

  const user = (await response.json()) as { id?: number; login?: string };
  return {
    token,
    clientId: config.ZAMMAD_OAUTH_CLIENT_ID ?? 'zammad',
    scopes: config.ZAMMAD_OAUTH_SCOPES,
    extra: { zammadUserId: user.id, zammadLogin: user.login },
  };
}
