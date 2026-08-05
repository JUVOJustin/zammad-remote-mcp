import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { callTool, type Json, skipReason, startHarness, stopHarness } from './harness.js';
import { AGENT_EMAIL, api, waitForIndex } from './zammad.js';

/**
 * The search builder against a real Zammad.
 *
 * `search-builder.test.ts` proves we emit the selector we intended. It cannot
 * prove Zammad agrees: an operator we spell slightly wrong, or a field that
 * does not exist on the ticket object, produces a selector that looks perfect
 * in a unit test and returns nothing — or everything — in production. Only a
 * real instance answers that, which is why these cases assert on returned
 * tickets rather than on the generated condition.
 */

let ready = false;

interface Fixture {
  open: number;
  closed: number;
  highPriority: number;
  tagged: number;
  mine: number;
}

const fixture: Fixture = { open: 0, closed: 0, highPriority: 0, tagged: 0, mine: 0 };
const MARKER = 'zqxjmarker';

/**
 * Derived from the ticket it is put on, so a second run against a surviving
 * instance gets its own tag.
 *
 * The alternative was to loosen the assertion to "contains", which would stop
 * it from catching a tag filter that matches too much — the failure worth
 * catching here.
 */
let tag = '';

async function seedTicket(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const ticket = await api<{ id: number }>('/api/v1/tickets', {
    method: 'POST',
    body: {
      title,
      group: 'Users',
      customer: 'customer@example.test',
      article: { subject: title, body: `${title} ${MARKER}`, type: 'note', internal: false },
      ...extra,
    },
  });
  return ticket.id;
}

before(async () => {
  ready = await startHarness();
  if (!ready) return;

  const agent = (await api<Json[]>(`/api/v1/users/search?query=${AGENT_EMAIL}&limit=1`))[0];

  fixture.open = await seedTicket('Search fixture open', { state: 'open' });
  fixture.closed = await seedTicket('Search fixture closed', { state: 'closed' });
  fixture.highPriority = await seedTicket('Search fixture urgent', { state: 'open', priority: '3 high' });
  fixture.tagged = await seedTicket('Search fixture tagged', { state: 'open' });
  fixture.mine = await seedTicket('Search fixture owned', { state: 'open', owner_id: agent.id });

  tag = `integration-search-${fixture.tagged}`;
  await api(`/api/v1/tags/add?object=Ticket&o_id=${fixture.tagged}&item=${tag}`, { method: 'POST' });

  // A no-op against the database, but the fulltext cases would race the
  // indexer the moment this stack gains Elasticsearch again.
  await waitForIndex(MARKER, 5);
});

after(stopHarness);

