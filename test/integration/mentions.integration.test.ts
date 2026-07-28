import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/core/app.js';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/util/logger.js';
import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  api,
  BASE_URL,
  createTicket,
  isReachable,
  mentionsFor,
  notificationsFor,
  type SeededAgent,
  seededAgent,
} from './zammad.js';

/**
 * The @@ rewrite against a real Zammad.
 *
 * The unit tests prove the markup we generate is what we intended. Only this
 * proves the part we do not control: that Zammad reads that markup back and
 * turns it into a mention. The whole feature rests on a callback in Zammad's
 * source, so asserting it here is the difference between believing that and
 * knowing it.
 *
 * Start the instance with ./up.sh. Without one the suite skips rather than
 * fails — a missing Docker daemon is not a broken build.
 */

/** MCP envelopes are checked field by field, so a loose type is the honest one here. */
// biome-ignore lint/suspicious/noExplicitAny: see above
type Json = any;

let appServer: ReturnType<typeof serve>;
let appPort = 0;
let available = false;
let agent: SeededAgent;

async function callTool(name: string, args: unknown): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${appPort}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const text = await response.text();
  const line = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim()
    : text;
  const body = JSON.parse(line ?? '{}');
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);

  const content = body.result?.content?.[0]?.text;
  assert.ok(content, `${name} returned no content: ${JSON.stringify(body).slice(0, 300)}`);
  return JSON.parse(content);
}

before(async () => {
  available = await isReachable();
  if (!available) return;

  agent = await seededAgent();

  const config = loadConfig({
    ZAMMAD_URL: BASE_URL,
    ZAMMAD_AUTH_MODE: 'basic',
    ZAMMAD_USERNAME: ADMIN_LOGIN,
    ZAMMAD_PASSWORD: ADMIN_PASSWORD,
    LOG_LEVEL: 'silent',
    METADATA_CACHE_TTL_SECONDS: '0',
  } as NodeJS.ProcessEnv);

  const app = createApp(config, createLogger('silent'));
  await new Promise<void>((resolve) => {
    appServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      appPort = info.port;
      resolve();
    });
  });
});

after(async () => {
  if (appServer) await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe('@@ mentions against a real Zammad', () => {
  it('records a mention Zammad recognises', async (t) => {
    if (!available) return t.skip(`no Zammad on ${BASE_URL} — run test/integration/up.sh`);

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
    const mentions = await mentionsFor(ticket.id);
    assert.ok(
      mentions.some((mention) => mention.user_id === agent.id),
      `Zammad recorded no mention for user ${agent.id}: ${JSON.stringify(mentions)}`,
    );
  });

  it('notifies the mentioned user', async (t) => {
    if (!available) return t.skip(`no Zammad on ${BASE_URL}`);

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
    if (!available) return t.skip(`no Zammad on ${BASE_URL}`);

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
    if (!available) return t.skip(`no Zammad on ${BASE_URL}`);

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
