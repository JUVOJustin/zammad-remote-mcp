import { z } from 'zod';

/**
 * All runtime configuration comes from the environment. The schema below is the
 * single source of truth — `.env.example` is generated from the same field list.
 *
 * The server is designed to be stateless, so nothing here is mutated at runtime.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

const port = z.coerce.number().int().min(1).max(65_535);

/** Strip a trailing slash so we can concatenate paths without doubling separators. */
const url = z
  .string()
  .trim()
  .min(1)
  .refine((v) => /^https?:\/\//.test(v), { message: 'must start with http:// or https://' })
  .transform((v) => v.replace(/\/+$/, ''));

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()));

const EnvSchema = z
  .object({
    // ---------------------------------------------------------------- server
    /** Interface + port the Node HTTP server binds to. */
    HOST: z.string().default('0.0.0.0'),
    PORT: port.default(3000),
    /**
     * Externally reachable base URL of *this* MCP server. Used for the OAuth
     * protected-resource metadata, the proxy callback URL and the `resource`
     * indicator (RFC 8707). Must match what MCP clients actually dial.
     */
    PUBLIC_URL: url.optional(),
    /** Path the Streamable HTTP transport is mounted on. */
    MCP_PATH: z
      .string()
      .default('/mcp')
      .transform((v) => (v.startsWith('/') ? v : `/${v}`)),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** Comma-separated allowlist for browser CORS. `*` allows any origin. */
    CORS_ORIGINS: csv.default(['*']),

    // ---------------------------------------------------------------- zammad
    /** Base URL of the Zammad instance, e.g. https://support.example.com */
    ZAMMAD_URL: url,
    /**
     * How the server authenticates against the Zammad REST API.
     *  - `oauth` : per-request Bearer token supplied by the MCP client (default,
     *              fully multi-tenant, nothing is stored server-side)
     *  - `token` : one fixed Zammad access token for every request
     *  - `basic` : HTTP basic auth with a fixed username/password
     */
    ZAMMAD_AUTH_MODE: z.enum(['oauth', 'token', 'basic']).default('oauth'),
    ZAMMAD_API_TOKEN: z.string().optional(),
    ZAMMAD_USERNAME: z.string().optional(),
    ZAMMAD_PASSWORD: z.string().optional(),
    /** Request timeout for a single Zammad API call. */
    ZAMMAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /** Retry count for transient failures (429/5xx/network). */
    ZAMMAD_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),

    // ----------------------------------------------------------------- oauth
    /**
     * How MCP clients obtain the token they send. This only has meaning when
     * ZAMMAD_AUTH_MODE=oauth, because that is the only mode in which the
     * incoming `Authorization` header is read at all — so leave it unset and it
     * follows: `proxy` under `oauth`, `disabled` under `token`/`basic`.
     *
     *  - `proxy`       : this server proxies /authorize + /token to Zammad. It
     *                    holds the client secret, offers RFC 7591 dynamic client
     *                    registration (which Zammad lacks) and rewrites the
     *                    redirect URI, so a single callback needs to be
     *                    registered in Zammad. Still stateless — the client's
     *                    redirect/state is carried in an HMAC-signed `state`.
     *  - `passthrough` : advertise Zammad's own endpoints; the MCP client talks
     *                    to Zammad directly. Requires every client redirect URI
     *                    to be registered in Zammad.
     *  - `disabled`    : serve no OAuth metadata. Useful under ZAMMAD_AUTH_MODE=oauth
     *                    when an API gateway in front already handles discovery
     *                    and just forwards the bearer token.
     */
    ZAMMAD_OAUTH_MODE: z.enum(['proxy', 'passthrough', 'disabled']).optional(),
    ZAMMAD_OAUTH_CLIENT_ID: z.string().optional(),
    ZAMMAD_OAUTH_CLIENT_SECRET: z.string().optional(),
    /** Doorkeeper's default scope in Zammad is `full`. */
    ZAMMAD_OAUTH_SCOPES: csv.default(['full']),
    /** Override only if the Zammad instance is mounted under a sub-path. */
    ZAMMAD_OAUTH_AUTHORIZE_PATH: z.string().default('/oauth/authorize'),
    ZAMMAD_OAUTH_TOKEN_PATH: z.string().default('/oauth/token'),
    ZAMMAD_OAUTH_REVOKE_PATH: z.string().default('/oauth/revoke'),
    /**
     * Secret used to HMAC the `state` parameter in proxy mode. Required in
     * proxy mode; keep it identical across replicas so any instance can verify
     * a callback issued by any other (this is what keeps the proxy stateless).
     */
    OAUTH_STATE_SECRET: z.string().min(16).optional(),
    /** Signed-state lifetime; bounds how long an authorization may take. */
    OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    /**
     * Hosts accepted as OAuth client redirect targets in proxy mode. Guards
     * against the proxy being used as an open redirector, which is a real risk
     * here: anyone may register a client, so an unrestricted redirect would let
     * an attacker collect a victim's authorization code.
     *
     * Loopback covers MCP clients that run on the user's machine and listen on
     * an ephemeral port. The hosted clients complete the flow on their own
     * domain instead and are listed so the server works without configuration;
     * remove them if you only ever connect local clients.
     */
    OAUTH_ALLOWED_REDIRECT_HOSTS: csv.default(['localhost', '127.0.0.1', '[::1]', 'claude.ai', 'claude.com']),
    /** Also allow custom-scheme redirects such as `vscode://` or `cursor://`. */
    OAUTH_ALLOWED_REDIRECT_SCHEMES: csv.default(['http', 'https', 'vscode', 'cursor', 'claude']),

    // ------------------------------------------------------------------ misc
    /**
     * Verify the incoming Bearer token with `GET /api/v1/users/me` before
     * running the MCP handshake. Costs one extra round trip per request; off by
     * default because an invalid token is surfaced by the first tool call
     * anyway (mapped back to a 401 with the right WWW-Authenticate header).
     */
    VALIDATE_TOKEN_EAGERLY: booleanish.default(false),
    /**
     * TTL for the in-process cache of slow-moving lookup data (groups, states,
     * priorities). Purely an optimisation: the cache is per-instance, per-token
     * and never required for correctness, so it does not make the server
     * stateful. Set to 0 to disable.
     */
    METADATA_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
    /**
     * Fold the instance's own states, priorities, groups and macros into the
     * tool input schemas as enums, so the model can see the valid values without
     * a discovery call. Set to false to publish static schemas — `tools/list`
     * then needs no Zammad contact at all.
     */
    DYNAMIC_TOOL_SCHEMAS: booleanish.default(true),
    /**
     * Above this many values an enum is omitted rather than truncated: a partial
     * list looks authoritative while silently hiding valid options, and it
     * inflates every tool listing.
     */
    SCHEMA_ENUM_MAX_VALUES: z.coerce.number().int().positive().max(1000).default(150),
    /** Hard ceiling on rows a single tool call may return. Zammad caps search at 200. */
    MAX_PAGE_SIZE: z.coerce.number().int().positive().max(500).default(100),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.ZAMMAD_AUTH_MODE === 'token' && !env.ZAMMAD_API_TOKEN) {
      fail('ZAMMAD_API_TOKEN', 'is required when ZAMMAD_AUTH_MODE=token');
    }
    if (env.ZAMMAD_AUTH_MODE === 'basic' && !(env.ZAMMAD_USERNAME && env.ZAMMAD_PASSWORD)) {
      fail('ZAMMAD_USERNAME', 'ZAMMAD_USERNAME and ZAMMAD_PASSWORD are required when ZAMMAD_AUTH_MODE=basic');
    }
    // Serving OAuth endpoints only makes sense when the incoming bearer token is
    // actually used. Under `token`/`basic` the MCP endpoint ignores the
    // `Authorization` header entirely, so a client would complete the whole
    // authorization flow and have its token silently discarded. Reject the
    // combination rather than let it look like it works.
    if (env.ZAMMAD_AUTH_MODE !== 'oauth' && env.ZAMMAD_OAUTH_MODE && env.ZAMMAD_OAUTH_MODE !== 'disabled') {
      fail(
        'ZAMMAD_OAUTH_MODE',
        `cannot be "${env.ZAMMAD_OAUTH_MODE}" while ZAMMAD_AUTH_MODE=${env.ZAMMAD_AUTH_MODE}: that mode uses a ` +
          'fixed server-side credential and never reads the incoming bearer token, so any token issued by the ' +
          'OAuth flow would be ignored. Either drop ZAMMAD_OAUTH_MODE (it defaults to disabled here) or set ' +
          'ZAMMAD_AUTH_MODE=oauth.',
      );
      return;
    }

    const oauthMode = resolveOAuthMode(env.ZAMMAD_AUTH_MODE, env.ZAMMAD_OAUTH_MODE);

    if (oauthMode !== 'disabled' && !env.ZAMMAD_OAUTH_CLIENT_ID) {
      fail('ZAMMAD_OAUTH_CLIENT_ID', `is required when ZAMMAD_OAUTH_MODE=${oauthMode}`);
    }
    if (oauthMode === 'proxy') {
      if (!env.OAUTH_STATE_SECRET) {
        fail(
          'OAUTH_STATE_SECRET',
          'is required when ZAMMAD_OAUTH_MODE=proxy (>=16 chars, stable across replicas)',
        );
      }
      if (!env.PUBLIC_URL) {
        fail('PUBLIC_URL', 'is required when ZAMMAD_OAUTH_MODE=proxy — it forms the OAuth callback URL');
      }
    }
  });

