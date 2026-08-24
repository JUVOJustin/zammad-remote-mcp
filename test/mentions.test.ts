import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ZammadClient } from '../src/core/zammad/client.js';
import type { LookupService, MentionCandidate } from '../src/core/zammad/lookup.js';
import { hasMention, rewriteMentions } from '../src/core/zammad/mentions.js';

/**
 * Candidates the way Zammad hands them over — matched on prefixes, so "Jan"
 * offers Janine too, and it is the code under test that has to decide.
 */
function stub(directory: MentionCandidate[]) {
  const seen: Array<{ term: string; groupId?: number }> = [];

  const lookup = {
    mentionableAgents: async (term: string, groupId?: number) => {
      seen.push({ term, groupId });
      return directory.filter((agent) =>
        [agent.name, agent.email ?? '', agent.login ?? '']
          .flatMap((field) => [field, ...field.split(/[\s@.]+/)])
          .some((part) => part.toLowerCase().startsWith(term.toLowerCase())),
      );
    },
    mentionableAgentById: async (id: number) => directory.find((agent) => agent.id === id),
  } as unknown as LookupService;

  const client = {} as unknown as ZammadClient;

  return { lookup, client, zammadUrl: 'https://help.acme.com', seen };
}

const jane: MentionCandidate = {
  id: 42,
  name: 'Jane Doe',
  email: 'jane@acme.com',
  login: 'jdoe',
};
const sam: MentionCandidate = { id: 7, name: 'Sam Ray', email: 'sam@acme.com', login: 'sray' };

const directory = [jane, sam];

describe('hasMention', () => {
  it('sees a mention in every form the trigger takes', () => {
    for (const body of ['@@jdoe', 'ping @@jane@acme.com now', '<p>@@"Jane Doe"</p>']) {
      assert.equal(hasMention(body), true, body);
    }
    for (const body of ['no mention here', 'mail me at jane@acme.com', 'a @ b']) {
      assert.equal(hasMention(body), false, body);
    }
  });

  it('does not leak regex state between calls', () => {
    assert.equal(hasMention('@@jdoe'), true);
    assert.equal(hasMention('@@jdoe'), true, 'a lastIndex left behind would miss the second');
  });
});

