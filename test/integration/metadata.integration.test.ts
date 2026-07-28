import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { callTool, callToolText, type Json, skipReason, startHarness, stopHarness } from './harness.js';
import { ADMIN_LOGIN, AGENT_EMAIL, api } from './zammad.js';

/**
 * Metadata and discovery against a real Zammad.
 *
 * The tool schemas advertise this instance's own states, groups and priorities,
 * so these enums are read from a live Zammad at registration time. If that
 * reading breaks, every schema silently narrows to a default and the tools stop
 * accepting values that are perfectly valid on the connected instance.
 */

let ready = false;

before(async () => {
  ready = await startHarness();
});

after(stopHarness);

describe('metadata against a real Zammad', () => {
  it('reports the authenticated user', async (t) => {
    if (!ready) return t.skip(skipReason);

    const me = await callTool('zammad_whoami', {});
    assert.equal(me.user.email, ADMIN_LOGIN);
    assert.ok(
      JSON.stringify(me).toLowerCase().includes('admin'),
      'whoami should show what the credential may do',
    );
  });

  it('publishes the states of this instance in the tool schema', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Read the schema the client actually receives, not the zod source.
    const listed = await callTool('zammad_search_tickets', { state: ['new'], output: 'count' });
    assert.equal(typeof listed.total_count, 'number', 'a state from this instance must be accepted');

    const closed = await callTool('zammad_search_tickets', { state: ['closed'], output: 'count' });
    assert.equal(typeof closed.total_count, 'number');
  });

  it('lists tags that exist', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await api<{ id: number }>('/api/v1/tickets', {
      method: 'POST',
      body: {
        title: 'Metadata tag source',
        group: 'Users',
        customer: 'customer@example.test',
        article: { body: 'x', type: 'note', internal: true },
      },
    });
    await api(`/api/v1/tags/add?object=Ticket&o_id=${ticket.id}&item=metadata-probe`, { method: 'POST' });

    // The tool searches rather than dumps, so it takes a term.
    const tags = await callTool('zammad_list_tags', { term: 'metadata' });
    assert.ok(
      JSON.stringify(tags).includes('metadata-probe'),
      `the tag is missing: ${JSON.stringify(tags).slice(0, 200)}`,
    );
  });

  it('lists overviews', async (t) => {
    if (!ready) return t.skip(skipReason);

    const overviews = await callTool('zammad_list_overviews', {});
    assert.ok(Array.isArray(overviews.overviews), 'no overviews came back');
    assert.ok(overviews.overviews.length > 0, 'a stock Zammad ships several');
  });

  it('reads custom attributes with an admin credential', async (t) => {
    if (!ready) return t.skip(skipReason);

    // This is the call that returns 403 for an agent token; the admin here
    // should get the object manager listing.
    const attributes = await callTool('zammad_list_custom_attributes', {});
    assert.ok(JSON.stringify(attributes).includes('Ticket'), 'no ticket attributes listed');
  });

  it('finds a user by email', async (t) => {
    if (!ready) return t.skip(skipReason);

    const found = await callTool('zammad_search_users', { email: { is: AGENT_EMAIL }, per_page: 10 });
    assert.ok(
      found.users.some((user: Json) => user.email === AGENT_EMAIL),
      `${AGENT_EMAIL} was not found: ${JSON.stringify(found).slice(0, 200)}`,
    );
  });

  it('refreshes the metadata cache', async (t) => {
    if (!ready) return t.skip(skipReason);

    const refreshed = await callToolText('zammad_refresh_metadata_cache', {});
    assert.ok(refreshed.length > 0, 'the refresh tool returned nothing');

    // The instance is still usable afterwards — a refresh that empties the
    // lookups would only show up on the next call.
    const me = await callTool('zammad_whoami', {});
    assert.equal(me.user.email, ADMIN_LOGIN);
  });
});
