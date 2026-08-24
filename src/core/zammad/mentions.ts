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

/**
 * A `@@` mention that did not happen, and why.
 *
 * Two ways to get here: the token named nobody, or it named someone the article
 * type cannot carry a mention to (`demoteMentions`). Reported rather than
 * raised, and reported rather than passed over. Leaving the article alone is the
 * right outcome — a typo must not cost the text somebody wrote — but on its own
 * it repeats the failure this module exists to prevent: the note reads as
 * intended to its author and the colleague is never told. The write already
 * happened by the time anyone could look, so the answer has to carry the miss.
 */
export interface UnresolvedMention {
  /**
   * The `@@` token as written, without the `@@` — or, when the mention resolved
   * but the channel cannot carry it, the name of the person it named.
   */
  token: string;
  /** Why nobody was mentioned: the lookup's own words, or the channel's limit. */
  reason: string;
}

export interface RewriteResult {
  body: string;
  /** `text/html` once a mention is present — the anchor needs it. */
  content_type: string;
  mentioned: MentionedUser[];
  unresolved: UnresolvedMention[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface UserRecord {
  id?: number;
  firstname?: string;
  lastname?: string;
  email?: string;
  login?: string;
}

function displayName(user: UserRecord, fallback: string): string {
  const full = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return full || user.email || user.login || fallback;
}

/**
 * The same result with its mentions moved into `unresolved`, for an article type
 * that cannot carry one — see `mentionsNotCarried` in compose.ts.
 *
 * The rewrite still ran and the body keeps it: the anchor is what makes the text
 * conversion print "Jane Doe" instead of the token somebody typed. What must not
 * survive is the claim. `mentioned` says a colleague was subscribed, and on
 * these types none was, so it is emptied rather than returned alongside a body
 * that no longer contains a single anchor.
 */
export function demoteMentions(result: RewriteResult, reason: string): RewriteResult {
  if (result.mentioned.length === 0) return result;
  return {
    ...result,
    mentioned: [],
    unresolved: [...result.unresolved, ...result.mentioned.map((user) => ({ token: user.name, reason }))],
  };
}

/**
 * Why a token resolved to nobody, said in a way the next attempt can act on.
 *
 * The lookup's own message is the useful part — it names the candidates when a
 * term is ambiguous — so it is passed through rather than replaced. What it
 * cannot know is the shape of the token it was handed: an unquoted `@@` stops at
 * the first space, so `@@Jannik Pollmeier` reaches it as `Jannik` and a name that
 * looked complete to its author was never searched for. That hint is added only
 * for unquoted tokens, where it is the likely mistake.
 */
function reasonFor(error: unknown, wasQuoted: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (wasQuoted) return message;
  return `${message} If the name contains a space, quote it: \`@@"First Last"\`.`;
}

/**
 * Rewrites `@@token` into a mention anchor.
 *
 * A plain-text body is escaped and promoted to HTML, because the anchor cannot
 * survive as `text/plain` — without that, adding a mention would silently turn
 * the rest of the note into markup.
 */
export async function rewriteMentions(
  body: string,
  contentType: string,
  context: { client: ZammadClient; lookup: LookupService; zammadUrl: string },
): Promise<RewriteResult> {
  MENTION.lastIndex = 0;
  if (!MENTION.test(body)) return { body, content_type: contentType, mentioned: [], unresolved: [] };

  const wasPlain = contentType !== 'text/html';
  const base = context.zammadUrl.replace(/\/+$/, '');

  const segments: string[] = [];
  const mentioned = new Map<number, MentionedUser>();
  /** Keyed by token, so a name misspelled the same way twice is reported once. */
  const unresolved = new Map<string, UnresolvedMention>();
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

    let anchor: string | null = null;
    if (raw.length > 0) {
      try {
        const [id] = await context.lookup.resolveUsers([raw]);
        if (id === undefined) throw new Error(`no Zammad user matches "${raw}"`);
        const user = await context.client.get<UserRecord>(`/api/v1/users/${id}`);
        const name = displayName(user ?? {}, raw);
        mentioned.set(id, { id, name });
        anchor =
          `<a href="${base}/#user/profile/${id}" data-mention-user-id="${id}">` + `${escapeHtml(name)}</a>`;
      } catch (error) {
        // An unresolvable @@token stays as written. Failing the whole article
        // over a typo would lose the text the caller actually wanted to record
        // — but the caller is told, in `unresolved`, that nobody was mentioned.
        anchor = null;
        unresolved.set(raw, { token: raw, reason: reasonFor(error, quoted !== undefined) });
      }
    }

    segments.push(anchor ?? (wasPlain ? escapeHtml(consumed) : consumed));
    cursor = match.index + consumed.length;
    MENTION.lastIndex = cursor;
    match = MENTION.exec(body);
  }

  const tail = body.slice(cursor);
  segments.push(wasPlain ? escapeHtml(tail) : tail);

  // Nothing resolved, so nothing was rewritten: hand back the body as authored
  // rather than a re-escaped copy of it. The misses still travel.
  if (mentioned.size === 0)
    return { body, content_type: contentType, mentioned: [], unresolved: [...unresolved.values()] };

  const rewritten = segments.join('');
  return {
    body: wasPlain ? rewritten.replace(/\r?\n/g, '<br>') : rewritten,
    content_type: 'text/html',
    mentioned: [...mentioned.values()],
    unresolved: [...unresolved.values()],
  };
}
