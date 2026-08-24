import { htmlEscape, htmlToText } from './signature.js';

/**
 * There is no content-type argument on any writing tool. A body may be authored
 * as plain text or as markup, and what reaches Zammad is decided by the channel
 * the article is going to — HTML where the channel renders HTML, finished text
 * where it does not. See `composeBody`, which is where that choice is made.
 *
 * Why the caller does not get the knob, verified against Zammad itself:
 *
 *   - The agent UI does not offer one either. Its composer is a contenteditable
 *     in every case; the screens that write email, notes and phone articles post
 *     `text/html`, and the ones that write SMS, Telegram, Facebook and WhatsApp
 *     convert to text in the browser before posting. The channel decides, not
 *     the author, and this module makes the same decision from the same input.
 *   - Zammad derives the plain-text version of an outgoing mail itself. The
 *     article's `content_type` is the send format
 *     (`ticket_article_communicate_email_job.rb` hands body and content type
 *     to `Channel::EmailBuild` unchanged), and a `text/html` article goes out
 *     as `multipart/alternative` with a text part Zammad generates via
 *     `String#html2text` (`email_build.rb`, verified empirically). Nothing is
 *     lost by never sending `text/plain` on that channel — a text-only reader
 *     gets Zammad's rendering of the same HTML.
 *   - A format knob on a model-facing tool is an invitation to pick wrongly.
 *     The default this replaced ( `text/plain`) made every email degrade its
 *     own signature; the knob's remaining uses were edge cases nobody here
 *     sends (inline PGP, text-only gateways).
 *
 * How a body becomes HTML:
 *
 *   - A body that already carries markup — a complete tag, see
 *     `looksLikeMarkup` — is stored as it is, except for its paragraph breaks:
 *     `<p>` is the one tag the outgoing mail template flattens, so
 *     `spaceParagraphs` rewrites it into the div-and-`<br>` shape the UI writes.
 *   - Anything else is plain prose and is converted the way the UI converts
 *     pasted text (`App.Utils.text2html`, mirrored below): escaped, line
 *     breaks kept, each line a `<div>`, an empty line a `<div><br></div>`.
 *     Without the conversion a mere relabelling would collapse every line
 *     break; HTML does not read `\n`.
 *
 * Deviations from `App.Utils.text2html` (utils.coffee, stable), each because
 * the original leans on a browser dependency:
 *
 *   - the UI escapes *inside* `linkify()` (the linkifyjs library escapes text
 *     nodes while wrapping URLs in anchors). Here the text is escaped with the
 *     same `htmlEscape` the signature module uses and URLs are left as text —
 *     mail clients linkify on display, and a generated `<a>` that linkifyjs
 *     would not have generated is a worse lie than a missing one;
 *   - the UI's second CRLF normalisation after linkify is dropped: textCleanup
 *     has already removed every `\r` by then, so it cannot observe anything.
 *
 * The single-line `<span>` wrap and the multi-line `<div>` split, including
 * the `<div><br></div>` empty-line form and the two-space `&nbsp;` quirk, are
 * verbatim. That `<div>`-per-line shape is also exactly what `htmlToText`
 * (signature.ts) folds back into lines, so a converted body and a signature
 * preview read from it agree.
 */

/** `App.Utils.textCleanup`, verbatim — including the 20-newline cap. */
export function textCleanup(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .replace(/(\r\n|\n\r)/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/ \n/g, '\n')
    .replace(/\n{3,20}/g, '\n\n');
}

/** `App.Utils.text2html`, with the deviations listed in the module doc. */
export function text2html(text: string): string {
  // The original writes this as `/  /g` — two literal spaces.
  let html = htmlEscape(textCleanup(text)).replace(/ {2}/g, ' &nbsp;');
  if (html.includes('\n')) {
    html = `<div>${html.replace(/\n/g, '</div><div>')}</div>`;
    return html.replace(/<div><\/div>/g, '<div><br></div>');
  }
  return `<span>${html}</span>`;
}

/**
 * A complete HTML tag — `<p>`, `</div>`, `<br/>`, `<a href=…>` — and nothing
 * less. `<info@example.com>` in running text, a pasted `x < y` comparison, a
 * `<3` — none of these parse as a tag and none of them make a body markup.
 *
 * This rule is this codebase's own: the UI never receives an unlabelled body,
 * so there is nothing to mirror. Its known false positive is prose quoting a
 * tag-shaped placeholder like `<order>`, which is then stored as it is rather
 * than escaped — visible in the article, not destructive to it.
 */
const COMPLETE_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i;

export function looksLikeMarkup(body: string): boolean {
  return COMPLETE_TAG.test(body);
}

/**
 * The format a body was authored in — what the mention rewrite needs to know
 * before the conversion, because its `@@"Jane Doe"` quotes would not survive
 * the escaping.
 */
