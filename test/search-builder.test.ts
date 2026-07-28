import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Config, loadConfig } from '../src/core/config.js';
import type { ZammadClient } from '../src/core/zammad/client.js';
import { clearLookupCache, LookupService } from '../src/core/zammad/lookup.js';
import {
  buildOrganizationSearch,
  buildTicketSearch,
  buildUserSearch,
  dateConditions,
  parseRelativeSpan,
  stringConditions,
} from '../src/core/zammad/search/builder.js';
import * as L from '../src/core/zammad/search/lucene.js';
import {
  searchOrganizationsInputSchema,
  searchTicketsInputSchema,
  searchUsersInputSchema,
} from '../src/core/zammad/search/schema.js';
import { type Condition, type ConditionLeaf, isBlock } from '../src/core/zammad/selector.js';

const config: Config = loadConfig({
  ZAMMAD_URL: 'https://support.example.com',
  ZAMMAD_AUTH_MODE: 'token',
  ZAMMAD_API_TOKEN: 'test-token',
  ZAMMAD_OAUTH_MODE: 'disabled',
  METADATA_CACHE_TTL_SECONDS: '0',
} as NodeJS.ProcessEnv);

/** Minimal stand-in for ZammadClient — the builder only ever reads lookups. */
function fakeClient(): ZammadClient {
  const responses: Record<string, unknown> = {
    '/api/v1/ticket_states': [
      { id: 1, name: 'new', active: true, state_type_id: 1, state_type: 'new' },
      { id: 2, name: 'open', active: true, state_type_id: 2, state_type: 'open' },
      { id: 3, name: 'pending reminder', active: true, state_type_id: 3, state_type: 'pending reminder' },
      { id: 4, name: 'closed', active: true, state_type_id: 5, state_type: 'closed' },
      { id: 7, name: 'waiting for customer', active: true, state_type_id: 3, state_type: 'pending reminder' },
    ],
    '/api/v1/ticket_priorities': [
      { id: 1, name: '1 low', active: true },
      { id: 2, name: '2 normal', active: true },
      { id: 3, name: '3 high', active: true },
    ],
    '/api/v1/groups': [
      { id: 1, name: 'Users', active: true },
      { id: 2, name: '1st Level', active: true },
      { id: 3, name: 'Support::Escalations', active: true },
    ],
    '/api/v1/users/search': [
      { id: 42, login: 'jane', email: 'jane@acme.com', firstname: 'Jane', lastname: 'Doe' },
    ],
    '/api/v1/organizations/search': [{ id: 7, name: 'Acme Inc' }],
  };

  return {
    baseUrl: config.ZAMMAD_URL,
    fingerprint: 'test',
    get: async (path: string) => responses[path],
  } as unknown as ZammadClient;
}

function lookup(): LookupService {
  clearLookupCache();
  return new LookupService(fakeClient(), config);
}

function parse(input: unknown) {
  return searchTicketsInputSchema.parse(input);
}

/** Collect every leaf in a selector tree, for assertions. */
function leaves(condition: Condition | undefined): ConditionLeaf[] {
  if (!condition) return [];
  if (!isBlock(condition)) return [condition];
  return condition.conditions.flatMap(leaves);
}

function findLeaf(condition: Condition | undefined, name: string): ConditionLeaf | undefined {
  return leaves(condition).find((l) => l.name === name);
}

describe('parseRelativeSpan', () => {
  it('parses shorthand spans', () => {
    assert.deepEqual(parseRelativeSpan('7d'), { value: 7, unit: 'day' });
    assert.deepEqual(parseRelativeSpan('30m'), { value: 30, unit: 'minute' });
    assert.deepEqual(parseRelativeSpan('2 weeks'), { value: 2, unit: 'week' });
    assert.deepEqual(parseRelativeSpan('3 months'), { value: 3, unit: 'month' });
    assert.deepEqual(parseRelativeSpan('24h'), { value: 24, unit: 'hour' });
  });

  it('passes through the object form', () => {
    assert.deepEqual(parseRelativeSpan({ value: 5, unit: 'year' }), { value: 5, unit: 'year' });
  });

  it('rejects an unknown unit', () => {
    assert.throws(() => parseRelativeSpan('7 fortnights'), /Unknown time unit/);
  });
});