describe('ticket search against a real Zammad', () => {
  it('filters by state', async (t) => {
    if (!ready) return t.skip(skipReason);

    const open = await callTool('zammad_search_tickets', { state: ['open'], per_page: 100 });
    const ids = open.tickets.map((ticket: Json) => ticket.id);

    assert.ok(ids.includes(fixture.open), 'the open fixture should be found');
    assert.ok(!ids.includes(fixture.closed), 'a closed ticket must not match state:open');
    // Every row Zammad returned really is open — a selector that silently
    // matched everything would still contain the fixture.
    assert.ok(open.tickets.every((ticket: Json) => ticket.state === 'open'));
  });

  it('excludes with state_not', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', { state_not: ['closed'], per_page: 100 });
    const ids = result.tickets.map((ticket: Json) => ticket.id);

    assert.ok(ids.includes(fixture.open));
    assert.ok(!ids.includes(fixture.closed));
  });

  it('filters by priority', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', { priority: ['3 high'], per_page: 100 });
    const ids = result.tickets.map((ticket: Json) => ticket.id);

    assert.ok(ids.includes(fixture.highPriority));
    assert.ok(!ids.includes(fixture.open), 'a normal-priority ticket must not match');
  });

  it('resolves an owner by email', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', { owner: [AGENT_EMAIL], per_page: 100 });
    const ids = result.tickets.map((ticket: Json) => ticket.id);

    assert.ok(ids.includes(fixture.mine), 'owner should resolve from an email address');
    assert.ok(!ids.includes(fixture.open));
  });

  it('resolves "me" to the authenticated user', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Nothing is owned by the admin, so this must come back empty rather than
    // falling back to "no filter" and returning the whole instance.
    const result = await callTool('zammad_search_tickets', { owner: ['me'], output: 'count' });
    assert.equal(typeof result.total_count, 'number');
    assert.ok(result.total_count < 5, `"me" looks unfiltered: ${result.total_count}`);
  });

  it('filters by tag', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', { tags: { any: [tag] }, per_page: 100 });
    const ids = result.tickets.map((ticket: Json) => ticket.id);

    assert.deepEqual(ids, [fixture.tagged], `only this run's fixture carries ${tag}`);
  });

  it('combines filters with AND', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', {
      state: ['open'],
      priority: ['3 high'],
      per_page: 100,
    });
    const ids = result.tickets.map((ticket: Json) => ticket.id);

    assert.ok(ids.includes(fixture.highPriority));
    assert.ok(!ids.includes(fixture.open), 'open alone is not enough');
  });

  it('matches article content', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', {
      article: { body: { contains: MARKER } },
      output: 'count',
    });

    assert.ok(result.total_count >= 5, `article body search found ${result.total_count}`);
  });

  it('runs the fulltext strategy end to end', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', {
      strategy: 'fulltext',
      text: MARKER,
      per_page: 100,
    });

    assert.equal(result.search.strategy, 'fulltext');
    const ids = result.tickets.map((ticket: Json) => ticket.id);
    assert.ok(ids.includes(fixture.open), `fulltext missed the fixtures: ${JSON.stringify(ids)}`);

    // This stack runs without Elasticsearch, so Zammad answered from the
    // database. What is proven is that the strategy is selected and the query
    // reaches Zammad intact — not that Elasticsearch parses it the same way.
  });

  it('counts without returning rows', async (t) => {
    if (!ready) return t.skip(skipReason);

    const count = await callTool('zammad_search_tickets', { state: ['open'], output: 'count' });

    assert.equal(typeof count.total_count, 'number');
    assert.equal(count.tickets, undefined, 'output:count should not carry rows');
  });

  it('pages through results', async (t) => {
    if (!ready) return t.skip(skipReason);

    const first = await callTool('zammad_search_tickets', {
      state: ['open'],
      per_page: 2,
      page: 1,
      sort_by: 'created_at',
      order_by: 'asc',
    });
    const second = await callTool('zammad_search_tickets', {
      state: ['open'],
      per_page: 2,
      page: 2,
      sort_by: 'created_at',
      order_by: 'asc',
    });

    assert.equal(first.tickets.length, 2);
    const overlap = first.tickets
      .map((ticket: Json) => ticket.id)
      .filter((id: number) => second.tickets.some((ticket: Json) => ticket.id === id));
    assert.deepEqual(overlap, [], 'pages must not repeat rows');
  });

  it('reports the selector it generated', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', { state: ['open'], output: 'count' });

    // The echo is what makes a surprising result diagnosable, so it has to
    // describe the query that actually ran.
    assert.ok(result.search.condition, 'no condition echoed');
    assert.match(JSON.stringify(result.search.condition), /ticket\.state_id/);
    assert.match(result.search.explanation, /state_id/);
  });

  it('rejects an unknown state with the valid options', async (t) => {
    if (!ready) return t.skip(skipReason);

    let message = '';
    try {
      await callTool('zammad_search_tickets', { state: ['definitely-not-a-state'], output: 'count' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.ok(message, 'an unknown state should not pass silently');
    assert.match(message, /open|closed|new/, `the error should list what is valid: ${message}`);
  });
});
