import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolInputError } from '../../util/errors.js';
import type { BodyFormat } from '../../zammad/article-body.js';
import { authoredContentType, ensureHtml, HTML_BODY_NOTE } from '../../zammad/compose.js';
import type { MentionedUser } from '../../zammad/mentions.js';
import { rewriteMentions } from '../../zammad/mentions.js';
import { asTopLevel, leaf } from '../../zammad/selector.js';
import {
  appendGroupSignature,
  appendSignatureFlag,
  type RenderContext,
  type SignatureOutcome,
  ticketLoader,
} from '../../zammad/signature.js';
import type { Vocabulary } from '../../zammad/vocabulary.js';
import type { ToolContext } from '../context.js';
import { withOnBehalfOf } from '../context.js';
import type { ArticleLike } from '../result.js';
import { guard, jsonResult, presentArticle, presentTicket, textResult, withRenderedBody } from '../result.js';
import { singleReferenceField, tagField } from './enrich.js';

/**
 * Ticket read/write operations.
 *
 * Zammad's controllers run every payload through `association_name_to_id_convert`,
 * so association *names* may be sent instead of IDs (`group: "1st Level"`,
 * `state: "open"`, `customer: "jane@acme.com"`). These tools pass names straight
 * through, which avoids a lookup round trip and keeps the arguments readable.
 */

const onBehalfOf = z
  .string()
  .optional()
  .describe('Perform the action as another Zammad user (login, email or ID). Requires admin privileges.');

/**
 * Whether the caller wants the presented object or Zammad's untouched one.
 * `full` is the escape hatch the old `raw_ticket` field used to be, except it
 * is now asked for rather than always attached.
 */
const outputShape = z
  .enum(['summary', 'full'])
  .default('summary')
  .describe(
    'Leave this at `summary`: it is everything Zammad returned minus its internal bookkeeping and the numeric ' +
      'twins of fields that are already spelled out (`group_id` next to `group`). Custom fields are included. ' +
      '`full` returns the untouched Zammad object and is only worth it when a field is missing that should be there.',
  );

/** Shared by every tool that returns article bodies — see zammad/article-body.ts. */
const bodyFormat = z
  .enum(['markdown', 'html'])
  .default('markdown')
  .describe(
    'How article bodies are rendered. Leave this at `markdown`: the body comes back as Markdown with the quoted ' +
      'reply and the signature removed. Headings, lists, tables, links and quotes keep their meaning, and nothing a ' +
      'reader needs is lost. Pass `html` only when the markup itself is the subject, such as tracing a broken email ' +
      'template or a rendering problem; it returns the stored HTML in full and is several times larger.',
  );

/**
 * `.strict()` for the same reason the tools themselves are: a dropped key is a
 * wrong answer that looks like a right one. The hyphen in `mime-type` is
 * Zammad's, and `mime_type` is the spelling anyone would guess — silently
 * discarded, every attachment would arrive as `application/octet-stream`.
 */
const attachmentSchema = z
  .object({
    filename: z.string().min(1),
    data: z.string().min(1).describe('Base64-encoded file content.'),
    'mime-type': z.string().min(1).default('application/octet-stream'),
  })
  .strict();

/**
 * Strict at this level too, not only on the tool that contains it.
 *
 * `internal` is the flag that decides whether the customer sees an article at
 * all. Inside an object that drops what it does not recognise, one misspelling
 * of it publishes the article and reports success — the shape of failure 2.0.0
 * made the tool schemas strict for, and which the mass update's article has
 * been strict against since.
 */
const articleInputSchema = z
  .object({
    body: z.string().min(1),
    subject: z.string().optional(),
    type: z
      .enum(['note', 'email', 'phone', 'web', 'sms', 'chat', 'fax'])
      .default('note')
      .describe(
        'Channel. `email` actually sends mail to the customer — use `note` for an internal record unless you mean to.',
      ),
    sender: z.enum(['Agent', 'Customer', 'System']).default('Agent'),
    internal: z
      .boolean()
      .default(true)
      .describe(
        'true keeps the article invisible to the customer. Defaults to true so nothing is published by accident.',
      ),
    to: z.string().optional(),
    cc: z.string().optional(),
    in_reply_to: z.string().optional(),
    time_unit: z.string().optional().describe('Time accounting for this article, e.g. "15".'),
    origin_by: z
      .string()
      .optional()
      .describe('Attribute the article to another user (login/email). Requires agent rights.'),
    attachments: z.array(attachmentSchema).optional(),
    append_signature: appendSignatureFlag,
  })
  .strict();

/**
 * Attributes shared by create and update.
 *
 * Every association takes a human identifier — a group name, a state name, an
 * agent's email. Zammad resolves those itself, its controllers run each payload
 * through `association_name_to_id_convert`, so no lookup happens here and the
 * arguments read the way the result does. The `*_id` variants stay for the case
 * where two records share a name and only a number is unambiguous.
 *
 * `organization` is the exception and has no name variant on purpose — see the
 * comment on `organization_id`.
 */
