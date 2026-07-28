import { ToolInputError } from '../../util/errors.js';
import type { LookupService } from '../lookup.js';
import {
  and,
  asTopLevel,
  type Condition,
  type ConditionLeaf,
  explainCondition,
  joinedValues,
  leaf,
  or,
  type RelativeRange,
  simplify,
} from '../selector.js';
import * as L from './lucene.js';
import type {
  DateFilter,
  RelativeSpan,
  SearchOrganizationsInput,
  SearchTicketsInput,
  SearchUsersInput,
  StringFilter,
} from './schema.js';

/**
 * Translates the structured tool input into what Zammad's search endpoint wants.
 *
 * Two facts from Zammad's `CanSearch#search` drive the whole design:
 *
 *  1. Zammad only routes to Elasticsearch when the `query` parameter is
 *     non-blank. With a blank `query` it always runs the SQL search — even when
 *     Elasticsearch is installed.
 *  2. The `condition` selector is honoured on *both* paths (`Selector::Sql` for
 *     SQL, `Selector::SearchIndex` via `build_query` for Elasticsearch).
 *
 * So structured filters belong in `condition`, where they are exact and behave
 * identically either way, and only genuine free text belongs in `query`, where
 * it degrades gracefully to a LIKE over title/number/article fields when there
 * is no Elasticsearch. That is the `auto` strategy, and it is why this server
 * does not need to know whether Elasticsearch is installed.
 */

export interface BuiltSearch {
  /** The `query` parameter — free text, or a full query_string in `fulltext` mode. */
  query?: string;
  /** The `condition` selector. */
  condition?: Condition;
  sort_by?: string[];
  order_by?: string[];
  /** Human-readable trace, returned to the caller when `explain` is set. */
  explanation: string[];
}

// -------------------------------------------------------------------- helpers

const SPAN_UNITS: Record<string, RelativeRange> = {
  m: 'minute',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
  w: 'week',
  wk: 'week',
  week: 'week',
  weeks: 'week',
  mo: 'month',
  month: 'month',
  months: 'month',
  y: 'year',
  yr: 'year',
  year: 'year',
  years: 'year',
};

export function parseRelativeSpan(span: RelativeSpan): { value: number; unit: RelativeRange } {
  if (typeof span !== 'string') return span;

  const match = /^\s*(\d+)\s*([a-z]+)\s*$/i.exec(span);
  if (!match)
    throw new ToolInputError(`Cannot parse time span "${span}". Use e.g. "30m", "24h", "7d", "2 weeks".`);

  const unit = SPAN_UNITS[match[2]!.toLowerCase()];
  if (!unit) throw new ToolInputError(`Unknown time unit "${match[2]}" in "${span}".`);

  return { value: Number(match[1]), unit };
}

/** Elasticsearch date-math suffix for a relative unit. */
const DATE_MATH: Record<RelativeRange, string> = {
  minute: 'm',
  hour: 'h',
  day: 'd',
  week: 'w',
  month: 'M',
  year: 'y',
};

