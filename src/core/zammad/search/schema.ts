import { z } from 'zod';
import { STATE_TYPES } from '../lookup.js';
import { BLOCK_OPERATORS, CONDITION_OPERATORS, RELATIVE_RANGES } from '../selector.js';

/**
 * Input schema for `zammad_search_tickets`.
 *
 * Every field maps onto a Zammad selector condition or an Elasticsearch clause;
 * the descriptions are written for a model calling the tool, because they are
 * what shows up in the tool's JSON Schema.
 */

// --------------------------------------------------------------------- shared

/** A reference to a record by numeric ID or by name/login/email. */
const ref = z.union([z.string().min(1), z.number().int().positive()]);
const refs = z.union([ref, z.array(ref).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));

export const relativeSpanSchema = z
  .union([
    z
      .string()
      .regex(
        /^\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)\s*$/i,
        'Use a span like "30m", "24h", "7d", "2 weeks" or "3 months".',
      )
      .describe('Shorthand span, e.g. "30m", "24h", "7d", "2 weeks", "3 months".'),
    z.object({
      value: z.number().int().positive(),
      unit: z.enum(RELATIVE_RANGES),
    }),
  ])
  .describe('A relative time span, either as shorthand ("7d") or as {value, unit}.');

export type RelativeSpan = z.infer<typeof relativeSpanSchema>;

/** ISO-8601 timestamp or date. Zammad accepts both. */
const timestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    'Use an ISO-8601 date ("2026-01-31") or timestamp ("2026-01-31T09:00:00Z").',
  );

export const dateFilterSchema = z
  .object({
    after: timestamp.optional().describe('Strictly after this absolute timestamp.'),
    before: timestamp.optional().describe('Strictly before this absolute timestamp.'),
    between: z.tuple([timestamp, timestamp]).optional().describe('Inclusive [from, to] range.'),
    within_last: relativeSpanSchema.optional().describe('Within the last N units, e.g. "7d".'),
    within_next: relativeSpanSchema
      .optional()
      .describe('Within the next N units — useful for pending_time / escalation_at.'),
    more_than_ago: relativeSpanSchema
      .optional()
      .describe('Older than N units ago, e.g. "30d" to find stale tickets.'),
    today: z.boolean().optional().describe('Falls on the current day in the Zammad instance timezone.'),
    is_set: z.boolean().optional().describe('true = the field has a value; false = the field is empty.'),
  })
  .strict()
  .describe('Date/time filter. Multiple keys are combined with AND.');

export type DateFilter = z.infer<typeof dateFilterSchema>;

export const stringFilterSchema = z
  .union([
    z.string().min(1).describe('Shorthand for {contains: "..."}'),
    z
      .object({
        is: z
          .union([z.string(), z.array(z.string()).min(1)])
          .optional()
          .describe('Exact match (any of, if an array).'),
        is_not: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
        contains: z.string().optional().describe('Substring match, case-insensitive.'),
        contains_not: z.string().optional(),
        starts_with: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
        ends_with: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
        regex: z.string().optional().describe('Regular expression (SQL backend only).'),
        not_regex: z.string().optional(),
        is_set: z.boolean().optional(),
      })
      .strict(),
  ])
  .describe('Text filter. A bare string is treated as {contains: "..."}.');

export type StringFilter = z.infer<typeof stringFilterSchema>;

const numberRangeSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    equals: z.number().optional(),
  })
  .strict();

// ---------------------------------------------------------------- ticket search

export const TICKET_SORT_FIELDS = [
  'created_at',
  'updated_at',
  'number',
  'title',
  'state_id',
  'priority_id',
  'group_id',
  'owner_id',
  'customer_id',
  'organization_id',
  'close_at',
  'pending_time',
  'escalation_at',
  'last_contact_at',
  'first_response_at',
  'article_count',
] as const;

export const ARTICLE_TYPES = [
  'email',
  'phone',
  'web',
  'note',
  'sms',
  'chat',
  'fax',
  'twitter status',
  'twitter direct-message',
  'facebook feed post',
  'facebook feed comment',
  'telegram personal-message',
  'whatsapp message',
] as const;

export const articleFilterSchema = z
  .object({
    body: stringFilterSchema.optional().describe('Match against article bodies.'),
    subject: stringFilterSchema.optional(),
    from: stringFilterSchema.optional().describe('Sender address/name of an article.'),
    to: stringFilterSchema.optional(),
    cc: stringFilterSchema.optional(),
    type: z.array(z.enum(ARTICLE_TYPES)).min(1).optional().describe('Article channel type.'),
    sender: z
      .array(z.enum(['Agent', 'Customer', 'System']))
      .min(1)
      .optional(),
    internal: z.boolean().optional().describe('true = internal notes only, false = public only.'),
  })
  .strict()
  .describe("Filters applied to the ticket's articles. A ticket matches if any article matches.");

