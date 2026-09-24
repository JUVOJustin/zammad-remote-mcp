/**
 * Where slow-moving lookup data is cached between requests.
 *
 * The core ships an in-process implementation, which is right for a long-lived
 * Node process. On Workers each isolate starts cold and dies quickly, so an
 * in-process cache mostly misses and every isolate re-reads the same states,
 * priorities and groups from Zammad; the Cloudflare package therefore supplies a
 * KV-backed store instead.
 *
 * The cache is never required for correctness — every entry can be rebuilt from
 * Zammad on demand, and no request depends on one populated by another. It stays
 * an optimisation, which is what keeps the server stateless.
 */
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Drop everything. Best-effort: a distributed store may not support it. */
  clear(): Promise<void>;
}

export function createMemoryCacheStore(maxEntries = 500): CacheStore {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  return {
    async get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },

    async set(key, value, ttlSeconds) {
      // Re-inserting moves the key to the end, so iteration order is write order.
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });

      // Evicted on write rather than by a timer. Expired entries go first; if
      // that is not enough, the oldest writes do — otherwise the bound would
      // hold only while entries happen to expire, and a caller that chooses
      // the keys could grow the map until the process runs out of memory.
      if (entries.size > maxEntries) {
        const now = Date.now();
        for (const [k, entry] of entries) if (entry.expiresAt <= now) entries.delete(k);
        for (const k of entries.keys()) {
          if (entries.size <= maxEntries) break;
          entries.delete(k);
        }
      }
    },

    async clear() {
      entries.clear();
    },
  };
}

/**
 * Read-through JSON caching with in-flight de-duplication.
 *
 * The de-duplication matters more than the cache on a cold start: the four
 * vocabulary sources are requested together, and without it a burst of parallel
 * requests would each fetch the same list. It is per-process and purely an
 * optimisation, exactly like the cache itself.
 */
export class JsonCache {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: CacheStore,
    private readonly ttlSeconds: number,
  ) {}

  /**
   * `ttlOf` lets a loaded value set its own lifetime — a fetched document that
   * carries `Cache-Control`, say — capped by the cache's TTL; 0 keeps it out.
   */
  async read<T>(key: string, load: () => Promise<T>, ttlOf?: (value: T) => number): Promise<T> {
    if (this.ttlSeconds <= 0) return load();

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const task = this.readUncached(key, load, ttlOf).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async readUncached<T>(
    key: string,
    load: () => Promise<T>,
    ttlOf?: (value: T) => number,
  ): Promise<T> {
    try {
      const cached = await this.store.get(key);
      if (cached !== undefined) return JSON.parse(cached) as T;
    } catch {
      // A cache that cannot be read is a cache miss, never a failed request.
    }

    const value = await load();

    const ttl = Math.min(ttlOf ? ttlOf(value) : this.ttlSeconds, this.ttlSeconds);
    if (ttl > 0) {
      try {
        await this.store.set(key, JSON.stringify(value), ttl);
      } catch {
        // Same on the way out: a write failure must not fail the caller.
      }
    }
    return value;
  }

  clear(): Promise<void> {
    this.inFlight.clear();
    return this.store.clear();
  }
}
