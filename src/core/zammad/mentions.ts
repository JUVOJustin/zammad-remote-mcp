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

export interface RewriteResult {
  body: string;
  /** `text/html` once a mention is present — the anchor needs it. */
  content_type: string;
  mentioned: MentionedUser[];
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
  if (!MENTION.test(body)) return { body, content_type: contentType, mentioned: [] };

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

    let anchor: string | null = null;
    if (raw.length > 0) {
      try {
        const [id] = await context.lookup.resolveUsers([raw]);
        if (id !== undefined) {
          const user = await context.client.get<UserRecord>(`/api/v1/users/${id}`);
          const name = displayName(user ?? {}, raw);
          mentioned.set(id, { id, name });
          anchor =
            `<a href="${base}/#user/profile/${id}" data-mention-user-id="${id}">` + `${escapeHtml(name)}</a>`;
        }
      } catch {
        // An unresolvable @@token stays as written. Failing the whole article
        // over a typo would lose the text the caller actually wanted to record.
        anchor = null;
      }
    }

    segments.push(anchor ?? (wasPlain ? escapeHtml(consumed) : consumed));
    cursor = match.index + consumed.length;
    MENTION.lastIndex = cursor;
    match = MENTION.exec(body);
  }

  const tail = body.slice(cursor);
  segments.push(wasPlain ? escapeHtml(tail) : tail);

  if (mentioned.size === 0) return { body, content_type: contentType, mentioned: [] };

  const rewritten = segments.join('');
  return {
    body: wasPlain ? rewritten.replace(/\r?\n/g, '<br>') : rewritten,
    content_type: 'text/html',
    mentioned: [...mentioned.values()],
  };
}
