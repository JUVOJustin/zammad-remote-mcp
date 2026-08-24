import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../src/core/config.js';
import type { ZammadClient } from '../src/core/zammad/client.js';
import { LookupService, type ZammadUser } from '../src/core/zammad/lookup.js';

/**
 * A Zammad whose user search matches the way the real one does — on prefixes,
 * across name, login and email — so what the candidates need narrowing from is
 * what a real search would have handed back.
 */
function zammad(directory: ZammadUser[]) {
  const asked: Array<Record<string, unknown>> = [];

  const client = {
    baseUrl: 'https://help.acme.com',
    fingerprint: 'test',
    get: async (path: string, query?: Record<string, unknown>) => {
      const byId = /^\/api\/v1\/users\/(\d+)$/.exec(path);
      if (byId) {
        const user = directory.find((candidate) => candidate.id === Number(byId[1]));
        if (!user) throw new Error('404');
        return user;
      }

      asked.push(query ?? {});
      const term = String(query?.query ?? '').toLowerCase();
      return directory.filter((user) => {
        const fields = [
          user.firstname,
          user.lastname,
          user.login,
          user.email,
          [user.firstname, user.lastname].filter(Boolean).join(' '),
        ].filter(Boolean) as string[];
        return fields
          .flatMap((field) => [field, ...field.split(/[\s@.]+/)])
          .some((part) => part.toLowerCase().startsWith(term));
      });
    },
  } as unknown as ZammadClient;

  // No cache, so each call is observable.
  const lookup = new LookupService(client, { METADATA_CACHE_TTL_SECONDS: 0 } as Config);
  return { lookup, asked };
}

const jan: ZammadUser = {
  id: 2,
  firstname: 'Jan',
  lastname: 'Ott',
  login: 'jott',
  email: 'jan@acme.com',
  active: true,
};
const departed: ZammadUser = {
  id: 3,
  firstname: 'Kristin',
  lastname: 'Rieder',
  login: 'krieder',
  email: 'kristin@acme.com',
  active: false,
};

describe('mentionableAgents', () => {
  it('asks for agents with access to the group, as the UI picker does', async () => {
    const { lookup, asked } = zammad([jan]);
    await lookup.mentionableAgents('Jan', 7);

    assert.equal(asked[0]?.permissions, 'ticket.agent');
    assert.equal(asked[0]?.['group_ids[7]'], 'read');
  });

  it('sends no group filter when there is no single group', async () => {
    const { lookup, asked } = zammad([jan]);
    await lookup.mentionableAgents('Jan');

    assert.equal(asked[0]?.permissions, 'ticket.agent');
    assert.equal(
      Object.keys(asked[0] ?? {}).some((key) => key.startsWith('group_ids')),
      false,
    );
  });

  it('returns the candidate with the identities a token may name them by', async () => {
    const { lookup } = zammad([jan]);
    assert.deepEqual(await lookup.mentionableAgents('Jan'), [
      { id: 2, name: 'Jan Ott', email: 'jan@acme.com', login: 'jott' },
    ]);
  });

  it('leaves out an agent who has been deactivated', async () => {
    // Zammad's search sorts by `active` rather than filtering on it, and the
    // group filter that would have dropped them is absent on a bulk update.
    const { lookup } = zammad([departed]);
    assert.deepEqual(await lookup.mentionableAgents('Kristin'), []);
  });
});

describe('mentionableAgentById', () => {
  it('turns the id into an identity and puts it through the same filters', async () => {
    const { lookup, asked } = zammad([jan]);
    assert.deepEqual(await lookup.mentionableAgentById(2), {
      id: 2,
      name: 'Jan Ott',
      email: 'jan@acme.com',
      login: 'jott',
    });
    // Not searched for as the characters "2".
    assert.equal(asked[0]?.query, 'jan@acme.com');
  });

  it('refuses an id whose account may not be mentioned', async () => {
    const { lookup } = zammad([departed]);
    assert.equal(await lookup.mentionableAgentById(3), undefined);
  });

  it('refuses an id that is nobody', async () => {
    const { lookup } = zammad([jan]);
    assert.equal(await lookup.mentionableAgentById(99), undefined);
  });
});
