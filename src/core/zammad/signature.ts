import { z } from 'zod';
import type { Logger } from '../util/logger.js';
import type { ZammadClient } from './client.js';
import type { Group, LookupService, Signature } from './lookup.js';

/**
 * Group signatures, appended the way Zammad's agent UI appends them.
 *
 * Zammad does **not** add a signature server-side. The UI composes the finished
 * body in the browser and posts it, so an article written through the API has no
 * signature at all unless the caller builds one. That is what this module does,
 * following `App.SignatureHelper` and `App.Utils.replaceTags` from Zammad's
 * frontend bundle:
 *
 *   - the group's `signature_id` picks the signature, which must be active and
 *     have a body (`findForGroup`);
 *   - `#{…}` placeholders are resolved against `user`, `ticket` and `config`
 *     (`render`);
 *   - the result is wrapped in `<div data-signature="true" data-signature-id="…">`
 *     (`buildElement`), which is the marker Zammad's reply handling later uses to
 *     find and strip the signature again;
 *   - it is appended after a blank line (`appendToBottom`).
 *
 * The UI does this in both places an article is written, and so does this: the
 * New Ticket screen (`CoreWorkflow`, on the "Send Email" tab) and the reply
 * composer on an open ticket (`setArticleTypePost`, whenever the type is set to
 * email). The two differ only in what they know: create renders against the
 * attributes the ticket is about to be given, the composer against the ticket as
 * it stands.
 *
 * Which group is asked is the same rule in both, and it is not simply "the
 * ticket's group": a group being changed in the same breath wins. On the zoom
 * screen `setArticleTypePost` prefers the pending `group_id` held in the task
 * state over `App.Ticket.fullLocal(id).group_id`, and `updateSignatureByGroup`
 * re-renders the signature the moment the group dropdown changes.
 */

/** Zammad's placeholder syntax, verbatim from `App.Utils.replaceTags`. */
const PLACEHOLDER = /#\{\s{0,2}(.+?)\s{0,2}\}/g;

/**
 * The tool argument, declared once so all three writing tools describe it
 * identically — a flag that meant something subtly different per tool would be
 * worse than no flag.
 *
 * This is also the only place the doubled-sign-off rule is stated. It is the
 * failure the mechanism cannot catch — `placeSignature` de-duplicates the
 * signature *element*, but "Viele Grüße, Justin Vogt" typed into the body is
 * ordinary prose — and the flag is what the caller is reading when it decides.
 *
 * Only the name is stated as a rule. A signature always ends with it, which is
 * what makes it a signature, but the closing line above it is optional and
 * Zammad's own default has none: an instruction to leave the closing out would
 * produce mail that jumps from the last sentence straight to a name. For that
 * judgement the caller needs to see the signature, which is what
 * `zammad_get_group_signature` is for.
 */
export const appendSignatureFlag = z
  .boolean()
  .default(true)
  .describe(
    "Append the group's signature to this article, as the Zammad agent UI does. Like the UI, it only " +
      'applies on the email channel (`type: "email"`, `sender: "Agent"`) and only when the group has an ' +
      'active signature — a note or a phone article is never signed. Placeholders such as ' +
      '`#{user.firstname}` are resolved here.\n\n' +
      "While this is on, do NOT write the sender's own name at the end of `body`. The signature is " +
      'appended after it and ends with that name, so writing it yourself shows it twice. Whether a ' +
      'closing line belongs in `body` depends on the signature: some carry one above the name, and ' +
      "Zammad's own default does not. Call `zammad_get_group_signature` to read the exact text that " +
      'will be appended before you write the body — that is the reliable way to decide. Set this to ' +
      'false when you want to compose the whole message including its ending.',
  );

/** The objects a signature template may address: `user`, `ticket`, `config`. */
export type RenderContext = Record<string, unknown>;

export interface SignatureOutcome {
  appended: boolean;
  signature_id?: number;
  signature_name?: string;
  /**
   * The rendered signature as plain text.
   *
   * Reported so the caller can see the closing that was added rather than infer
   * it — which is what lets a following article avoid repeating the sign-off.
   */
  appended_text?: string;
  /** Why nothing was appended — surfaced to the caller instead of failing. */
  reason?: string;
}

/** Long enough to show the closing and the name; short enough not to be noise. */
const PREVIEW_CHARS = 300;

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

