import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { createOAuthLayer } from './auth/oauth.js';
import type { Config } from './config.js';
import { createMcpServer } from './mcp/server.js';
import { ZammadApiError } from './util/errors.js';
import type { Logger } from './util/logger.js';
import type { Credential } from './zammad/client.js';

/**
 * Builds the Hono application.
 *
 * The MCP endpoint runs in stateless mode: every POST gets a brand-new
 * `McpServer` and `StreamableHTTPTransport`, both discarded once the response is
 * written. No session IDs are issued, so a client may hit any replica on any
 * request without sticky routing.
 */
export function createApp(config: Config, logger: Logger): Hono {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS,
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'Mcp-Session-Id',
        'MCP-Protocol-Version',
        'Last-Event-ID',
      ],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
      maxAge: 86_400,
    }),
  );

  app.use('*', async (c, next) => {
    const started = Date.now();
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
      version: '1.0.0',
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
    // discover where to authorize.
    if (oauth) {
      c.header(
        'WWW-Authenticate',
        `Bearer realm="zammad-mcp", error="invalid_token", error_description="${detail.replace(/"/g, "'")}", ` +
          `resource_metadata="${oauth.resourceMetadataUrl}"`,
      );
    }
    return c.json({ error: 'unauthorized', error_description: detail }, 401);
  };

  app.all(config.MCP_PATH, async (c) => {
    let credential: Credential;

    if (config.ZAMMAD_AUTH_MODE === 'oauth') {
      const header = c.req.header('Authorization') ?? c.req.header('authorization');
      const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (!token) {
        return unauthorized(
          c,
          'Missing bearer token. Authorize against Zammad and send the access token as `Authorization: Bearer <token>`.',
        );
      }
      credential = { kind: 'bearer', token };

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
    } else if (config.ZAMMAD_AUTH_MODE === 'token') {
      credential = { kind: 'token', token: config.ZAMMAD_API_TOKEN! };
    } else {
      credential = {
        kind: 'basic',
        username: config.ZAMMAD_USERNAME!,
        password: config.ZAMMAD_PASSWORD!,
      };
    }

    // The SDK's own Web-standard transport: takes a `Request`, returns a
    // `Response`, imports no Node built-ins. That is what lets the same core run
    // on Node and on edge runtimes without a runtime-specific transport.
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session tracking, so the transport neither issues nor
      // expects an `Mcp-Session-Id` and any replica can serve any request.
      sessionIdGenerator: undefined,
      // Reply with a complete JSON body rather than an SSE stream. A stateless
      // server never pushes anything to the client, so a stream buys nothing —
      // and because `handleRequest` then resolves only once the body is fully
      // built, the per-request server can be torn down immediately afterwards
      // without truncating the response.
      enableJsonResponse: true,
    });
    const server = await createMcpServer({ config, logger, credential });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      return response ?? c.body(null, 204);
    } catch (error) {
      if (error instanceof ZammadApiError && error.isAuthError) {
        return unauthorized(c, 'The Zammad access token is invalid, expired or revoked.');
      }
      logger.error('mcp request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: 'internal_error', error_description: 'The MCP request could not be handled.' },
        500,
      );
    } finally {
      // Release the per-request server/transport pair. Errors here are not
      // actionable — the response has already been produced.
      await server.close().catch(() => undefined);
    }
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
