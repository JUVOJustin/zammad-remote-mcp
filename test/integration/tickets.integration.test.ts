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

  /**
   * The signature, against the instance that owns it.
   *
   * A unit test can only prove the helpers agree with a fixture. What it cannot
   * show is that the group really points at that signature, that the placeholders
   * name attributes this Zammad actually returns, or that Zammad stores the
   * composed body rather than rewriting it — all of which are only visible from
   * the article Zammad hands back.
   */
  describe('group signatures', () => {
    /** What the UI would put in the "Send Email" tab: recipient included. */
    const emailArticle = (overrides: Record<string, unknown> = {}) => ({
      body: 'Opened by the integration suite.',
      type: 'email',
      sender: 'Agent',
      internal: false,
      to: CUSTOMER_EMAIL,
      ...overrides,
    });

    async function firstArticle(ticketId: number): Promise<Json> {
      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticketId}`);
      return articles[0];
    }

    it('signs an email article with the signature configured on the group', async (t) => {
      if (!ready) return t.skip(skipReason);

      const group = await api<Json>('/api/v1/groups/1');
      assert.ok(group.signature_id, 'the seeded group has no signature to test against');
      const signature = await api<Json>(`/api/v1/signatures/${group.signature_id}`);
      assert.match(signature.body, /#\{/, 'the fixture signature has no placeholder to resolve');

      const created = await callTool('zammad_create_ticket', {
        title: 'Signature applied',
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ content_type: 'text/html' }),
      });

      assert.equal(created.signature.appended, true);
      assert.equal(created.signature.signature_id, group.signature_id);
      assert.equal(created.signature.signature_name, signature.name);

      const body: string = (await firstArticle(created.ticket.id)).body;
      assert.ok(
        body.includes(`data-signature-id="${group.signature_id}"`),
        `Zammad did not store the marker: ${body}`,
      );
      // The credential the harness authenticates with is the admin, so this is
      // the placeholder resolved against a user Zammad really returned.
      const me = await api<Json>('/api/v1/users/me');
      assert.ok(body.includes(`${me.firstname} ${me.lastname}`), `the user did not render: ${body}`);
      assert.ok(!body.includes('#{'), `a placeholder was left unrendered: ${body}`);
    });

    it('renders it as text for a text/plain article', async (t) => {
      if (!ready) return t.skip(skipReason);

      const created = await callTool('zammad_create_ticket', {
        title: 'Signature as text',
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        article: emailArticle(),
      });

      const article = await firstArticle(created.ticket.id);
      const me = await api<Json>('/api/v1/users/me');
      assert.equal(article.content_type, 'text/plain');
      assert.ok(!article.body.includes('<div'), `markup leaked into a plain article: ${article.body}`);
      assert.ok(article.body.includes(`${me.firstname} ${me.lastname}`), article.body);
    });

    it('leaves a note unsigned, as the create screen does', async (t) => {
      if (!ready) return t.skip(skipReason);

      const created = await newTicket('Signature skipped for a note');

      assert.equal(created.signature.appended, false);
      assert.equal((await firstArticle(created.ticket.id)).body, 'Opened by the integration suite.');
    });

    it('honours append_signature: false on the email channel', async (t) => {
      if (!ready) return t.skip(skipReason);

      const created = await callTool('zammad_create_ticket', {
        title: 'Signature declined',
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ content_type: 'text/html', append_signature: false }),
      });

      assert.equal(created.signature, undefined);
      assert.equal((await firstArticle(created.ticket.id)).body, 'Opened by the integration suite.');
    });

    it('signs a reply added with zammad_create_article', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Signature on a reply');
      const me = await api<Json>('/api/v1/users/me');

      const created = await callTool('zammad_create_article', {
        ticket_id: ticket.ticket.id,
        body: 'Replying from the integration suite.',
        type: 'email',
        internal: false,
        to: CUSTOMER_EMAIL,
        content_type: 'text/html',
      });

      assert.equal(created.signature.appended, true);

      // Read back from Zammad, not from the tool's own echo.
      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      const reply = articles[articles.length - 1];
      assert.ok(reply.body.includes('data-signature-id='), reply.body);
      assert.ok(reply.body.includes(`${me.firstname} ${me.lastname}`), reply.body);
    });

    it('signs an article appended through zammad_update_ticket', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Signature on an update');
      const updated = await callTool('zammad_update_ticket', {
        ticket_id: ticket.ticket.id,
        state: 'open',
        article: {
          body: 'Closing note from the integration suite.',
          type: 'email',
          internal: false,
          to: CUSTOMER_EMAIL,
          content_type: 'text/html',
        },
      });

      assert.equal(updated.signature.appended, true);

      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      assert.ok(articles[articles.length - 1].body.includes('data-signature-id='));
    });

    it('resolves #{ticket.…} against the ticket being replied to', async (t) => {
      if (!ready) return t.skip(skipReason);

      // The Escalations group's signature is seeded with ticket placeholders,
      // so this reads what the composer would render on an open ticket: the
      // number and title Zammad itself assigned.
      const ticket = await callTool('zammad_create_ticket', {
        title: 'Signature placeholders',
        group: 'Escalations',
        customer: CUSTOMER_EMAIL,
        article: { body: 'Opened by the integration suite.', type: 'note', internal: false },
      });

      await callTool('zammad_create_article', {
        ticket_id: ticket.ticket.id,
        body: 'Reply',
        type: 'email',
        internal: false,
        to: CUSTOMER_EMAIL,
        content_type: 'text/html',
      });

      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      const reply = articles[articles.length - 1];
      assert.ok(
        reply.body.includes(
          `Escalations desk — Re ${ticket.ticket.number}: Signature placeholders (Escalations)`,
        ),
        reply.body,
      );
    });

    it('signs with the group the same update moves the ticket to', async (t) => {
      if (!ready) return t.skip(skipReason);

      // The ticket is in Users (signature 1) and is moved to Escalations
      // (signature 2) in the same call. The UI re-renders the signature the
      // moment the group changes, so the destination group's has to win.
      const ticket = await newTicket('Signature follows the group');
      const escalations = await api<Json>('/api/v1/groups/2');

      const updated = await callTool('zammad_update_ticket', {
        ticket_id: ticket.ticket.id,
        group: 'Escalations',
        article: {
          body: 'Handing over.',
          type: 'email',
          internal: false,
          to: CUSTOMER_EMAIL,
          content_type: 'text/html',
        },
      });

      assert.equal(
        updated.signature.signature_id,
        escalations.signature_id,
        'it signed with the group the ticket was leaving',
      );

      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      assert.ok(articles[articles.length - 1].body.includes('Escalations desk'));
    });

    it('leaves a note added to an existing ticket unsigned', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await newTicket('Signature skipped on a note reply');
      await callTool('zammad_create_article', { ticket_id: ticket.ticket.id, body: 'An internal note.' });

      const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      assert.equal(articles[articles.length - 1].body, 'An internal note.');
    });

    /**
     * The states a real instance can be in that must produce no signature.
     *
     * These are seeded as groups rather than asserted against a stub, because the
     * thing under test is what Zammad actually stores: a null `signature_id` and
     * an `active: false` signature are exactly the two an admin creates by
     * leaving the group form empty or by retiring a signature.
     */
    it('adds nothing when the group has no signature configured', async (t) => {
      if (!ready) return t.skip(skipReason);

      const group = await api<Json[]>('/api/v1/groups');
      const unsigned = group.find((candidate) => candidate.name === 'Unsigned');
      assert.equal(unsigned?.signature_id, null, 'the fixture group should have no signature');

      const created = await callTool('zammad_create_ticket', {
        title: 'Signature absent',
        group: 'Unsigned',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ content_type: 'text/html' }),
      });

      assert.equal(created.signature.appended, false);
      assert.match(created.signature.reason, /no active signature/);
      assert.equal((await firstArticle(created.ticket.id)).body, 'Opened by the integration suite.');
    });

    it('adds nothing when the group’s signature is switched off', async (t) => {
      if (!ready) return t.skip(skipReason);

      const created = await callTool('zammad_create_ticket', {
        title: 'Signature inactive',
        group: 'Retired',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ content_type: 'text/html' }),
      });

      assert.equal(created.signature.appended, false);
      const body = (await firstArticle(created.ticket.id)).body;
      assert.equal(body, 'Opened by the integration suite.');
      assert.ok(!body.includes('Retired team'), 'an inactive signature was sent');
    });

    it('does not sign a reply twice when the same body comes back', async (t) => {
      if (!ready) return t.skip(skipReason);

      // What a caller does by reading an article and passing the body back, or by
      // retrying a call it thought had failed. Zammad's own composer refuses to
      // stack signatures and so must this.
      const ticket = await newTicket('Signature not doubled');
      const first = await callTool('zammad_create_article', {
        ticket_id: ticket.ticket.id,
        body: 'First attempt.',
        type: 'email',
        internal: false,
        to: CUSTOMER_EMAIL,
        content_type: 'text/html',
      });
      assert.equal(first.signature.appended, true);

      const stored = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      const signedBody = stored[stored.length - 1].body;

      const second = await callTool('zammad_create_article', {
        ticket_id: ticket.ticket.id,
        body: signedBody,
        type: 'email',
        internal: false,
        to: CUSTOMER_EMAIL,
        content_type: 'text/html',
      });

      assert.equal(second.signature.appended, false);
      assert.match(second.signature.reason, /already carries this signature/);

      const after = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.ticket.id}`);
      const body = after[after.length - 1].body;
      assert.equal(
        body.match(/data-signature-id/g)?.length,
        1,
        `the signature was stacked: ${body.slice(0, 400)}`,
      );
    });

    it('signs as the user it acts on behalf of, not as the credential', async (t) => {
      if (!ready) return t.skip(skipReason);

      // `signshow` reports the authenticated session even under X-On-Behalf-Of,
      // so the user has to come from /api/v1/users/me. Getting it wrong signs one
      // agent's mail with another's name.
      const agent = (await api<Json[]>(`/api/v1/users/search?query=${AGENT_EMAIL}&limit=1`))[0];
      const me = await api<Json>('/api/v1/users/me');

      const created = await callTool('zammad_create_ticket', {
        title: 'Signature on behalf',
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        on_behalf_of: AGENT_EMAIL,
        article: emailArticle({ content_type: 'text/html' }),
      });

      const body = (await firstArticle(created.ticket.id)).body;
      assert.ok(body.includes(`${agent.firstname} ${agent.lastname}`), body);
      assert.ok(!body.includes(`${me.firstname} ${me.lastname}`), 'it signed as the credential owner');
    });

    it('reports the closing it added', async (t) => {
      if (!ready) return t.skip(skipReason);

      const me = await api<Json>('/api/v1/users/me');
      const created = await callTool('zammad_create_ticket', {
        title: 'Signature reported',
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ content_type: 'text/html' }),
      });

      // A doubled sign-off can only be prevented by the caller, so what was
      // appended has to be visible rather than guessed at.
      assert.ok(
        created.signature.appended_text.includes(`${me.firstname} ${me.lastname}`),
        created.signature.appended_text,
      );
      assert.ok(!created.signature.appended_text.includes('<'), 'the preview should be plain text');
    });

    it('previews the same text it later writes', async (t) => {
      if (!ready) return t.skip(skipReason);

      // The preview exists so a caller can decide whether the body still needs a
      // closing. If it ever diverged from what is actually appended it would be
      // worse than nothing, so the two are compared against a real instance.
      const preview = await callTool('zammad_get_group_signature', { group: 'Users' });
      assert.equal(preview.has_signature, true);

      const created = await callTool('zammad_create_ticket', {
        title: 'Preview parity',
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ content_type: 'text/html' }),
      });

      const body = (await firstArticle(created.ticket.id)).body;
      assert.equal(body, `Opened by the integration suite.<br><br>${preview.html}`);
      assert.equal(created.signature.appended_text, preview.text);
    });

    it('previews a reply against the ticket it would go on', async (t) => {
      if (!ready) return t.skip(skipReason);

      const ticket = await callTool('zammad_create_ticket', {
        title: 'Preview from ticket',
        group: 'Escalations',
        customer: CUSTOMER_EMAIL,
        article: { body: 'Opened by the integration suite.', type: 'note', internal: false },
      });

      const preview = await callTool('zammad_get_group_signature', { ticket_id: ticket.ticket.id });

      assert.equal(preview.group, 'Escalations');
      // The seeded signature carries ticket placeholders, which is what makes a
      // ticket-scoped preview different from a bare group one.
      assert.ok(preview.text.includes(ticket.ticket.number), preview.text);
      assert.ok(preview.text.includes('Preview from ticket'), preview.text);
      assert.equal(preview.note, undefined, 'nothing was left unresolved, so there is no caveat');
    });

    it('reports the groups that sign nothing', async (t) => {
      if (!ready) return t.skip(skipReason);

      for (const group of ['Unsigned', 'Retired']) {
        const preview = await callTool('zammad_get_group_signature', { group });
        assert.equal(preview.has_signature, false, group);
        assert.equal(preview.text, undefined, group);
      }
    });

    it('offers the flag as enabled by default wherever an article is written', async (t) => {
      if (!ready) return t.skip(skipReason);

      const tools = await listTools();
      const schemaFor = (name: string) => tools.find((tool: Json) => tool.name === name)?.inputSchema as Json;

      assert.equal(
        schemaFor('zammad_create_ticket').properties.article.properties.append_signature.default,
        true,
      );
      assert.equal(
        schemaFor('zammad_update_ticket').properties.article.properties.append_signature.default,
        true,
      );
      assert.equal(schemaFor('zammad_create_article').properties.append_signature.default, true);
    });
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
