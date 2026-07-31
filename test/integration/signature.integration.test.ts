import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  callTool,
  callToolExpectingError,
  type Json,
  listTools,
  skipReason,
  startHarness,
  stopHarness,
} from './harness.js';
import { CUSTOMER_EMAIL } from './zammad.js';

/**
 * The signature paths that used to be asserted against a stub.
 *
 * The lookup edge cases are seeded as real groups — `Unsigned` has none,
 * `Retired` points at one an admin switched off, `Blank` at one saved empty.
 * Each is a state an instance genuinely drifts into, and each has to leave the
 * article exactly as it was written.
 *
 * Two of the stub's cases are gone rather than ported, because the instance
 * showed they were fiction:
 *
 *  - a *dangling* `signature_id` cannot exist. `groups.signature_id` carries a
 *    foreign key and Postgres refuses one, so the stub was asserting a state the
 *    database forbids. The guard in `findForGroup` stays as belt and braces.
 *  - "never forwards `append_signature` to Zammad" is unobservable here: Zammad
 *    ignores attributes it does not know and answers 200 either way, which is
 *    precisely the blindness that let two silent no-ops through. It cannot be
 *    replaced by an effect assertion, so it is dropped rather than faked.
 *
 * The `signshow` fallback is also not covered any more. It fires when an
 * instance restricts `/api/v1/signatures` but not `/api/v1/groups`, and that
 * combination is not reachable on a stock Zammad: an agent token reads both, and
 * a customer token is refused both.
 */

let ready = false;

before(async () => {
  ready = await startHarness();
});

after(stopHarness);

/** What the create screen sends on its "Send Email" tab. */
const emailArticle = (overrides: Record<string, unknown> = {}) => ({
  body: 'Opened by the integration suite.',
  type: 'email',
  sender: 'Agent',
  internal: false,
  to: CUSTOMER_EMAIL,
  content_type: 'text/html',
  ...overrides,
});

async function firstArticleBody(ticketId: number): Promise<string> {
  const listed = await callTool('zammad_list_ticket_articles', {
    ticket_id: ticketId,
    body_format: 'html',
  });
  return String(listed.articles[0].body);
}

describe('signature lookup against the states an instance can be in', () => {
  for (const [group, why] of [
    ['Unsigned', 'the group has no signature at all'],
    ['Retired', 'the signature is switched off'],
    ['Blank', 'the signature renders to nothing once its placeholders are resolved'],
  ] as Array<[string, string]>) {
    it(`writes the article untouched when ${why}`, async (t) => {
      if (!ready) return t.skip(skipReason);

      const created = await callTool('zammad_create_ticket', {
        title: `Signature absent — ${group}`,
        group,
        customer: CUSTOMER_EMAIL,
        article: emailArticle(),
      });

      assert.equal(created.created, true, 'an unsigned group must not fail the write');
      assert.equal(created.signature.appended, false);

      const body = await firstArticleBody(created.ticket.id);
      assert.equal(body, 'Opened by the integration suite.');
      assert.ok(!body.includes('data-signature'), body);

      // The preview answers with the group's *name* here too. Every other field
      // of that tool speaks in names, and an internal id is of no use to a caller.
      for (const args of [{ group }, { ticket_id: created.ticket.id }]) {
        const preview = await callTool('zammad_get_group_signature', args);
        assert.equal(preview.has_signature, false, JSON.stringify(args));
        assert.equal(preview.group, group, `expected the name, got ${preview.group}`);
      }
    });
  }

  it('says a signature rendered to nothing, rather than claiming a duplicate', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The text/plain duplicate check is `endsWith`, and `endsWith('')` is true
    // for every body — so an empty render would report every article as already
    // signed. The Blank group's signature is markup only for exactly this.
    const created = await callTool('zammad_create_ticket', {
      title: 'Signature renders to nothing',
      group: 'Blank',
      customer: CUSTOMER_EMAIL,
      article: emailArticle({ content_type: 'text/plain' }),
    });

    assert.equal(created.signature.appended, false);
    assert.match(created.signature.reason, /renders to nothing/);
    assert.doesNotMatch(created.signature.reason, /already/i, 'there is no duplicate to report');
  });

  it('does not offer append_signature on a mass update, which cannot honour it', async (t) => {
    if (!ready) return t.skip(skipReason);

    // One article goes to the whole batch while a signature belongs to each
    // ticket's group. Advertising a flag that defaults to true and does nothing
    // is the worse of the two.
    const schema = (await listTools()).find((t2: Json) => t2.name === 'zammad_mass_update_tickets')
      ?.inputSchema as Json;
    assert.equal(schema.properties.article.properties.append_signature, undefined);
  });

  it('never promises in the preview what the writer then declines to append', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The two share a renderer so they cannot drift on the text; they can still
    // drift on the *verdict*. Blank's template is markup only — non-empty, so it
    // survives the lookup, and empty once rendered.
    for (const group of ['Unsigned', 'Retired', 'Blank']) {
      const preview = await callTool('zammad_get_group_signature', { group });
      const created = await callTool('zammad_create_ticket', {
        title: `Preview agrees — ${group}`,
        group,
        customer: CUSTOMER_EMAIL,
        article: emailArticle(),
      });

      assert.equal(
        preview.has_signature,
        created.signature.appended,
        `${group}: preview said ${preview.has_signature}, the write said ${created.signature.appended}`,
      );
    }
  });

  it('signs prose that merely ends with the same words as the signature', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The plain-text duplicate check compares the trailing block, and Zammad's
    // signatures are name-heavy — the stock one opens with the agent's name. A
    // body whose last sentence happens to name the same person must still be
    // signed, and must not be reported as an already-signed duplicate.
    const me = await callTool('zammad_whoami', {});
    const created = await callTool('zammad_create_ticket', {
      title: 'Prose ending in the sender name',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: emailArticle({
        content_type: 'text/plain',
        body: `For anything further please contact ${me.user.firstname} ${me.user.lastname}`,
      }),
    });

    assert.equal(created.signature.appended, true, created.signature.reason);
  });

  it('leaves a plain-text body that really was signed already', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The case the check exists for: a caller reads a body back and sends it
    // again. The separator is what tells this apart from the prose above.
    const ticket = await callTool('zammad_create_ticket', {
      title: 'Plain-text retry',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: emailArticle({ content_type: 'text/plain' }),
    });
    assert.equal(ticket.signature.appended, true);

    const signed = await callTool('zammad_list_ticket_articles', { ticket_id: ticket.ticket.id });
    const again = await callTool('zammad_create_article', {
      ticket_id: ticket.ticket.id,
      body: String(signed.articles[0].body),
      type: 'email',
      internal: false,
      to: CUSTOMER_EMAIL,
    });

    assert.equal(again.signature.appended, false);
    assert.match(again.signature.reason, /already ends with this signature/);
  });

  it('does not sign a phone, web, sms, chat, fax or note article', async (t) => {
    if (!ready) return t.skip(skipReason);

    for (const type of ['phone', 'web', 'sms', 'chat', 'fax', 'note'] as const) {
      const created = await callTool('zammad_create_ticket', {
        title: `Unsigned channel ${type}`,
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        // `to` only makes sense on the email channel, and the schema is strict.
        article: { body: 'Opened by the integration suite.', type, internal: true },
      });

      assert.equal(created.signature.appended, false, `a ${type} article was signed`);
      assert.equal(await firstArticleBody(created.ticket.id), 'Opened by the integration suite.');
    }
  });

  it('does not sign an article attributed to the customer or the system', async (t) => {
    if (!ready) return t.skip(skipReason);

    for (const sender of ['Customer', 'System'] as const) {
      const created = await callTool('zammad_create_ticket', {
        title: `Unsigned sender ${sender}`,
        group: 'Users',
        customer: CUSTOMER_EMAIL,
        article: emailArticle({ sender }),
      });

      assert.equal(created.signature.appended, false, `a ${sender} article was signed`);
    }
  });

  it('signs an internal email, because the UI does not unsign one either', async (t) => {
    if (!ready) return t.skip(skipReason);

    const created = await callTool('zammad_create_ticket', {
      title: 'Signed internal email',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: emailArticle({ internal: true }),
    });

    assert.equal(created.signature.appended, true);
  });
});