describe('dateConditions', () => {
  it('maps relative spans onto Zammad operators', () => {
    const [within] = dateConditions('ticket.created_at', { within_last: '7d' });
    assert.equal(within!.operator, 'within last (relative)');
    assert.equal(within!.value, 7);
    assert.equal(within!.range, 'day');
  });

  it('maps more_than_ago to "before (relative)"', () => {
    const [older] = dateConditions('ticket.updated_at', { more_than_ago: '30d' });
    assert.equal(older!.operator, 'before (relative)');
    assert.equal(older!.range, 'day');
  });

  it('emits a two-element array for "in range"', () => {
    const [range] = dateConditions('ticket.created_at', {
      between: { from: '2026-01-01', to: '2026-02-01' },
    });
    assert.equal(range!.operator, 'in range');
    assert.deepEqual(range!.value, ['2026-01-01', '2026-02-01']);
  });

  it('rejects an empty filter', () => {
    assert.throws(() => dateConditions('ticket.created_at', {}), /is empty/);
  });
});

describe('stringConditions', () => {
  it('treats a bare string as "contains"', () => {
    const [c] = stringConditions('ticket.title', 'printer');
    assert.equal(c!.operator, 'contains');
    assert.equal(c!.value, 'printer');
  });

  it('uses the plural operators for arrays', () => {
    const [c] = stringConditions('ticket.title', { is: ['a', 'b'] });
    assert.equal(c!.operator, 'is any of');
    assert.deepEqual(c!.value, ['a', 'b']);
  });

  it('uses the singular operator for a single value', () => {
    const [c] = stringConditions('ticket.title', { is: 'only' });
    assert.equal(c!.operator, 'is');
    assert.equal(c!.value, 'only');
  });
});

describe('top-level condition shape', () => {
  // Zammad's Selector::Base.migrate_selector treats a condition without a
  // `conditions` key as the legacy attribute-keyed form and does
  // `{name: 'name'}.merge('ticket.state_id')` — Hash#merge with a String raises,
  // and the API answers HTTP 500. A single-filter search is exactly the case
  // where `simplify` used to collapse the block down to a bare leaf.
  const isTopLevelBlock = (condition: Condition | undefined) => condition !== undefined && isBlock(condition);

  it('wraps a lone filter in a block instead of emitting a bare leaf', async () => {
    const built = await buildTicketSearch(parse({ state: ['open'] }), lookup());

    assert.ok(isTopLevelBlock(built.condition), 'top-level condition must be a block');
    const root = built.condition as { operator: string; conditions: unknown[] };
    assert.equal(root.operator, 'AND');
    assert.equal(root.conditions.length, 1);
    assert.deepEqual(findLeaf(built.condition, 'ticket.state_id')?.value, [2]);
  });

  it('wraps a lone exclusion too', async () => {
    const built = await buildTicketSearch(parse({ state_not: ['closed'] }), lookup());
    assert.ok(isTopLevelBlock(built.condition));
  });

  it('wraps a lone raw_condition leaf', async () => {
    const built = await buildTicketSearch(
      parse({ raw_condition: { name: 'ticket.foo', operator: 'is', value: 1 } }),
      lookup(),
    );
    assert.ok(isTopLevelBlock(built.condition));
  });

  it('wraps lone filters in the user and organization searches', async () => {
    const users = await buildUserSearch(searchUsersInputSchema.parse({ active: true }), lookup());
    assert.ok(isTopLevelBlock(users.condition));

    const orgs = await buildOrganizationSearch(searchOrganizationsInputSchema.parse({ name: 'Acme' }));
    assert.ok(isTopLevelBlock(orgs.condition));
  });
});

