import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError } from '../util/errors.js';
import { type BodyFormat, renderArticleBody } from '../zammad/article-body.js';

/**
 * Tool results are returned as pretty-printed JSON inside a single text block.
 * That is the format every MCP client renders, and it keeps large ticket
 * payloads readable for the model without depending on structured-content
 * support.
 */
export function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: describeError(error) }],
  };
}

/**
 * Wraps a tool handler so a thrown error is reported back to the model as tool
 * output rather than as a protocol-level failure — the model can then correct
 * its arguments and retry, which matters most for the search tools.
 */
export function guard<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** Drop null/undefined/empty values so result payloads stay compact. */
export function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

export interface TicketLike {
  id?: number;
  number?: string;
  title?: string;
  state?: string;
  state_id?: number;
  priority?: string;
  priority_id?: number;
  group?: string;
  group_id?: number;
  owner?: string;
  owner_id?: number;
  customer?: string;
  customer_id?: number;
  organization?: string;
  organization_id?: number;
  created_at?: string;
  updated_at?: string;
  close_at?: string;
  pending_time?: string;
  escalation_at?: string;
  last_contact_at?: string;
  article_count?: number;
  tags?: unknown;
  [key: string]: unknown;
}

/**
 * Fields Zammad returns on a ticket that no reader needs.
 *
 * Two groups. The SLA counters and checklist plumbing are bookkeeping the web
 * interface uses and nothing else. The `*_id` entries are the other half of a
 * pair: with `expand=true` Zammad returns `group_id: 1` *and* `group: "Users"`
 * side by side, so keeping the number as well says the same thing twice — and
 * the name is what both a model and this server's own write tools address.
 *
 * `article_ids` goes for the same reason: `article_count` already says how
 * many, and the articles themselves are written out beside it.
 */
const TICKET_NOISE = new Set([
  'first_response_escalation_at',
  'first_response_in_min',
  'first_response_diff_in_min',
  'close_escalation_at',
  'close_in_min',
  'close_diff_in_min',
  'update_escalation_at',
  'update_in_min',
  'update_diff_in_min',
  'last_owner_update_at',
  'preferences',
  'checklist_id',
  'referencing_checklist_ids',
  'referencing_checklists',
  'ticket_time_accounting_ids',
  'ticket_time_accounting',
  'article_ids',
]);

/** The same idea for an article: resolved twins, and mail transport internals. */
const ARTICLE_NOISE = new Set([
  'origin_by_id',
  'message_id',
  'message_id_md5',
  'in_reply_to',
  'reply_to',
  'detected_language',
  'preferences',
  // Derived rather than copied: `presentArticle` renders the body, reports the
  // content type it actually produced, and filters the attachment list. Letting
  // the generic pass copy Zammad's versions first would mean removing them
  // again, and forgetting to is how the raw attachment array once survived.
  'body',
  'content_type',
  'attachments',
]);

/**
 * Everything Zammad sent, minus what nobody reads.
 *
 * A denylist rather than a hand-picked field list. The list this replaced kept
 * twelve fields and dropped thirty-six, which was fine until an instance added
 * an Object Manager attribute: the field simply vanished on read while the
 * write tools still accepted it. Naming what to discard means anything unknown
 * survives, which is the behaviour a general-purpose server needs.
 */
