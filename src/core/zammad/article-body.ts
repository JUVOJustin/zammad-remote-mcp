import TurndownService from 'turndown';

/**
 * Article bodies as a model should read them: Markdown, not stored markup.
 *
 * Zammad keeps most email articles as `text/html`, and on a live instance that
 * markup is the bulk of the payload. Measured over 377 real articles, rendering
 * cut 2.04M characters of stored body to 244K. Volume was the smaller problem:
 * 43% of those articles exceeded the 4000-character body cap and were truncated
 * mid-markup, so a model received a screenful of `<div style=…>` and none of the
 * message — then re-fetched the same article to look for it. After rendering, 2%
 * reach the cap.
 *
 * Markdown rather than plain text because it costs almost nothing and keeps
 * meaning: headings, lists, link targets and quote levels survive, where a flat
 * text pass throws them away.
 *
 * Two things are dropped besides the tags, both keyed off structure rather than
 * off guessed wording:
 *
 *   - Quoted replies. In a ticket thread that text is already present as an
 *     earlier article, so repeating it once per reply is duplication. Only
 *     blockquotes that identify themselves as citations, open with a mail
 *     client's attribution line, or trail the message are removed — a customer
 *     quoting an error message keeps it, rendered as a Markdown quote.
 *   - The signature block, marked by `<span class="js-signatureMarker">` or a
 *     `data-signature` attribute.
 *
 * The order is deliberate: quotes go first, then the signature is located in
 * what remains. 18% of customer replies carry a signature marker *inside* the
 * quoted copy of our own outgoing mail, and cutting at the first marker without
 * dequoting first would truncate there instead.
 *
 * Signatures with no Zammad marker — a foreign sender's legal footer — are left
 * alone. Recognising those means matching on wording ("Amtsgericht" appears in
 * 64% of bodies), which is not reliable enough to risk cutting real content.
 *
 * On Cloudflare Workers turndown needs its bundled DOM rather than the host's;
 * see the `alias` block in examples/cloudflare/wrangler.jsonc.
 */

export type BodyFormat = 'markdown' | 'html';

/** What the text rendering removed. Surfaced so a model knows text is missing. */
export type OmittedPart = 'quoted_reply' | 'signature';

export interface RenderedBody {
  body: string;
  omitted: OmittedPart[];
}

/**
 * Any tag carrying Zammad's signature marker. Tag-agnostic on purpose: the
 * instance emits `<span class="js-signatureMarker">`, `<div data-signature="true"
 * data-signature-id="1">` and a bare `<div data-signature-id="1">`.
 *
 * Deliberately not extended with foreign markers such as `gmail_signature` or
 * `moz-cite-prefix`: Zammad's inbound sanitizer drops class attributes it does
 * not own. Across 167 inbound articles the only class that survived storage was
 * `js-signatureMarker`, so matching on other clients' names would be dead code.
 */
const SIGNATURE = /<[a-z]+[^>]*(?:js-signatureMarker|data-signature)[^>]*>/i;

const BLOCKQUOTE_TAG = /<(\/)?blockquote\b([^>]*)>/gi;
const CITE_ATTR = /type=["']?cite/i;
/**
 * The line a mail client writes above a quoted reply — "Am … schrieb …",
 * "On … wrote:", or a forwarded-header block. It sits *inside* the blockquote,
 * at its start, not before it.
 */
const ATTRIBUTION =
  /^[\s\S]{0,40}?(?:Am\s[\s\S]{0,90}?schrieb|On\s[\s\S]{0,90}?wrote|Le\s[\s\S]{0,90}?écrit|El\s[\s\S]{0,90}?escribió|Op\s[\s\S]{0,90}?schreef|(?:Von|From|Betreff|Subject|Gesendet|Sent|Datum|Date):\s)/i;

interface QuoteSpan {
  start: number;
  end: number;
  attrs: string;
  inner: string;
}

/**
 * Outermost `<blockquote>` elements, found by counting depth rather than by a
 * non-greedy regex — real reply chains nest, and the deepest seen on a live
 * instance was 13 levels. A regex would match the outer opening tag against the
 * innermost closing tag and mangle everything between.
 */
function topLevelBlockquotes(html: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  let depth = 0;
  let start = -1;
  let attrs = '';

  BLOCKQUOTE_TAG.lastIndex = 0;
  let match = BLOCKQUOTE_TAG.exec(html);
  while (match !== null) {
    const closing = match[1] === '/';
    if (closing) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        const end = match.index + match[0].length;
        spans.push({ start, end, attrs, inner: html.slice(start, end) });
        start = -1;
      }
    } else {
      if (depth === 0) {
        start = match.index;
        attrs = match[2] ?? '';
      }
      depth += 1;
    }
    match = BLOCKQUOTE_TAG.exec(html);
  }
  return spans;
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this blockquote a quoted reply, or is it the customer quoting something
 * for emphasis? Only the first is safe to drop, so the ambiguous case is kept.
 *
 * Removed when the element says so itself (`type="cite"`), when it opens with a
 * mail client's attribution line, or when nothing follows it — top-posting puts
 * the reply above the quote, so a trailing blockquote is the thread history.
 */