/**
 * A selector value. Spelled out rather than left as `z.unknown()`, which emits
 * an empty `{}` sub-schema — meaningless to a model and rejected outright by
 * the stricter tool-schema validators.
 */
const selectorValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

export const customConditionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        'Full attribute path, e.g. `ticket.my_custom_field`, `customer.department`, `organization.vip`. ' +
          'Object Manager attributes live on `ticket.<name>`.',
      ),
    operator: z.enum(CONDITION_OPERATORS),
    value: selectorValue.optional(),
    range: z.enum(RELATIVE_RANGES).optional().describe('Required for the `(relative)` operators.'),
    pre_condition: z
      .enum(['not_set', 'current_user.id', 'current_user.organization_id', 'specific'])
      .optional(),
  })
  .strict();

/**
 * `raw_condition` as exposed to tool callers.
 *
 * The selector language is recursive, and expressing that with `z.lazy` emits a
 * `$ref` into `definitions` wrapped in `allOf`. Several MCP clients validate
 * tool schemas against a strict JSON Schema subset that allows none of those
 * and silently drop the whole tool — which is how `zammad_search_tickets`
 * disappeared from Codex.
 *
 * Unrolling to a fixed depth keeps the structure machine-readable with no
 * `$ref` at all. Two levels of grouping cover the queries anyone writes by
 * hand; the server still parses the full recursive form, so nothing deeper is
 * rejected at runtime.
 */
const conditionLeafInput = customConditionSchema;

const conditionGroupInner = z
  .object({
    operator: z.enum(BLOCK_OPERATORS),
    conditions: z.array(conditionLeafInput).min(1),
  })
  .strict();

const conditionGroupOuter = z
  .object({
    operator: z.enum(BLOCK_OPERATORS),
    conditions: z.array(z.union([conditionLeafInput, conditionGroupInner])).min(1),
  })
  .strict();

const rawConditionInput = z.union([conditionLeafInput, conditionGroupOuter]);

