import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { callTool, type Json, skipReason, startHarness, stopHarness } from './harness.js';
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

  it('leaves a body without @@ exactly as written', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('No mention');
    const result = await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: 'Plain note, nothing to resolve.',
      internal: true,
    });

    const stored = await api<Json>(`/api/v1/ticket_articles/${result.article.id}`);
    assert.equal(stored.body, 'Plain note, nothing to resolve.');
    assert.equal(stored.content_type, 'text/plain', 'nothing was linked, so nothing forced HTML');
    assert.equal(result.mentioned, undefined);
    assert.deepEqual(await mentionsFor(ticket.id), []);
  });

  it('keeps an unresolvable @@token as text instead of failing', async (t) => {
    if (!ready) return t.skip(skipReason);

    const ticket = await createTicket('Unknown mention');
    const result = await callTool('zammad_create_article', {
      ticket_id: ticket.id,
      body: '@@nobody@example.invalid should stay literal',
      internal: true,
    });

    const stored = await api<Json>(`/api/v1/ticket_articles/${result.article.id}`);
    assert.ok(stored.body.includes('@@nobody@example.invalid'), stored.body);
    assert.deepEqual(await mentionsFor(ticket.id), []);
  });
});