describe('zammad_get_group_signature', () => {
  it('asks for something to look up rather than guessing', async (t) => {
    if (!ready) return t.skip(skipReason);

    const message = await callToolExpectingError('zammad_get_group_signature', {});
    assert.match(message, /group.*group_id.*ticket_id/s);
  });

  it('is advertised as read-only', async (t) => {
    if (!ready) return t.skip(skipReason);

    const tool = (await listTools()).find((t2: Json) => t2.name === 'zammad_get_group_signature');
    assert.ok(tool, 'the tool is not listed');
    assert.equal(tool.annotations.readOnlyHint, true);
  });
});

describe('the rule against a doubled sign-off', () => {
  /**
   * Stated in exactly one place: the flag itself.
   *
   * It was briefly repeated in the body field, the tool descriptions and the
   * server instructions — four copies to keep in step, and the instructions are
   * read on every connection whether an article is being written or not. The
   * rule lives with the argument it qualifies, and nowhere else.
   */
  const flags = async () => {
    const tools = await listTools();
    const at = (name: string, path: (schema: Json) => Json) =>
      path(tools.find((tool: Json) => tool.name === name)?.inputSchema as Json).description as string;
    return {
      create: at('zammad_create_ticket', (s) => s.properties.article.properties.append_signature),
      update: at('zammad_update_ticket', (s) => s.properties.article.properties.append_signature),
      article: at('zammad_create_article', (s) => s.properties.append_signature),
    };
  };

  it('tells the caller not to repeat the sender name, and where to look first', async (t) => {
    if (!ready) return t.skip(skipReason);

    for (const [tool, description] of Object.entries(await flags())) {
      assert.match(description, /do NOT write the sender's own name/i, tool);
      assert.match(description, /twice/i, tool);
      // The closing line stays a judgement call, not an instruction: Zammad's
      // own default signature has none, so "leave the closing out" would produce
      // mail that jumps from the last sentence straight to a name.
      assert.match(description, /whether a closing line belongs/i, tool);
      assert.match(description, /zammad_get_group_signature/, tool);
    }
  });

  it('does not repeat itself in the body field or the tool descriptions', async (t) => {
    if (!ready) return t.skip(skipReason);

    const tools = await listTools();
    const tool = (name: string) => tools.find((t2: Json) => t2.name === name) as Json;

    for (const description of [
      tool('zammad_create_ticket').inputSchema.properties.article.properties.body.description,
      tool('zammad_update_ticket').inputSchema.properties.article.properties.body.description,
      tool('zammad_create_article').inputSchema.properties.body.description,
    ]) {
      assert.equal(description, undefined, `the rule leaked back into a body field: ${description}`);
    }

    for (const name of ['zammad_create_ticket', 'zammad_update_ticket', 'zammad_create_article']) {
      // The *fact* that signing happens stays; the rule about it does not.
      assert.match(tool(name).description, /append_signature/, name);
      assert.doesNotMatch(tool(name).description, /twice/i, name);
    }
  });
});
