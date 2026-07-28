import type { CacheStore } from 'zammad-remote-mcp';

/**
 * Workers KV as the lookup cache.
 *
 * On Node the in-process cache is effective because one process serves many
 * requests. A Worker isolate is short-lived and there are many of them, so an
 * in-process cache mostly misses and every cold start re-reads the same states,
 * priorities and groups from Zammad. KV is shared across isolates and colos, so
 * the read happens roughly once per TTL for the whole deployment instead of once
 * per isolate.
 *
 * Nothing here changes the stateless guarantee: every entry is reconstructible
 * from Zammad, no request depends on one written by another, and a KV outage
 * degrades to the uncached path rather than an error.
 */

/** Cloudflare rejects `expirationTtl` below 60 seconds. */
const MIN_KV_TTL_SECONDS = 60;

/** The slice of the KV binding this store uses. */
export interface KvNamespaceLike {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

export function createKvCacheStore(namespace: KvNamespaceLike, prefix = 'zammad-mcp:'): CacheStore {
  return {
    async get(key) {
      const value = await namespace.get(prefix + key, 'text');
      return value ?? undefined;
    },

    async set(key, value, ttlSeconds) {
      // Below the KV minimum the entry would be rejected outright; round up so a
      // short TTL still caches rather than silently doing nothing. A TTL of 0
      // never reaches here — JsonCache skips the store entirely.
      const ttl = Math.max(Math.ceil(ttlSeconds), MIN_KV_TTL_SECONDS);
      await namespace.put(prefix + key, value, { expirationTtl: ttl });
    },

    /**
     * Backs `zammad_refresh_metadata_cache`. KV has no bulk delete, so this
     * pages through the namespace's own prefix and deletes key by key. Bounded
     * by design: the cache holds a handful of lists plus resolved lookups.
     *
     * KV is eventually consistent, so a delete can take up to a minute to be
     * visible everywhere — the tool clears the cache, it does not guarantee the
     * very next read misses.
     */
    async clear() {
      let cursor: string | undefined;
      do {
        const page = await namespace.list({ prefix, cursor });
        await Promise.all(page.keys.map((entry) => namespace.delete(entry.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    },
  };
}
