import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  callTool,
  callToolExpectingError,
  type Json,
  skipReason,
  startHarness,
  stopHarness,
} from './harness.js';
import {
  api,
  CUSTOMER_EMAIL,
  createTicket,
  mentionsFor,
  notificationsFor,
  type SeededAgent,
  seededAgent,
  waitForMention,
} from './zammad.js';

/**
 * The @@ rewrite against a real Zammad.
 *
 * The unit tests prove the markup we generate is what we intended. Only this
 * proves the part we do not control: that Zammad reads that markup back and
 * turns it into a mention. The whole feature rests on a callback in Zammad's
 * source, so asserting it here is the difference between believing that and
 * knowing it.
 */

let ready = false;
let agent: SeededAgent;

before(async () => {
  ready = await startHarness();
  if (!ready) return;
  agent = await seededAgent();
});

after(stopHarness);

describe('@@ mentions against a real Zammad', () => {
  it('records a mention Zammad recognises', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('Mention integration');
    const result = await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: `@@${agent.email} can you take a look?`,
      internal: true,
    });

    assert.deepEqual(
      result.mentioned?.map((user: Json) => user.id),
      [agent.id],
      'the tool should report who it linked',
    );

    const stored = await api<Json>(`/api/v1/ticket_articles/${result.article.id}`);
    assert.equal(stored.content_type, 'text/html', 'the anchor cannot survive as text/plain');
    assert.match(stored.body, new RegExp(`data-mention-user-id="${agent.id}"`));
    assert.ok(!stored.body.includes('@@'), `the shorthand should be gone: ${stored.body}`);

    // The point of the whole exercise: Zammad turned our markup into a mention.
    const mentions = await waitForMention(ticket.id, agent.id);
    assert.ok(
      mentions.some((mention) => mention.user_id === agent.id),
      `Zammad recorded no mention for user ${agent.id}: ${JSON.stringify(mentions)}`,
    );
  });

  it('records a mention written into the first article of a new ticket', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The same body can arrive through zammad_create_ticket, which builds its
    // own payload. That path was silently skipping the rewrite until #8, so it
    // is asserted separately rather than assumed to follow from create_article.
    const result = await callTool('zammad_create_ticket', {
      title: 'Mention on create',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: { body: `@@${agent.email} please take a look`, internal: true },
    });

    assert.deepEqual(result.mentioned, [{ id: agent.id, name: `${agent.firstname} ${agent.lastname}` }]);

    const mentions = await waitForMention(result.ticket.id, agent.id);
    assert.ok(
      mentions.some((mention) => mention.user_id === agent.id),
      'Zammad recorded no mention for a ticket created with one',
    );
  });

  it('notifies the mentioned user', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('Mention notification');
    await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: `@@${agent.email} please review`,
      internal: true,
    });

    // Written by the scheduler rather than in-request, so give it a moment.
    let notifications: Json[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      notifications = await notificationsFor(agent.email);
      if (notifications.some((n) => n.o_id === ticket.id && n.user_id === agent.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    assert.ok(
      notifications.some((n) => n.o_id === ticket.id && n.user_id === agent.id),
      `no online notification reached ${agent.email}: ${JSON.stringify(notifications).slice(0, 300)}`,
    );
  });

  it('stores a body without @@ unchanged in content', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('No mention');
    const result = await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: 'Plain note, nothing to resolve.',
      internal: true,
    });

    // Every article is written as text/html (compose.ts); a single plain line
    // becomes the UI's own <span> wrap, and reads back as the text it was.
    const stored = await api<Json>(`/api/v1/ticket_articles/${result.article.id}`);
    assert.equal(stored.body, '<span>Plain note, nothing to resolve.</span>');
    assert.equal(stored.content_type, 'text/html');
    assert.equal(result.mentioned, undefined);
    assert.deepEqual(await mentionsFor(ticket.id), []);
  });

  it('refuses an unresolvable @@token rather than filing the article without it', async (t) => {
    if (!ready) return t.skip(skipReason);

    // check_mentions is create-only, so an article filed without its anchor can
    // never be given the mention afterwards. Refusing is the only way back.
    const ticket = await createTicket('Unknown mention');
    const message = await callToolExpectingError('zammad_create_article', {
      ticket_id: ticket.id,
      body: '@@nobody@example.invalid should not be filed',
      internal: true,
    });

    assert.match(message, /No agent is named "nobody@example.invalid"/);
    assert.deepEqual(await mentionsFor(ticket.id), []);
    const articles = await api<Json[]>(`/api/v1/ticket_articles/by_ticket/${ticket.id}`);
    assert.equal(articles.length, 1, `only the opening article should exist: ${JSON.stringify(articles)}`);
  });

  it('refuses a customer, whom Zammad would reject anyway', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Validations::MentionValidator refuses anyone without agent access, and
    // check_mentions_raises_error turns that into a 422 that loses the article.
    // Narrowing the search to ticket.agent is what keeps it from getting there.
    const ticket = await createTicket('Customer mention');
    const message = await callToolExpectingError('zammad_create_article', {
      ticket_id: ticket.id,
      body: `@@${CUSTOMER_EMAIL} cannot be mentioned`,
      internal: true,
    });

    assert.match(message, /No agent is named/);
    assert.deepEqual(await mentionsFor(ticket.id), []);
  });

  it('refuses a first name, which names nobody on its own', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Zammad's user search matches prefixes, so the first name does find the
    // agent — and taking that hit is how the wrong colleague gets mentioned.
    const ticket = await createTicket('First name mention');
    const message = await callToolExpectingError('zammad_create_article', {
      ticket_id: ticket.id,
      body: `@@${agent.firstname} please look`,
      internal: true,
    });

    assert.match(message, new RegExp(`No agent is named "${agent.firstname}"`));
    // The refusal has to say who it did find, or there is no way forward.
    assert.match(message, new RegExp(`${agent.firstname} ${agent.lastname}`));
    assert.deepEqual(await mentionsFor(ticket.id), []);
  });

  it('records a mention written as the whole name', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('Full name mention');
    const result = await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: `@@${agent.firstname} ${agent.lastname} please look`,
      internal: true,
    });

    assert.deepEqual(
      result.mentioned?.map((user: Json) => user.id),
      [agent.id],
    );

    const stored = await api<Json>(`/api/v1/ticket_articles/${result.article.id}`);
    // The name is the mention, not text left standing beside it.
    assert.ok(!stored.body.includes(`${agent.firstname} ${agent.lastname} ${agent.firstname}`), stored.body);
    assert.match(stored.body, new RegExp(`data-mention-user-id="${agent.id}"[^<]*>[^<]*</a> please look`));

    const mentions = await waitForMention(ticket.id, agent.id);
    assert.ok(mentions.some((mention) => mention.user_id === agent.id));
  });

  it('records a mention written as a numeric user id', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('Id mention');
    const result = await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: `@@${agent.id} please look`,
      internal: true,
    });

    assert.deepEqual(
      result.mentioned?.map((user: Json) => user.id),
      [agent.id],
    );

    const mentions = await waitForMention(ticket.id, agent.id);
    assert.ok(mentions.some((mention) => mention.user_id === agent.id));
  });
});
