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
 * A compact ticket row. Association *names* are preferred over IDs because they
 * are what a model needs to reason about the result; the numeric ID is kept so
 * follow-up calls can address the ticket precisely.
 */
export function summarizeTicket(ticket: TicketLike): Record<string, unknown> {
  return compact({
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    state: ticket.state ?? ticket.state_id,
    priority: ticket.priority ?? ticket.priority_id,
    group: ticket.group ?? ticket.group_id,
    owner: ticket.owner ?? ticket.owner_id,
    customer: ticket.customer ?? ticket.customer_id,
    organization: ticket.organization ?? ticket.organization_id,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    close_at: ticket.close_at,
    pending_time: ticket.pending_time,
    escalation_at: ticket.escalation_at,
    article_count: ticket.article_count,
    tags: ticket.tags,
  });
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

export function summarizeArticle(
  article: ArticleLike,
  options: { maxBodyChars?: number; bodyFormat?: BodyFormat } = {},
): Record<string, unknown> {
  const limit = options.maxBodyChars ?? 4000;
  const format = options.bodyFormat ?? 'markdown';
  const rendered = renderArticleBody(article.body, article.content_type, format);
  const body = rendered.body || undefined;

  return compact({
    id: article.id,
    ticket_id: article.ticket_id,
    type: article.type ?? article.type_id,
    sender: article.sender ?? article.sender_id,
    from: article.from,
    to: article.to,
    cc: article.cc,
    subject: article.subject,
    internal: article.internal,
    created_at: article.created_at,
    created_by: article.created_by ?? article.created_by_id,
    // Report what the model is actually reading, not how Zammad stored it.
    content_type: format === 'html' ? article.content_type : 'text/markdown',
    body:
      body && body.length > limit
        ? `${body.slice(0, limit)}\n…[truncated, ${body.length} chars total]`
        : body,
    body_omitted: rendered.omitted,
    attachments: article.attachments?.map((a) =>
      compact({
        id: a.id,
        filename: a.filename,
        size: a.size,
      }),
    ),
  });
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
