import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  callTool,
  callToolExpectingError,
  type Json,
  listTools,
  skipReason,
  startHarness,
  stopHarness,
  withRejectedCredential,
} from './harness.js';
import { api, CUSTOMER_EMAIL } from './zammad.js';

/**
 * The tool surface, against the instance it describes.
 *
 * These assertions used to run against a stub Zammad in `test/server.test.ts`.
 * A stub can only confirm what we already believed about Zammad, and twice now
 * that belief was wrong in ways it happily reproduced: an argument Zammad
 * ignores came back 200, and an article nested in the wrong parameter came back
 * 200 with nothing written. Everything that depends on Zammad agreeing lives
 * here instead.
 */

let ready = false;

before(async () => {
  ready = await startHarness();
});

after(stopHarness);

describe('the tool surface of a real instance', () => {
  it('publishes the whole toolset', async (t) => {
    if (!ready) return t.skip(skipReason);

    const names: string[] = (await listTools()).map((tool: Json) => tool.name);
    for (const expected of [
      'zammad_search_tickets',
      'zammad_search_users',
      'zammad_search_organizations',
      'zammad_search_global',
      'zammad_get_ticket',
      'zammad_create_ticket',
      'zammad_update_ticket',
      'zammad_delete_ticket',
      'zammad_merge_tickets',
      'zammad_mass_update_tickets',
      'zammad_create_article',
      'zammad_get_user',
      'zammad_list_custom_attributes',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  it('no longer exposes the tools the schema enums replaced', async (t) => {
    if (!ready) return t.skip(skipReason);

    const names: string[] = (await listTools()).map((tool: Json) => tool.name);
    for (const gone of [
      'zammad_list_ticket_states',
      'zammad_list_ticket_priorities',
      'zammad_list_groups',
      'zammad_list_macros',
    ]) {
      assert.ok(!names.includes(gone), `${gone} should have been replaced by schema enums`);
    }
  });

  it('names the macros of this instance rather than asking for an ID', async (t) => {
    if (!ready) return t.skip(skipReason);

    const macros = await api<Json[]>('/api/v1/macros');
    assert.ok(macros.length > 0, 'the instance has no macro to advertise');

    const schema = (await listTools()).find((tool: Json) => tool.name === 'zammad_apply_macro')
      ?.inputSchema as Json;

    assert.ok(schema.properties.macro, 'expected a `macro` argument');
    assert.ok(
      JSON.stringify(schema.properties.macro).includes(macros[0].name),
      `the macro enum does not name "${macros[0].name}": ${JSON.stringify(schema.properties.macro)}`,
    );
  });

  it('still accepts a value that is not in the published enum', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Clients cache schemas, so a state created after discovery must not be
    // rejected client-side. The enum is a hint; the server resolves. The point
    // is *which layer* refuses: Zammad's value set, with a message naming the
    // alternatives, rather than schema validation with nothing to act on.
    const message = await callToolExpectingError('zammad_search_tickets', { state: 'brand-new-state' });

    assert.match(message, /Unknown ticket state/);
    assert.match(message, /open/, 'the error should list what this instance does have');
  });

  it('surfaces a refused credential as a tool error rather than crashing', async (t) => {
    if (!ready) return t.skip(skipReason);

    await withRejectedCredential(async (call) => {
      const result = await call('zammad_get_user', { user: 'me' });

      assert.equal(result.isError, true, 'a 401 must not take the connection down');
      assert.match(result.content[0].text, /401|auth/i, result.content[0].text);
    });
  });

  it('runs each call under the caller’s own credential', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The stub used to assert the Authorization header it received. Against a
    // real instance the honest form is to ask for something whose answer only
    // Zammad can decide: an internal article is visible to the agent who wrote
    // it and hidden from the customer. If the identity never left this process,
    // both reads would return the same thing.
    //
    // Deliberately not a row count: the suites run in parallel and create
    // tickets as they go, so any two counts taken in sequence race each other.
    const created = await callTool('zammad_create_ticket', {
      title: 'Credential scoping',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: { body: 'PUBLIC opening', type: 'note', internal: false },
    });
    await callTool('zammad_create_article', {
      ticket_id: created.ticket.id,
      body: 'INTERNAL follow-up',
      internal: true,
    });

    const asCredential = await callTool('zammad_get_ticket', { ticket_id: created.ticket.id });
    const asCustomer = await callTool('zammad_get_ticket', {
      ticket_id: created.ticket.id,
      on_behalf_of: CUSTOMER_EMAIL,
    });

    const bodies = (result: Json) => JSON.stringify(result.ticket?.articles ?? result.articles ?? []);
    assert.match(bodies(asCredential), /INTERNAL follow-up/, 'the agent should see its own internal note');
    assert.doesNotMatch(
      bodies(asCustomer),
      /INTERNAL follow-up/,
      'the internal note reached the customer, so the call did not act as them',
    );
    assert.match(bodies(asCustomer), /PUBLIC opening/, 'the customer should still see the public article');
  });
});
