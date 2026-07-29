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

const QUOTE = /<blockquote[\s\S]*?<\/blockquote>/gi;
/**
 * Any tag carrying Zammad's signature marker. Tag-agnostic on purpose: the
 * instance emits `<span class="js-signatureMarker">`, `<div data-signature="true"
 * data-signature-id="1">` and a bare `<div data-signature-id="1">`.
 */
const SIGNATURE = /<[a-z]+[^>]*(?:js-signatureMarker|data-signature)[^>]*>/i;
const INVISIBLE = /<(script|style|head|title)[\s\S]*?<\/\1>/gi;

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

  const dequoted = body.replace(QUOTE, '');
  const marker = SIGNATURE.exec(dequoted);
  const withoutSignature = marker ? dequoted.slice(0, marker.index) : dequoted;

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
        ...(dequoted.length !== body.length ? (['quoted_reply'] as const) : []),
        ...(marker ? (['signature'] as const) : []),
      ],
    },
    { html: dequoted, omitted: dequoted.length !== body.length ? ['quoted_reply'] : [] },
    { html: body, omitted: [] },
  ];

  for (const candidate of candidates) {
    const text = htmlToText(candidate.html);
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
