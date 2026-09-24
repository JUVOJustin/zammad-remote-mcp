import { OAuthClientInformationFullSchema, OAuthClientMetadataSchema } from '@modelcontextprotocol/core';
import { type OAuthClientMetadata, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { createMemoryCacheStore, JsonCache } from '../util/cache.js';
import { SignatureError, seal, unseal } from './signing.js';

/**
 * The MCP clients of the OAuth proxy, and where each may receive a code.
 *
 * Doorkeeper knows exactly one client — the Zammad application this server is
 * registered as — so every MCP client is a client of this server instead. None
 * of the three ways to become one needs a client database:
 *
 *  - Client ID Metadata Document: the `client_id` is an HTTPS URL and the
 *    registration record is the JSON document served there. This is what the
 *    MCP specification prefers.
 *  - Dynamic registration (deprecated by the specification, kept for clients
 *    that predate the documents): the minted `client_id` carries its own
 *    registration record in a signed payload.
 *  - The configured Zammad client ID, for a client that was handed it directly.
 */
export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  /** Space-separated scopes the client may request. */
  scope: string;
}

const CLIENT_ID_PREFIX = 'zmcp_';

interface SignedClientPayload {
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
  iat: number;
}

export async function resolveClient(config: Config, clientId: string): Promise<RegisteredClient | undefined> {
  if (clientId.startsWith('https://')) {
    return config.OAUTH_CLIENT_ID_METADATA_DOCUMENTS
      ? resolveMetadataDocumentClient(config, clientId)
      : undefined;
  }

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
        client_name: payload.client_name,
        redirect_uris: payload.redirect_uris,
        scope: payload.scope ?? scope,
      };
    } catch (error) {
      if (error instanceof SignatureError) return undefined;
      throw error;
    }
  }

  if (clientId === config.ZAMMAD_OAUTH_CLIENT_ID) {
    // The proxy always sends its own callback upstream, so this list only
    // governs where *we* are willing to bounce the code back to.
    return { client_id: clientId, redirect_uris: [config.oauthCallbackUrl], scope };
  }

  return undefined;
}

/**
 * Stateless dynamic client registration (RFC 7591).
 *
 * The minted `client_id` *is* the registration record: the client's redirect
 * URIs travel in a signed payload that `resolveClient` reads back, which is why
 * no database is needed. The real Zammad secret stays on the server and MCP
 * clients authenticate with PKCE alone, so every registration is a public
 * client whatever it asked for.
 */
export async function registerClient(config: Config, body: unknown): Promise<Record<string, unknown>> {
  const parsed = OAuthClientMetadataSchema.safeParse(body);
  if (!parsed.success) {
    throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, firstIssue(parsed.error));
  }
  const metadata = parsed.data;

  if (metadata.redirect_uris.length === 0) {
    throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, 'redirect_uris must list at least one URI.');
  }
  for (const uri of metadata.redirect_uris) {
    const problem = redirectProblem(config, uri);
    if (problem) throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, problem);
  }

  const payload: SignedClientPayload = {
    redirect_uris: metadata.redirect_uris,
    client_name: metadata.client_name,
    scope: metadata.scope?.trim() ? metadata.scope : config.ZAMMAD_OAUTH_SCOPES.join(' '),
    iat: Math.floor(Date.now() / 1000),
  };

  // The schema drops anything that is not client metadata, so a `client_secret`
  // in the request cannot be echoed back — none is issued, because a secret
  // that cannot be verified statelessly would only break the token exchange.
  return {
    ...metadata,
    client_id: await seal(config.OAUTH_STATE_SECRET!, payload, CLIENT_ID_PREFIX),
    client_id_issued_at: payload.iat,
    scope: payload.scope,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  } satisfies OAuthClientMetadata & { client_id: string; client_id_issued_at: number };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The redirect URI a code for this client goes back to, or an `invalid_request`
 * naming why the requested one is not acceptable.
 *
 * A loopback URI matches a registered one on any port (RFC 8252 §7.3): native
 * clients listen on an ephemeral port they cannot know when registering.
 */
