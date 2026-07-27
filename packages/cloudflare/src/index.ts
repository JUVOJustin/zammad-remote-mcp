import { bootstrap } from '@zammad-mcp/core';

/**
 * Cloudflare Workers host.
 *
 * The whole runtime difference from the Node package: configuration comes from
 * the Worker's `env` binding instead of `process.env`, and the app is returned
 * as a `fetch` handler instead of being handed to a socket listener. Everything
 * else — routing, MCP, OAuth, the Zammad client — is `@zammad-mcp/core`.
 */

/** Worker bindings. Vars and secrets arrive as plain strings, so this *is* the env. */
export type WorkerEnv = Record<string, string | undefined>;

/**
 * The app is rebuilt per request rather than cached in module scope.
 *
 * Construction is cheap (config parsing plus route registration) and the server
 * is stateless by design, so there is nothing to keep warm. Rebuilding also
 * means a changed binding takes effect immediately instead of surviving in a
 * long-lived isolate.
 */
export default {
  fetch(request: Request, env: WorkerEnv): Response | Promise<Response> {
    let handler: ReturnType<typeof bootstrap>;
    try {
      handler = bootstrap({ env });
    } catch (error) {
      // A misconfigured Worker has no console to fail loudly on, so the error
      // has to travel in the response — otherwise it is invisible.
      return Response.json(
        {
          error: 'configuration_error',
          error_description: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
    return handler.fetch(request);
  },
};