const ticketAttributes = {
  title: z.string().min(1).optional(),
  group: z
    .string()
    .optional()
    .describe('Group name, e.g. "1st Level". `group_id` takes a numeric ID instead.'),
  group_id: z.number().int().positive().optional().describe('Alternative to `group`, which takes a name.'),
  state: z
    .string()
    .optional()
    .describe(
      'State name, e.g. "open", "closed", "pending reminder". `state_id` takes a numeric ID instead.',
    ),
  state_id: z.number().int().positive().optional().describe('Alternative to `state`, which takes a name.'),
  priority: z
    .string()
    .optional()
    .describe('Priority name, e.g. "2 normal". `priority_id` takes a numeric ID instead.'),
  priority_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Alternative to `priority`, which takes a name.'),
  owner: z
    .string()
    .optional()
    .describe(
      'Agent login or email. Pass an empty string to unassign. `owner_id` takes a numeric ID instead.',
    ),
  owner_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Alternative to `owner`, which takes a login or email. Use 1 to unassign.'),
  customer: z
    .string()
    .optional()
    .describe(
      'Customer login or email. Prefix with `guess:` to create the user if unknown. `customer_id` takes a ' +
        'numeric ID instead.',
    ),
  customer_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Alternative to `customer`, which takes a login or email.'),
  // No `organization` counterpart: a ticket's organization is derived from its
  // customer, and a name is silently ignored here. Verified against a live
  // instance — passing one returns 201 with the organization unset, which is
  // worse than an error. `organization_id` only picks between the organizations
  // the customer already belongs to; it cannot assign an unrelated one.
  organization_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Only for customers who belong to several organizations — it selects which one the ticket counts ' +
        "against. A ticket's organization otherwise follows its customer automatically, so setting this to " +
        'an organization the customer does not belong to has no effect.',
    ),
  pending_time: z
    .string()
    .optional()
    .describe('ISO-8601 timestamp. Required when moving a ticket into a pending state.'),
  // Create only. Zammad accepts `tags` on `POST /api/v1/tickets` and ignores it
  // on `PUT` — verified against 7.1.1: a ticket created with [alpha, beta] and
  // then updated with [gamma] still carries [alpha, beta], and the update
  // reports success. `zammad_update_ticket` therefore does not offer it; it
  // takes `add_tags` / `remove_tags`, which go through the endpoints that work.
  tags: z.array(z.string().min(1)).optional(),
  custom_fields: z
    // Not z.unknown(): that emits an empty `{}` sub-schema, which tells a model
    // nothing and is rejected by the stricter tool-schema validators.
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]),
    )
    .optional()
    .describe(
      'Object Manager attributes, keyed by their internal name. Discover the names with ' +
        'zammad_list_custom_attributes.',
    ),
} as const;

/**
 * Tags live outside the ticket record.
 *
 * `PUT /api/v1/tickets/:id` ignores a `tags` attribute, so adding and removing
 * go through `/api/v1/tags/add` and `/api/v1/tags/remove`, one request per tag —
 * Zammad takes a single `item` and offers no batch form. Removals run after
 * additions so that naming the same tag in both is a removal rather than a race.
 *
 * The list is read back rather than computed: whether an unknown tag is created
 * on the fly depends on the instance's `tag_new` setting, so what was asked for
 * and what the ticket now carries are not the same statement.
 */