export function chooseRedirectUri(config: Config, client: RegisteredClient, requested?: string): string {
  let chosen: string;
  if (requested === undefined) {
    if (client.redirect_uris.length !== 1) {
      throw new OAuthError(
        OAuthErrorCode.InvalidRequest,
        'redirect_uri must be specified when the client has more than one registered redirect URI.',
      );
    }
    chosen = client.redirect_uris[0]!;
  } else if (
    client.redirect_uris.includes(requested) ||
    isRegisteredLoopback(requested, client.redirect_uris)
  ) {
    chosen = requested;
  } else {
    throw new OAuthError(
      OAuthErrorCode.InvalidRequest,
      `redirect_uri "${requested}" is not registered for this client.`,
    );
  }

  // A registration signed before the allowlist was narrowed, or a metadata
  // document listing hosts this deployment does not trust, still must not
  // receive a code.
  const problem = redirectProblem(config, chosen);
  if (problem) throw new OAuthError(OAuthErrorCode.InvalidRequest, problem);
  return chosen;
}

function isRegisteredLoopback(requested: string, registered: string[]): boolean {
  const url = parseUrl(requested);
  if (!url || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  return registered.some((candidate) => {
    const known = parseUrl(candidate);
    return (
      known !== undefined &&
      known.protocol === url.protocol &&
      known.hostname === url.hostname &&
      known.pathname === url.pathname &&
      known.search === url.search
    );
  });
}

/**
 * Why a redirect URI must not receive an authorization code, if it must not.
 *
 * The allowlist is the only thing standing between the proxy and an open
 * redirector: anyone may register a client or publish a metadata document, so
 * an unrestricted redirect URI would let an attacker walk a victim through a
 * genuine Zammad login and receive the victim's code — which they can exchange,
 * because they created the PKCE challenge. The message names the setting to
 * change, since the operator is the one who has to act on it.
 */
export function redirectProblem(config: Config, raw: string): string | undefined {
  const url = parseUrl(raw);
  if (!url) return `redirect_uri "${raw}" is not a valid absolute URI`;

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!config.OAUTH_ALLOWED_REDIRECT_SCHEMES.includes(scheme)) {
    return (
      `redirect_uri scheme "${scheme}" is not allowed. Permitted schemes: ${config.OAUTH_ALLOWED_REDIRECT_SCHEMES.join(', ')}. ` +
      'Add it to OAUTH_ALLOWED_REDIRECT_SCHEMES if this client is trusted.'
    );
  }

  if (scheme === 'http' || scheme === 'https') {
    const host = url.hostname.toLowerCase();
    const allowed = config.OAUTH_ALLOWED_REDIRECT_HOSTS.map((h) => h.toLowerCase());
    // `URL` keeps the brackets around an IPv6 host; the setting may be written either way.
    if (!allowed.includes(host) && !allowed.includes(host.replace(/^\[|\]$/g, ''))) {
      return (
        `redirect_uri host "${host}" is not allowed. Permitted hosts: ${config.OAUTH_ALLOWED_REDIRECT_HOSTS.join(', ')}. ` +
        `Add "${host}" to OAUTH_ALLOWED_REDIRECT_HOSTS if this client is trusted.`
      );
    }
  }
  return undefined;
}

// ------------------------------------------------ client ID metadata documents

const DOCUMENT_TIMEOUT_MS = 5_000;
/** Real documents are well under a kilobyte; this bounds what one cache entry can hold. */
const DOCUMENT_MAX_BYTES = 16 * 1024;
const DOCUMENT_DEFAULT_TTL_SECONDS = 300;
const DOCUMENT_MAX_TTL_SECONDS = 86_400;

/**
 * Fetched documents, per process, with concurrent requests for one document
 * sharing a single fetch. Each `/authorize`, `/token` and `/revoke` resolves the
 * client again, and without this every one of them would be an outbound request
 * to the client's host. The keys are URLs anyone can choose, which is why the
 * store's bound has to hold for entries that have not expired.
 */
const documents = new JsonCache(createMemoryCacheStore(200), DOCUMENT_MAX_TTL_SECONDS);

/**
 * Resolve a client whose `client_id` is the URL of its metadata document
 * (draft-ietf-oauth-client-id-metadata-document).
 *
 * Fetching a URL that anyone can name is a server-side request forgery surface,
 * so the fetch is narrowed as far as a legitimate client allows: HTTPS on the
 * default port to a public-looking host name — no IP literals, no single-label
 * or local-only names — no redirects, a short timeout and a small body limit.
 * A public name that resolves to a private address is not caught here, since
 * the core cannot resolve names on every runtime; TLS certificate validation is
 * what keeps such a fetch from succeeding against an ordinary internal service.
 *
 * The document itself grants nothing: the redirect URI it lists still has to
 * pass the same allowlist as a registered one before a code is sent there.
 */
async function resolveMetadataDocumentClient(config: Config, clientId: string): Promise<RegisteredClient> {
  const url = metadataDocumentUrl(clientId);
  const { client } = await documents.read(
    clientId,
    () => fetchMetadataDocument(config, url, clientId),
    (fetched) => fetched.ttl,
  );
  return client;
}