describe('rewriteMentions', () => {
  it('leaves a body without @@ untouched and asks Zammad nothing', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('Just a note.', 'text/plain', context);

    assert.equal(result.body, 'Just a note.');
    assert.equal(result.content_type, 'text/plain');
    assert.deepEqual(result.mentioned, []);
    assert.deepEqual(context.seen, []);
  });

  it('turns @@email into the anchor Zammad recognises', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@jane@acme.com please look', 'text/plain', context);

    assert.equal(
      result.body,
      '<a href="https://help.acme.com/#user/profile/42" data-mention-user-id="42">Jane Doe</a> please look',
    );
    // The anchor cannot survive as text/plain, so the article has to become HTML.
    assert.equal(result.content_type, 'text/html');
    assert.deepEqual(result.mentioned, [{ id: 42, name: 'Jane Doe' }]);
  });

  it('accepts a login and a quoted full name', async () => {
    const context = stub(directory);
    const login = await rewriteMentions('@@jdoe hi', 'text/plain', context);
    const quoted = await rewriteMentions('@@"Jane Doe" hi', 'text/plain', context);

    assert.match(login.body, /data-mention-user-id="42"/);
    assert.match(quoted.body, /data-mention-user-id="42"/);
    assert.equal(quoted.body.includes('"Jane Doe"'), false, 'the quotes are syntax, not content');
  });

  it('narrows the candidates to the group the article is filed under', async () => {
    const context = stub(directory);
    await rewriteMentions('@@jdoe hi', 'text/plain', { ...context, groupId: 3 });

    // App.Mention.searchUser passes the ticket's group, so the picker only ever
    // offers agents who may actually be mentioned on it.
    assert.deepEqual(context.seen, [{ term: 'jdoe', groupId: 3 }]);
  });

  it('takes the whole name an unquoted mention spells out', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@Jane Doe bitte übernehmen', 'text/plain', context);

    assert.equal(
      result.body,
      '<a href="https://help.acme.com/#user/profile/42" data-mention-user-id="42">Jane Doe</a>' +
        ' bitte übernehmen',
    );
  });

  it('refuses a first name on its own, and says who it found', async () => {
    // Zammad's search matches prefixes, so `Jane` would resolve as readily to a
    // Janine. Guessing between them mentions the wrong colleague in a note that
    // reads as though it reached the right one.
    const context = stub(directory);

    await assert.rejects(
      rewriteMentions('@@Jane bitte übernehmen', 'text/plain', context),
      (error: Error) => {
        assert.match(error.message, /No agent is named "Jane"/);
        assert.match(error.message, /Jane Doe <jane@acme.com>/);
        return true;
      },
    );
  });

  it('refuses a name that only starts like one, rather than matching part of it', async () => {
    // `@@Jane Doerr` must not become a link on "Jane Doe" followed by "rr",
    // which would read back as the name the author wrote.
    const context = stub(directory);
    await assert.rejects(
      rewriteMentions('@@Jane Doerr hat angerufen', 'text/plain', context),
      /No agent is named "Jane"/,
    );
  });

  it('keeps punctuation after the name it took', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('Frag @@Jane Doe, danke.', 'text/plain', context);

    assert.ok(result.body.endsWith('</a>, danke.'), result.body);
  });

  it('matches a name across whatever spacing was typed', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@Jane  Doe bitte', 'text/plain', context);

    assert.ok(result.body.endsWith('</a> bitte'), result.body);
  });

  it('takes a numeric id as the identity it is', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@42 bitte', 'text/plain', context);

    assert.deepEqual(result.mentioned, [{ id: 42, name: 'Jane Doe' }]);
    assert.ok(result.body.endsWith('</a> bitte'), result.body);
  });

  it('keeps trailing punctuation out of the login', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('Ask @@jane@acme.com, then close.', 'text/plain', context);

    assert.match(result.body, /data-mention-user-id="42"/);
    assert.ok(result.body.endsWith('</a>, then close.'), result.body);
  });

  it('escapes the surrounding text when promoting plain text to HTML', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@jdoe see <b> & "quotes"', 'text/plain', context);

    // Without escaping, promoting to HTML would silently reinterpret the note.
    assert.ok(result.body.includes('&lt;b&gt; &amp; &quot;quotes&quot;'), result.body);
  });

  it('preserves line breaks that text/plain implied', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@jdoe\nsecond line', 'text/plain', context);

    assert.ok(result.body.includes('<br>second line'), result.body);
  });

  it('does not escape a body that was already HTML', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('<div>@@jdoe <b>bold</b></div>', 'text/html', context);

    assert.ok(result.body.includes('<b>bold</b>'), result.body);
    assert.match(result.body, /data-mention-user-id="42"/);
  });

  it('fails the call when a token names nobody, rather than filing the article', async () => {
    const context = stub(directory);

    // check_mentions is create-only: an article filed without its anchor cannot
    // be given the mention afterwards, so refusing is the only way back.
    await assert.rejects(
      rewriteMentions('@@nobody@acme.com and @@jdoe', 'text/plain', context),
      /No agent is named "nobody@acme.com"/,
    );
  });

  it('reports each mentioned user once', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@jdoe @@jane@acme.com @@sam@acme.com', 'text/plain', context);

    assert.deepEqual(
      result.mentioned.map((user) => user.id),
      [42, 7],
    );
  });

  it('reads a bare @@ as two characters of text', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('costs 5 @@ each', 'text/plain', context);

    assert.equal(result.body, 'costs 5 @@ each');
    assert.equal(result.content_type, 'text/plain', 'nothing was linked, so nothing forced HTML');
    assert.deepEqual(context.seen, []);
  });

  it('handles repeated calls without regex state leaking between them', async () => {
    const context = stub(directory);
    const first = await rewriteMentions('@@jdoe one', 'text/plain', context);
    const second = await rewriteMentions('@@jdoe two', 'text/plain', context);

    assert.equal(first.mentioned.length, 1);
    assert.equal(second.mentioned.length, 1, 'a lastIndex left behind would skip this match');
  });
});