function normalizeStringFilter(filter: StringFilter): Exclude<StringFilter, string> {
  return typeof filter === 'string' ? { contains: filter } : filter;
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

// ------------------------------------------------------------ selector builders

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Validates an absolute timestamp here rather than in the schema.
 *
 * A `pattern` in the published schema makes strict MCP clients drop the whole
 * tool, so the check lives at the point of use — where a bad value yields a
 * message the model can correct.
 */
function assertTimestamp(field: string, value: string): string {
  if (!ISO_TIMESTAMP.test(value.trim())) {
    throw new ToolInputError(
      `"${value}" is not a valid timestamp for ${field}. Use an ISO-8601 date ("2026-01-31") ` +
        'or timestamp ("2026-01-31T09:00:00Z").',
    );
  }
  return value;
}

export function dateConditions(field: string, filter: DateFilter): ConditionLeaf[] {
  const conditions: ConditionLeaf[] = [];

  if (filter.after) conditions.push(leaf(field, 'after (absolute)', assertTimestamp(field, filter.after)));
  if (filter.before) conditions.push(leaf(field, 'before (absolute)', assertTimestamp(field, filter.before)));
  if (filter.between) {
    conditions.push(
      leaf(field, 'in range', [
        assertTimestamp(field, filter.between.from),
        assertTimestamp(field, filter.between.to),
      ]),
    );
  }

  if (filter.within_last) {
    const { value, unit } = parseRelativeSpan(filter.within_last);
    conditions.push(leaf(field, 'within last (relative)', value, { range: unit }));
  }
  if (filter.within_next) {
    const { value, unit } = parseRelativeSpan(filter.within_next);
    conditions.push(leaf(field, 'within next (relative)', value, { range: unit }));
  }
  if (filter.more_than_ago) {
    const { value, unit } = parseRelativeSpan(filter.more_than_ago);
    // `before (relative)` compiles to `< now-<n><unit>` — i.e. older than.
    conditions.push(leaf(field, 'before (relative)', value, { range: unit }));
  }
  if (filter.today) conditions.push(leaf(field, 'today'));
  if (filter.is_set !== undefined) conditions.push(leaf(field, filter.is_set ? 'is set' : 'not set'));

  if (conditions.length === 0) {
    throw new ToolInputError(
      `Date filter on "${field}" is empty — provide at least one of after/before/between/within_last/within_next/more_than_ago/today/is_set.`,
    );
  }
  return conditions;
}

export function stringConditions(field: string, raw: StringFilter): ConditionLeaf[] {
  const filter = normalizeStringFilter(raw);
  const conditions: ConditionLeaf[] = [];

  if (filter.is !== undefined) {
    const values = asArray(filter.is);
    conditions.push(values.length > 1 ? leaf(field, 'is any of', values) : leaf(field, 'is', values[0]));
  }
  if (filter.is_not !== undefined) {
    const values = asArray(filter.is_not);
    conditions.push(values.length > 1 ? leaf(field, 'is none of', values) : leaf(field, 'is not', values[0]));
  }
  if (filter.contains !== undefined) conditions.push(leaf(field, 'contains', filter.contains));
  if (filter.contains_not !== undefined) conditions.push(leaf(field, 'contains not', filter.contains_not));
  if (filter.starts_with !== undefined)
    conditions.push(leaf(field, 'starts with one of', asArray(filter.starts_with)));
  if (filter.ends_with !== undefined)
    conditions.push(leaf(field, 'ends with one of', asArray(filter.ends_with)));
  if (conditions.length === 0) {
    throw new ToolInputError(
      `Text filter on "${field}" is empty — provide at least one of is/is_not/contains/contains_not/starts_with/ends_with. ` +
        'Regular expressions and is-set checks are available through `custom`.',
    );
  }
  return conditions;
}

/**
 * Article types and senders are seeded in Zammad with explicit, fixed primary
 * keys (`db/seeds/ticket_article_types.rb`, `..._senders.rb`), so they can be
 * mapped without a lookup round trip.
 */
const ARTICLE_TYPE_IDS: Record<string, number> = {
  email: 1,
  sms: 2,
  chat: 3,
  fax: 4,
  phone: 5,
  'twitter status': 6,
  'twitter direct-message': 7,
  'facebook feed post': 8,
  'facebook feed comment': 9,
  note: 10,
  web: 11,
  'telegram personal-message': 12,
  'facebook direct-message': 13,
  'whatsapp message': 14,
};

const ARTICLE_SENDER_IDS: Record<string, number> = { Agent: 1, Customer: 2, System: 3 };

/**
 * Date filters, in one place. `selector` is the path used in a Zammad selector,
 * `column` the underlying column, which is also the Elasticsearch field name.
 * Note `closed_at` is exposed under the name agents know while Zammad's column
 * is `close_at`.
 */
const TICKET_DATE_FIELDS = [
  { input: 'created_at', column: 'created_at' },
  { input: 'updated_at', column: 'updated_at' },
  { input: 'closed_at', column: 'close_at' },
  { input: 'pending_time', column: 'pending_time' },
  { input: 'escalation_at', column: 'escalation_at' },
  { input: 'last_contact_at', column: 'last_contact_at' },
] as const satisfies ReadonlyArray<{ input: keyof SearchTicketsInput; column: string }>;

/** Article sub-filters that are plain text matches, and their selector paths. */
const ARTICLE_TEXT_FIELDS = ['body', 'subject', 'from'] as const;

// -------------------------------------------------------------- ticket search

/**
 * Accumulates the pieces of a selector.
 *
 * Positive filters are joined by the caller's `match` operator (AND or OR);
 * exclusions are always ANDed on top, because "any of these states, but never a
 * closed one" would otherwise be satisfied by the closed state itself.
 */
class FilterCollector {
  readonly filters: Condition[] = [];
  readonly exclusions: Condition[] = [];
  readonly explanation: string[] = [];

  add(condition: Condition | undefined, note: string): void {
    if (!condition) return;
    this.filters.push(condition);
    this.explanation.push(note);
  }

  exclude(condition: Condition | undefined, note: string): void {
    if (!condition) return;
    this.exclusions.push(condition);
    this.explanation.push(note);
  }

  /** Join everything into the final selector. */
  build(match: 'all' | 'any'): Condition | undefined {
    const glue = match === 'any' ? or : and;
    const positive = this.filters.length ? glue(...this.filters) : undefined;
    return asTopLevel(simplify(and(positive, ...this.exclusions)));
  }
}

type Ref = string | number;
type RefResolver = (values: readonly Ref[]) => Promise<number[]>;

interface RefFilterSpec {
  /** Selector path, e.g. `ticket.owner_id`. */
  field: string;
  include?: readonly Ref[];
  exclude?: readonly Ref[];
  resolve: RefResolver;
  /** Already-resolved IDs to union into the include set (used by `state_type`). */
  extraIncludeIds?: readonly number[];
  /**
   * A magic token such as `me` or `mine` that maps onto a Zammad
   * `pre_condition` instead of a lookup — the selector then resolves it against
   * whoever is authenticated, which is both cheaper and more correct than
   * baking in an ID.
   */
  self?: { token: string; preCondition: string; note: string };
}

/**
 * The include/exclude/self pattern shared by every reference filter (state,
 * priority, group, owner, customer, organization, created_by, updated_by).
 */
async function applyRefFilter(collector: FilterCollector, spec: RefFilterSpec): Promise<void> {
  const isSelf = (value: Ref) => String(value).toLowerCase() === spec.self?.token;

  if (spec.include?.length || spec.extraIncludeIds?.length) {
    const requested = spec.include ?? [];
    if (spec.self && requested.some(isSelf)) {
      collector.add(
        leaf(spec.field, 'is', undefined, { pre_condition: spec.self.preCondition }),
        spec.self.note,
      );
    }

    const lookupValues = spec.self ? requested.filter((v) => !isSelf(v)) : requested;
    const ids = [
      ...(spec.extraIncludeIds ?? []),
      ...(lookupValues.length ? await spec.resolve(lookupValues) : []),
    ];
    const unique = [...new Set(ids)];
    if (unique.length) {
      collector.add(leaf(spec.field, 'is', unique), `${spec.field} in [${unique.join(', ')}]`);
    }
  }

  if (spec.exclude?.length) {
    const lookupValues = spec.self ? spec.exclude.filter((v) => !isSelf(v)) : spec.exclude;
    if (lookupValues.length) {
      const ids = await spec.resolve(lookupValues);
      if (ids.length) {
        collector.exclude(leaf(spec.field, 'is not', ids), `${spec.field} not in [${ids.join(', ')}]`);
      }
    }
  }
}

/** Ticket number and title. */
function applyIdentifiers(input: SearchTicketsInput, collector: FilterCollector): void {
  if (input.number) {
    const numbers = asArray(input.number);
    collector.add(
      numbers.length > 1
        ? leaf('ticket.number', 'is any of', numbers)
        : leaf('ticket.number', 'is', numbers[0]),
      `number is ${numbers.join(', ')}`,
    );
  }
  if (input.title) {
    collector.add(
      and(...stringConditions('ticket.title', input.title)),
      `title ${describeStringFilter(input.title)}`,
    );
  }
}

/** State, state type, priority and group — all name-to-ID lookups. */
async function applyClassification(
  input: SearchTicketsInput,
  lookup: LookupService,
  collector: FilterCollector,
): Promise<void> {
  await applyRefFilter(collector, {
    field: 'ticket.state_id',
    include: input.state,
    exclude: input.state_not,
    extraIncludeIds: input.state_type ? await lookup.resolveStateTypes(input.state_type) : undefined,
    resolve: (values) => lookup.resolveStates(values),
  });

  await applyRefFilter(collector, {
    field: 'ticket.priority_id',
    include: input.priority,
    exclude: input.priority_not,
    resolve: (values) => lookup.resolvePriorities(values),
  });

  await applyRefFilter(collector, {
    field: 'ticket.group_id',
    include: input.group,
    exclude: input.group_not,
    resolve: (values) => lookup.resolveGroups(values),
  });
}

/** Owner, customer, organization and the audit columns. */
async function applyPeople(
  input: SearchTicketsInput,
  lookup: LookupService,
  collector: FilterCollector,
): Promise<void> {
  if (input.unassigned !== undefined) {
    // Zammad models "nobody" as the system user (id 1); `not_set` is the
    // selector's portable spelling of that on both backends.
    collector.add(
      leaf('ticket.owner_id', input.unassigned ? 'is' : 'is not', undefined, { pre_condition: 'not_set' }),
      input.unassigned ? 'owner is not set' : 'owner is set',
    );
  }

  const resolveUsers: RefResolver = (values) => lookup.resolveUsers(values);

  await applyRefFilter(collector, {
    field: 'ticket.owner_id',
    include: input.owner,
    exclude: input.owner_not,
    resolve: resolveUsers,
    self: { token: 'me', preCondition: 'current_user.id', note: 'owner is the authenticated user' },
  });

  await applyRefFilter(collector, {
    field: 'ticket.customer_id',
    include: input.customer,
    exclude: input.customer_not,
    resolve: resolveUsers,
    self: { token: 'me', preCondition: 'current_user.id', note: 'customer is the authenticated user' },
  });

  await applyRefFilter(collector, {
    field: 'ticket.organization_id',
    include: input.organization,
    exclude: input.organization_not,
    resolve: (values) => lookup.resolveOrganizations(values),
    self: {
      token: 'mine',
      preCondition: 'current_user.organization_id',
      note: "organization is the authenticated user's organization",
    },
  });

  await applyRefFilter(collector, {
    field: 'ticket.created_by_id',
    include: input.created_by,
    resolve: resolveUsers,
    self: { token: 'me', preCondition: 'current_user.id', note: 'created by the authenticated user' },
  });

  await applyRefFilter(collector, {
    field: 'ticket.updated_by_id',
    include: input.updated_by,
    resolve: resolveUsers,
    self: { token: 'me', preCondition: 'current_user.id', note: 'last updated by the authenticated user' },
  });
}

function applyTags(input: SearchTicketsInput, collector: FilterCollector): void {
  const tags = input.tags;
  if (!tags) return;

  if (tags.all) {
    collector.add(
      leaf('ticket.tags', 'contains all', joinedValues(tags.all)),
      `has all tags: ${tags.all.join(', ')}`,
    );
  }
  if (tags.any) {
    collector.add(
      leaf('ticket.tags', 'contains one', joinedValues(tags.any)),
      `has any tag: ${tags.any.join(', ')}`,
    );
  }
  if (tags.none) {
    // `contains one not` negates "carries at least one of" → carries none.
    collector.exclude(
      leaf('ticket.tags', 'contains one not', joinedValues(tags.none)),
      `has none of the tags: ${tags.none.join(', ')}`,
    );
  }
}

/** Date ranges, escalation state and article counts. */
function applyTemporal(input: SearchTicketsInput, collector: FilterCollector): void {
  for (const { input: key, column } of TICKET_DATE_FIELDS) {
    const filter = input[key] as DateFilter | undefined;
    if (!filter) continue;
    const field = `ticket.${column}`;
    collector.add(and(...dateConditions(field, filter)), `${field} ${describeDateFilter(filter)}`);
  }

  if (input.escalated !== undefined) {
    collector.add(
      input.escalated
        ? // `before (relative)` with 0 compiles to `escalation_at < now`.
          leaf('ticket.escalation_at', 'before (relative)', 0, { range: 'minute' })
        : or(
            leaf('ticket.escalation_at', 'not set'),
            leaf('ticket.escalation_at', 'after (relative)', 0, { range: 'minute' }),
          ),
      input.escalated ? 'escalation deadline has passed' : 'not currently escalated',
    );
  }

  if (input.article_count) {
    const { min, max, equals } = input.article_count;
    const parts: ConditionLeaf[] = [];
    if (equals !== undefined) parts.push(leaf('ticket.article_count', 'is', equals));
    if (min !== undefined) parts.push(leaf('ticket.article_count', 'is greater than or equal to', min));
    if (max !== undefined) parts.push(leaf('ticket.article_count', 'is less than or equal to', max));
    if (parts.length === 0) throw new ToolInputError('article_count needs at least one of min/max/equals.');
    collector.add(and(...parts), `article_count ${JSON.stringify(input.article_count)}`);
  }
}

function applyArticleFilters(input: SearchTicketsInput, collector: FilterCollector): void {
  const article = input.article;
  if (!article) return;

  const parts: Condition[] = [];
  for (const field of ARTICLE_TEXT_FIELDS) {
    const filter = article[field];
    if (filter) parts.push(...stringConditions(`article.${field}`, filter));
  }

  if (article.type) {
    parts.push(leaf('article.type_id', 'is', mapIds(article.type, ARTICLE_TYPE_IDS)));
  }
  if (article.sender) {
    parts.push(leaf('article.sender_id', 'is', mapIds(article.sender, ARTICLE_SENDER_IDS)));
  }
  if (article.internal !== undefined) {
    parts.push(leaf('article.internal', 'is', article.internal));
  }

  if (parts.length === 0) throw new ToolInputError('The `article` filter is empty.');
  collector.add(and(...parts), `article matches ${Object.keys(article).join(', ')}`);
}

function mapIds(names: readonly string[], table: Record<string, number>): number[] {
  return names.map((name) => table[name]).filter((id): id is number => id !== undefined);
}

export async function buildTicketSearch(
  input: SearchTicketsInput,
  lookup: LookupService,
): Promise<BuiltSearch> {
  const collector = new FilterCollector();

  applyIdentifiers(input, collector);
  await applyClassification(input, lookup, collector);
  await applyPeople(input, lookup, collector);
  applyTags(input, collector);
  applyTemporal(input, collector);
  applyArticleFilters(input, collector);

  for (const custom of input.custom ?? []) {
    collector.add(custom as ConditionLeaf, `custom: ${custom.name} ${custom.operator}`);
  }
  if (input.raw_condition) collector.add(input.raw_condition, 'raw_condition merged');

  const condition = collector.build(input.match);
  const query = buildQueryString(input, collector.explanation);

  if (!query && !condition) {
    throw new ToolInputError(
      'The search has no criteria. Provide at least `text` or one filter — or call `zammad_list_tickets` to page through everything.',
    );
  }

  const sort = normalizeSort(input.sort_by, input.order_by);

  return {
    query,
    condition,
    sort_by: sort.sortBy,
    order_by: sort.orderBy,
    explanation: collector.explanation,
  };
}

/** Pick the `query` parameter according to the requested strategy. */
function buildQueryString(input: SearchTicketsInput, explanation: string[]): string | undefined {
  if (input.strategy === 'fulltext') return buildFulltextQuery(input, explanation);

  if (input.strategy === 'structured') {
    // Deliberately no `query`, which forces Zammad's exact database search
    // regardless of whether Elasticsearch is installed.
    if (input.text) {
      throw new ToolInputError(
        'strategy="structured" does not send a text query. Use strategy="auto" (default) to combine free text with filters, ' +
          'or move the text into `title`/`article.body` filters.',
      );
    }
    return undefined;
  }

  const text = input.text ? L.freeText(input.text, { prefixWildcard: true }) : undefined;
  if (text) explanation.push(`free-text query: ${text}`);
  if (input.raw_query) explanation.push(`raw_query merged: ${input.raw_query}`);
  return L.combine('AND', [text, input.raw_query]);
}

/**
 * `fulltext` mode: compile every filter into a single Elasticsearch
 * `query_string`. More expressive than the selector (wildcards, phrase
 * matching and nested article fields in one expression) but it only works when
 * the Zammad instance actually has Elasticsearch attached — without it Zammad
 * treats the whole string as a LIKE pattern and matches nothing useful.
 */
function buildFulltextQuery(input: SearchTicketsInput, explanation: string[]): string | undefined {
  const must: Array<string | undefined> = [
    input.text ? L.freeText(input.text, { prefixWildcard: true }) : undefined,
    input.number ? L.anyOf('number', asArray(input.number)) : undefined,
    input.title ? luceneStringClause('title', input.title) : undefined,
    ...fulltextRefClauses(input),
    ...fulltextDateClauses(input),
    fulltextArticleClause(input),
    input.raw_query,
  ];

  const mustNot: Array<string | undefined> = [
    input.state_not ? L.anyOf('state.name', input.state_not.map(String)) : undefined,
    input.priority_not ? L.anyOf('priority.name', input.priority_not.map(String)) : undefined,
    input.group_not ? L.anyOf('group.name', input.group_not.map(String)) : undefined,
    input.tags?.none ? L.anyOf('tags', input.tags.none) : undefined,
  ];

  const positive = L.combine(input.match === 'any' ? 'OR' : 'AND', must);
  const negative = mustNot
    .map((clause) => (clause ? L.negate(clause) : undefined))
    .filter((clause): clause is string => Boolean(clause));

  const query = L.combine('AND', [positive, ...negative]);
  if (query) explanation.push(`elasticsearch query_string: ${query}`);
  return query;
}

/** Association and tag clauses for the fulltext strategy. */
function fulltextRefClauses(input: SearchTicketsInput): Array<string | undefined> {
  const names = (values: readonly Ref[] | undefined) => values?.map(String);

  return [
    input.state ? L.anyOf('state.name', names(input.state)!) : undefined,
    input.priority ? L.anyOf('priority.name', names(input.priority)!) : undefined,
    input.group ? L.anyOf('group.name', names(input.group)!) : undefined,
    // Elasticsearch indexes the login and the email separately; match either.
    input.owner
      ? L.combine('OR', [
          L.anyOf('owner.login', names(input.owner)!),
          L.anyOf('owner.email', names(input.owner)!),
        ])
      : undefined,
    input.customer
      ? L.combine('OR', [
          L.anyOf('customer.login', names(input.customer)!),
          L.anyOf('customer.email', names(input.customer)!),
        ])
      : undefined,
    input.organization ? L.anyOf('organization.name', names(input.organization)!) : undefined,
    input.tags?.all ? L.allOf('tags', input.tags.all) : undefined,
    input.tags?.any ? L.anyOf('tags', input.tags.any) : undefined,
  ];
}

function fulltextDateClauses(input: SearchTicketsInput): Array<string | undefined> {
  const clauses = TICKET_DATE_FIELDS.map(({ input: key, column }) => {
    const filter = input[key] as DateFilter | undefined;
    return filter ? luceneDateClause(column, filter) : undefined;
  });

  if (input.escalated !== undefined) {
    clauses.push(
      input.escalated
        ? L.range('escalation_at', '*', 'now')
        : L.combine('OR', [L.negate(L.exists('escalation_at')), L.range('escalation_at', 'now', '*')]),
    );
  }
  return clauses;
}

function fulltextArticleClause(input: SearchTicketsInput): string | undefined {
  const article = input.article;
  if (!article) return undefined;

  const parts: Array<string | undefined> = ARTICLE_TEXT_FIELDS.map((field) => {
    const filter = article[field];
    return filter ? luceneStringClause(`article.${field}`, filter) : undefined;
  });

  if (article.type) parts.push(L.anyOf('article.type.name', article.type));
  if (article.sender) parts.push(L.anyOf('article.sender.name', article.sender));
  if (article.internal !== undefined) {
    parts.push(L.fieldClause('article.internal', String(article.internal)));
  }

  return L.combine('AND', parts);
}

function luceneStringClause(field: string, raw: StringFilter): string | undefined {
  const filter = normalizeStringFilter(raw);
  const clauses: Array<string | undefined> = [];

  if (filter.is !== undefined) clauses.push(L.anyOf(field, asArray(filter.is)));
  if (filter.is_not !== undefined) clauses.push(L.negate(L.anyOf(field, asArray(filter.is_not))));
  // Elasticsearch has no substring operator in query_string; a leading and
  // trailing wildcard is the closest equivalent (`analyze_wildcard` is on).
  if (filter.contains !== undefined)
    clauses.push(L.fieldClause(field, `*${L.escapeTerm(filter.contains)}*`, { allowWildcards: true }));
  if (filter.contains_not !== undefined)
    clauses.push(
      L.negate(L.fieldClause(field, `*${L.escapeTerm(filter.contains_not)}*`, { allowWildcards: true })),
    );
  if (filter.starts_with !== undefined) {
    clauses.push(
      L.combine(
        'OR',
        asArray(filter.starts_with).map((v) =>
          L.fieldClause(field, `${L.escapeTerm(v)}*`, { allowWildcards: true }),
        ),
      ),
    );
  }
  if (filter.ends_with !== undefined) {
    clauses.push(
      L.combine(
        'OR',
        asArray(filter.ends_with).map((v) =>
          L.fieldClause(field, `*${L.escapeTerm(v)}`, { allowWildcards: true }),
        ),
      ),
    );
  }

  return L.combine('AND', clauses);
}

function luceneDateClause(field: string, filter: DateFilter): string | undefined {
  const clauses: Array<string | undefined> = [];

  if (filter.after) clauses.push(L.range(field, filter.after, '*', { excludeLower: true }));
  if (filter.before) clauses.push(L.range(field, '*', filter.before, { excludeUpper: true }));
  if (filter.between) clauses.push(L.range(field, filter.between.from, filter.between.to));

  if (filter.within_last) {
    const { value, unit } = parseRelativeSpan(filter.within_last);
    clauses.push(L.range(field, `now-${value}${DATE_MATH[unit]}`, 'now'));
  }
  if (filter.within_next) {
    const { value, unit } = parseRelativeSpan(filter.within_next);
    clauses.push(L.range(field, 'now', `now+${value}${DATE_MATH[unit]}`));
  }
  if (filter.more_than_ago) {
    const { value, unit } = parseRelativeSpan(filter.more_than_ago);
    clauses.push(L.range(field, '*', `now-${value}${DATE_MATH[unit]}`, { excludeUpper: true }));
  }
  if (filter.today) clauses.push(L.range(field, 'now/d', 'now/d'));
  if (filter.is_set !== undefined) clauses.push(filter.is_set ? L.exists(field) : L.negate(L.exists(field)));

  return L.combine('AND', clauses);
}

function normalizeSort(
  sortBy: SearchTicketsInput['sort_by'],
  orderBy: SearchTicketsInput['order_by'],
): { sortBy?: string[]; orderBy?: string[] } {
  if (!sortBy) return {};
  const fields = asArray(sortBy);
  // Zammad zips sort_by and order_by positionally and drops any field whose
  // matching order is blank, so the arrays must be the same length.
  const orders = orderBy ? asArray(orderBy) : [];
  const normalized = fields.map((_, index) => orders[index] ?? orders[0] ?? 'desc');
  return { sortBy: fields, orderBy: normalized };
}

// ------------------------------------------------------- users / organizations

export async function buildUserSearch(input: SearchUsersInput, lookup: LookupService): Promise<BuiltSearch> {
  const explanation: string[] = [];
  const filters: Condition[] = [];

  if (input.email) filters.push(...stringConditions('user.email', input.email));
  if (input.login) filters.push(...stringConditions('user.login', input.login));
  if (input.firstname) filters.push(...stringConditions('user.firstname', input.firstname));
  if (input.lastname) filters.push(...stringConditions('user.lastname', input.lastname));
  if (input.active !== undefined) filters.push(leaf('user.active', 'is', input.active));
  if (input.vip !== undefined) filters.push(leaf('user.vip', 'is', input.vip));

  if (input.organization) {
    const ids = await lookup.resolveOrganizations(input.organization);
    filters.push(leaf('user.organization_id', 'is', ids));
    explanation.push(`organization_id in [${ids.join(', ')}]`);
  }
  if (input.role) {
    filters.push(leaf('user.role_ids', 'is', input.role));
    explanation.push(`roles: ${input.role.join(', ')}`);
  }
  if (input.custom) filters.push(...(input.custom as ConditionLeaf[]));
  if (input.raw_condition) filters.push(input.raw_condition);

  const condition = asTopLevel(simplify(and(...filters)));
  const query = input.text ? L.freeText(input.text, { prefixWildcard: true }) : undefined;

  if (!query && !condition) {
    throw new ToolInputError('The user search has no criteria — provide `text` or at least one filter.');
  }
  if (query) explanation.push(`free-text query: ${query}`);

  return { query, condition, explanation };
}

export async function buildOrganizationSearch(input: SearchOrganizationsInput): Promise<BuiltSearch> {
  const explanation: string[] = [];
  const filters: Condition[] = [];

  if (input.name) filters.push(...stringConditions('organization.name', input.name));
  if (input.domain) filters.push(...stringConditions('organization.domain', input.domain));
  if (input.active !== undefined) filters.push(leaf('organization.active', 'is', input.active));
  if (input.vip !== undefined) filters.push(leaf('organization.vip', 'is', input.vip));
  if (input.custom) filters.push(...(input.custom as ConditionLeaf[]));
  if (input.raw_condition) filters.push(input.raw_condition);

  const condition = asTopLevel(simplify(and(...filters)));
  const query = input.text ? L.freeText(input.text, { prefixWildcard: true }) : undefined;

  if (!query && !condition) {
    throw new ToolInputError(
      'The organization search has no criteria — provide `text` or at least one filter.',
    );
  }
  if (query) explanation.push(`free-text query: ${query}`);

  return { query, condition, explanation };
}

// ------------------------------------------------------------------ describing

function describeStringFilter(filter: StringFilter): string {
  const normalized = normalizeStringFilter(filter);
  return Object.entries(normalized)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' AND ');
}

function describeDateFilter(filter: DateFilter): string {
  return Object.entries(filter)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' AND ');
}

export function renderSearchExplanation(built: BuiltSearch): string {
  const lines: string[] = [];
  if (built.query) lines.push(`query: ${built.query}`);
  if (built.condition) lines.push(`condition:\n${explainCondition(built.condition)}`);
  if (built.sort_by)
    lines.push(`sort: ${built.sort_by.join(', ')} ${built.order_by?.join(', ') ?? ''}`.trim());
  if (built.explanation.length)
    lines.push(`filters:\n${built.explanation.map((e) => `  - ${e}`).join('\n')}`);
  return lines.join('\n');
}
