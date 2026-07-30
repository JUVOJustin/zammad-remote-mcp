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
    ['Blank', 'the signature is saved with an empty body'],
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
    });
  }

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