async function fetchMetadataDocument(
  config: Config,
  url: URL,
  clientId: string,
): Promise<{ client: RegisteredClient; ttl: number }> {
  const reject = (reason: string) =>
    new OAuthError(OAuthErrorCode.InvalidClient, `The client metadata document at ${clientId} ${reason}.`);
  // Answered as a server fault rather than `invalid_client`: a client told its
  // id is invalid discards its tokens, which an outage at its host must not cause.
  const unavailable = (reason: string) =>
    new OAuthError(
      OAuthErrorCode.ServerError,
      `The client metadata document at ${clientId} ${reason}; try again later.`,
    );

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      // A redirect would let an allowed-looking URL hand the fetch to any host.
      redirect: 'manual',
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    });
  } catch {
    throw unavailable('could not be fetched');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status >= 500 || response.status === 429) {
      throw unavailable(`answered HTTP ${response.status}`);
    }
    throw reject(`answered HTTP ${response.status} instead of 200`);
  }

  let document: unknown;
  try {
    document = JSON.parse(await readLimited(response, DOCUMENT_MAX_BYTES));
  } catch (error) {
    if (error instanceof RangeError) throw reject(`is larger than ${DOCUMENT_MAX_BYTES} bytes`);
    if (error instanceof SyntaxError) throw reject('is not valid JSON');
    throw unavailable('could not be read');
  }

  const parsed = OAuthClientInformationFullSchema.safeParse(document);
  if (!parsed.success) throw reject(`is not valid client metadata: ${firstIssue(parsed.error)}`);
  const metadata = parsed.data;

  if (metadata.client_id !== clientId) throw reject('names a different client_id than its own URL');
  if (!metadata.client_name?.trim()) throw reject('has no client_name');
  if (metadata.redirect_uris.length === 0) throw reject('lists no redirect_uris');
  if (metadata.client_secret !== undefined) {
    throw reject('contains a client_secret, which a public document must not');
  }

  const authMethod = metadata.token_endpoint_auth_method ?? 'none';
  if (authMethod !== 'none') {
    throw reject(
      `asks for token_endpoint_auth_method "${authMethod}"; this server only accepts public clients ("none") and relies on PKCE`,
    );
  }

  const client: RegisteredClient = {
    client_id: clientId,
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
    scope: metadata.scope?.trim() ? metadata.scope : config.ZAMMAD_OAUTH_SCOPES.join(' '),
  };

  return { client, ttl: cacheLifetime(response.headers.get('cache-control')) };
}

/** Names that only ever resolve inside a network, `localhost.localdomain` included. */
const LOCAL_SUFFIXES = ['.localhost', '.localdomain', '.local', '.internal', '.home.arpa'];

function metadataDocumentUrl(clientId: string): URL {
  const invalid = (reason: string) =>
    new OAuthError(
      OAuthErrorCode.InvalidClient,
      `client_id ${clientId} is not a usable metadata document URL: ${reason}.`,
    );

  const url = parseUrl(clientId);
  if (url?.protocol !== 'https:') throw invalid('it must be an https URL');
  if (url.pathname === '/' || url.pathname === '') throw invalid('it must have a path');
  if (url.hash || url.username || url.password) throw invalid('it must not carry a fragment or credentials');
  if (url.port) throw invalid('it must use the default https port');

  // `localhost.` is the same host as `localhost`, and `URL` keeps the dot.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw invalid('the host must be a name');
  if (!host.includes('.')) throw invalid('the host must be a fully qualified name');
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw invalid('the host must not be local');
  return url;
}

/** Seconds a document may be served from cache by its own headers; the cache caps it. */
function cacheLifetime(header: string | null): number {
  if (!header) return DOCUMENT_DEFAULT_TTL_SECONDS;
  if (/\b(no-store|no-cache)\b/i.test(header)) return 0;
  const maxAge = /\bmax-age=(\d+)/i.exec(header)?.[1];
  return maxAge === undefined ? DOCUMENT_DEFAULT_TTL_SECONDS : Number(maxAge);
}

/**
 * The body as text, or a `RangeError` once it grows past `limit` bytes.
 *
 * The SDK's `readRequestBody` reads the same way but takes a `Request` and
 * leaves an oversized stream open; this cancels it, so the sender stops too.
 */
async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RangeError('response body too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** The first schema complaint, naming the field — enough for a client developer to act on. */
function firstIssue(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid client metadata';
  return issue.path.length ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message;
}
