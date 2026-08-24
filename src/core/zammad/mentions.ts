import { ToolInputError } from '../util/errors.js';
import type { ZammadClient } from './client.js';
import type { LookupService, MentionCandidate } from './lookup.js';

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
  'Mention a colleague by writing `@@jane@acme.com`, `@@jdoe`, `@@42` or their whole name — `@@Jane Doe`, ' +
  'quoted as `@@"Jane Doe"` where the sentence would run on — and they are linked and notified. Only agents ' +
  'with access to the ticket group can be mentioned, and the token has to name exactly one: an email ' +
  'address, a login, a user id, or the full name. A first name on its own names nobody — `@@Jane` is ' +
  'refused rather than guessed at. Anything naming none or several fails the call and writes nothing. Keep ' +
  'the article `internal: true`, or the customer sees the mention too.';

/** A word that must not be cut into: "Ottmar", "Müller", "Nyström". */
const WORD_CHARACTER = '[\\p{L}\\p{N}_]';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `written` begin with this name, and how many characters does it take?
 *
 * A name is matched whole and by its own words: "Jan Ott" matches "Jan Ott hat
 * angerufen" and takes seven characters, matches "Jan  Ott" across whatever
 * spacing was typed, and does not match "Jan Ottmar" at all — the word the name
 * would end inside is not the word the name is.
 */
function nameMatch(name: string, written: string): number {
  const words = name.trim().split(/\s+/).map(escapeRegex);
  if (words.length === 0) return 0;
  const pattern = new RegExp(`^${words.join('\\s+')}(?!${WORD_CHARACTER})`, 'iu');
  return pattern.exec(written)?.[0].length ?? 0;
}

/**
 * Which agent did the author name, and how much of the text says so?
 *
 * The token grammar stops at the first space, so an unquoted `@@Jan Ott` reaches
 * here as `Jan` with " Ott hat angerufen" behind it. Resolving the token on its
 * own is what this must not do: Zammad's user search matches prefixes, so `Jan`
 * finds Janine as readily as Jan Ott, and picking the single hit would mention
 * a colleague whose name the author never wrote — invisibly, since the anchor
 * then prints her name over his.
 *
 * So the token is used to ask, and the written text decides. A candidate is the
 * one named when the text spells out their whole name, or when the token is an
 * identity — an email address or a login — that is theirs. A name matched in
 * part is not a match: `@@Jan` names nobody, and says so, listing the agents it
 * found so the next attempt can spell one out.
 *
 * `written` is the token and everything after it, because the name may run past
 * where the token stopped. What is returned is how far the name reached, which
 * is what the caller consumes.
 */
function namedBy(candidates: MentionCandidate[], token: string, written: string) {
  const needle = token.trim().toLowerCase();
  const identified = candidates.filter(
    (agent) => agent.email?.toLowerCase() === needle || agent.login?.toLowerCase() === needle,
  );
  if (identified.length > 0) return { matched: identified, length: token.length };

  let length = 0;
  const matched: MentionCandidate[] = [];
  for (const agent of candidates) {
    const reach = nameMatch(agent.name, written);
    if (reach === 0) continue;
    // The longest name wins the text it covers: where an instance holds both
    // "Jan Ott" and "Jan Ott Sørensen", `@@Jan Ott Sørensen` names the second
    // and only the second.
    if (reach > length) {
      length = reach;
      matched.length = 0;
    }
    if (reach === length) matched.push(agent);
  }
  return { matched, length };
}

/** Does this body ask for a mention at all? */
export function hasMention(body: string): boolean {
  MENTION.lastIndex = 0;
  return MENTION.test(body);
}

/**
 * The agent one `@@token` names, or the reason there is not one.
 *
 * A numeric token is an identity and is looked up as one — `query: "42"` would
 * search for the characters. Everything else is asked of the search and then
 * decided by `namedBy`, so the answer comes from what the author wrote and not
 * from what the search happened to return.
 */
async function resolveOne(
  token: string,
  written: string,
  context: { lookup: LookupService; groupId?: number },
): Promise<{ id: number; name: string; length: number }> {
  if (/^\d+$/.test(token)) {
    const agent = await context.lookup.mentionableAgentById(Number(token), context.groupId);
    if (!agent) {
      throw new ToolInputError(
        `Zammad user ${token} cannot be mentioned here. A mention reaches agents with access to the ` +
          "ticket's group; a customer, a deactivated account or an agent without that access cannot be " +
          'mentioned, and Zammad rejects the whole article if one is.',
      );
    }
    return { id: agent.id, name: agent.name, length: token.length };
  }

  const candidates = await context.lookup.mentionableAgents(token, context.groupId);
  const { matched, length } = namedBy(candidates, token, written);

  if (matched.length === 1) {
    const agent = matched[0]!;
    return { id: agent.id, name: agent.name, length };
  }

  if (matched.length > 1) {
    throw new ToolInputError(
      `${listAgents(matched)} share that name, so there is no one to mention. Use an email address, a ` +
        'login or a numeric user id instead.',
    );
  }

  throw new ToolInputError(
    `No agent is named "${token}". A mention needs the colleague's whole name — a first name on its own ` +
      'does not name them — or an email address, a login, or a numeric user id. ' +
      (candidates.length > 0
        ? `Agents whose name starts that way: ${listAgents(candidates)}.`
        : 'A mention also reaches agents only, and only those with access to the ticket group; ' +
          '`zammad_search_users` finds the right account.'),
  );
}

/** Candidates as a model can act on them: the name to write, and the address. */
function listAgents(agents: MentionCandidate[]): string {
  return agents
    .slice(0, 10)
    .map((agent) => `${agent.name} <${agent.email ?? agent.login ?? agent.id}>`)
    .join('; ');
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
      // Quoted, the token is the whole of what was written. Unquoted, the name
      // may run past where the token stopped, so the text carries on from there.
      const written = quoted ?? raw + body.slice(match.index + consumed.length);
      const user = await resolveOne(raw, written, context);
      mentioned.set(user.id, { id: user.id, name: user.name });
      segments.push(
        `<a href="${base}/#user/profile/${user.id}" data-mention-user-id="${user.id}">` +
          `${escapeHtml(user.name)}</a>`,
      );
      // What the name reached beyond the token is part of the mention, not text
      // to leave standing beside an anchor that already prints it.
      if (quoted === undefined) tail = user.length - raw.length;
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