function isQuotedReply(span: QuoteSpan, html: string): boolean {
  if (CITE_ATTR.test(span.attrs)) return true;
  if (ATTRIBUTION.test(visibleText(span.inner))) return true;

  // "Nothing follows" has to look past a trailing signature, which is what
  // normally sits below a top-posted reply. Anything else counts as content, no
  // matter how short — a reply can be a single word, and keeping a quote only
  // costs bytes whereas dropping one loses text. Only the bare "--" delimiter is
  // tolerated, since that introduces a signature rather than being one.
  let tail = html.slice(span.end);
  const signature = SIGNATURE.exec(tail);
  if (signature) tail = tail.slice(0, signature.index);
  return /^[-–—.\s]*$/.test(visibleText(tail));
}

/**
 * One service for the whole process. Turndown holds no per-conversion state, and
 * the rules below exist because the defaults are wasteful on support mail.
 */
const markdown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  // The default renders <br> as two trailing spaces, which is invisible noise.
  br: '',
});

markdown.remove(['script', 'style', 'head', 'title']);

// Attachments are reported separately, so an inline image adds nothing here.
markdown.addRule('dropImages', { filter: 'img', replacement: () => '' });

/**
 * A link whose text already is its target needs no markdown wrapper — the
 * default would print the URL twice. 90% of the measured articles contained
 * anchors and a third of those were self-linking, so this is not an edge case.
 */
markdown.addRule('links', {
  filter: (node) => node.nodeName === 'A' && Boolean(node.getAttribute('href')),
  replacement: (content, node) => {
    const href = ((node as HTMLElement).getAttribute('href') ?? '').trim();
    const text = content.trim();
    if (!href || /^(mailto:|cid:|#|javascript:)/i.test(href)) return text;
    if (!text) return href;
    if (text === href || href.includes(text) || text.includes(href)) return href;
    return `[${text}](${href})`;
  },
});

/**
 * Emphasis in a support mail is almost always styling rather than meaning —
 * a coloured brand word, a bolded greeting. Marking it up costs characters and
 * tells a model nothing, so the text is kept and the markers are not.
 */
markdown.addRule('plainEmphasis', {
  filter: ['b', 'strong', 'i', 'em'],
  replacement: (content) => content,
});

function toMarkdown(html: string): string {
  let text: string;
  try {
    text = markdown.turndown(html);
  } catch {
    // Never fail a ticket read because one body would not convert.
    text = html.replace(/<[^>]+>/g, ' ');
  }
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Drop the blockquotes that are quoted replies, leaving the ambiguous ones in
 * place so that a customer who quoted a document or an error message keeps it.
 * Turndown renders whatever survives with `>` markers of its own.
 */
function removeQuotedReplies(html: string): { html: string; removed: boolean } {
  const spans = topLevelBlockquotes(html);
  if (spans.length === 0) return { html, removed: false };

  let out = '';
  let cursor = 0;
  let removed = false;

  for (const span of spans) {
    out += html.slice(cursor, span.start);
    if (isQuotedReply(span, html)) {
      // A blockquote is a block: keep the break it used to provide, or the text
      // either side runs together.
      out += '\n';
      removed = true;
    } else {
      out += span.inner;
    }
    cursor = span.end;
  }
  return { html: out + html.slice(cursor), removed };
}

/**
 * Render one article body for a model.
 *
 * `format: 'html'` returns the stored body untouched — the escape hatch for
 * when the markup itself is what is being debugged.
 */
export function renderArticleBody(
  body: string | undefined,
  contentType: string | undefined,
  format: BodyFormat = 'markdown',
): RenderedBody {
  if (typeof body !== 'string' || body.length === 0) return { body: '', omitted: [] };
  if (format === 'html') return { body, omitted: [] };
  // A plain-text article is already what a model should read; running it through
  // a markdown converter would only escape its punctuation.
  if (contentType !== 'text/html') return { body: body.trim(), omitted: [] };

  const quotes = removeQuotedReplies(body);
  const marker = SIGNATURE.exec(quotes.html);
  const withoutSignature = marker ? quotes.html.slice(0, marker.index) : quotes.html;

  /**
   * Progressively put back what was cut, rather than return nothing: an article
   * whose entire body is a signature — or a quote — is better shown in full than
   * shown as empty. `omitted` always describes the candidate that won, so it can
   * never claim a removal that was undone.
   */
  const candidates: Array<{ html: string; omitted: OmittedPart[] }> = [
    {
      html: withoutSignature,
      omitted: [
        ...(quotes.removed ? (['quoted_reply'] as const) : []),
        ...(marker ? (['signature'] as const) : []),
      ],
    },
    { html: quotes.html, omitted: quotes.removed ? ['quoted_reply'] : [] },
    { html: body, omitted: [] },
  ];

  for (const candidate of candidates) {
    const text = toMarkdown(candidate.html);
    if (text) return { body: text, omitted: candidate.omitted };
  }

  // A pasted screenshot with no accompanying text renders to nothing. Saying so
  // beats returning a blank body; the images are already listed as attachments.
  const images = body.match(/<img\b[^>]*>/gi)?.length ?? 0;
  return {
    body: images > 0 ? `[no text content — ${images} inline image(s), see attachments]` : '',
    omitted: [],
  };
}