export interface SignatureResult extends SignatureOutcome {
  /** The article body to send. Unchanged from the input when nothing was appended. */
  body: string;
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Underscore's `_.isObject`, which is what the original walk tests against. */
function isWalkable(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null);
}

/**
 * Resolves `#{user.firstname}` against a context object.
 *
 * Two details of the original are easy to miss and both are visible in output:
 * markup inside the braces is discarded before the path is split (the rich-text
 * editor happily splits a placeholder across tags), and anything that resolves
 * to nothing renders as `-` rather than as an empty string.
 *
 * One deliberate divergence: Zammad renders a path that lands on an object as
 * `[object Object]`. That string in an outgoing email is worse than the `-` an
 * empty value already produces, so objects are treated as unresolved.
 */
export function replaceTags(template: string, objects: RenderContext): string {
  return template.replace(PLACEHOLDER, (_match, rawPath: string) => {
    const segments = rawPath.replace(/<.+?>/g, '').split('.');

    let current: unknown = objects;
    for (const segment of segments) {
      if (isWalkable(current) && segment in (current as object)) {
        current = (current as Record<string, unknown>)[segment];
      } else {
        current = '';
        break;
      }
    }

    const value = typeof current === 'function' ? (current as () => unknown)() : current;
    const text =
      value === null || value === undefined || typeof value === 'object' ? '' : htmlEscape(String(value));
    return text === '' ? '-' : text;
  });
}

/** `App.Utils.htmlStrip` — drop the leading and trailing `<br>` of a fragment. */
function htmlStrip(html: string): string {
  return html.replace(/^(?:\s*<br\s*\/?>)+/i, '').replace(/(?:<br\s*\/?>\s*)+$/i, '');
}

/** The marker Zammad's own reply handling looks for. */
export function buildSignatureElement(id: number, renderedBody: string): string {
  return `<div data-signature="true" data-signature-id="${id}">${htmlStrip(renderedBody)}</div>`;
}

/** `App.SignatureHelper.appendToBottom` — a blank line first, unless there is one. */
export function appendToHtmlBody(body: string, element: string): string {
  return /<br\s*\/?>\s*$/i.test(body) ? `${body}${element}` : `${body}<br><br>${element}`;
}