describe('buildTicketSearch — auto strategy', () => {
  it('routes free text to `query` and filters to `condition`', async () => {
    const built = await buildTicketSearch(parse({ text: 'printer offline', state: ['open'] }), lookup());

    // Free text only — no field syntax, so it degrades to a LIKE without Elasticsearch.
    assert.equal(built.query, 'printer* AND offline*');
    assert.ok(built.condition, 'expected a selector');
    assert.deepEqual(findLeaf(built.condition, 'ticket.state_id')?.value, [2]);
  });

  it('resolves state names, priority names and group names to IDs', async () => {
    const built = await buildTicketSearch(
      parse({ state: ['open', 'closed'], priority: ['3 high'], group: ['1st Level'] }),
      lookup(),
    );

    assert.deepEqual(findLeaf(built.condition, 'ticket.state_id')?.value, [2, 4]);
    assert.deepEqual(findLeaf(built.condition, 'ticket.priority_id')?.value, [3]);
    assert.deepEqual(findLeaf(built.condition, 'ticket.group_id')?.value, [2]);
  });

  it('accepts the leaf name of a nested group', async () => {
    const built = await buildTicketSearch(parse({ group: ['escalations'] }), lookup());
    assert.deepEqual(findLeaf(built.condition, 'ticket.group_id')?.value, [3]);
  });

  it('expands state_type into every matching state ID', async () => {
    const built = await buildTicketSearch(parse({ state_type: ['pending reminder'] }), lookup());
    // Both the stock state and the instance's custom one.
    assert.deepEqual(findLeaf(built.condition, 'ticket.state_id')?.value, [3, 7]);
  });

  it('lists valid options when a state name is wrong', async () => {
    await assert.rejects(
      () => buildTicketSearch(parse({ state: ['opened'] }), lookup()),
      /Unknown ticket state "opened".*open/s,
    );
  });

  it('maps owner "me" to the current_user pre-condition instead of a lookup', async () => {
    const built = await buildTicketSearch(parse({ owner: ['me'] }), lookup());
    const leaf = findLeaf(built.condition, 'ticket.owner_id');
    assert.equal(leaf?.pre_condition, 'current_user.id');
    assert.equal(leaf?.value, undefined);
  });

  it('resolves a user by email to an ID', async () => {
    const built = await buildTicketSearch(parse({ owner: ['jane@acme.com'] }), lookup());
    assert.deepEqual(findLeaf(built.condition, 'ticket.owner_id')?.value, [42]);
  });

  it('models "unassigned" with the not_set pre-condition', async () => {
    const built = await buildTicketSearch(parse({ unassigned: true }), lookup());
    const leaf = findLeaf(built.condition, 'ticket.owner_id');
    assert.equal(leaf?.pre_condition, 'not_set');
    assert.equal(leaf?.operator, 'is');
  });

  it('joins tag values with commas, as both selector backends require', async () => {
    const built = await buildTicketSearch(
      parse({ tags: { all: ['vip', 'billing'], none: ['spam'] } }),
      lookup(),
    );

    const all = leaves(built.condition).find((l) => l.operator === 'contains all');
    assert.equal(all?.value, 'vip,billing');
    assert.equal(typeof all?.value, 'string');

    const none = leaves(built.condition).find((l) => l.operator === 'contains one not');
    assert.equal(none?.value, 'spam');
  });

  it('keeps exclusions outside an "any" group so they always apply', async () => {
    const built = await buildTicketSearch(
      parse({ match: 'any', state: ['open'], priority: ['3 high'], state_not: ['closed'] }),
      lookup(),
    );

    assert.ok(built.condition && isBlock(built.condition));
    const root = built.condition;
    assert.equal(root.operator, 'AND', 'exclusions must be ANDed onto the OR group');

    const orBlock = root.conditions.find((c) => isBlock(c) && c.operator === 'OR');
    assert.ok(orBlock, 'expected the positive filters to be ORed');

    const exclusion = root.conditions.find((c) => !isBlock(c) && c.operator === 'is not');
    assert.ok(exclusion, 'expected the exclusion at the top level');
  });

  it('compiles escalated=true to escalation_at < now', async () => {
    const built = await buildTicketSearch(parse({ escalated: true }), lookup());
    const leaf = findLeaf(built.condition, 'ticket.escalation_at');
    assert.equal(leaf?.operator, 'before (relative)');
    assert.equal(leaf?.value, 0);
    assert.equal(leaf?.range, 'minute');
  });

  it('treats "not escalated" as unset OR in the future', async () => {
    const built = await buildTicketSearch(parse({ escalated: false }), lookup());
    const ops = leaves(built.condition).map((l) => l.operator);
    assert.ok(ops.includes('not set'));
    assert.ok(ops.includes('after (relative)'));
  });

  it('maps article type and sender names onto their seeded IDs', async () => {
    const built = await buildTicketSearch(
      parse({ article: { type: ['email', 'phone'], sender: ['Customer'] } }),
      lookup(),
    );
    assert.deepEqual(findLeaf(built.condition, 'article.type_id')?.value, [1, 5]);
    assert.deepEqual(findLeaf(built.condition, 'article.sender_id')?.value, [2]);
  });

  it("maps closed_at onto Zammad's close_at column", async () => {
    const built = await buildTicketSearch(parse({ closed_at: { within_last: '7d' } }), lookup());
    assert.ok(findLeaf(built.condition, 'ticket.close_at'));
  });

  it('merges a raw_condition into the generated selector', async () => {
    const built = await buildTicketSearch(
      parse({
        state: ['open'],
        raw_condition: { name: 'ticket.custom_flag', operator: 'is', value: true },
      }),
      lookup(),
    );
    assert.equal(findLeaf(built.condition, 'ticket.custom_flag')?.value, true);
  });

  it('pads order_by to match sort_by', async () => {
    const built = await buildTicketSearch(
      parse({ state: ['open'], sort_by: ['priority_id', 'created_at'], order_by: 'desc' }),
      lookup(),
    );
    assert.deepEqual(built.sort_by, ['priority_id', 'created_at']);
    assert.deepEqual(built.order_by, ['desc', 'desc']);
  });

  it('refuses a search with no criteria at all', async () => {
    await assert.rejects(() => buildTicketSearch(parse({}), lookup()), /no criteria/);
  });
});

