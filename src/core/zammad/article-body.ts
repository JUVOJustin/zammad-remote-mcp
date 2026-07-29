/**
 * Article bodies as a model should see them.
 *
 * Zammad stores most email articles as `text/html`, and on a real instance that
 * markup is the overwhelming majority of the payload — measured over 377
 * articles from a live instance, rendering cut 2.04M characters of stored body
 * to 290K, a 86% reduction. Worse than the volume, 43% of those articles
 * exceeded the 4000-character body cap and were truncated mid-markup, so a model
 * received a screenful of `<div style=…>` and none of the message — which is
 * what pushes it into re-fetching the same article through `zammad_get_article`.
 * After rendering, 5% reach the cap.
 *
 * Two things are dropped besides the tags, both keyed off structure that Zammad
 * itself emits rather than off guessed wording:
 *
 *   - `<blockquote>` — the quoted reply. In a ticket thread that text is by
 *     definition already present as an earlier article, so repeating it once per
 *     reply is pure duplication.
 *   - The signature block, marked by `<span class="js-signatureMarker">` or a
 *     `data-signature` attribute.
 *
 * The order is deliberate: quotes go first, then the signature is located in
 * what remains. 18% of customer replies carry a signature marker *inside* the
 * quoted section (their own copy of our outgoing mail), and cutting at the first
 * marker without dequoting first would truncate at that copy instead.
 *
 * Signatures that carry no Zammad marker — a foreign sender's legal footer, for
 * instance — are left alone. Detecting those means matching on wording
 * ("Amtsgericht", "Mit freundlichen Grüßen"), which is not reliable enough to
 * risk cutting real content.
 */

export type BodyFormat = 'text' | 'html';

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
const INVISIBLE = /<(script|style|head|title)[\s\S]*?<\/\1>/gi;

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

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  lsquo: '‘',
  rsquo: '’',
  euro: '€',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity];
    return named !== undefined ? named : match;
  });
}

/**
 * Keep the destination of a link when it is not already the visible text.
 * 90% of the HTML articles measured contained anchors, and two thirds of those
 * pointed somewhere the anchor text did not name — dropping the href would lose
 * the URL a support thread is often about.
 */
function unwrapAnchors(html: string): string {
  return html.replace(
    /<a\s[^>]*href=(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (match, _quote: string, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      const target = href.trim();
      if (!target || /^(mailto:|cid:|#|javascript:)/i.test(target)) return text || match;
      if (!text) return target;
      // `text` is often a shortened rendering of the same URL.
      if (text === target || target.includes(text) || text.includes(target)) return target;
      return `${text} (${target})`;
    },
  );
}

function htmlToText(html: string): string {
  let text = html.replace(INVISIBLE, '');
  text = unwrapAnchors(text);
  // Attachments are reported separately, so inline images add nothing here.
  text = text.replace(/<img\b[^>]*>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol)>/gi, '\n');
  text = text.replace(/<\/(td|th)>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[^\S\n]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/**
 * Stands in for a kept quote while the surrounding markup is turned into text.
 * NUL delimits it because it cannot appear in article text and is not
 * whitespace, so neither the tag stripping nor the whitespace collapsing in
 * `htmlToText` can damage one or accidentally produce one.
 */
const KEPT_QUOTE = /\u0000q(\d+)\u0000/g;

/**
 * Drop the blockquotes that are quoted replies and set the ambiguous ones aside
 * to be re-inserted as text, so that a customer who used a blockquote to quote a
 * document or an error message keeps it.
 */
function removeQuotedReplies(html: string): { html: string; removed: boolean; kept: string[] } {
  const spans = topLevelBlockquotes(html);
  if (spans.length === 0) return { html, removed: false, kept: [] };

  const kept: string[] = [];
  let out = '';
  let cursor = 0;
  let removed = false;

  for (const span of spans) {
    out += html.slice(cursor, span.start);
    // A blockquote is a block: whatever replaces it has to keep the line break
    // it used to provide, or the text either side runs together.
    out += '\n';
    if (isQuotedReply(span, html)) {
      removed = true;
    } else {
      out += `\u0000q${kept.length}\u0000`;
      kept.push(span.inner);
    }
    out += '\n';
    cursor = span.end;
  }
  return { html: out + html.slice(cursor), removed, kept };
}

/** Render the quotes that survived, marked with `>` so they read as quotations. */
function reinsertKeptQuotes(text: string, kept: string[]): string {
  if (kept.length === 0) return text;
  return text
    .replace(KEPT_QUOTE, (_match, index: string) => {
      const quoted = htmlToText(kept[Number(index)] ?? '');
      if (!quoted) return '';
      return quoted
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    })
    .trim();
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
  format: BodyFormat = 'text',
): RenderedBody {
  if (typeof body !== 'string' || body.length === 0) return { body: '', omitted: [] };
  if (format === 'html' || contentType !== 'text/html') {
    return { body: format === 'html' ? body : body.trim(), omitted: [] };
  }

  const quotes = removeQuotedReplies(body);
  const marker = SIGNATURE.exec(quotes.html);
  const withoutSignature = marker ? quotes.html.slice(0, marker.index) : quotes.html;

  /**
   * Progressively put back what was cut, rather than return nothing: an article
   * whose entire body is a signature — or a quote — is better shown in full than
   * shown as empty. `omitted` always describes the candidate that won, so it can
   * never claim a removal that was undone.
   */
  const candidates: Array<{ html: string; kept: string[]; omitted: OmittedPart[] }> = [
    {
      html: withoutSignature,
      kept: quotes.kept,
      omitted: [
        ...(quotes.removed ? (['quoted_reply'] as const) : []),
        ...(marker ? (['signature'] as const) : []),
      ],
    },
    { html: quotes.html, kept: quotes.kept, omitted: quotes.removed ? ['quoted_reply'] : [] },
    { html: body, kept: [], omitted: [] },
  ];

  for (const candidate of candidates) {
    const text = reinsertKeptQuotes(htmlToText(candidate.html), candidate.kept);
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
