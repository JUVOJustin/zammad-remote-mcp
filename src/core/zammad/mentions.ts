import type { ZammadClient } from './client.js';
import type { LookupService } from './lookup.js';

/**
 * `@@name` handling for article bodies.
 *
 * `@@` is the autocomplete trigger in Zammad's own editor — it opens a name
 * picker and what ends up stored is a link. Sent verbatim through the API it
 * stays literal text and reaches nobody, which fails silently: the note looks
 * right to whoever wrote it and the colleague never hears about it.
 *
 * So the same shorthand is honoured here. A body is scanned for `@@` tokens,
 * each is resolved to a user, and the text is rewritten into the anchor Zammad
 * renders as a mention.
 *
 * That anchor is all that is needed: `Ticket::Article#check_mentions` runs on
 * create, scans the body for `a[data-mention-user-id]` and calls
 * `Mention.subscribe!` itself, so the notification follows from the markup. The
 * separate /api/v1/mentions endpoint is for subscribing without writing an
 * article and is not involved here. The callback is create-only, so editing a
 * body afterwards does not mention anyone — this runs on create alone.
 *
 * A token that does not name exactly one mentionable agent fails the call, and
 * nothing is written. The alternative — file the article and report the miss —
 * was tried and is worse: the caller has the text it just sent and can send it
 * again, so nothing is lost by refusing, whereas an article that is already on
 * the ticket cannot be un-filed and its mention cannot be added afterwards. The
 * callback is create-only, so "write now, fix the mention later" is not a thing
 * that exists. Candidates are narrowed the way the UI narrows them, which is
 * also what keeps ambiguity rare — see `resolveMentionableUser` in lookup.ts.
 */

/**
 * Matches `@@"Jane Doe"` (quoted, for names with spaces) or `@@jane@acme.com`
 * / `@@jdoe` (unquoted, no whitespace).
 */
const MENTION = /@@(?:"([^"\n]{1,120})"|([^\s<>"]+))/g;

/** Trailing sentence punctuation belongs to the sentence, not the login. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export interface MentionedUser {
  id: number;
  name: string;
}

export interface RewriteResult {
  body: string;
  /** `text/html` once a mention is present — the anchor needs it. */
  content_type: string;
  mentioned: MentionedUser[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * What every tool that takes an article body says about `@@`.
 *
 * One copy, three tools, as with `HTML_BODY_NOTE` — the rule lives with the
 * feature it describes rather than in three descriptions that drift apart.
 *
 * It has to carry the two things a caller cannot find out by trying: that the
 * candidates are agents and not everybody, and that a name matching none or
 * several of them fails the whole call. The second is what stops a model from
 * writing `@@Jannik` and assuming silence meant success.
 */
export const MENTION_NOTE =
  'Mention a colleague by writing `@@jane@acme.com`, `@@jdoe` or `@@"Jane Doe"` in the body — they are ' +
  'linked and notified. Only agents with access to the ticket group can be mentioned, and the name must ' +
  'match exactly one of them: a name that matches none or several fails the call and writes nothing, so ' +
  'prefer an email address or login. Keep the article `internal: true`, or the customer sees the mention too.';

/**
 * How much of the text after an unquoted token is the rest of the name it named.
 *
 * `@@Jannik Pollmeier` is the form a colleague's name is written in, and the
 * token grammar stops at the space — so `Jannik` is what gets resolved, and the
 * surname is left behind as text. Once resolution narrows to agents that token
 * usually does name one person, which turns a lookup failure into a sentence
 * reading "Jannik Pollmeier Pollmeier bitte übernehmen".
 *
 * So when the resolved name begins with the token, and the text carries straight
 * on with the rest of that name, those words are part of the mention and are
 * consumed with it. Nothing else is touched: an email address or a login does
 * not prefix the name it resolved to, so nothing is ever swallowed after one.
 */
function nameTail(name: string, token: string, rest: string): number {
  if (!name.toLowerCase().startsWith(token.toLowerCase())) return 0;
  const remainder = name.slice(token.length).trim();
  if (!remainder) return 0;
  const escaped = remainder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s+${escaped}`, 'i').exec(rest)?.[0].length ?? 0;
}

/** Does this body ask for a mention at all? */
export function hasMention(body: string): boolean {
  MENTION.lastIndex = 0;
  return MENTION.test(body);
}

/**
 * Rewrites `@@token` into a mention anchor, or throws.
 *
 * A plain-text body is escaped and promoted to HTML, because the anchor cannot
 * survive as `text/plain` — without that, adding a mention would silently turn
 * the rest of the note into markup.
 *
 * `groupId` narrows the candidates to the agents with access to that group, as
 * the UI's picker does. It is the group the article is being filed under, which
 * on an update is the one this same call is moving the ticket to. Left out only
 * where there is no single group to speak of — a bulk update spans many — and
 * then the agent filter still applies.
 *
 * Nothing is caught here. A token that names nobody, or names more than one
 * agent, fails the tool call before the article is written; see the module doc
 * for why refusing beats filing the article and reporting the miss.
 */
export async function rewriteMentions(
  body: string,
  contentType: string,
  context: { client: ZammadClient; lookup: LookupService; zammadUrl: string; groupId?: number },
): Promise<RewriteResult> {
  if (!hasMention(body)) return { body, content_type: contentType, mentioned: [] };

  const wasPlain = contentType !== 'text/html';
  const base = context.zammadUrl.replace(/\/+$/, '');

  const segments: string[] = [];
  const mentioned = new Map<number, MentionedUser>();
  let cursor = 0;

  MENTION.lastIndex = 0;
  let match = MENTION.exec(body);
  while (match) {
    const quoted = match[1];
    const raw = quoted ?? (match[2] ?? '').replace(TRAILING_PUNCTUATION, '');
    // Whatever punctuation was stripped is text again, not part of the name.
    const consumed = quoted === undefined ? `@@${raw}` : match[0];
    const before = body.slice(cursor, match.index);
    segments.push(wasPlain ? escapeHtml(before) : before);
    /** Characters after the token that belong to the name it resolved to. */
    let tail = 0;

    // `@@` followed by nothing is not a mention; it is two characters of text.
    if (raw.length === 0) {
      segments.push(wasPlain ? escapeHtml(consumed) : consumed);
    } else {
      const user = await context.lookup.resolveMentionableUser(raw, context.groupId);
      mentioned.set(user.id, user);
      segments.push(
        `<a href="${base}/#user/profile/${user.id}" data-mention-user-id="${user.id}">` +
          `${escapeHtml(user.name)}</a>`,
      );
      // The anchor prints the whole name, so a surname the token could not reach
      // must not be left standing next to it.
      if (quoted === undefined) tail = nameTail(user.name, raw, body.slice(match.index + consumed.length));
    }

    cursor = match.index + consumed.length + tail;
    MENTION.lastIndex = cursor;
    match = MENTION.exec(body);
  }

  const tail = body.slice(cursor);
  segments.push(wasPlain ? escapeHtml(tail) : tail);

  // Every token that reached the lookup resolved, or this line was never got to.
  // An empty `mentioned` here means the body held only `@@` with nothing after
  // it, which changed nothing and must not promote the body to HTML.
  if (mentioned.size === 0) return { body, content_type: contentType, mentioned: [] };

  const rewritten = segments.join('');
  return {
    body: wasPlain ? rewritten.replace(/\r?\n/g, '<br>') : rewritten,
    content_type: 'text/html',
    mentioned: [...mentioned.values()],
  };
}
