import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { createOAuthLayer } from './auth/oauth.js';
import type { Config } from './config.js';
import { createMcpServer } from './mcp/server.js';
import type { Logger } from './util/logger.js';
import { SERVER_VERSION } from './version.js';
import type { Credential } from './zammad/client.js';

/**
 * Builds the Hono application.
 *
 * The MCP endpoint is stateless: every request is answered by a brand-new
 * `McpServer`, discarded once the response is written, so a client may hit any
 * replica on any request without sticky routing.
 */
function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

export function createApp(config: Config, logger: Logger): Hono {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS,
      // `Mcp-Method` and `Mcp-Name` accompany every 2026-07-28 request; a browser
      // client whose preflight does not allow them cannot reach the server at all.
      allowHeaders: ['Content-Type', 'Authorization', 'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['WWW-Authenticate'],
      maxAge: 86_400,
    }),
  );

  // PUBLIC_URL forms the OAuth issuer, the callback URL and the resource
  // identifier. If it does not match the host clients actually dial, discovery
  // and the whole authorization flow point somewhere that does not exist — and
  // nothing about the symptom says so. Warn once per host seen.
  const warnedHosts = new Set<string>();
  const expectedHost = safeHost(config.publicUrl);

  app.use('*', async (c, next) => {
    const started = Date.now();

    const actualHost = safeHost(c.req.url);
    if (expectedHost && actualHost && actualHost !== expectedHost && !warnedHosts.has(actualHost)) {
      warnedHosts.add(actualHost);
      logger.warn('PUBLIC_URL does not match the host this request arrived on', {
        public_url: config.publicUrl,
        request_host: actualHost,
        consequence:
          'OAuth discovery, the callback URL and the resource identifier all point at ' +
          `${expectedHost}. Set PUBLIC_URL to the URL clients actually dial.`,
      });
    }

    await next();
    // stderr only — stdout stays clean.
    logger.debug('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
    });
  });

  // ------------------------------------------------------------------ oauth
  const oauth = createOAuthLayer(config, logger);
  if (oauth) app.route('/', oauth.router);

  // ------------------------------------------------------------- operations
  app.get('/health', (c) => c.json({ status: 'ok', zammad_url: config.ZAMMAD_URL }));

  app.get('/', (c) =>
    c.json({
      name: 'zammad-remote-mcp',
      version: SERVER_VERSION,
      transport: 'streamable-http',
      stateless: true,
      mcp_endpoint: `${config.publicUrl}${config.MCP_PATH}`,
      auth_mode: config.ZAMMAD_AUTH_MODE,
      oauth_mode: config.ZAMMAD_OAUTH_MODE,
      protected_resource_metadata: oauth?.resourceMetadataUrl ?? null,
    }),
  );

  // --------------------------------------------------------------- mcp path
  const unauthorized = (c: Context, detail: string) => {
    // RFC 9728: point the client at the protected-resource metadata so it can
    // discover where to authorize, and name the scopes to ask for.
    if (oauth) {
      c.header(
        'WWW-Authenticate',
        `Bearer realm="zammad-mcp", error="invalid_token", error_description="${detail.replace(/"/g, "'")}", ` +
          `scope="${config.ZAMMAD_OAUTH_SCOPES.join(' ')}", resource_metadata="${oauth.resourceMetadataUrl}"`,
      );
    }
    return c.json({ error: 'unauthorized', error_description: detail }, 401);
  };

  // One handler for the process. It builds a fresh server per request from the
  // factory, answers 2026-07-28 requests natively and 2025-era ones — which
  // negotiate with `initialize` — through the SDK's stateless fallback, so both
  // generations of client reach the same tools.
  const mcp = createMcpHandler(
    async ({ authInfo }) => {
      try {
        return await createMcpServer({ config, logger, credential: credentialFor(config, authInfo) });
      } catch (error) {
        logger.error('could not build the MCP server for a request', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    {
      // The SDK reports every request it refuses here — an unsupported protocol
      // version, a missing header, the wrong media type. Anyone can send those,
      // so they are not errors of this server; its own failures are logged above.
      onerror: (error) => logger.debug('mcp request refused', { error: error.message }),
      // Nothing is ever published to a `subscriptions/listen` stream (see the
      // capabilities in createMcpServer), so the few a client might still open
      // are capped well below the SDK's default of 1024 held connections.
      maxSubscriptions: 16,
    },
  );

  app.all(config.MCP_PATH, async (c) => {
    if (config.ZAMMAD_AUTH_MODE !== 'oauth') return mcp.fetch(c.req.raw);

    const header = c.req.header('Authorization') ?? c.req.header('authorization');
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token) {
      return unauthorized(
        c,
        'Missing bearer token. Authorize against Zammad and send the access token as `Authorization: Bearer <token>`.',
      );
    }

    if (config.VALIDATE_TOKEN_EAGERLY) {
      const response = await fetch(`${config.ZAMMAD_URL}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.ZAMMAD_TIMEOUT_MS),
      }).catch(() => undefined);

      if (!response?.ok) {
        return unauthorized(
          c,
          `Zammad rejected the access token (HTTP ${response?.status ?? 'unreachable'}).`,
        );
      }
    }

    return mcp.fetch(c.req.raw, {
      authInfo: { token, clientId: 'zammad', scopes: config.ZAMMAD_OAUTH_SCOPES },
    });
  });

  app.notFound((c) =>
    c.json(
      {
        error: 'not_found',
        error_description: `No route for ${c.req.method} ${c.req.path}. The MCP endpoint is ${config.MCP_PATH}.`,
      },
      404,
    ),
  );

  app.onError((error, c) => {
    logger.error('unhandled error', { error: error.message, path: c.req.path });
    return c.json({ error: 'internal_error', error_description: error.message }, 500);
  });

  return app;
}

/**
 * The Zammad credential for one MCP request: the caller's bearer token in
 * `oauth` mode, the configured one otherwise.
 */
function credentialFor(config: Config, authInfo: AuthInfo | undefined): Credential {
  if (config.ZAMMAD_AUTH_MODE === 'oauth') return { kind: 'bearer', token: authInfo?.token ?? '' };
  if (config.ZAMMAD_AUTH_MODE === 'token') return { kind: 'token', token: config.ZAMMAD_API_TOKEN! };
  return { kind: 'basic', username: config.ZAMMAD_USERNAME!, password: config.ZAMMAD_PASSWORD! };
}
