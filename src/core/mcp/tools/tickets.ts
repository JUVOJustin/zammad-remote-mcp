import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolInputError } from '../../util/errors.js';
import type { BodyFormat } from '../../zammad/article-body.js';
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
import { singleReferenceField } from './enrich.js';

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

const attachmentSchema = z.object({
  filename: z.string().min(1),
  data: z.string().min(1).describe('Base64-encoded file content.'),
  'mime-type': z.string().min(1).default('application/octet-stream'),
});

const articleInputSchema = z.object({
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
  content_type: z.enum(['text/plain', 'text/html']).default('text/plain'),
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
});

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
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Replaces the tag list on create; on update, prefer zammad_add_ticket_tags / zammad_remove_ticket_tags.',
    ),
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
  for (const key of keys) {
    if (input[key] !== undefined) payload[key] = input[key];
  }
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
  article: z.infer<typeof articleInputSchema>,
  context: ToolContext,
): Promise<{ payload: Record<string, unknown>; mentioned: MentionedUser[] }> {
  const mentions = await rewriteMentions(article.body, article.content_type, {
    client: context.client,
    lookup: context.lookup,
    zammadUrl: context.config.ZAMMAD_URL,
  });

  const payload: Record<string, unknown> = {
    body: mentions.body,
    type: article.type,
    sender: article.sender,
    internal: article.internal,
    content_type: mentions.content_type,
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
      content_type: payload.content_type as string,
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
    article: articleInputSchema.describe('The first article of the ticket.'),
    state: attributesWithVocabulary.state,
    state_id: ticketAttributes.state_id,
    priority: attributesWithVocabulary.priority,
    priority_id: ticketAttributes.priority_id,
    owner: ticketAttributes.owner,
    owner_id: ticketAttributes.owner_id,
    organization_id: ticketAttributes.organization_id,
    pending_time: ticketAttributes.pending_time,
    tags: ticketAttributes.tags,
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
  const updateTicketInput = z.object({
    ticket_id: z.number().int().positive().optional(),
    ticket_number: z.string().min(1).optional(),
    ...attributesWithVocabulary,
    article: articleInputSchema
      .optional()
      .describe('Optional article to append as part of the same update (e.g. a reply plus a state change).'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_update_ticket',
    {
      title: 'Update a Zammad ticket',
      description:
        'Change ticket attributes (state, priority, group, owner, customer, pending time, custom fields) and ' +
        'optionally append an article in the same call. Only the fields you pass are modified. Moving a ticket into ' +
        'a pending state requires `pending_time`.\n\n' +
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

      if (Object.keys(body).length === 0) {
        throw new ToolInputError('Nothing to update — pass at least one attribute or an article.');
      }

      const ticket = await context.client.put<Record<string, unknown>>(`/api/v1/tickets/${id}`, body, {
        expand: true,
      });
      return jsonResult({
        updated: true,
        ...(signature ? { signature } : {}),
        ticket: presentTicket(ticket),
        ...(mentioned.length > 0 ? { mentioned } : {}),
      });
    }),
  );

  const customerInput = z.object({
    ticket_id: z.number().int().positive().optional(),
    ticket_number: z.string().min(1).optional(),
    customer_id: z.number().int().positive().optional(),
    customer: z.string().optional().describe('Customer login or email.'),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_update_ticket_customer',
    {
      title: 'Reassign a Zammad ticket to another customer',
      description:
        "Move a ticket to a different customer. The ticket's organization follows the new customer automatically.",
      inputSchema: customerInput.strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = customerInput.parse(rawInput);
      if (input.customer_id === undefined && !input.customer) {
        throw new ToolInputError('Provide `customer_id` or `customer`.');
      }
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const id = await resolveTicketId(context, input);

      const customerId = input.customer_id ?? (await context.lookup.resolveUsers([input.customer!]))[0];
      const ticket = await context.client.put<Record<string, unknown>>(
        `/api/v1/tickets/${id}/update_customer`,
        { customer_id: customerId },
        { expand: true },
      );
      return jsonResult({ updated: true, ticket: presentTicket(ticket) });
    }),
  );

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

  const massUpdateInput = z.object({
    ticket_ids: z.array(z.number().int().positive()).min(1).max(500),
    ...attributesWithVocabulary,
    article: massArticleSchema
      .optional()
      .describe(
        "A note to add to every ticket in the batch. Only a note: Zammad's own bulk form offers no other " +
          'article type, so use zammad_create_article per ticket to reply by email.',
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
        const mentions = await rewriteMentions(input.article.body, 'text/plain', {
          client: context.client,
          lookup: context.lookup,
          zammadUrl: context.config.ZAMMAD_URL,
        });
        article = {
          body: mentions.body,
          content_type: mentions.content_type,
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

  const customerTicketsInput = z.object({
    customer_id: z.number().int().positive().optional(),
    customer: z.string().optional().describe('Customer login or email.'),
    page: z.number().int().positive().default(1),
    per_page: z.number().int().positive().max(100).default(25),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_get_customer_tickets',
    {
      title: "Get a customer's open and closed ticket counts",
      description:
        "Zammad's customer sidebar data: the open and closed tickets belonging to one customer. For arbitrary " +
        'filtering use zammad_search_tickets with `customer`.',
      inputSchema: customerTicketsInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = customerTicketsInput.parse(rawInput);
      if (input.customer_id === undefined && !input.customer) {
        throw new ToolInputError('Provide `customer_id` or `customer`.');
      }
      const context = withOnBehalfOf(base, input.on_behalf_of);
      const customerId = input.customer_id ?? (await context.lookup.resolveUsers([input.customer!]))[0];

      const result = await context.client.get<unknown>('/api/v1/ticket_customer', {
        customer_id: customerId,
        page: input.page,
        per_page: input.per_page,
      });
      return jsonResult(result);
    }),
  );

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

  // ------------------------------------------------------------------ tags ---
  const tagInput = z.object({
    ticket_id: z.number().int().positive(),
    tags: z.array(z.string().min(1)).min(1),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_add_ticket_tags',
    {
      title: 'Add tags to a Zammad ticket',
      description:
        'Attach one or more tags. Tags that do not exist yet are created if the instance allows it.',
      inputSchema: tagInput.strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = tagInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      for (const tag of input.tags) {
        await context.client.post('/api/v1/tags/add', undefined, {
          object: 'Ticket',
          o_id: input.ticket_id,
          item: tag,
        });
      }
      const current = await context.client.get<{ tags?: string[] }>('/api/v1/tags', {
        object: 'Ticket',
        o_id: input.ticket_id,
      });
      return jsonResult({ added: input.tags, tags: current?.tags ?? [] });
    }),
  );

  server.registerTool(
    'zammad_remove_ticket_tags',
    {
      title: 'Remove tags from a Zammad ticket',
      description:
        'Detach one or more tags from a ticket. Tags not present on the ticket are ignored, so this is safe to ' +
        'call speculatively. Returns the remaining tag list.',
      inputSchema: tagInput.strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = tagInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);
      for (const tag of input.tags) {
        await context.client.delete('/api/v1/tags/remove', {
          object: 'Ticket',
          o_id: input.ticket_id,
          item: tag,
        });
      }
      const current = await context.client.get<{ tags?: string[] }>('/api/v1/tags', {
        object: 'Ticket',
        o_id: input.ticket_id,
      });
      return jsonResult({ removed: input.tags, tags: current?.tags ?? [] });
    }),
  );

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