const SIGNATURE_OPEN = /<div\b[^>]*\bdata-signature=(["'])true\1[^>]*>/gi;

interface Located {
  id?: number;
  start: number;
  end: number;
}

/** How many `<blockquote>` are still open at `index`. */
function openQuotesBefore(html: string, index: number): number {
  const before = html.slice(0, index);
  const opened = before.match(/<blockquote\b/gi)?.length ?? 0;
  const closed = before.match(/<\/blockquote\s*>/gi)?.length ?? 0;
  return opened - closed;
}

/**
 * The index just past the `</div>` that closes the element opened at `from`, or
 * undefined when the markup never closes it.
 *
 * Undefined rather than "the rest of the body": a truncated or mangled signature
 * element would otherwise swallow everything the caller wrote after it, and
 * silently dropping the message is far worse than leaving a stale signature in
 * place. An element whose end cannot be found is left alone.
 */
function endOfElement(html: string, from: number): number | undefined {
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = from;
  let depth = 1;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return undefined;
}

/**
 * Signatures already in a body, at the top level only.
 *
 * `removeTopLevel` excludes `blockquote [data-signature=true]` — a quoted reply
 * carries the *other* side's signature, and rewriting a quote would be exactly
 * the kind of side effect this must not have.
 */
function locateSignatures(html: string): Located[] {
  const found: Located[] = [];
  SIGNATURE_OPEN.lastIndex = 0;
  for (let match = SIGNATURE_OPEN.exec(html); match; match = SIGNATURE_OPEN.exec(html)) {
    if (openQuotesBefore(html, match.index) > 0) continue;
    // An element with no closing tag is skipped rather than removed — see
    // `endOfElement`. The scan carries on past the opening tag.
    const end = endOfElement(html, match.index + match[0].length);
    if (end === undefined) continue;

    const id = /\bdata-signature-id=(["'])(\d+)\1/i.exec(match[0])?.[2];
    found.push({ id: id === undefined ? undefined : Number(id), start: match.index, end });
    SIGNATURE_OPEN.lastIndex = end;
  }
  return found;
}

/**
 * Puts the signature in the body the way the UI does, which above all means
 * never leaving two in one article.
 *
 * Both UI call sites check first: a body that already carries this exact
 * `data-signature-id` is left completely alone, and any *other* top-level
 * signature is removed before the new one is appended. Without that, a caller
 * who passes back a body it read from a previous reply — or who retries a failed
 * call — ends up sending two.
 *
 * The trailing `<br><br>` of a removed signature is deliberately kept: the UI
 * reuses it, because `appendToBottom` sees a body already ending in a break and
 * does not add a second pair.
 */
export function placeSignature(
  body: string,
  id: number,
  element: string,
): { body: string; changed: boolean } {
  const existing = locateSignatures(body);
  if (existing.some((found) => found.id === id)) return { body, changed: false };

  // Splice from the back so earlier offsets stay valid.
  let stripped = body;
  for (const found of [...existing].reverse()) {
    stripped = stripped.slice(0, found.start) + stripped.slice(found.end);
  }
  return { body: appendToHtmlBody(stripped, element), changed: true };
}

/**
 * Signature bodies are always HTML, so a `text/plain` article needs one.
 *
 * Promoting the article to `text/html` instead would change how the caller's own
 * body is rendered, which is not something a signature flag should do.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The article shape this module needs — a subset of the tool's article input. */
export interface ArticleForSignature {
  body: string;
  type: string;
  sender: string;
  content_type: string;
}

/**
 * The email channel and nothing else — the create screen's "Send Email" tab and
 * the composer's email type.
 *
 * `sender` is checked because the create screen's tab implies it: `email-out`
 * maps to `{article: 'email', sender: 'Agent'}`. The composer tests the type
 * alone, but it has no way to write an article as anyone but the agent, so for
 * every input the UI can actually produce the two rules agree. The API can send
 * `{type: 'email', sender: 'Customer'}` — an inbound mail being recorded — and
 * signing that with the agent's signature would be wrong.
 *
 * `internal` is not part of it. The UI has no internal toggle on create, and an
 * email that is later hidden from the customer still reads as one an agent
 * signed — dropping the signature there would be a second, invented rule.
 */
function channelWantsSignature(article: ArticleForSignature): boolean {
  return article.type === 'email' && article.sender === 'Agent';
}

/** Spreading a partial over a loaded ticket must not blank fields with undefined. */
function defined(values: RenderContext): RenderContext {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export interface RenderedSignature {
  group: Group;
  signature: Signature;
  /** The signature with its placeholders resolved, still HTML. */
  rendered: string;
}

/**
 * Finds a group's signature and renders it.
 *
 * Shared by the `append_signature` flag and by `zammad_get_group_signature`, so
 * what a caller previews is produced by the same code that writes it — a preview
 * built separately would drift and be worse than none.
 *
 * Returns undefined for every reason a group can be unsigned; throws only if
 * Zammad itself cannot be read.
 */
export async function renderGroupSignature(args: {
  lookup: LookupService;
  group: string | number;
  /** What `#{ticket.…}` resolves against. Absent on a bare group preview. */
  ticket?: RenderContext;
}): Promise<RenderedSignature | undefined> {
  const found = await findForGroup(args.lookup, args.group);
  if (!found) return undefined;
  const { signature, group } = found;

  const user = await args.lookup.me().catch(() => ({}));
  // The group goes in as the record, not the name it was addressed by, so
  // `#{ticket.group.name}` resolves — that is the object the UI renders with.
  const context: RenderContext = { user, ticket: { ...(args.ticket ?? {}), group } };
  // Reading the settings costs a request against Zammad's session endpoint, so
  // it only happens for the signatures that actually reference one.
  if (signature.body.includes('#{config.')) {
    context.config = await args.lookup.frontendConfig().catch(() => ({}));
  }

  return { group, signature, rendered: replaceTags(signature.body, context) };
}

/**
 * Appends the group's signature to `article.body`, or explains why it did not.
 *
 * Never throws. A missing signature, a group that cannot be resolved or a Zammad
 * that refuses the lookup are all reported as `appended: false` — creating the
 * ticket matters more than decorating it, and a caller that asked for a
 * signature it did not get can see that in the result.
 */
export async function appendGroupSignature(args: {
  lookup: LookupService;
  logger: Logger;
  article: ArticleForSignature;
  /**
   * Group name or ID set by this same call. Takes precedence over the group the
   * ticket already has, which is what the UI does when the group is being
   * changed alongside the reply.
   */
  group?: string | number;
  /** Ticket attributes known without a round trip — this call's own arguments. */
  ticket?: RenderContext;
  /**
   * The ticket being replied to. A thunk rather than a value so the fetch only
   * happens for the articles that can actually carry a signature.
   */
  loadTicket?: () => Promise<RenderContext>;
}): Promise<SignatureResult> {
  const { article } = args;
  const unchanged = (reason: string): SignatureResult => ({
    body: article.body,
    appended: false,
    reason,
  });

  if (!channelWantsSignature(article)) {
    return unchanged(
      `signatures are only added to outbound email (type "email", sender "Agent"), not to a ${article.sender} ${article.type} article`,
    );
  }

  try {
    const existing = args.loadTicket ? await args.loadTicket() : {};
    const ticket = { ...existing, ...defined(args.ticket ?? {}) };

    const reference = args.group ?? (ticket.group_id as number | undefined);
    if (reference === undefined || reference === '') {
      return unchanged('no group was given, so no signature could be looked up');
    }

    const found = await renderGroupSignature({ lookup: args.lookup, group: reference, ticket });
    if (!found) return unchanged('this group has no active signature with a body');
    const { signature, rendered } = found;

    const identity = {
      signature_id: signature.id,
      signature_name: signature.name,
      appended_text: preview(htmlToText(rendered)),
    };

    // Before the branch, not inside the text/plain one: a template that is
    // markup only — `<br><br>` — passes the non-empty check in findForGroup and
    // then renders to nothing. On the HTML path that used to append an empty
    // `<div data-signature>`; on the plain path `endsWith('')` is true for every
    // body, so each article was reported as an already-signed duplicate.
    const text = htmlToText(rendered);
    if (text === '') {
      return {
        body: article.body,
        appended: false,
        ...identity,
        reason: 'this signature renders to nothing once its placeholders are resolved',
      };
    }

    if (article.content_type === 'text/html') {
      const placed = placeSignature(
        article.body,
        signature.id,
        buildSignatureElement(signature.id, rendered),
      );
      return placed.changed
        ? { body: placed.body, appended: true, ...identity }
        : {
            body: placed.body,
            appended: false,
            ...identity,
            reason: 'the body already carries this signature, so it was left as it is',
          };
    }

    // text/plain has no `data-signature` marker to recognise, so the only
    // duplicate that can be detected is an identical trailing block. Appending a
    // second copy to a retried call would be worse than missing this case.
    const trimmed = article.body.replace(/\s+$/, '');
    if (trimmed.endsWith(text)) {
      return {
        body: article.body,
        appended: false,
        ...identity,
        reason: 'the body already ends with this signature, so it was left as it is',
      };
    }
    return { body: `${trimmed}\n\n${text}`, appended: true, ...identity };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.logger.debug('signature lookup failed', { error: message });
    return unchanged(`the signature could not be read from Zammad: ${message}`);
  }
}

/**
 * The ticket a reply is being written on, as the render context.
 *
 * `expand` is asked for because a signature prints names, not ids — it adds
 * `group`, `state` and `customer` as readable strings while leaving `group_id`
 * in place, which is what picks the signature.
 */
export function ticketLoader(client: ZammadClient, ticketId: number): () => Promise<RenderContext> {
  return async () => (await client.get<RenderContext>(`/api/v1/tickets/${ticketId}`, { expand: true })) ?? {};
}

/** `App.SignatureHelper.findForGroup` — group → signature, active and non-empty. */
async function findForGroup(
  lookup: LookupService,
  reference: string | number,
): Promise<{ group: Group; signature: Signature } | undefined> {
  const [groupId] = await lookup.resolveGroups([reference]);
  const groups = await lookup.groups();
  const group = Array.isArray(groups) ? groups.find((candidate) => candidate.id === groupId) : undefined;
  // A group carries at most one signature — `Group.signature_id` is a single
  // column, and the many-to-one lives on `Signature.group_ids`. So there is no
  // "which of several" to decide: null here simply means unsigned.
  if (!group?.signature_id) return undefined;

  const signatures = await lookup.signatures();
  const signature = Array.isArray(signatures)
    ? signatures.find((candidate) => candidate.id === group.signature_id)
    : undefined;

  // Inactive is the case the UI warns about on the group form ("This signature
  // is inactive, it won't be included in the reply"), and a dangling id is what
  // a deleted signature leaves behind. Both mean: send nothing.
  return signature?.active && typeof signature.body === 'string' && signature.body
    ? { group, signature }
    : undefined;
}
