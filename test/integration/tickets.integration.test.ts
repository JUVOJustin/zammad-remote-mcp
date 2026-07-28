import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { callTool, type Json, listTools, skipReason, startHarness, stopHarness } from './harness.js';
import { AGENT_EMAIL, api, CUSTOMER_EMAIL } from './zammad.js';

/**
 * The write tools against a real Zammad.
 *
 * These are the calls that change a customer's helpdesk, and most of them
 * translate a friendly name into an id before they do. A wrong mapping is
 * invisible in a unit test with a stubbed client — it shows up as a ticket in
 * the wrong state or assigned to nobody.
 */

let ready = false;

async function newTicket(title: string): Promise<Json> {
  return callTool('zammad_create_ticket', {
    title,
    group: 'Users',
    customer: CUSTOMER_EMAIL,
    article: { body: 'Opened by the integration suite.', type: 'note', internal: false },
  });
}

before(async () => {
  ready = await startHarness();
});

after(stopHarness);

describe('ticket lifecycle against a real Zammad', () => {
  it('creates a ticket with names rather than ids', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle create');
    assert.ok(created.ticket.id, 'no ticket came back');

    const stored = await api<Json>(`/api/v1/tickets/${created.ticket.id}`);
    assert.equal(stored.title, 'Lifecycle create');
    // group and customer arrived as strings and had to be resolved.
    assert.ok(stored.group_id, 'group was not resolved');
    assert.ok(stored.customer_id, 'customer was not resolved');
  });

  it('moves a ticket through states and back', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle states');
    const id = created.ticket.id;

    await callTool('zammad_update_ticket', { ticket_id: id, state: 'open' });
    assert.equal((await api<Json>(`/api/v1/tickets/${id}`)).state_id, 2);

    await callTool('zammad_update_ticket', { ticket_id: id, state: 'closed' });
    const closed = await api<Json>(`/api/v1/tickets/${id}`);
    assert.equal(closed.state_id, 4);
    assert.ok(closed.close_at, 'closing should stamp close_at');
  });

  it('requires pending_time for a pending state', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle pending');
    let message = '';
    try {
      await callTool('zammad_update_ticket', { ticket_id: created.ticket.id, state: 'pending reminder' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.match(message, /pending_time/i, `the error should name what is missing: ${message}`);
  });

  it('assigns an owner by email', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle owner');
    await callTool('zammad_update_ticket', { ticket_id: created.ticket.id, owner: AGENT_EMAIL });

    const stored = await api<Json>(`/api/v1/tickets/${created.ticket.id}`);
    const agent = (await api<Json[]>(`/api/v1/users/search?query=${AGENT_EMAIL}&limit=1`))[0];
    assert.equal(stored.owner_id, agent.id);
  });

  it('adds and removes tags', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle tags');
    const id = created.ticket.id;

    await callTool('zammad_add_ticket_tags', { ticket_id: id, tags: ['alpha', 'beta'] });
    let tags = await api<Json>(`/api/v1/tags?object=Ticket&o_id=${id}`);
    assert.deepEqual([...tags.tags].sort(), ['alpha', 'beta']);

    await callTool('zammad_remove_ticket_tags', { ticket_id: id, tags: ['alpha'] });
    tags = await api<Json>(`/api/v1/tags?object=Ticket&o_id=${id}`);
    assert.deepEqual(tags.tags, ['beta']);
  });

  it('links two tickets and unlinks them again', async (t) => {
    if (!ready) return t.skip(skipReason);

    const one = await newTicket('Lifecycle link source');
    const two = await newTicket('Lifecycle link target');

    await callTool('zammad_link_tickets', {
      ticket_id: one.ticket.id,
      target_ticket_id: two.ticket.id,
      type: 'normal',
    });

    const links = await callTool('zammad_list_ticket_links', { ticket_id: one.ticket.id });
    assert.ok(
      JSON.stringify(links).includes(String(two.ticket.id)),
      `the link is not visible: ${JSON.stringify(links).slice(0, 200)}`,
    );

    await callTool('zammad_unlink_tickets', {
      ticket_id: one.ticket.id,
      target_ticket_id: two.ticket.id,
      type: 'normal',
    });
    const after = await callTool('zammad_list_ticket_links', { ticket_id: one.ticket.id });
    assert.ok(!JSON.stringify(after).includes(`"id":${two.ticket.id}`), 'the link survived unlinking');
  });

  it('reads back the articles it wrote', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle articles');
    await callTool('zammad_create_article', {
      ticket_id: created.ticket.id,
      body: 'A second note.',
      internal: true,
    });

    const listed = await callTool('zammad_list_ticket_articles', { ticket_id: created.ticket.id });
    assert.equal(listed.total, 2, 'the opening article plus the note');
    assert.ok(listed.articles.some((article: Json) => article.body.includes('A second note.')));
  });

  it('records time against a ticket', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle time');
    await callTool('zammad_create_time_accounting', { ticket_id: created.ticket.id, time_unit: '15' });

    const entries = await callTool('zammad_list_time_accounting', { ticket_id: created.ticket.id });
    assert.ok(JSON.stringify(entries).includes('15'), JSON.stringify(entries).slice(0, 200));
  });

  it('returns the ticket history', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await newTicket('Lifecycle history');
    await callTool('zammad_update_ticket', { ticket_id: created.ticket.id, state: 'closed' });

    const history = await callTool('zammad_get_ticket_history', { ticket_id: created.ticket.id });
    assert.ok(JSON.stringify(history).includes('state'), 'the state change is not in the history');
  });

  it('updates several tickets at once', async (t) => {
    if (!ready) return t.skip(skipReason);

    const one = await newTicket('Lifecycle mass one');
    const two = await newTicket('Lifecycle mass two');

    await callTool('zammad_mass_update_tickets', {
      ticket_ids: [one.ticket.id, two.ticket.id],
      state: 'closed',
    });

    for (const created of [one, two]) {
      const stored = await api<Json>(`/api/v1/tickets/${created.ticket.id}`);
      assert.equal(stored.state_id, 4, `ticket ${created.ticket.id} was not closed`);
    }
  });

  it('advertises the groups of this instance wherever a group is taken', async (t) => {
    if (!ready) return t.skip(skipReason);

    // create_ticket used to declare `group` as a bare string while update and
    // search both carried the instance's groups — so the one tool that
    // *requires* a group was the only one that never said which exist.
    const tools = await listTools();
    for (const name of ['zammad_create_ticket', 'zammad_update_ticket', 'zammad_search_tickets']) {
      const schema = tools.find((tool: Json) => tool.name === name)?.inputSchema;
      assert.ok(
        JSON.stringify(schema?.properties?.group).includes('"Users"'),
        `${name} does not name the real groups: ${JSON.stringify(schema?.properties?.group)}`,
      );
    }
  });

  it('rejects an unknown group rather than inventing one', async (t) => {
    if (!ready) return t.skip(skipReason);

    let message = '';
    try {
      await callTool('zammad_create_ticket', {
        title: 'Lifecycle bad group',
        group: 'No Such Group',
        customer: CUSTOMER_EMAIL,
        article: { body: 'x', type: 'note', internal: true },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Names outside the enum stay allowed on purpose, so this one reaches
    // Zammad — but it has to fail, and name what it choked on.
    assert.match(message, /No Such Group/, `the error should quote the bad value: ${message}`);
  });
});