describe('buildTicketSearch — structured strategy', () => {
  it("emits no query, forcing Zammad's database search", async () => {
    const built = await buildTicketSearch(parse({ strategy: 'structured', state: ['open'] }), lookup());
    assert.equal(built.query, undefined);
    assert.ok(built.condition);
  });

  it('rejects free text, which it cannot honour', async () => {
    await assert.rejects(
      () => buildTicketSearch(parse({ strategy: 'structured', text: 'printer' }), lookup()),
      /does not send a text query/,
    );
  });
});

describe('buildTicketSearch — fulltext strategy', () => {
  it('compiles filters into a single query_string', async () => {
    const built = await buildTicketSearch(
      parse({ strategy: 'fulltext', text: 'printer', state: ['open'], group: ['1st Level'] }),
      lookup(),
    );

    assert.ok(built.query);
    assert.match(built.query!, /printer\*/);
    assert.match(built.query!, /state\.name:open/);
    // A value containing a space must be quoted.
    assert.match(built.query!, /group\.name:"1st Level"/);
  });

  it('negates excluded values with NOT', async () => {
    const built = await buildTicketSearch(
      parse({ strategy: 'fulltext', text: 'x', state_not: ['closed'] }),
      lookup(),
    );
    assert.match(built.query!, /NOT .*state\.name:closed/);
  });

  it('turns date filters into Elasticsearch date math', async () => {
    const built = await buildTicketSearch(
      parse({ strategy: 'fulltext', text: 'x', created_at: { within_last: '7d' } }),
      lookup(),
    );
    assert.match(built.query!, /created_at:\[now-7d TO now\]/);
  });

  it('uses AND between multi-valued tag requirements', async () => {
    const built = await buildTicketSearch(
      parse({ strategy: 'fulltext', text: 'x', tags: { all: ['vip', 'billing'] } }),
      lookup(),
    );
    assert.match(built.query!, /tags:\(vip AND billing\)/);
  });
});

describe('lucene helpers', () => {
  it('escapes Lucene syntax in free text', () => {
    assert.equal(L.escapeTerm('a+b'), 'a\\+b');
    assert.equal(L.escapeTerm('C:\\temp'), 'C\\:\\\\temp');
  });

  it('quotes values containing whitespace', () => {
    assert.equal(L.renderValue('1st Level'), '"1st Level"');
    assert.equal(L.renderValue('simple'), 'simple');
    assert.equal(L.renderValue(42), '42');
  });

  it('passes an already-Lucene query through untouched', () => {
    assert.equal(L.freeText('title:foo OR title:bar'), 'title:foo OR title:bar');
  });

  it('adds a prefix wildcard to bare words only', () => {
    assert.equal(L.freeText('printer offline', { prefixWildcard: true }), 'printer* AND offline*');
  });

  it('builds open-ended ranges', () => {
    assert.equal(L.range('created_at', 'now-1d', undefined), 'created_at:[now-1d TO *]');
  });

  it('parenthesises compound clauses when combining', () => {
    assert.equal(L.combine('AND', ['a:1 OR a:2', 'b:3']), '(a:1 OR a:2) AND b:3');
  });
});
