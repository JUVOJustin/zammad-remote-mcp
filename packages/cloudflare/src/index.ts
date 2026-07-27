import { bootstrap } from '@zammad-mcp/core';
import { createKvCacheStore, type KvNamespaceLike } from './kv-cache.js';

/**
 * Cloudflare Workers host.
 *
 * The whole runtime difference from the Node package: configuration comes from
 * the Worker's `env` binding instead of `process.env`, the lookup cache is
 * backed by KV instead of process memory, and the app is returned as a `fetch`
 * handler instead of being handed to a socket listener. Everything else —
 * routing, MCP, OAuth, the Zammad client — is `@zammad-mcp/core`.
 */

export interface WorkerEnv extends Record<string, unknown> {
  /**
   * Optional KV namespace for the lookup cache. Without it the Worker falls
   * back to per-isolate memory, which still works but re-reads the instance's
   * states, priorities and groups on every cold start.
   */
  LOOKUP_CACHE?: KvNamespaceLike;
}

/**
 * The app is rebuilt per request rather than cached in module scope.
 *
 * Construction is cheap — config parsing plus route registration — and the
 * server is stateless by design, so there is nothing to keep warm. Rebuilding
 * also means a changed binding takes effect immediately instead of surviving in
 * a long-lived isolate. The expensive part, the Zammad lookups, is what KV
 * caches.
 */
export default {
  fetch(request: Request, env: WorkerEnv): Response | Promise<Response> {
    let handler: ReturnType<typeof bootstrap>;
    try {
      handler = bootstrap({
        // Vars and secrets arrive as strings; other bindings (the KV namespace)
        // are objects and are filtered out before configuration is parsed.
        env: stringVars(env),
        cache: env.LOOKUP_CACHE ? createKvCacheStore(env.LOOKUP_CACHE) : undefined,
      });
    } catch (error) {
      // A misconfigured Worker has no console the operator is watching, so the
      // reason has to travel in the response or it is invisible.
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

function stringVars(env: WorkerEnv): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') vars[key] = value;
  }
  return vars;
}
