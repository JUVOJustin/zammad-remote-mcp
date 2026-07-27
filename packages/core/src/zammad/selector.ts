import { z } from 'zod';

/**
 * Zammad's "selector" language — the same structure that powers overviews,
 * triggers and schedulers. `POST /api/v1/tickets/search` accepts it as
 * `condition`, and Zammad compiles it either to SQL (`Selector::Sql`) or to an
 * Elasticsearch query (`Selector::SearchIndex`) depending on which backend
 * serves the request. Emitting selectors instead of raw query strings is what
 * lets this server produce filters that behave identically with and without
 * Elasticsearch.
 */

/** `Selector::Sql::VALID_BLOCK_OPERATORS` */
export const BLOCK_OPERATORS = ['AND', 'OR', 'NOT'] as const;
export type BlockOperator = (typeof BLOCK_OPERATORS)[number];

/** `Selector::Sql::VALID_OPERATORS`, verbatim. */
export const CONDITION_OPERATORS = [
  'after (absolute)',
  'after (relative)',
  'before (absolute)',
  'before (relative)',
  'contains all not',
  'contains all',
  'contains not',
  'contains one not',
  'contains one',
  'contains',
  'does not match regex',
  'ends with one of',
  'ends with',
  'from (relative)',
  'has changed',
  'has reached warning',
  'has reached',
  'in range',
  'is any of',
  'is in working time',
  'is less than',
  'is less than or equal to',
  'is greater than',
  'is greater than or equal to',
  'is none of',
  'is not in working time',
  'is not',
  'is set',
  'is',
  'matches',
  'matches regex',
  'not set',
  'starts with one of',
  'starts with',
  'till (relative)',
  'today',
  'within last (relative)',
  'within next (relative)',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Units accepted by the `(relative)` operators — `Selector::SearchIndex#relative_map`. */
export const RELATIVE_RANGES = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;
export type RelativeRange = (typeof RELATIVE_RANGES)[number];

export interface ConditionLeaf {
  /** `<table>.<attribute>`, e.g. `ticket.state_id`, `article.body`, `customer.email`. */
  name: string;
  operator: ConditionOperator;
  value?: unknown;
  /** Required by the `(relative)` operators. */
  range?: RelativeRange;
  /** `not_set` | `current_user.id` | `current_user.organization_id` | `specific` */
  pre_condition?: string;
}

export interface ConditionBlock {
  operator: BlockOperator;
  conditions: Condition[];
}

export type Condition = ConditionLeaf | ConditionBlock;

export function isBlock(condition: Condition): condition is ConditionBlock {
  return Array.isArray((condition as ConditionBlock).conditions);
}

export const conditionLeafSchema: z.ZodType<ConditionLeaf> = z.object({
  name: z
    .string()
    .min(1)
    .describe('Attribute path such as `ticket.state_id`, `article.body` or `customer.email`.'),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.unknown().optional(),
  range: z.enum(RELATIVE_RANGES).optional(),
  pre_condition: z.string().optional(),
});

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      operator: z.enum(BLOCK_OPERATORS),
      conditions: z.array(conditionSchema).min(1),
    }),
    conditionLeafSchema,
  ]),
) as z.ZodType<Condition>;

// ---------------------------------------------------------------- constructors

export function and(...conditions: Array<Condition | undefined | null>): ConditionBlock {
  return { operator: 'AND', conditions: compact(conditions) };
}

export function or(...conditions: Array<Condition | undefined | null>): ConditionBlock {
  return { operator: 'OR', conditions: compact(conditions) };
}

export function not(...conditions: Array<Condition | undefined | null>): ConditionBlock {
  return { operator: 'NOT', conditions: compact(conditions) };
}

function compact(conditions: Array<Condition | undefined | null>): Condition[] {
  return conditions.filter((c): c is Condition => c != null && !(isBlock(c) && c.conditions.length === 0));
}

export function leaf(
  name: string,
  operator: ConditionOperator,
  value?: unknown,
  extra: Partial<Pick<ConditionLeaf, 'range' | 'pre_condition'>> = {},
): ConditionLeaf {
  const condition: ConditionLeaf = { name, operator };
  if (value !== undefined) condition.value = value;
  if (extra.range) condition.range = extra.range;
  if (extra.pre_condition) condition.pre_condition = extra.pre_condition;
  return condition;
}

/**
 * `contains all|one|...` values must be sent as a comma-separated string.
 * `Selector::Sql` calls `String#split(',')` on `ticket.tags` unconditionally
 * (an array would raise), and `Selector::SearchIndex` splits strings the same
 * way — so a joined string is the only encoding both backends accept.
 */
export function joinedValues(values: readonly string[]): string {
  return values
    .map((v) => v.trim())
    .filter(Boolean)
    .join(',');
}

/**
 * Flatten single-child blocks and drop empty ones so the emitted selector stays
 * readable — useful because it is echoed back to the model for iteration.
 */
export function simplify(condition: Condition): Condition | undefined {
  if (!isBlock(condition)) return condition;

  const children = condition.conditions.map(simplify).filter((c): c is Condition => c !== undefined);

  if (children.length === 0) return undefined;

  // `NOT` is not associative with its children the way AND/OR are, so only
  // collapse a lone child for the conjunctive operators.
  if (children.length === 1 && condition.operator !== 'NOT') return children[0];

  // Inline nested blocks that share the parent's operator.
  const flattened: Condition[] = [];
  for (const child of children) {
    if (isBlock(child) && child.operator === condition.operator && condition.operator !== 'NOT') {
      flattened.push(...child.conditions);
    } else {
      flattened.push(child);
    }
  }

  return { operator: condition.operator, conditions: flattened };
}

/**
 * Wrap a selector so it is safe to send as the top-level `condition`.
 *
 * Zammad's `Selector::Base.migrate_selector` treats any condition object without
 * a `conditions` key as the *legacy* flat form — a hash keyed by attribute name,
 * e.g. `{'ticket.state_id' => {operator: 'is', value: [2]}}` — and rebuilds it by
 * merging each value into `{name: <key>}`. Hand it a bare leaf and it iterates
 * that leaf's own keys instead, reaching `{name: 'name'}.merge('ticket.state_id')`:
 * `Hash#merge` with a String raises, and the API answers HTTP 500.
 *
 * `simplify` deliberately collapses a single-child block down to its leaf, which
 * is right for nested positions but fatal at the root — and the root is exactly
 * where a one-filter search lands. So every selector leaving this module for the
 * wire goes through here.
 */
export function asTopLevel(condition: Condition | undefined): ConditionBlock | undefined {
  if (!condition) return undefined;
  if (isBlock(condition)) return condition;
  return { operator: 'AND', conditions: [condition] };
}

/** Human-readable rendering of a selector, returned alongside search results. */
export function explainCondition(condition: Condition, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (isBlock(condition)) {
    const header = `${pad}${condition.operator}`;
    const body = condition.conditions.map((c) => explainCondition(c, indent + 1)).join('\n');
    return `${header}\n${body}`;
  }
  const parts = [`${pad}${condition.name} ${condition.operator}`];
  if (condition.value !== undefined) parts.push(JSON.stringify(condition.value));
  if (condition.range) parts.push(`(${condition.range})`);
  if (condition.pre_condition) parts.push(`[${condition.pre_condition}]`);
  return parts.join(' ');
}
