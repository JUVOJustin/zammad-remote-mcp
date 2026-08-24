import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config } from '../src/core/config.js';
import type { ZammadClient } from '../src/core/zammad/client.js';
import { LookupService, type ZammadUser } from '../src/core/zammad/lookup.js';

/**
 * A Zammad whose user search matches the way the real one does — on prefixes,
 * across name, login and email — so the narrowing under test is the narrowing
 * that has to happen here rather than one the fixture did for it.
 */
function zammad(directory: ZammadUser[]) {
  const asked: Array<Record<string, unknown>> = [];

  const client = {
    baseUrl: 'https://help.acme.com',
    fingerprint: 'test',
    get: async (path: string, query?: Record<string, unknown>) => {
      const byId = /^\/api\/v1\/users\/(\d+)$/.exec(path);
      if (byId) return directory.find((user) => user.id === Number(byId[1]));

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
        // Whole field or any word of it, matched on its prefix — which is what
        // makes "Jan" return Janine and "me" return Melanie on a real instance.
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

const janine: ZammadUser = {
  id: 1,
  firstname: 'Janine',
  lastname: 'Schmidt',
  login: 'jschmidt',
  email: 'janine@acme.com',
  active: true,
};
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

describe('resolveMentionableUser', () => {
  it('asks for agents with access to the group, as the UI picker does', async () => {
    const { lookup, asked } = zammad([jan]);
    await lookup.resolveMentionableUser('jan@acme.com', 7);

    assert.equal(asked[0]?.permissions, 'ticket.agent');
    assert.equal(asked[0]?.['group_ids[7]'], 'read');
  });

  it('sends no group filter when there is no single group', async () => {
    const { lookup, asked } = zammad([jan]);
    await lookup.resolveMentionableUser('jan@acme.com');

    assert.equal(asked[0]?.permissions, 'ticket.agent');
    assert.equal(
      Object.keys(asked[0] ?? {}).some((key) => key.startsWith('group_ids')),
      false,
    );
  });

  it('refuses a name it only prefix-matched', async () => {
    // The search returns Janine for "Jan". Accepting her would mention the
    // wrong colleague, in a note that reads as though it reached the right one.
    const { lookup } = zammad([janine]);
    await assert.rejects(lookup.resolveMentionableUser('Jan'), /No agent goes by "Jan"/);
  });

  it('accepts a whole part of the name', async () => {
    const { lookup } = zammad([janine, jan]);
    assert.deepEqual(await lookup.resolveMentionableUser('Jan'), { id: 2, name: 'Jan Ott' });
    assert.deepEqual(await lookup.resolveMentionableUser('Schmidt'), { id: 1, name: 'Janine Schmidt' });
  });

  it('accepts the full name, an email address and a login', async () => {
    const { lookup } = zammad([janine, jan]);
    for (const term of ['Janine Schmidt', 'janine@acme.com', 'jschmidt']) {
      assert.equal((await lookup.resolveMentionableUser(term)).id, 1, term);
    }
  });

  it('accepts a numeric id by resolving it through the same filters', async () => {
    const { lookup, asked } = zammad([jan]);
    assert.deepEqual(await lookup.resolveMentionableUser('2'), { id: 2, name: 'Jan Ott' });
    // Not searched for as the characters "2": turned into an identity first.
    assert.equal(asked[0]?.query, 'jan@acme.com');
  });

  it('refuses an id that is not a mentionable agent', async () => {
    const { lookup } = zammad([departed]);
    await assert.rejects(lookup.resolveMentionableUser('3'), /No agent goes by/);
  });

  it('leaves out an agent who has been deactivated', async () => {
    // Zammad's search sorts by `active` rather than filtering on it, and the
    // group filter that would have dropped them is absent on a bulk update.
    const { lookup } = zammad([departed]);
    await assert.rejects(lookup.resolveMentionableUser('Kristin'), /No agent goes by "Kristin"/);
  });

  it('refuses a name two agents share, naming both', async () => {
    const twin: ZammadUser = {
      id: 4,
      firstname: 'Jan',
      lastname: 'Meyer',
      login: 'jmeyer',
      email: 'jan.meyer@acme.com',
      active: true,
    };
    const { lookup } = zammad([jan, twin]);

    await assert.rejects(lookup.resolveMentionableUser('Jan'), (error: Error) => {
      assert.match(error.message, /is the name of 2 agents/);
      assert.match(error.message, /Jan Ott/);
      assert.match(error.message, /Jan Meyer/);
      return true;
    });
  });
});
