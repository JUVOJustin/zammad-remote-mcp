import type { Config } from '../config.js';
import { createMemoryCacheStore } from '../util/cache.js';
import { OAuthError } from '../util/errors.js';
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
  if (clientId.startsWith('https://')) return resolveMetadataDocumentClient(config, clientId);

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
export async function registerClient(config: Config, metadata: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(metadata)) {
    throw new OAuthError('invalid_client_metadata', 'The registration request must be a JSON object.');
  }

  const redirectUris = metadata.redirect_uris;
  if (!isStringList(redirectUris)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of URIs.');
  }
  for (const uri of redirectUris) {
    const problem = redirectProblem(config, uri);
    if (problem) throw new OAuthError('invalid_redirect_uri', problem);
  }

  const payload: SignedClientPayload = {
    redirect_uris: redirectUris,
    client_name: typeof metadata.client_name === 'string' ? metadata.client_name : undefined,
    scope:
      typeof metadata.scope === 'string' && metadata.scope.trim()
        ? metadata.scope
        : config.ZAMMAD_OAUTH_SCOPES.join(' '),
    iat: Math.floor(Date.now() / 1000),
  };

  return {
    ...metadata,
    client_id: await seal(config.OAUTH_STATE_SECRET!, payload, CLIENT_ID_PREFIX),
    client_id_issued_at: payload.iat,
    client_name: payload.client_name,
    redirect_uris: payload.redirect_uris,
    scope: payload.scope,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    // A secret that cannot be verified statelessly would only break the token
    // exchange, so none is issued even when the request asked for one.
    client_secret: undefined,
    client_secret_expires_at: undefined,
  };
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
        'invalid_request',
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
    throw new OAuthError('invalid_request', `redirect_uri "${requested}" is not registered for this client.`);
  }

  // A registration signed before the allowlist was narrowed, or a metadata
  // document listing hosts this deployment does not trust, still must not
  // receive a code.
  const problem = redirectProblem(config, chosen);
  if (problem) throw new OAuthError('invalid_request', problem);
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
const DOCUMENT_MAX_BYTES = 64 * 1024;
const DOCUMENT_DEFAULT_TTL_SECONDS = 300;
const DOCUMENT_MAX_TTL_SECONDS = 86_400;

/**
 * Fetched documents, per process. Each `/authorize`, `/token` and `/revoke`
 * resolves the client again, and without this every one of them would be an
 * outbound request to the client's host.
 */
const documentCache = createMemoryCacheStore(200);

/**
 * Resolve a client whose `client_id` is the URL of its metadata document
 * (draft-ietf-oauth-client-id-metadata-document).
 *
 * Fetching a URL that anyone can name is a server-side request forgery surface,
 * so the fetch is narrowed as far as a legitimate client allows: HTTPS to a
 * named host only — no IP literals, no `localhost` — no redirects, a short
 * timeout and a small body limit. The document itself grants nothing: the
 * redirect URI it lists still has to pass the same allowlist as a registered
 * one before a code is sent there.
 */
async function resolveMetadataDocumentClient(config: Config, clientId: string): Promise<RegisteredClient> {
  const url = metadataDocumentUrl(clientId);

  const cached = await documentCache.get(clientId);
  if (cached !== undefined) return JSON.parse(cached) as RegisteredClient;

  const reject = (reason: string) =>
    new OAuthError('invalid_client', `The client metadata document at ${clientId} ${reason}.`);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      // A redirect would let an allowed-looking URL hand the fetch to any host.
      redirect: 'manual',
      signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    });
  } catch {
    throw reject('could not be fetched');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw reject(`answered HTTP ${response.status} instead of 200`);
  }

  let document: unknown;
  try {
    document = JSON.parse(await readLimited(response, DOCUMENT_MAX_BYTES));
  } catch (error) {
    throw reject(
      error instanceof RangeError ? `is larger than ${DOCUMENT_MAX_BYTES} bytes` : 'is not valid JSON',
    );
  }

  if (!isRecord(document)) throw reject('is not a JSON object');
  if (document.client_id !== clientId) throw reject('names a different client_id than its own URL');
  if (typeof document.client_name !== 'string' || !document.client_name.trim()) {
    throw reject('has no client_name');
  }
  if (!isStringList(document.redirect_uris)) throw reject('lists no redirect_uris');
  if ('client_secret' in document) throw reject('contains a client_secret, which a public document must not');

  const authMethod = document.token_endpoint_auth_method ?? 'none';
  if (authMethod !== 'none') {
    throw reject(
      `asks for token_endpoint_auth_method "${String(authMethod)}"; this server only accepts public clients ("none") and relies on PKCE`,
    );
  }

  const client: RegisteredClient = {
    client_id: clientId,
    client_name: document.client_name,
    redirect_uris: document.redirect_uris,
    scope:
      typeof document.scope === 'string' && document.scope.trim()
        ? document.scope
        : config.ZAMMAD_OAUTH_SCOPES.join(' '),
  };

  const ttl = cacheLifetime(response.headers.get('cache-control'));
  if (ttl > 0) await documentCache.set(clientId, JSON.stringify(client), ttl);
  return client;
}

function metadataDocumentUrl(clientId: string): URL {
  const invalid = (reason: string) =>
    new OAuthError(
      'invalid_client',
      `client_id ${clientId} is not a usable metadata document URL: ${reason}.`,
    );

  const url = parseUrl(clientId);
  if (url?.protocol !== 'https:') throw invalid('it must be an https URL');
  if (url.pathname === '/' || url.pathname === '') throw invalid('it must have a path');
  if (url.hash || url.username || url.password) throw invalid('it must not carry a fragment or credentials');

  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw invalid('the host must be a name');
  if (host === 'localhost' || host.endsWith('.localhost')) throw invalid('the host must not be local');
  return url;
}

/** Seconds a document may be served from cache, honouring the response's own headers. */
function cacheLifetime(header: string | null): number {
  if (!header) return DOCUMENT_DEFAULT_TTL_SECONDS;
  if (/\b(no-store|no-cache)\b/i.test(header)) return 0;
  const maxAge = /\bmax-age=(\d+)/i.exec(header)?.[1];
  if (maxAge === undefined) return DOCUMENT_DEFAULT_TTL_SECONDS;
  return Math.min(Number(maxAge), DOCUMENT_MAX_TTL_SECONDS);
}

/** The body as text, or a `RangeError` once it grows past `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RangeError('response body too large');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}
