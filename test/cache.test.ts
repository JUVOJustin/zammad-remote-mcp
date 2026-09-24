import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CacheStore } from '../src/core/util/cache.js';
import { createMemoryCacheStore, JsonCache } from '../src/core/util/cache.js';

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