export const searchTicketsInputSchema = z
  .object({
    // ------------------------------------------------------------ free text
    text: z
      .string()
      .optional()
      .describe(
        'Free-text search across title, ticket number and article content. With Elasticsearch this is a ' +
          'full-text query; without it, Zammad falls back to a LIKE over title/number/article body, from, to and subject.',
      ),

    // ----------------------------------------------------- ticket attributes
    number: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe('Exact ticket number(s), e.g. "67001".'),
    title: stringFilterSchema.optional(),

    state: refs.optional().describe('Ticket states by name ("open", "closed") or ID.'),
    state_not: refs.optional().describe('Exclude these states.'),
    state_type: z
      .array(z.enum(STATE_TYPES))
      .min(1)
      .optional()
      .describe(
        'Filter by state category rather than by individual state. Expanded to every matching state ID, ' +
          'so it keeps working on instances with custom states.',
      ),

    priority: refs.optional().describe('Priorities by name ("3 high") or ID.'),
    priority_not: refs.optional(),

    group: refs
      .optional()
      .describe('Groups/queues by name or ID. Nested groups may be given as "Parent::Child".'),
    group_not: refs.optional(),

    owner: refs
      .optional()
      .describe(
        'Assigned agents by email, login or ID. The literal "me" resolves to the authenticated user.',
      ),
    owner_not: refs.optional(),
    unassigned: z
      .boolean()
      .optional()
      .describe('true = only tickets with no owner; false = only assigned tickets.'),

    customer: refs
      .optional()
      .describe('Customers by email, login or ID. "me" resolves to the authenticated user.'),
    customer_not: refs.optional(),

    organization: refs
      .optional()
      .describe(
        'Customer organizations by name or ID. "mine" resolves to the authenticated user\'s organization.',
      ),
    organization_not: refs.optional(),

    created_by: refs.optional().describe('Users who created the ticket.'),
    updated_by: refs.optional(),

    tags: z
      .object({
        all: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Ticket must carry every one of these tags.'),
        any: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Ticket must carry at least one of these tags.'),
        none: z.array(z.string().min(1)).min(1).optional().describe('Ticket must carry none of these tags.'),
      })
      .strict()
      .optional(),

    // -------------------------------------------------------------- temporal
    created_at: dateFilterSchema.optional(),
    updated_at: dateFilterSchema.optional(),
    closed_at: dateFilterSchema.optional().describe("Maps to Zammad's `close_at`."),
    pending_time: dateFilterSchema.optional().describe('When a pending ticket is due to come back.'),
    escalation_at: dateFilterSchema.optional(),
    last_contact_at: dateFilterSchema.optional(),
    last_contact_agent_at: dateFilterSchema.optional(),
    last_contact_customer_at: dateFilterSchema.optional(),
    first_response_at: dateFilterSchema.optional(),

    escalated: z
      .boolean()
      .optional()
      .describe('true = escalation deadline already passed; false = not currently escalated.'),

    article_count: numberRangeSchema.optional().describe('Number of articles on the ticket.'),

    // -------------------------------------------------------------- articles
    article: articleFilterSchema.optional(),

    // ------------------------------------------------------ custom / escape
    custom: z
      .array(customConditionSchema)
      .min(1)
      .optional()
      .describe('Raw selector conditions for Object Manager / custom attributes not covered above.'),
    raw_condition: rawConditionInput
      .optional()
      .describe(
        'A Zammad selector, merged with the generated conditions. Either a single condition ' +
          '({name, operator, value}) or a group ({operator: "AND"|"OR"|"NOT", conditions: [...]}), ' +
          'nestable one level deeper. Full escape hatch for anything the named filters do not cover.',
      ),
    raw_query: z
      .string()
      .optional()
      .describe(
        'Raw Elasticsearch query_string fragment, AND-ed onto the generated query. Requires Elasticsearch.',
      ),

    // -------------------------------------------------------------- controls
    match: z
      .enum(['all', 'any'])
      .default('all')
      .describe('How the top-level filters combine. "all" = AND (default), "any" = OR.'),
    strategy: z
      .enum(['auto', 'fulltext', 'structured'])
      .default('auto')
      .describe(
        'auto: free text goes to the search backend, structured filters go to the selector — correct with or without ' +
          'Elasticsearch (recommended). fulltext: compile everything into one Elasticsearch query_string (needs ' +
          'Elasticsearch, enables wildcards/fuzziness across fields). structured: selector only, no text query — ' +
          "forces Zammad's exact database search.",
      ),

    sort_by: z
      .union([z.enum(TICKET_SORT_FIELDS), z.array(z.enum(TICKET_SORT_FIELDS)).min(1)])
      .optional()
      .describe('Defaults to relevance when a text query is present, otherwise updated_at.'),
    order_by: z.union([z.enum(['asc', 'desc']), z.array(z.enum(['asc', 'desc'])).min(1)]).optional(),

    page: z.number().int().positive().default(1),
    per_page: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(25)
      .describe('Zammad caps ticket search at 200 rows per page.'),

    output: z
      .enum(['summary', 'full', 'ids', 'count'])
      .default('summary')
      .describe(
        'summary: compact rows with resolved state/priority/group names (default). full: complete ticket objects. ' +
          'ids: ticket IDs only. count: total match count only, no rows — cheapest way to size a result set.',
      ),
    explain: z
      .boolean()
      .default(true)
      .describe('Include the generated Zammad query/selector in the response so it can be refined.'),
    on_behalf_of: z
      .string()
      .optional()
      .describe('Run the search as another Zammad user (login, email or ID). Requires admin privileges.'),
  })
  .strict();

export type SearchTicketsInput = z.infer<typeof searchTicketsInputSchema>;

// ------------------------------------------------------- generic object search

export const searchUsersInputSchema = z
  .object({
    text: z.string().optional().describe('Free-text over name, email, login, phone, note.'),
    email: stringFilterSchema.optional(),
    login: stringFilterSchema.optional(),
    firstname: stringFilterSchema.optional(),
    lastname: stringFilterSchema.optional(),
    organization: refs.optional().describe('Restrict to these organizations (name or ID).'),
    role: z.array(z.string()).min(1).optional().describe('Role names, e.g. ["Agent"].'),
    active: z.boolean().optional(),
    vip: z.boolean().optional(),
    custom: z.array(customConditionSchema).min(1).optional(),
    raw_condition: rawConditionInput.optional(),
    page: z.number().int().positive().default(1),
    per_page: z.number().int().positive().max(200).default(25),
    output: z.enum(['summary', 'full', 'ids', 'count']).default('summary'),
    explain: z.boolean().default(false),
  })
  .strict();

export type SearchUsersInput = z.infer<typeof searchUsersInputSchema>;

export const searchOrganizationsInputSchema = z
  .object({
    text: z.string().optional(),
    name: stringFilterSchema.optional(),
    domain: stringFilterSchema.optional(),
    vip: z.boolean().optional(),
    active: z.boolean().optional(),
    custom: z.array(customConditionSchema).min(1).optional(),
    raw_condition: rawConditionInput.optional(),
    page: z.number().int().positive().default(1),
    per_page: z.number().int().positive().max(200).default(25),
    output: z.enum(['summary', 'full', 'ids', 'count']).default('summary'),
    explain: z.boolean().default(false),
  })
  .strict();

export type SearchOrganizationsInput = z.infer<typeof searchOrganizationsInputSchema>;