export function authoredContentType(body: string): 'text/plain' | 'text/html' {
  return looksLikeMarkup(body) ? 'text/html' : 'text/plain';
}

/**
 * One closed `<p>` element. Non-greedy because paragraphs do not nest — a `<p>`
 * is closed by the next `</p>`, and HTML has no valid shape where it is not.
 *
 * An unclosed `<p>`, whose end a browser infers, is not matched and is left as
 * it was: rewriting only its opening tag would emit a `<div>` nothing closes,
 * which is a worse body than a flattened one.
 */
const PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;

/** A paragraph that is a blank line rather than one holding text. */
const BLANK_PARAGRAPH = /^(?:\s|&nbsp;|<br\s*\/?>)*$/i;

/**
 * Give a `<p>`-separated body the line structure the UI would have composed.
 *
 * `<p>` is the obvious tag for a paragraph and the one a model reaches for, but
 * on an outgoing Zammad mail it is the one tag that does not separate anything.
 * `Channel::EmailBuild` wraps the article in its own template, and that template
 * ends `p { margin: 0 }` — inlined onto every element, so each paragraph goes
 * out as `<p style="margin: 0;">`. The text part is derived by `html2text`,
 * which reads `</p><p>` as a single newline. Both parts therefore lose every
 * paragraph break the author wrote; verified on article 49235, where six
 * paragraphs reached the recipient as one block in the HTML part and as six
 * unseparated lines in the text part.
 *
 * The UI never hits this because its composer writes no `<p>` at all: one
 * `<div>` per line, `<div><br></div>` for a blank one — the shape `text2html`
 * produces above. A `<br>` survives both the template's CSS and `html2text`, so
 * that is what a paragraph boundary becomes here. The paragraphs themselves
 * become divs, which under `margin: 0` is what they already rendered as.
 *
 * Only the boundary *between* two adjacent paragraphs is filled, and only when
 * neither side is already a blank one — `<p>eins</p><p><br></p><p>zwei</p>` is
 * an author asking for one empty line, not three. A trailing blank line is never
 * added: what follows the body is the signature, which brings its own `<br><br>`.
 *
 * Everything else in the body is left alone. Two paragraphs with a list between
 * them are not adjacent and get no filler; lists and headings keep the margins
 * the template leaves them; and a body already written as divs — the UI's own
 * shape, or `text2html` output — contains no `<p>` to rewrite.
 */
export function spaceParagraphs(html: string): string {
  let out = '';
  let cursor = 0;
  /** Where the previous paragraph ended, so "adjacent" can mean what it says. */
  let previousEnd = -1;
  let previousBlank = false;

  PARAGRAPH.lastIndex = 0;
  for (let match = PARAGRAPH.exec(html); match; match = PARAGRAPH.exec(html)) {
    const between = html.slice(cursor, match.index);
    const adjacent = cursor === previousEnd && between.trim() === '';
    const inner = match[1] ?? '';
    const blank = BLANK_PARAGRAPH.test(inner);

    // Whitespace between two paragraphs is the source's own indentation; the
    // break now comes from the markup, so the gap is dropped rather than kept.
    if (!adjacent) out += between;
    if (adjacent && !blank && !previousBlank) out += '<div><br></div>';
    out += blank ? '<div><br></div>' : `<div>${inner}</div>`;

    cursor = match.index + match[0].length;
    previousEnd = cursor;
    previousBlank = blank;
  }
  return out + html.slice(cursor);
}

/**
 * The body as it is written to Zammad when the channel renders HTML: markup
 * passes through with its paragraph breaks made to survive the mail template,
 * plain prose is converted. `contentType` is the authored format after the
 * mention rewrite.
 */
export function ensureHtml(body: string, contentType: string): string {
  return contentType === 'text/html' ? spaceParagraphs(body) : text2html(body);
}

/**
 * Article types whose body is transmitted as it is stored, with no conversion
 * anywhere in Zammad — so markup in it reaches the recipient as characters.
 *
 * Read off the senders rather than assumed. `Ticket::Article#body_as_text` and
 * `#body_as_html` exist, but these channels do not call them: SMS sends
 * `article.body.first(160)` (`communicate_sms_job.rb`), Telegram sends
 * `text: article.body` (`communicate_telegram_job.rb`), Facebook `body:
 * article.body` (`communicate_facebook_job.rb`) and WhatsApp the same
 * (`service/ticket/article/type/whatsapp_message/deliver.rb`). A `<div>` in any
 * of those is delivered spelled out, and on SMS it is billed and counted
 * against the 160 characters as well.
 *
 * The agent UI reaches the same conclusion in the browser: every one of these
 * composers ends `params.content_type = 'text/plain'` and
 * `params.body = App.Utils.html2text(params.body, true)` — `sms_reply.coffee`,
 * `telegram.coffee`, `facebook_reply.coffee`, `whatsapp_reply.coffee` — while
 * the email, phone and note composers post `text/html` untouched. The rule here
 * is that same split, applied server-side.
 *
 * The two Twitter types are listed although the UI no longer offers them: the
 * types still seed, and a text-only transport could not render markup anyway.
 */