function present(object: Record<string, unknown>, noise: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (noise.has(key)) continue;
    if (isResolvedTwin(key, object)) continue;
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Is this a `<field>_id` whose `<field>` is already spelled out beside it?
 *
 * Checked against the object rather than listed by name, because the number is
 * only redundant when the name is actually there. Zammad resolves associations
 * only when the request passed `expand=true`; a response without it carries
 * `state_id: 4` and no `state` at all, and dropping the id by name would leave
 * the caller with neither. Every write endpoint here asks for `expand`, so this
 * should not come up — but it costs one lookup to make that a preference rather
 * than a requirement.
 */
function isResolvedTwin(key: string, object: Record<string, unknown>): boolean {
  if (!key.endsWith('_id')) return false;
  const resolved = object[key.slice(0, -'_id'.length)];
  return resolved !== undefined && resolved !== null && resolved !== '';
}

export function presentTicket(ticket: TicketLike): Record<string, unknown> {
  return present(ticket, TICKET_NOISE);
}

export interface ArticleLike {
  id?: number;
  ticket_id?: number;
  type?: string;
  type_id?: number;
  sender?: string;
  sender_id?: number;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  content_type?: string;
  internal?: boolean;
  created_at?: string;
  created_by?: string;
  created_by_id?: number;
  attachments?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * An article as a model should read it: everything Zammad sent minus the noise,
 * with the body rendered. See `presentTicket` for why this is a denylist.
 */
export function presentArticle(
  article: ArticleLike,
  options: { bodyFormat?: BodyFormat } = {},
): Record<string, unknown> {
  const format = options.bodyFormat ?? 'markdown';
  const rendered = renderArticleBody(article.body, article.content_type, format);
  const out = present(article, ARTICLE_NOISE);

  if (rendered.body) out.body = rendered.body;
  // Report what the model is actually reading, not how Zammad stored it.
  out.content_type = format === 'html' ? article.content_type : 'text/markdown';
  if (rendered.omitted.length > 0) out.body_omitted = rendered.omitted;

  const attachments = Array.isArray(article.attachments)
    ? article.attachments
        .filter((a) => !isAlternativePart(a))
        .map((a) => present({ id: a.id, filename: a.filename, size: a.size }, new Set()))
    : [];
  if (attachments.length > 0) out.attachments = attachments;

  return out;
}

/**
 * `message.html` is not an attachment. When a mail arrives as multipart Zammad
 * stores the HTML alternative as one, so every such article lists a file that is
 * a copy of the body already printed beside it. Across 60 tickets that was 43%
 * of all attachment entries.
 *
 * Inline images are left in place even though they are a similar share, because
 * they are the only trace a pasted screenshot leaves once `<img>` is stripped
 * from the body — an article whose body renders to nothing points at them.
 */
function isAlternativePart(attachment: Record<string, unknown>): boolean {
  const preferences = attachment.preferences as Record<string, unknown> | undefined;
  return preferences?.['content-alternative'] === true;
}

/**
 * The complete stored article, but with its body rendered.
 *
 * For the paths that hand back the whole Zammad object instead of a summary.
 * Zammad has no representation negotiation of its own — `content_type`
 * describes what is stored, and asking for `text/plain` via a query parameter
 * or an Accept header returns byte-identical HTML — so a body that leaves this
 * server un-rendered cannot be fixed anywhere downstream. Attaching the
 * rendering to `body_format` rather than to the summary keeps one switch in
 * charge of the representation, whichever shape the caller asked for.
 *
 * Unlike `summarizeArticle` this does not truncate: the caller asked for the
 * whole object, and the rendering has already removed most of the volume.
 */
export function withRenderedBody(
  article: ArticleLike,
  format: BodyFormat = 'markdown',
): Record<string, unknown> {
  if (format === 'html') return { ...article };

  const rendered = renderArticleBody(article.body, article.content_type, format);
  return {
    ...article,
    body: rendered.body,
    content_type: 'text/markdown',
    ...(rendered.omitted.length > 0 ? { body_omitted: rendered.omitted } : {}),
  };
}

export function summarizeUser(user: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: user.id,
    login: user.login,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    phone: user.phone,
    organization: user.organization ?? user.organization_id,
    department: user.department,
    active: user.active,
    vip: user.vip,
    out_of_office: user.out_of_office,
    last_login: user.last_login,
  });
}

export function summarizeOrganization(org: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: org.id,
    name: org.name,
    domain: org.domain,
    domain_assignment: org.domain_assignment,
    shared: org.shared,
    vip: org.vip,
    active: org.active,
    note: org.note,
    members: org.members,
  });
}
