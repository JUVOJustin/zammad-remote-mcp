import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../src/core/config.js';
import type { CacheStore } from '../src/core/util/cache.js';
import { createMemoryCacheStore, JsonCache } from '../src/core/util/cache.js';
import type { ZammadClient } from '../src/core/zammad/client.js';
import { LookupService } from '../src/core/zammad/lookup.js';

describe('memory cache store', () => {
  it('round-trips a value', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', 'v', 60);
    assert.equal(await store.get('k'), 'v');
  });

  it('expires entries', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', 'v', -1);
    assert.equal(await store.get('k'), undefined);
  });

  it('clears everything', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', 'v', 60);
    await store.clear();
    assert.equal(await store.get('k'), undefined);
  });

  it('stays within its bound when nothing has expired, dropping the oldest writes', async () => {
    // The OAuth proxy caches under keys a caller chooses; a bound that only
    // held once entries expired let those callers grow it without limit.
    const store = createMemoryCacheStore(3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) await store.set(key, key, 3600);

    assert.equal(await store.get('a'), undefined);
    assert.equal(await store.get('b'), undefined);
    assert.equal(await store.get('e'), 'e');
    assert.equal(await store.get('c'), 'c');
  });
});

describe('JsonCache', () => {
  it('loads once and serves the cached copy afterwards', async () => {
    let calls = 0;
    const cache = new JsonCache(createMemoryCacheStore(), 60);
    const load = async () => {
      calls++;
      return { states: ['open'] };
    };

    assert.deepEqual(await cache.read('k', load), { states: ['open'] });
    assert.deepEqual(await cache.read('k', load), { states: ['open'] });
    assert.equal(calls, 1);
  });

  it('de-duplicates concurrent loads of the same key', async () => {
    // The four vocabulary sources are requested together on a cold start; without
    // this, a burst of parallel requests would each fetch the same list.
    let calls = 0;
    const cache = new JsonCache(createMemoryCacheStore(), 60);
    const load = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return calls;
    };

    const results = await Promise.all([cache.read('k', load), cache.read('k', load), cache.read('k', load)]);
    assert.equal(calls, 1);
    assert.deepEqual(results, [1, 1, 1]);
  });

  it('bypasses the store when the TTL is zero', async () => {
    let calls = 0;
    const cache = new JsonCache(createMemoryCacheStore(), 0);
    const load = async () => ++calls;

    await cache.read('k', load);
    await cache.read('k', load);
    assert.equal(calls, 2);
  });

  it('treats an unreadable cache as a miss rather than an error', async () => {
    // A cache outage must degrade to the uncached path, never fail the request.
    const broken: CacheStore = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      set: async () => {
        throw new Error('KV unavailable');
      },
      clear: async () => {},
    };

    const cache = new JsonCache(broken, 60);
    assert.deepEqual(await cache.read('k', async () => ({ ok: true })), { ok: true });
  });

  it('lets a loaded value set its own lifetime, capped by the cache and 0 meaning never', async () => {
    const writes: Array<[string, number]> = [];
    const store = createMemoryCacheStore();
    const recording: CacheStore = { ...store, set: async (key, _value, ttl) => void writes.push([key, ttl]) };
    const cache = new JsonCache(recording, 600);

    await cache.read(
      'short',
      async () => ({ ttl: 30 }),
      (value) => value.ttl,
    );
    await cache.read(
      'long',
      async () => ({ ttl: 86_400 }),
      (value) => value.ttl,
    );
    await cache.read(
      'never',
      async () => ({ ttl: 0 }),
      (value) => value.ttl,
    );

    assert.deepEqual(writes, [
      ['short', 30],
      ['long', 600],
    ]);
  });

  it('does not cache a failed load', async () => {
    let calls = 0;
    const cache = new JsonCache(createMemoryCacheStore(), 60);
    const load = async () => {
      calls++;
      throw new Error('upstream down');
    };

    await assert.rejects(() => cache.read('k', load));
    await assert.rejects(() => cache.read('k', load));
    assert.equal(calls, 2, 'a failure must not be remembered');
  });
});

describe('lookup cache', () => {
  it('merges concurrent loads across the per-request services', async () => {
    // Every MCP request builds its own LookupService; a cold burst of them must
    // still read each list from Zammad once.
    let calls = 0;
    const client = {
      baseUrl: 'http://merge.test',
      fingerprint: 'one-credential',
      get: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ id: 1, name: 'open', state_type_id: 2, active: true }];
      },
    } as unknown as ZammadClient;
    const config = { METADATA_CACHE_TTL_SECONDS: 60 } as Config;

    await Promise.all([1, 2, 3].map(() => new LookupService(client, config).states()));
    assert.equal(calls, 1);
  });
});
