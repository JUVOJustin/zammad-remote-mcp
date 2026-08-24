import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ZammadClient } from '../src/core/zammad/client.js';
import type { LookupService, MentionableUser } from '../src/core/zammad/lookup.js';
import { hasMention, rewriteMentions } from '../src/core/zammad/mentions.js';

/**
 * Resolves anything in `directory`; anything else fails the way the lookup does.
 * `seen` records what each call asked for, so the group narrowing can be checked.
 */
function stub(directory: Record<string, MentionableUser>) {
  const seen: Array<{ term: string; groupId?: number }> = [];

  const lookup = {
    resolveMentionableUser: async (term: string, groupId?: number) => {
      seen.push({ term, groupId });
      const hit = directory[term.toLowerCase()];
      if (!hit) throw new Error(`No agent matches "${term}".`);
      return hit;
    },
  } as unknown as LookupService;

  const client = {} as unknown as ZammadClient;

  return { lookup, client, zammadUrl: 'https://help.acme.com', seen };
}

const jane: MentionableUser = { id: 42, name: 'Jane Doe' };
const sam: MentionableUser = { id: 7, name: 'Sam Ray' };

const directory: Record<string, MentionableUser> = {
  'jane@acme.com': jane,
  jdoe: jane,
  'jane doe': jane,
  'sam@acme.com': sam,
};

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
    assert.deepEqual(result.mentioned, [jane]);
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

  it('takes the rest of an unquoted name with the token', async () => {
    // `@@Jannik Pollmeier` resolves `Jannik` and the anchor prints the full
    // name, so leaving the surname behind would read "… Pollmeier Pollmeier …".
    const context = stub({ jannik: { id: 17, name: 'Jannik Pollmeier' } });
    const result = await rewriteMentions('@@Jannik Pollmeier bitte übernehmen', 'text/plain', context);

    assert.equal(
      result.body,
      '<a href="https://help.acme.com/#user/profile/17" data-mention-user-id="17">Jannik Pollmeier</a>' +
        ' bitte übernehmen',
    );
  });

  it('stops the swallowed surname at a word boundary', async () => {
    // With an agent called Jan Ott, eating "Ott" out of "Ottmar" would leave a
    // sentence that reads exactly as written while the mention went elsewhere.
    const context = stub({ jan: { id: 9, name: 'Jan Ott' } });
    const result = await rewriteMentions('@@Jan Ottmar hat angerufen', 'text/plain', context);

    assert.ok(result.body.endsWith('</a> Ottmar hat angerufen'), result.body);
  });

  it('leaves the sentence alone when the token is not the start of the name', async () => {
    // A login or an address does not prefix the name it resolved to, so the next
    // word is the caller's sentence and not part of the mention.
    const context = stub(directory);
    const result = await rewriteMentions('@@jdoe Doe bitte prüfen', 'text/plain', context);

    assert.ok(result.body.endsWith('</a> Doe bitte prüfen'), result.body);
  });

  it('keeps punctuation after a swallowed surname', async () => {
    const context = stub({ jannik: { id: 17, name: 'Jannik Pollmeier' } });
    const result = await rewriteMentions('Frag @@Jannik Pollmeier, danke.', 'text/plain', context);

    assert.ok(result.body.endsWith('</a>, danke.'), result.body);
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
      /No agent matches "nobody@acme.com"/,
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
