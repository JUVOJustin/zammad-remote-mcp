import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bytesToBase64, textFromBytes } from '../../util/base64.js';
import { rewriteMentions } from '../../zammad/mentions.js';
import type { ToolContext } from '../context.js';
import { withOnBehalfOf } from '../context.js';
import { guard, jsonResult, presentArticle, textResult, withRenderedBody } from '../result.js';

const onBehalfOf = z
  .string()
  .optional()
  .describe('Perform the action as another Zammad user (login, email or ID). Requires admin privileges.');

/**
 * Whether the caller wants the presented object or Zammad's untouched one.
 * `full` is the escape hatch the old `raw_article` field used to be, except it
 * is now asked for rather than always attached.
 */
const outputShape = z
  .enum(['summary', 'full'])
  .default('summary')
  .describe(
    'Leave this at `summary`: it is everything Zammad returned minus its internal bookkeeping and the numeric ' +
      'twins of fields that are already spelled out (`sender_id` next to `sender`). Custom fields are included. ' +
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

export function registerArticleTools(server: McpServer, base: ToolContext): void {
  const listInput = z.object({
    ticket_id: z.number().int().positive(),
    limit: z.number().int().positive().max(200).default(50),
    body_format: bodyFormat,
    include_internal: z.boolean().default(true),
    output: outputShape,
  });

  server.registerTool(
    'zammad_list_ticket_articles',
    {
      title: "List a Zammad ticket's articles",
      description:
        'The full conversation on a ticket, oldest first. Bodies are rendered as Markdown with the quoted reply ' +
        'and signature removed. Bodies are returned in full, as Zammad stores them.',
      inputSchema: listInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = listInput.parse(rawInput);
      const articles = await base.client.get<Record<string, unknown>[]>(
        `/api/v1/ticket_articles/by_ticket/${input.ticket_id}`,
        { expand: true },
      );

      let rows = Array.isArray(articles) ? articles : [];
      if (!input.include_internal) rows = rows.filter((a) => a.internal !== true);

      const limited = rows.slice(-input.limit);
      return jsonResult({
        ticket_id: input.ticket_id,
        total: rows.length,
        returned: limited.length,
        articles:
          input.output === 'full'
            ? limited.map((a) => withRenderedBody(a, input.body_format))
            : limited.map((a) => presentArticle(a, { bodyFormat: input.body_format })),
      });
    }),
  );

  const getArticleInput = z.object({
    article_id: z.number().int().positive(),
    body_format: bodyFormat,
    output: outputShape,
  });

  server.registerTool(
    'zammad_get_article',
    {
      title: 'Get a single Zammad article',
      description:
        'Fetch one article by ID with its full body and attachment metadata. Attachment IDs from here are what ' +
        'zammad_download_attachment takes.',
      inputSchema: getArticleInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = getArticleInput.parse(rawInput);

      const article = await base.client.get<Record<string, unknown>>(
        `/api/v1/ticket_articles/${input.article_id}`,
        { expand: true },
      );
      return jsonResult({
        article:
          input.output === 'full'
            ? withRenderedBody(article, input.body_format)
            : presentArticle(article, { bodyFormat: input.body_format }),
      });
    }),
  );

  const createInput = z.object({
    ticket_id: z.number().int().positive(),
    body: z.string().min(1),
    subject: z.string().optional(),
    type: z
      .enum(['note', 'email', 'phone', 'web', 'sms', 'chat', 'fax'])
      .default('note')
      .describe('`email` sends a real message to the recipients — `note` only records text on the ticket.'),
    sender: z.enum(['Agent', 'Customer', 'System']).default('Agent'),
    internal: z
      .boolean()
      .default(true)
      .describe(
        'true keeps the article hidden from the customer. Defaults to true so nothing is published by accident.',
      ),
    content_type: z.enum(['text/plain', 'text/html']).default('text/plain'),
    to: z.string().optional().describe('Recipients — required for outbound email articles.'),
    cc: z.string().optional(),
    in_reply_to: z.string().optional(),
    time_unit: z.string().optional(),
    origin_by: z.string().optional().describe('Credit the article to another user (login/email).'),
    body_format: bodyFormat,
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1),
          data: z.string().min(1).describe('Base64-encoded content.'),
          'mime-type': z.string().min(1).default('application/octet-stream'),
        }),
      )
      .optional(),
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_create_article',
    {
      title: 'Add an article to a Zammad ticket',
      description:
        'Append a note, reply or logged phone call to a ticket. An article with `type: "email"` and ' +
        '`internal: false` is actually delivered to the addresses in `to`/`cc`; the defaults (`note`, internal) ' +
        'record text without notifying anyone.\n\n' +
        'Mention a colleague by writing `@@jane@acme.com`, `@@jdoe` or `@@"Jane Doe"` in the body — they are ' +
        'linked and notified. Keep such a note `internal: true`, or the customer sees the mention too.',
      inputSchema: createInput.strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    guard(async (rawInput) => {
      const input = createInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);

      // `@@name` is rewritten into the anchor Zammad recognises; its own
      // create-callback turns that into the mention and the notification.
      const mentions = await rewriteMentions(input.body, input.content_type, {
        client: context.client,
        lookup: context.lookup,
        zammadUrl: base.config.ZAMMAD_URL,
      });

      const body: Record<string, unknown> = {
        ticket_id: input.ticket_id,
        body: mentions.body,
        type: input.type,
        sender: input.sender,
        internal: input.internal,
        content_type: mentions.content_type,
      };
      for (const key of ['subject', 'to', 'cc', 'in_reply_to', 'time_unit', 'origin_by'] as const) {
        if (input[key] !== undefined) body[key] = input[key];
      }
      if (input.attachments?.length) body.attachments = input.attachments;

      const article = await context.client.post<Record<string, unknown>>('/api/v1/ticket_articles', body);
      return jsonResult({
        created: true,
        article: presentArticle(article, { bodyFormat: input.body_format }),
        ...(mentions.mentioned.length > 0 ? { mentioned: mentions.mentioned } : {}),
      });
    }),
  );

  const updateInput = z.object({
    article_id: z.number().int().positive(),
    internal: z.boolean().optional().describe('Toggle customer visibility.'),
    subject: z.string().optional(),
    body: z.string().optional(),
    body_format: bodyFormat,
    on_behalf_of: onBehalfOf,
  });

  server.registerTool(
    'zammad_update_article',
    {
      title: 'Update a Zammad article',
      description:
        'Change an existing article. Zammad restricts what may be edited after creation — toggling `internal` is ' +
        'always allowed, editing the body may not be. Note that `@@name` mentions are only ever resolved on ' +
        'creation, so adding one here does not link or notify anyone — use zammad_create_article instead.',
      inputSchema: updateInput.strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = updateInput.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);

      const body: Record<string, unknown> = {};
      for (const key of ['internal', 'subject', 'body'] as const) {
        if (input[key] !== undefined) body[key] = input[key];
      }
      const article = await context.client.put<Record<string, unknown>>(
        `/api/v1/ticket_articles/${input.article_id}`,
        body,
      );
      return jsonResult({
        updated: true,
        article: presentArticle(article, { bodyFormat: input.body_format }),
      });
    }),
  );

  server.registerTool(
    'zammad_delete_article',
    {
      title: 'Delete a Zammad article',
      description:
        'Remove an article from a ticket. Zammad only permits this within a short window after creation ' +
        '(10 minutes by default) and only for the author.',
      inputSchema: z
        .object({
          article_id: z.number().int().positive(),
          confirm: z.literal(true).describe('Must be true — deletion cannot be undone.'),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = z
        .object({ article_id: z.number().int().positive(), confirm: z.literal(true) })
        .parse(rawInput);
      await base.client.delete(`/api/v1/ticket_articles/${input.article_id}`);
      return textResult(`Article ${input.article_id} deleted.`);
    }),
  );

  server.registerTool(
    'zammad_get_article_plain',
    {
      title: 'Get the raw source of a Zammad email article',
      description:
        'The original RFC822 message for an email article, headers included. Useful for tracing delivery ' +
        'problems.',
      inputSchema: z.object({ article_id: z.number().int().positive() }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const { article_id } = z.object({ article_id: z.number().int().positive() }).parse(rawInput);
      const response = await base.client.request<Response>(`/api/v1/ticket_article_plain/${article_id}`, {
        raw: true,
      });
      const text = await response.text();
      return textResult(text.slice(0, 100_000));
    }),
  );

  const attachmentInput = z.object({
    ticket_id: z.number().int().positive(),
    article_id: z.number().int().positive(),
    attachment_id: z.number().int().positive(),
    encoding: z
      .enum(['text', 'base64'])
      .default('text')
      .describe('`text` for readable files; `base64` for binaries such as images or PDFs.'),
    max_bytes: z.number().int().positive().max(5_000_000).default(500_000),
  });

  server.registerTool(
    'zammad_download_attachment',
    {
      title: 'Download a Zammad attachment',
      description:
        "Fetch an attachment's contents. Attachment IDs come from the `attachments` array on an article. Large " +
        'files are truncated at `max_bytes`.',
      inputSchema: attachmentInput.strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = attachmentInput.parse(rawInput);
      const response = await base.client.request<Response>(
        `/api/v1/ticket_attachment/${input.ticket_id}/${input.article_id}/${input.attachment_id}`,
        { raw: true },
      );

      const bytes = new Uint8Array(await response.arrayBuffer());
      const truncated = bytes.length > input.max_bytes;
      const slice = truncated ? bytes.subarray(0, input.max_bytes) : bytes;

      return jsonResult({
        content_type: response.headers.get('content-type'),
        bytes: bytes.length,
        truncated,
        encoding: input.encoding,
        content: input.encoding === 'base64' ? bytesToBase64(slice) : textFromBytes(slice),
      });
    }),
  );
}
