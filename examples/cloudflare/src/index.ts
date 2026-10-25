import { env } from 'cloudflare:workers';
import { bootstrap, createLogger } from 'zammad-remote-mcp';
import { createKvCacheStore, type KvNamespaceLike } from './kv-cache.js';

// Re-exported so a hand-written Worker can reuse the KV store without reaching
// into a subpath that is not part of the package's public exports.
export { createKvCacheStore, type KvNamespaceLike };

/**
 * Cloudflare Workers host.
 *
 * The whole runtime difference from the Node package: configuration comes from
 * the Worker's `env` binding instead of `process.env`, the lookup cache is
 * backed by KV instead of process memory, and the app is returned as a `fetch`
 * handler instead of being handed to a socket listener.
 */
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
  fetch(request: Request): Response | Promise<Response> {
    let handler: ReturnType<typeof bootstrap>;
    try {
      handler = bootstrap({
        // Vars and secrets arrive as strings; other bindings (the KV namespace)
        // are objects and are filtered out before configuration is parsed.
        env: stringVars(env),
        cache: env.LOOKUP_CACHE ? createKvCacheStore(env.LOOKUP_CACHE) : undefined,
      });
    } catch (error) {
      // Configuration errors can contain submitted values; keep them out of public responses.
      createLogger('error').error('Worker configuration failed', {
        name: error instanceof Error ? error.name : 'unknown',
      });
      return Response.json(
        {
          error: 'configuration_error',
          error_description: 'Worker configuration is invalid. Check variables and required secret bindings.',
        },
        { status: 500 },
      );
    }
    const url = new URL(request.url);
    const resource = new URL(handler.config.resourceIdentifier);
    const issuer = new URL(handler.config.publicUrl);
    if (url.origin === resource.origin && resource.origin !== issuer.origin) {
      const paths = [
        handler.config.MCP_PATH,
        '/.well-known/oauth-protected-resource',
        `/.well-known/oauth-protected-resource${handler.config.MCP_PATH}`,
      ];
      // A Cloudflare prefix route also matches unrelated suffixes; preserve the application's origin for those paths.
      if (!paths.includes(url.pathname)) return fetch(request);
    }
    return handler.fetch(request);
  },
};

function stringVars(bindings: Cloudflare.Env): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === 'string') vars[key] = value;
  }
  return vars;
}