async function applyTags(
  context: ToolContext,
  ticketId: number,
  add: string[] | undefined,
  remove: string[] | undefined,
): Promise<string[]> {
  // `add` is a POST and `remove` is a DELETE — Zammad is not symmetric here, and
  // POSTing to `tags/remove` answers 404. Additions are independent of each
  // other so they go out together; the two phases stay ordered.
  const run = async () => {
    await Promise.all(
      (add ?? []).map((item) =>
        context.client.post('/api/v1/tags/add', undefined, { object: 'Ticket', o_id: ticketId, item }),
      ),
    );
    for (const item of remove ?? []) {
      await context.client.delete('/api/v1/tags/remove', { object: 'Ticket', o_id: ticketId, item });
    }
  };

  try {
    await run();
  } catch (error) {
    // The attribute change has already landed and some tags may have, so the
    // error has to say what the ticket now carries. Failing silently here is
    // the half-success this tool was merged to stop reporting as a whole one.
    const partial = await context.client
      .get<{ tags?: string[] }>('/api/v1/tags', { object: 'Ticket', o_id: ticketId })
      .catch(() => undefined);
    const carried = partial?.tags?.join(', ') ?? 'unknown';
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — other changes were applied; ` +
        `ticket ${ticketId} now carries: ${carried}`,
    );
  }

  const current = await context.client.get<{ tags?: string[] }>('/api/v1/tags', {
    object: 'Ticket',
    o_id: ticketId,
  });
  return current?.tags ?? [];
}

/** Merge the shared attribute block into a Zammad payload. */
function ticketPayload(input: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const keys = [
    'title',
    'group',
    'group_id',
    'state',
    'state_id',
    'priority',
    'priority_id',
    'owner',
    'owner_id',
    'customer',
    'customer_id',
    'organization_id',
    'pending_time',
  ];
  // `guess:` rides on `customer_id`, not on `customer`. Zammad's
  // `association_name_to_id_convert` resolves a `customer` name against
  // existing users and 422s when there is none; the create-if-unknown path
  // lives in `TicketsController`'s customer_id handling, which reads the
  // prefix. Verified against 7.1.1 — the same address 422s as `customer` and
  // creates the user as `customer_id`. Since `customer_id` is typed as a
  // number here, the prefix was unreachable through these tools until this
  // moved it across, and the description promising it was simply wrong.
  const customer = input.customer;
  const guessed = typeof customer === 'string' && customer.toLowerCase().startsWith('guess:');
  if (guessed && input.customer_id !== undefined) {
    // Two known keys that contradict each other. Silently preferring one is the
    // same failure as dropping an unknown key, and the strict schema cannot see
    // it, so it is refused here.
    throw new ToolInputError(
      'Pass either `customer` with a `guess:` prefix or `customer_id`, not both — they name different users.',
    );
  }

  for (const key of keys) {
    if (key === 'customer' && guessed) continue;
    if (input[key] !== undefined) payload[key] = input[key];
  }
  if (guessed) payload.customer_id = customer;

  if (Array.isArray(input.tags)) payload.tags = (input.tags as string[]).join(',');
  if (input.custom_fields && typeof input.custom_fields === 'object') {
    Object.assign(payload, input.custom_fields);
  }
  return payload;
}

/**
 * Builds the article payload and resolves `@@name` mentions in its body — the
 * same rewrite zammad_create_article applies, needed here too since this is
 * the other place an article body reaches Zammad. See zammad/mentions.ts.
 */
async function articlePayload(
  // The flag is not consumed here — signing happens in signArticle() afterwards,
  // on the finished HTML body.
  article: z.infer<typeof articleInputSchema>,
  context: ToolContext,
): Promise<{ payload: Record<string, unknown>; mentioned: MentionedUser[] }> {
  // Mentions read the body as authored — before the HTML conversion, whose
  // escaping would break the `@@"Jane Doe"` quoting.
  const mentions = await rewriteMentions(article.body, authoredContentType(article.body), {
    client: context.client,
    lookup: context.lookup,
    zammadUrl: context.config.ZAMMAD_URL,
  });

  const payload: Record<string, unknown> = {
    // Every article is written as text/html — see zammad/compose.ts. Plain
    // prose is converted the way the UI converts pasted text.
    body: ensureHtml(mentions.body, mentions.content_type),
    type: article.type,
    sender: article.sender,
    internal: article.internal,
    content_type: 'text/html',
  };
  for (const key of ['subject', 'to', 'cc', 'in_reply_to', 'time_unit', 'origin_by'] as const) {
    if (article[key] !== undefined) payload[key] = article[key];
  }
  if (article.attachments?.length) payload.attachments = article.attachments;
  return { payload, mentioned: mentions.mentioned };
}

/**
 * Appends the group signature to an article payload, in place.
 *
 * Runs on the payload rather than on the input, and only after `articlePayload`:
 * rewriting `@@mentions` can promote a body to `text/html`, so reading the
 * content type off the caller's input would build a plain-text signature for a
 * body that is now markup. Returns undefined when the caller turned the flag off,
 * so the result stays silent rather than reporting a decision nobody asked about.
 */
async function signArticle(
  context: ToolContext,
  input: z.infer<typeof articleInputSchema>,
  payload: Record<string, unknown>,
  scope: {
    group?: string | number;
    ticket?: RenderContext;
    loadTicket?: () => Promise<RenderContext>;
  },
): Promise<SignatureOutcome | undefined> {
  if (!input.append_signature) return undefined;

  const { body, ...outcome } = await appendGroupSignature({
    lookup: context.lookup,
    logger: context.logger,
    article: {
      body: payload.body as string,
      type: input.type,
      sender: input.sender,
    },
    ...scope,
  });

  payload.body = body;
  return outcome;
}

interface HistoryResponse {
  assets?: { TicketArticle?: Record<string, ArticleLike> };
  [key: string]: unknown;
}

/**
 * Zammad bundles every article it references into the history response, bodies
 * and all. On a 103-article ticket that made the payload 1.1M characters, more
 * than half of it stored markup — enough to exhaust a context window on what is
 * meant to be an audit trail.
 */
function renderHistoryAssets(history: HistoryResponse, format: BodyFormat): unknown {
  const articles = history?.assets?.TicketArticle;
  if (!articles || format === 'html') return history;

  const rendered: Record<string, unknown> = {};
  for (const [id, article] of Object.entries(articles)) {
    rendered[id] = withRenderedBody(article, format);
  }
  return { ...history, assets: { ...history.assets, TicketArticle: rendered } };
}

/** Resolve a ticket number to its ID via the search endpoint. */
async function resolveTicketId(
  context: ToolContext,
  args: { ticket_id?: number; ticket_number?: string },
): Promise<number> {
  if (args.ticket_id !== undefined) return args.ticket_id;

  const number = args.ticket_number!;
  const response = await context.client.post<{ records?: Array<{ id: number; number: string }> }>(
    '/api/v1/tickets/search',
    {
      // Must be a block, not a bare leaf — see `asTopLevel` in zammad/selector.ts.
      condition: asTopLevel(leaf('ticket.number', 'is', number)),
      per_page: 2,
      page: 1,
      expand: true,
      with_total_count: true,
    },
  );

  const records = response?.records ?? [];
  const exact = records.filter((r) => r.number === number);
  if (exact.length === 0) {
    throw new ToolInputError(`No ticket with number "${number}" is visible to this user.`);
  }
  return exact[0]!.id;
}

export function registerTicketTools(server: McpServer, base: ToolContext, vocabulary: Vocabulary): void {
  // Same idea as the search tools: the instance's own value sets become enums,
  // so `zammad_list_ticket_states` and friends are not needed to write a ticket.
  const attributesWithVocabulary = {
    ...ticketAttributes,
    state: singleReferenceField(vocabulary.states, 'Ticket state.'),
    priority: singleReferenceField(vocabulary.priorities, 'Ticket priority.'),
    group: singleReferenceField(vocabulary.groups, 'Group/queue.'),
    tags: tagField(
      vocabulary.tags,
      "The ticket's tags. Set on create; use `add_tags` / `remove_tags` to change them afterwards, " +
        'because Zammad ignores this field on an update.',
    ).optional(),
  };

  // ----------------------------------------------------------------- read ---
  const getTicketInput = z.object({
    ticket_id: z.number().int().positive().optional(),
    ticket_number: z.string().min(1).optional(),
    include_articles: z.boolean().default(true).describe('Fetch the conversation as well.'),
    article_limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(20)
      .describe('Most recent N articles to include.'),
    body_format: bodyFormat,
    output: outputShape,
    include_tags: z.boolean().default(true),
    include_links: z.boolean().default(false).describe('Include linked tickets (child/parent/normal).'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_get_ticket',
    {
      title: 'Get a Zammad ticket',
      description:
        'Fetch one ticket by ID or by ticket number, optionally with its articles, tags and links. Association ' +
        'names are resolved, so the result shows "open" rather than a state ID. Article bodies are rendered as ' +
        'Markdown with the quoted reply and signature removed; pass `body_format: "html"` for the original markup.',
      inputSchema: getTicketInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = getTicketInput.parse(rawInput);
      if (input.ticket_id === undefined && input.ticket_number === undefined) {
        throw new ToolInputError('Provide either ticket_id or ticket_number.');
      }
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const id = await resolveTicketId(context, input);

      const ticket = await context.client.get<Record<string, unknown>>(`/api/v1/tickets/${id}`, {
        expand: true,
      });
      const payload: Record<string, unknown> = {
        ticket: input.output === 'full' ? ticket : presentTicket(ticket),
      };

      if (input.include_articles) {
        const articles = await context.client.get<Record<string, unknown>[]>(
          `/api/v1/ticket_articles/by_ticket/${id}`,
          { expand: true },
        );
        const list = Array.isArray(articles) ? articles : [];
        payload.article_count = list.length;
        // `output` governs the articles too. Asking for the full shape because
        // an article field is missing would otherwise change only the ticket.
        payload.articles = list
          .slice(-input.article_limit)
          .map((a) =>
            input.output === 'full'
              ? withRenderedBody(a, input.body_format)
              : presentArticle(a, { bodyFormat: input.body_format }),
          );
        if (list.length > input.article_limit) {
          payload.articles_note = `Showing the ${input.article_limit} most recent of ${list.length} articles.`;
        }
      }

      if (input.include_tags) {
        const tags = await context.client
          .get<{ tags?: string[] }>('/api/v1/tags', { object: 'Ticket', o_id: id })
          .catch(() => undefined);
        if (tags?.tags) payload.tags = tags.tags;
      }

      if (input.include_links) {
        const links = await context.client
          .get<unknown>('/api/v1/links', { link_object: 'Ticket', link_object_value: id })
          .catch(() => undefined);
        if (links) payload.links = links;
      }

      return jsonResult(payload);
    }),
  );

  const listTicketsInput = z.object({
    page: z.number().int().positive().default(1),
    per_page: z.number().int().positive().max(100).default(25),
    sort_by: z.string().default('created_at'),
    order_by: z.enum(['asc', 'desc']).default('desc'),
    output: z.enum(['summary', 'full', 'ids']).default('summary'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_list_tickets',
    {
      title: 'List Zammad tickets',
      description:
        'Page through every ticket visible to the authenticated user, newest first by default. This is an unfiltered ' +
        'listing — for anything narrower use zammad_search_tickets, which filters server-side.',
      inputSchema: listTicketsInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = listTicketsInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);

      const tickets = await context.client.get<Record<string, unknown>[]>('/api/v1/tickets', {
        page: input.page,
        per_page: input.per_page,
        sort_by: input.sort_by,
        order_by: input.order_by,
        expand: input.output !== 'ids',
      });

      const rows = Array.isArray(tickets) ? tickets : [];
      return jsonResult({
        page: input.page,
        per_page: input.per_page,
        returned: rows.length,
        tickets:
          input.output === 'ids'
            ? rows.map((t) => t.id)
            : input.output === 'full'
              ? rows
              : rows.map(presentTicket),
      });
    }),
  );

  // --------------------------------------------------------------- create ---
  const createTicketInput = z.object({
    title: z.string().min(1),
    // The vocabulary-backed field, as everywhere else. A bare string here left
    // the one tool that *requires* a group as the only one not naming which
    // groups exist, so a wrong guess came back as a 422 from Zammad instead of
    // a schema the caller could have read first.
    group: attributesWithVocabulary.group,
    group_id: z.number().int().positive().optional(),
    customer: z
      .string()
      .optional()
      .describe('Customer login or email. Prefix with `guess:` to create the user if unknown.'),
    customer_id: z.number().int().positive().optional(),
    article: articleInputSchema.describe(`The first article of the ticket. ${HTML_BODY_NOTE}`),
    state: attributesWithVocabulary.state,
    state_id: ticketAttributes.state_id,
    priority: attributesWithVocabulary.priority,
    priority_id: ticketAttributes.priority_id,
    owner: ticketAttributes.owner,
    owner_id: ticketAttributes.owner_id,
    organization_id: ticketAttributes.organization_id,
    pending_time: ticketAttributes.pending_time,
    tags: attributesWithVocabulary.tags,
    custom_fields: ticketAttributes.custom_fields,
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_create_ticket',
    {
      title: 'Create a Zammad ticket',
      description:
        'Create a ticket together with its first article. `group` and `customer` are required by Zammad. Note that ' +
        'an article with `type: "email"` and `internal: false` is delivered to the customer — the defaults ' +
        '(`note`, internal) do not send anything.\n\n' +
        'Mention a colleague in the article body by writing `@@jane@acme.com`, `@@jdoe` or `@@"Jane Doe"` — they ' +
        'are linked and notified. Keep the article `internal: true`, or the customer sees the mention too.\n\n' +
        'An email article is signed with the group signature unless `article.append_signature` is turned off.',
      inputSchema: createTicketInput.strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async (rawInput) => {
      const input = createTicketInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);

      if (!input.group && input.group_id === undefined) {
        throw new ToolInputError('Zammad requires a group — pass `group` (name) or `group_id`.');
      }
      if (!input.customer && input.customer_id === undefined) {
        throw new ToolInputError(
          'Zammad requires a customer — pass `customer` (login/email) or `customer_id`.',
        );
      }

      const article = await articlePayload(input.article, context);

      // Zammad never signs an article server-side — the agent UI composes the
      // signature into the body before it posts. Without this, a ticket opened
      // through the API goes out unsigned where the same ticket opened by hand
      // would not.
      const signature = await signArticle(context, input.article, article.payload, {
        group: input.group_id ?? input.group,
        // What the create screen renders against: the ticket does not exist yet,
        // so placeholders see the attributes it is about to be given. `group` is
        // filled in from the resolved record.
        ticket: {
          title: input.title,
          customer: input.customer,
          state: input.state,
          priority: input.priority,
        },
      });

      const body = {
        ...ticketPayload(input),
        title: input.title,
        article: article.payload,
      };

      // `expand` is what makes Zammad resolve state/group/owner/customer to names.
      // Without it the response carries only the numeric ids, which the presented
      // shape drops — the caller would get a ticket with no associations at all.
      const ticket = await context.client.post<Record<string, unknown>>('/api/v1/tickets', body, {
        expand: true,
      });
      return jsonResult({
        created: true,
        ...(signature ? { signature } : {}),
        ticket: presentTicket(ticket),
        ...(article.mentioned.length > 0 ? { mentioned: article.mentioned } : {}),
      });
    }),
  );

  // --------------------------------------------------------------- update ---
  // `tags` is deliberately absent — Zammad drops it on a `PUT`, so offering it
  // here would accept a change it never makes. The strict schema names it
  // instead, and points at the two arguments that do work.
  const { tags: _createOnlyTags, ...updatableAttributes } = attributesWithVocabulary;
  const updateTicketInput = z.object({
    ticket_id: z.number().int().positive().optional(),
    ticket_number: z.string().min(1).optional(),
    ...updatableAttributes,
    add_tags: tagField(
      vocabulary.tags,
      'Tags to attach. A name not among these is accepted and created, if the instance allows it.',
    ).optional(),
    remove_tags: tagField(vocabulary.tags, 'Tags to detach.').optional(),
    article: articleInputSchema
      .optional()
      .describe(
        'Optional article to append as part of the same update (e.g. a reply plus a state change). ' +
          HTML_BODY_NOTE,
      ),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_update_ticket',
    {
      title: 'Update a Zammad ticket',
      description:
        'Change ticket attributes (title, state, priority, group, owner, customer, organization, pending time, ' +
        'custom fields), add or remove tags, and optionally append an article — all in one call. Only the fields ' +
        'you pass are modified.\n\n' +
        'Tags are `add_tags` and `remove_tags`. There is no whole-list `tags` argument here: Zammad accepts one ' +
        'on create and ignores it on an update, so it is refused rather than silently dropped.\n\n' +
        'Moving a ticket into a pending state requires `pending_time`. Passing `customer` moves the ticket and ' +
        'lets the organization follow; `organization_id` only picks between the organizations that customer ' +
        'already belongs to.\n\n' +
        'Mention a colleague in the article body by writing `@@jane@acme.com`, `@@jdoe` or `@@"Jane Doe"` — they ' +
        'are linked and notified. Keep the article `internal: true`, or the customer sees the mention too.\n\n' +
        'An email article is signed with the group signature unless `article.append_signature` is turned off.',
      inputSchema: updateTicketInput.strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async (rawInput) => {
      const input = updateTicketInput.parse(rawInput);
      if (input.ticket_id === undefined && input.ticket_number === undefined) {
        throw new ToolInputError('Provide either ticket_id or ticket_number.');
      }
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const id = await resolveTicketId(context, input);

      const body = ticketPayload(input);
      let mentioned: MentionedUser[] = [];
      let signature: SignatureOutcome | undefined;
      if (input.article) {
        const article = await articlePayload(input.article, context);
        signature = await signArticle(context, input.article, article.payload, {
          // A group moved in this same call is the one the UI signs with —
          // `setArticleTypePost` prefers the pending group over the stored one.
          group: input.group_id ?? input.group,
          ticket: { title: input.title, state: input.state, priority: input.priority },
          loadTicket: ticketLoader(context.client, id),
        });
        body.article = article.payload;
        mentioned = article.mentioned;
      }

      const touchesTags = Boolean(input.add_tags || input.remove_tags);
      if (Object.keys(body).length === 0 && !touchesTags) {
        throw new ToolInputError('Nothing to update — pass at least one attribute, tags or an article.');
      }

      // A tag-only call has nothing for the ticket endpoint, and Zammad answers
      // a `PUT` with an empty body by touching `updated_at`. Skipping it keeps
      // "add a tag" from reading as an edit in the ticket history.
      const ticket = Object.keys(body).length
        ? await context.client.put<Record<string, unknown>>(`/api/v1/tickets/${id}`, body, { expand: true })
        : await context.client.get<Record<string, unknown>>(`/api/v1/tickets/${id}`, { expand: true });

      const tags = touchesTags ? await applyTags(context, id, input.add_tags, input.remove_tags) : undefined;

      return jsonResult({
        updated: true,
        ...(signature ? { signature } : {}),
        ticket: presentTicket(ticket),
        ...(tags ? { tags } : {}),
        ...(mentioned.length > 0 ? { mentioned } : {}),
      });
    }),
  );

  // No `zammad_update_ticket_customer`. It called
  // `PUT /api/v1/tickets/:id/update_customer`, which `zammad_update_ticket`
  // matches exactly: passing `customer` on the ordinary update moves the ticket
  // and lets the organization follow, verified against 7.1.1 by reassigning
  // between two organizations both ways and reading the ticket back. The
  // identifiers were the same on both tools too — `ticket_id` or
  // `ticket_number`, a customer by login, email or id.

  // --------------------------------------------------------------- delete ---
  const deleteInput = z.object({
    ticket_id: z.number().int().positive(),
    confirm: z
      .literal(true)
      .describe('Must be true. Deleting a ticket is permanent and removes its articles and attachments.'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_delete_ticket',
    {
      title: 'Delete a Zammad ticket',
      description:
        'Permanently delete a ticket. Requires admin rights in Zammad and cannot be undone — in most workflows ' +
        'closing the ticket (`zammad_update_ticket` with `state: "closed"`) is what is actually wanted.',
      inputSchema: deleteInput.strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = deleteInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      await context.client.delete(`/api/v1/tickets/${input.ticket_id}`);
      return textResult(`Ticket ${input.ticket_id} deleted.`);
    }),
  );

  // ---------------------------------------------------------------- merge ---
  const mergeInput = z.object({
    source_ticket_id: z.number().int().positive().describe('The ticket that is merged away.'),
    target_ticket_number: z.string().min(1).describe('Ticket NUMBER (not ID) of the ticket that survives.'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_merge_tickets',
    {
      title: 'Merge two Zammad tickets',
      description:
        'Move every article from the source ticket into the target and set the source to "merged". Note the ' +
        'asymmetry required by Zammad: the source is addressed by ID, the target by ticket number.',
      inputSchema: mergeInput.strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = mergeInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const result = await context.client.put<unknown>(
        `/api/v1/ticket_merge/${input.source_ticket_id}/${encodeURIComponent(input.target_ticket_number)}`,
      );
      return jsonResult({ merged: true, result });
    }),
  );

  // ----------------------------------------------------------- mass update ---
  /**
   * What the agent UI's bulk form offers, and nothing else.
   *
   * `App.TicketBulkForm` filters the article-type select down to a single option
   * — `articleTypeFilter` returns `[note]` and discards the rest — so a mass
   * update in Zammad can never send mail. What remains is the Comment textarea
   * and the public/internal select, which is exactly this schema.
   *
   * `.strict()` rather than the usual permissive object: one article is applied
   * to every ticket in the batch, so `to`/`cc` would address one recipient list
   * to a hundred different customers, and `attachments` would copy the same file
   * onto all of them. Dropping those keys quietly — which a non-strict parse does
   * — would tell the caller the batch succeeded as asked. Refusing them says what
   * happened.
   */
  const massArticleSchema = z
    .object({
      body: z.string().min(1).describe('The note to add to every ticket in the batch.'),
      internal: z
        .boolean()
        .default(true)
        .describe('true keeps the note invisible to the customer. Defaults to true, as elsewhere.'),
    })
    .strict();

  // `tags` is absent here for the same reason it is absent from the update:
  // Zammad drops it. Verified against 7.1.1 — a mass update carrying
  // `{tags: "a,b", state: "closed"}` closes every ticket and tags none of them,
  // and answers 200. There is no `add_tags` counterpart either: Zammad's own
  // bulk form has no tag field, and one tag call per ticket per tag is a
  // different operation from a batch. Tag per ticket with `zammad_update_ticket`.
  const massUpdateInput = z.object({
    ticket_ids: z.array(z.number().int().positive()).min(1).max(500),
    ...updatableAttributes,
    article: massArticleSchema
      .optional()
      .describe(
        "A note to add to every ticket in the batch. Only a note: Zammad's own bulk form offers no other " +
          `article type, so use zammad_create_article per ticket to reply by email. ${HTML_BODY_NOTE}`,
      ),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_mass_update_tickets',
    {
      title: 'Update many Zammad tickets at once',
      description:
        'Apply the same attribute changes (and optionally the same note) to a batch of tickets in one request. ' +
        'Zammad processes the batch in the background, so the response confirms acceptance rather than completion.\n\n' +
        "The article is a note and only a note, as in the agent UI's own bulk form — one article is applied to " +
        'every ticket, so there is no sensible recipient for an email. Reply per ticket with zammad_create_article. ' +
        'The note body may use `@@jane@acme.com` / `@@jdoe` / `@@"Jane Doe"` to mention and notify a colleague.',
      inputSchema: massUpdateInput.strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async (rawInput) => {
      const input = massUpdateInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);

      const attributes = ticketPayload(input);
      let mentioned: MentionedUser[] = [];
      let article: Record<string, unknown> | undefined;

      if (input.article) {
        const mentions = await rewriteMentions(input.article.body, authoredContentType(input.article.body), {
          client: context.client,
          lookup: context.lookup,
          zammadUrl: context.config.ZAMMAD_URL,
        });
        article = {
          body: ensureHtml(mentions.body, mentions.content_type),
          content_type: 'text/html',
          // Fixed, not taken from the caller: the bulk form has no other choice.
          type: 'note',
          sender: 'Agent',
          internal: input.article.internal,
        };
        mentioned = mentions.mentioned;
      }

      if (Object.keys(attributes).length === 0 && !article) {
        throw new ToolInputError('Nothing to update — pass at least one attribute or an article.');
      }

      // `article` is a top-level parameter, not part of `attributes`.
      // `TicketsMassController#update` reads `params[:article]` and passes it to
      // `article_create`, while `attributes` goes through `clean_update_params`,
      // which drops anything that is not a ticket column. Nesting it there —
      // which is what this did — returned 200 and silently wrote no article at
      // all. Verified against a real instance both ways.
      const result = await context.client.post<unknown>('/api/v1/tickets/mass_update', {
        ticket_ids: input.ticket_ids,
        attributes,
        ...(article ? { article } : {}),
      });
      return jsonResult({
        submitted: true,
        ticket_count: input.ticket_ids.length,
        result,
        ...(mentioned.length > 0 ? { mentioned } : {}),
      });
    }),
  );

  const macroNames = vocabulary.macros.map((macro) => macro.name);
  const macroInput = z.object({
    ticket_ids: z.array(z.number().int().positive()).min(1).max(500),
    macro:
      macroNames.length > 0
        ? z
            .union([
              z.enum(macroNames as [string, ...string[]]),
              z.string().min(1),
              z.number().int().positive(),
            ])
            .describe('Macro name or numeric ID. The names are read live from this Zammad instance.')
        : z.union([z.string().min(1), z.number().int().positive()]).describe('Macro name or numeric ID.'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_apply_macro',
    {
      title: 'Apply a Zammad macro to tickets',
      description:
        'Run a stored macro against one or more tickets. Macros bundle the attribute changes and notes an agent ' +
        'would otherwise apply by hand.',
      inputSchema: macroInput.strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async (rawInput) => {
      const input = macroInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const macroId = await context.lookup.resolveMacro(input.macro);
      const result = await context.client.post<unknown>('/api/v1/tickets/mass_macro', {
        ticket_ids: input.ticket_ids,
        macro_id: macroId,
      });
      return jsonResult({ submitted: true, macro_id: macroId, result });
    }),
  );

  // ------------------------------------------------------------- ancillary ---
  const historyInput = z.object({
    ticket_id: z.number().int().positive(),
    body_format: bodyFormat,
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_get_ticket_history',
    {
      title: "Get a Zammad ticket's change history",
      description:
        'Every recorded change on a ticket — who changed what, when. Useful for auditing and for ' +
        'reconstructing how a ticket reached its current state. Zammad bundles the referenced articles into the ' +
        'response, so their bodies are rendered here too.',
      inputSchema: historyInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = historyInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const history = await context.client.get<HistoryResponse>(`/api/v1/ticket_history/${input.ticket_id}`);
      return jsonResult(renderHistoryAssets(history, input.body_format));
    }),
  );

  const relatedInput = z.object({
    ticket_id: z.number().int().positive(),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_get_related_tickets',
    {
      title: 'Get tickets related to a Zammad ticket',
      description:
        'Tickets Zammad considers similar to the given one, plus its linked tickets. Good for spotting ' +
        'duplicates before answering.',
      inputSchema: relatedInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = relatedInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const related = await context.client.get<unknown>(`/api/v1/ticket_related/${input.ticket_id}`);
      return jsonResult(related);
    }),
  );

  // No `zammad_get_customer_tickets`. It wrapped `/api/v1/ticket_customer` —
  // the customer sidebar's open/closed split — which `zammad_search_tickets`
  // already answers with `customer` plus `state`, a filter it documents and
  // resolves by login or email. A second tool for one preset combination of
  // arguments is a tool to choose wrongly between, and the preset is the part a
  // caller can supply.
  server.registerTool(
    'zammad_get_recent_tickets',
    {
      title: 'Get recently viewed Zammad tickets',
      description:
        'The tickets the authenticated user opened most recently, newest first. A quick way to answer ' +
        '"what was I just working on" without a search.',
      inputSchema: z.object({ limit: z.number().int().positive().max(50).default(10) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const { limit } = z.object({ limit: z.number().int().positive().max(50).default(10) }).parse(rawInput);
      const result = await base.client.get<unknown>('/api/v1/ticket_recent', { limit });
      return jsonResult(result);
    }),
  );

  // No `zammad_add_ticket_tags` / `zammad_remove_ticket_tags`. Their endpoints
  // are still what runs — see applyTags — but as `add_tags` / `remove_tags` on
  // `zammad_update_ticket`, where tagging usually travels anyway: a triage step
  // is a state change and a tag, and that was two calls that could half-succeed
  // with nothing able to say so. Folding them in also retires the trap that
  // `tags` on an update was, which Zammad accepted and ignored.

  // ----------------------------------------------------------------- links ---
  const linkInput = z.object({
    ticket_id: z
      .number()
      .int()
      .positive()
      .describe('Source ticket ID. The relationship is created from this ticket to target_ticket_id.'),
    target_ticket_id: z
      .number()
      .int()
      .positive()
      .describe('Target ticket ID. Its relationship to ticket_id is defined by type.'),
    type: z
      .enum(['normal', 'parent', 'child'])
      .default('normal')
      .describe(
        'Target role relative to ticket_id: normal = peer, parent = target is the parent, child = target is the child.',
      ),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_link_tickets',
    {
      title: 'Link two Zammad tickets',
      description:
        "Create a link between two tickets. `type` describes the target's role relative to the source: `child` makes " +
        'the target a child of the source.',
      inputSchema: linkInput.strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = linkInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const sourceTicket = await context.client.get<{ number?: string }>(
        `/api/v1/tickets/${input.ticket_id}`,
      );
      if (!sourceTicket.number) {
        throw new ToolInputError(`Ticket ${input.ticket_id} has no ticket number and cannot be linked.`);
      }
      const result = await context.client.post<unknown>('/api/v1/links/add', {
        link_type: input.type,
        link_object_source: 'Ticket',
        link_object_source_number: sourceTicket.number,
        link_object_target: 'Ticket',
        link_object_target_value: input.target_ticket_id,
      });
      return jsonResult({ linked: true, result });
    }),
  );

  server.registerTool(
    'zammad_unlink_tickets',
    {
      title: 'Remove a link between two Zammad tickets',
      description:
        'Remove an existing link between two tickets. The tickets themselves are untouched; only the ' +
        'relationship is deleted.',
      inputSchema: linkInput.strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = linkInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const result = await context.client.delete<unknown>('/api/v1/links/remove', undefined, {
        link_type: input.type,
        link_object_source: 'Ticket',
        link_object_source_value: input.ticket_id,
        link_object_target: 'Ticket',
        link_object_target_value: input.target_ticket_id,
      });
      return jsonResult({ unlinked: true, result });
    }),
  );

  server.registerTool(
    'zammad_list_ticket_links',
    {
      title: "List a Zammad ticket's links",
      description:
        'Show the tickets linked to a ticket, grouped by link type (normal, parent, child). Useful for ' +
        'following a chain of related incidents.',
      inputSchema: z.object({ ticket_id: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const { ticket_id } = z.object({ ticket_id: z.number().int().positive() }).parse(rawInput);
      const links = await base.client.get<unknown>('/api/v1/links', {
        link_object: 'Ticket',
        link_object_value: ticket_id,
      });
      return jsonResult(links);
    }),
  );

  // -------------------------------------------------------- time accounting ---
  server.registerTool(
    'zammad_list_time_accounting',
    {
      title: 'List time entries on a Zammad ticket',
      description:
        'All recorded time units booked against a ticket, with who logged them and when. Use it to check ' +
        'billable effort before invoicing or closing.',
      inputSchema: z.object({ ticket_id: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const { ticket_id } = z.object({ ticket_id: z.number().int().positive() }).parse(rawInput);
      const entries = await base.client.get<unknown>(`/api/v1/tickets/${ticket_id}/time_accountings`);
      return jsonResult(entries);
    }),
  );

  const timeInput = z.object({
    ticket_id: z.number().int().positive(),
    time_unit: z.union([z.number(), z.string()]).describe('Amount of time, e.g. 15 or "15".'),
    ticket_article_id: z.number().int().positive().optional(),
    type_id: z.number().int().positive().optional().describe('Activity type ID, if the instance uses them.'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_create_time_accounting',
    {
      title: 'Record time on a Zammad ticket',
      description: 'Book time units against a ticket, optionally tied to a specific article.',
      inputSchema: timeInput.strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = timeInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const entry = await context.client.post<unknown>(
        `/api/v1/tickets/${input.ticket_id}/time_accountings`,
        {
          time_unit: String(input.time_unit),
          ...(input.ticket_article_id ? { ticket_article_id: input.ticket_article_id } : {}),
          ...(input.type_id ? { type_id: input.type_id } : {}),
        },
      );
      return jsonResult({ created: true, entry });
    }),
  );
}
