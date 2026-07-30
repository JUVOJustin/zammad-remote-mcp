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
} from './harness.js';
import { AGENT_EMAIL, api, CUSTOMER_EMAIL, mentionsFor, seededAgent } from './zammad.js';

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

  it('refuses a ticket with no group or customer, naming what is missing', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Zammad requires both. Catching it here means one round trip instead of a
    // 422 whose body has to be read to find out which field was meant.
    assert.match(
      await callToolExpectingError('zammad_create_ticket', {
        title: 'No group',
        article: { body: 'hi' },
      }),
      /requires a group/,
    );
    assert.match(
      await callToolExpectingError('zammad_create_ticket', {
        title: 'No customer',
        group: 'Users',
        article: { body: 'hi' },
      }),
      /requires a customer/,
    );
  });

  it('writes the first article as an internal note unless told otherwise', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The safe default, asserted on what Zammad stored rather than on the
    // payload we sent: nothing reaches the customer by accident.
    const created = await callTool('zammad_create_ticket', {
      title: 'Default article shape',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: { body: 'Something broke' },
    });

    const listed = await callTool('zammad_list_ticket_articles', { ticket_id: created.ticket.id });
    const first = listed.articles[0];
    assert.equal(first.type, 'note', 'articles must default to a note, not an email');
    assert.equal(first.internal, true, 'articles must default to internal');

    // And the association names went through untouched — Zammad resolved them.
    const stored = await api<Json>(`/api/v1/tickets/${created.ticket.id}`);
    assert.equal(
      stored.group_id,
      (await api<Json[]>('/api/v1/groups')).find((g: Json) => g.name === 'Users').id,
    );
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

  /**
   * Mass update, against the instance rather than against an assumption.
   *
   * The article used to be nested inside `attributes`, where
   * `TicketsMassController#update` never looks: it reads `params[:article]` and
   * hands that to `article_create`, while `attributes` goes through
   * `clean_update_params`, which keeps only ticket columns. The call returned
   * 200, the tool reported `submitted: true`, and no article was ever written.
   * Nothing short of reading the articles back off a real Zammad shows that, so
   * every assertion here does.
   */
  describe('mass update articles', () => {
    async function articleBodies(ticketId: number): Promise<string[]> {
      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticketId}`);
      return articles.map((article: Json) => String(article.body));
    }

    it('writes the note to every ticket in the batch', async (t) => {
      if (!ready) return t.skip(skipReason);

      const one = await newTicket('Mass note one');
      const two = await newTicket('Mass note two');

      const result = await callTool('zammad_mass_update_tickets', {
        ticket_ids: [one.ticket.id, two.ticket.id],
        state: 'open',
        article: { body: 'Bulk note from the integration suite.' },
      });
      assert.equal(result.submitted, true);

      for (const created of [one, two]) {
        const bodies = await articleBodies(created.ticket.id);
        assert.ok(
          bodies.some((body) => body.includes('Bulk note from the integration suite.')),
          `ticket ${created.ticket.id} never got the note: ${JSON.stringify(bodies)}`,
        );
        assert.equal((await api<Json>(`/api/v1/tickets/${created.ticket.id}`)).state_id, 2);
      }
    });

    it('records the note as an internal note by an agent', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Mass note shape');
      await callTool('zammad_mass_update_tickets', {
        ticket_ids: [ticket.ticket.id],
        article: { body: 'Shape check.' },
      });

      // Read back through the tool, which resolves the numeric type and sender
      // to the names Zammad itself uses — an assertion on `type_id: 10` would
      // pass on this instance and mean nothing on another.
      const listed = await callTool('zammad_list_ticket_articles', { ticket_id: ticket.ticket.id });
      const note = listed.articles[listed.articles.length - 1];

      assert.equal(note.type, 'note', 'the batch wrote something other than a note');
      assert.equal(note.sender, 'Agent');
      assert.equal(note.internal, true, 'internal must default to true here as everywhere');
    });

    it('honours internal: false', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Mass note public');
      await callTool('zammad_mass_update_tickets', {
        ticket_ids: [ticket.ticket.id],
        article: { body: 'Visible to the customer.', internal: false },
      });

      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      assert.equal(articles[articles.length - 1].internal, false);
    });

    it('resolves @@mentions in the note and notifies the agent', async (t) => {
      if (!ready) return t.skip(skipReason);

      // The mention rewrite was already wired up here, but it fed the article
      // into `attributes`, so nothing was ever created and nobody was notified.
      const agent = await seededAgent();
      const ticket = await newTicket('Mass note mention');

      const result = await callTool('zammad_mass_update_tickets', {
        ticket_ids: [ticket.ticket.id],
        article: { body: `@@${AGENT_EMAIL} please pick this up` },
      });

      assert.ok(
        JSON.stringify(result.mentioned ?? []).includes(String(agent.id)),
        `the mention was not resolved: ${JSON.stringify(result.mentioned)}`,
      );

      const bodies = await articleBodies(ticket.ticket.id);
      assert.ok(
        bodies.some((body) => body.includes('data-mention-user-id')),
        `the anchor never reached Zammad: ${JSON.stringify(bodies)}`,
      );
      const mentions = await mentionsFor(ticket.ticket.id);
      assert.ok(
        mentions.some((mention) => mention.user_id === agent.id),
        'Zammad recorded no mention, so nobody was notified',
      );
    });

    it('takes a note with no attribute changes at all', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Mass note only');
      await callTool('zammad_mass_update_tickets', {
        ticket_ids: [ticket.ticket.id],
        article: { body: 'Note without attributes.' },
      });

      const bodies = await articleBodies(ticket.ticket.id);
      assert.ok(
        bodies.some((body) => body.includes('Note without attributes.')),
        JSON.stringify(bodies),
      );
    });

    it('refuses the article fields a batch cannot honour', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Mass note rejected');
      // One article goes to every ticket, so a recipient list would be addressed
      // to each customer in the batch. Zammad's own bulk form offers none of
      // these, and a strict schema says so rather than dropping them silently.
      for (const [field, value] of [
        ['type', 'email'],
        ['sender', 'Customer'],
        ['to', CUSTOMER_EMAIL],
        ['cc', CUSTOMER_EMAIL],
        ['subject', 'Subject'],
        ['content_type', 'text/html'],
        ['in_reply_to', '<x@y>'],
        ['time_unit', '15'],
        ['origin_by', AGENT_EMAIL],
        ['attachments', []],
      ] as Array<[string, unknown]>) {
        const message = await callToolExpectingError('zammad_mass_update_tickets', {
          ticket_ids: [ticket.ticket.id],
          article: { body: 'x', [field]: value },
        });
        assert.match(message, new RegExp(field, 'i'), `${field} was accepted or the error never named it`);
      }

      // And nothing was written while all of those were being refused.
      const bodies = await articleBodies(ticket.ticket.id);
      assert.equal(bodies.length, 1, `a refused call still wrote an article: ${JSON.stringify(bodies)}`);
    });

    it('offers only body and internal in its schema', async (t) => {
      if (!ready) return t.skip(skipReason);

      const tools = await listTools();
      const schema = tools.find((tool: Json) => tool.name === 'zammad_mass_update_tickets')
        ?.inputSchema as Json;

      assert.deepEqual(Object.keys(schema.properties.article.properties).sort(), ['body', 'internal']);
      assert.equal(schema.properties.article.additionalProperties, false, 'the article schema is not strict');
    });
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