const TEXT_DELIVERED = new Set([
  'sms',
  'telegram personal-message',
  'facebook feed post',
  'facebook feed comment',
  'facebook direct-message',
  'whatsapp message',
  'twitter status',
  'twitter direct-message',
]);

export interface ComposedBody {
  body: string;
  content_type: 'text/html' | 'text/plain';
}

/**
 * Why an article of this type cannot carry a `@@mention`, or `null` when it can.
 *
 * A mention is an anchor and nothing else: `Ticket::Article#check_mentions` runs
 * `Nokogiri::HTML(body).css('a[data-mention-user-id]')` on create and subscribes
 * whoever it finds. On a `TEXT_DELIVERED` type the body is finished as text
 * before it is stored, so there is no anchor left to find and nobody is
 * subscribed — the mention simply does not happen.
 *
 * That is also what the agent UI does. Its SMS, Telegram, Facebook and WhatsApp
 * composers run `App.Utils.html2text` over the composed HTML, which flattens any
 * anchor the mention picker inserted, so a mention typed into one of those
 * screens subscribes nobody either.
 *
 * Which makes a `@@` in one of these bodies a request that cannot be met, and
 * the answer is to refuse it rather than write the article and let the mention
 * quietly not happen. The caller still has its text and can send it again
 * without the mention, or put the mention where mentions work.
 */
export function mentionsNotCarried(type: string): string | null {
  if (!TEXT_DELIVERED.has(type)) return null;
  return (
    `A \`${type}\` article is stored as plain text, so the anchor Zammad reads a mention from cannot ` +
    'survive in it and nobody would be notified. Send this message without the `@@` mention, and mention ' +
    'the colleague in an internal note on the same ticket instead.'
  );
}

/**
 * The body and the content type to store, for the article type it is going to.
 *
 * Email is where HTML belongs and where it is not the end of the line: the
 * article's `content_type` is the send format, and `Channel::EmailBuild` builds
 * a `multipart/alternative` whose text part it derives itself. Notes, phone
 * articles and web articles are read in the browser, which renders HTML too.
 * Storing those as HTML keeps Zammad's own later conversion available — nothing
 * here pre-empts it.
 *
 * A `TEXT_DELIVERED` type has no later conversion to preserve, so this is the
 * one place the text has to be finished. Markup is folded into lines by the
 * same `htmlToText` the signature preview uses, mirroring the `App.Utils.
 * html2text` call the UI makes for exactly these types; prose is stored as
 * authored. `content_type` is then `text/plain`, which is also what stops
 * `body_as_text` from running a second conversion over it.
 *
 * `spaceParagraphs` runs first here too, for the reason it runs at all: a
 * paragraph boundary is a blank line, and `htmlToText` — laying markup out the
 * way a browser does — reads `</p><p>` as a single break, exactly as the mail
 * template does. Without it a `<p>`-written body would lose its paragraphs on
 * these channels as well.
 */
export function composeBody(body: string, type: string, contentType: string): ComposedBody {
  if (!TEXT_DELIVERED.has(type)) {
    return { body: ensureHtml(body, contentType), content_type: 'text/html' };
  }
  return {
    body: contentType === 'text/html' ? htmlToText(spaceParagraphs(body)) : textCleanup(body),
    content_type: 'text/plain',
  };
}

/**
 * What every writing tool tells the caller about `body`.
 *
 * `text2html` is a safety net, not a formatter. It escapes and keeps line
 * breaks, which is what a body needs to survive at all, but it renders nothing:
 * a body written in some other markup reaches the reader as the characters it
 * was typed with. So the note asks for HTML and describes what the conversion
 * does with prose, and leaves the formats it is not out of it — the pull worth
 * countering is a schema that reads as a choice between equals.
 *
 * One copy, four tools, as with `append_signature`: the rule lives with the
 * argument it qualifies. Not in the `body` field — a schema with a description
 * on every leaf is read as boilerplate — and not in the server instructions,
 * which are read on every connection whether an article is being written or not.
 */
export const HTML_BODY_NOTE =
  'Write `body` as HTML — `<p>`, `<br>`, `<b>`, `<a href="…">`, `<ul>` — the markup the agent UI composes. ' +
  'Prose without any tag is still accepted and keeps its line breaks, but it arrives unformatted; a body ' +
  'carrying any HTML tag is taken as markup wholesale. Write it that way whatever the article type: a ' +
  'channel that can only carry text, such as `sms`, is sent the text this renders to, not the tags.';