export type OAuthMode = 'proxy' | 'passthrough' | 'disabled';

/**
 * `ZAMMAD_OAUTH_MODE` is a sub-setting of `ZAMMAD_AUTH_MODE`, not an independent
 * axis: only the `oauth` auth mode reads the caller's bearer token, so only
 * there is there anything for the OAuth endpoints to be *for*. Left unset it
 * therefore follows the auth mode, and `disabled` never has to be spelled out
 * just to turn off machinery that was irrelevant anyway.
 */
function resolveOAuthMode(authMode: 'oauth' | 'token' | 'basic', explicit: OAuthMode | undefined): OAuthMode {
  if (authMode !== 'oauth') return 'disabled';
  return explicit ?? 'proxy';
}

export type Env = z.infer<typeof EnvSchema>;

/**
 * Where configuration comes from: `process.env` on Node, the `env` binding on
 * Workers. Typed structurally so the core needs no Node type definitions.
 */
export type EnvSource = Record<string, string | undefined>;

export interface Config extends Env {
  /**
   * Resolved OAuth mode — always concrete, derived from ZAMMAD_AUTH_MODE when
   * the variable is not set explicitly. Consumers read this, never the raw env.
   */
  ZAMMAD_OAUTH_MODE: OAuthMode;
  /** Always defined: falls back to http://localhost:PORT when PUBLIC_URL is unset. */
  publicUrl: string;
  /** Absolute callback URL that must be registered in Zammad (proxy mode). */
  oauthCallbackUrl: string;
  /** Absolute Zammad OAuth endpoints. */
  zammadAuthorizeUrl: string;
  zammadTokenUrl: string;
  zammadRevokeUrl: string;
  /** Canonical resource identifier for RFC 8707 / RFC 9728. */
  resourceIdentifier: string;
}

export function loadConfig(source: EnvSource): Config {
  // Drop empty strings so `FOO=` in a .env file falls back to the default
  // instead of failing validation.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }

  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;
  const publicUrl = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`;

  return {
    ...env,
    ZAMMAD_OAUTH_MODE: resolveOAuthMode(env.ZAMMAD_AUTH_MODE, env.ZAMMAD_OAUTH_MODE),
    publicUrl,
    oauthCallbackUrl: `${publicUrl}/oauth/callback`,
    zammadAuthorizeUrl: `${env.ZAMMAD_URL}${env.ZAMMAD_OAUTH_AUTHORIZE_PATH}`,
    zammadTokenUrl: `${env.ZAMMAD_URL}${env.ZAMMAD_OAUTH_TOKEN_PATH}`,
    zammadRevokeUrl: `${env.ZAMMAD_URL}${env.ZAMMAD_OAUTH_REVOKE_PATH}`,
    resourceIdentifier: `${publicUrl}${env.MCP_PATH}`,
  };
}
