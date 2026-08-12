import { htmlEscape } from './signature.js';

/**
 * Every article this server writes is `text/html`. There is no content-type
 * argument on any writing tool; a body may be authored as plain text or as
 * markup, and either way what reaches Zammad is HTML.
 *
 * Why this is the only mode, verified against Zammad itself:
 *
 *   - The agent UI writes nothing else. Its composer is a contenteditable and
 *     both writing screens post `text/html` — for emails, notes and phone
 *     articles alike. An API article stored as HTML is the faithful one.
 *   - Zammad derives the plain-text version of an outgoing mail itself. The
 *     article's `content_type` is the send format
 *     (`ticket_article_communicate_email_job.rb` hands body and content type
 *     to `Channel::EmailBuild` unchanged), and a `text/html` article goes out
 *     as `multipart/alternative` with a text part Zammad generates via
 *     `String#html2text` (`email_build.rb`, verified empirically). Nothing is
 *     lost by never sending `text/plain` — a text-only reader gets Zammad's
 *     rendering of the same HTML.
 *   - A format knob on a model-facing tool is an invitation to pick wrongly.
 *     The default this replaced ( `text/plain`) made every email degrade its
 *     own signature; the knob's remaining uses were edge cases nobody here
 *     sends (inline PGP, text-only gateways).
 *
 * How a body becomes HTML:
 *
 *   - A body that already carries markup — a complete tag, see
 *     `looksLikeMarkup` — is stored as it is.
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
 * The body as it is written to Zammad: HTML, always. `contentType` is the
 * authored format after the mention rewrite — already-markup passes through,
 * plain prose is converted.
 */
export function ensureHtml(body: string, contentType: string): string {
  return contentType === 'text/html' ? body : text2html(body);
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
  'carrying any HTML tag is taken as markup wholesale.';
