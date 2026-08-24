import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ZammadClient } from '../src/core/zammad/client.js';
import type { LookupService } from '../src/core/zammad/lookup.js';
import { demoteMentions, rewriteMentions } from '../src/core/zammad/mentions.js';

/** Resolves anything in `directory`; anything else fails the way Zammad's search does. */
function stub(directory: Record<string, { id: number; firstname?: string; lastname?: string }>) {
  const byId = new Map(Object.values(directory).map((user) => [user.id, user]));
  let userFetches = 0;

  const lookup = {
    resolveUsers: async (values: readonly (string | number)[]) =>
      values.map((value) => {
        const hit = directory[String(value).toLowerCase()];
        if (!hit) throw new Error(`No Zammad user matches "${value}".`);
        return hit.id;
      }),
  } as unknown as LookupService;

  const client = {
    get: async (path: string) => {
      userFetches += 1;
      return byId.get(Number(path.split('/').pop()));
    },
  } as unknown as ZammadClient;

  return { lookup, client, zammadUrl: 'https://help.acme.com', fetches: () => userFetches };
}

const directory = {
  'jane@acme.com': { id: 42, firstname: 'Jane', lastname: 'Doe' },
  jdoe: { id: 42, firstname: 'Jane', lastname: 'Doe' },
  'jane doe': { id: 42, firstname: 'Jane', lastname: 'Doe' },
  'sam@acme.com': { id: 7, firstname: 'Sam', lastname: 'Ray' },
};

describe('rewriteMentions', () => {
  it('leaves a body without @@ untouched', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('Just a note.', 'text/plain', context);

    assert.equal(result.body, 'Just a note.');
    assert.equal(result.content_type, 'text/plain');
    assert.deepEqual(result.mentioned, []);
    assert.equal(context.fetches(), 0, 'must not call Zammad when there is nothing to resolve');
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

  it('leaves an unresolvable @@token as written', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@nobody@acme.com and @@jdoe', 'text/plain', context);

    // A typo must not cost the caller the note they were writing.
    assert.ok(result.body.includes('@@nobody@acme.com'), result.body);
    assert.deepEqual(result.mentioned, [{ id: 42, name: 'Jane Doe' }]);
  });

  it('reports an unresolvable @@token instead of passing over it', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@nobody@acme.com and @@jdoe', 'text/plain', context);

    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0]?.token, 'nobody@acme.com');
    // The lookup's own words, so the next attempt has something to act on.
    assert.match(result.unresolved[0]?.reason ?? '', /No Zammad user matches/);
  });

  it('says nothing about mentions that resolved', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@jdoe hi', 'text/plain', context);

    assert.deepEqual(result.unresolved, []);
  });

  it('points an unquoted token at the quoting it needed', async () => {
    // `@@Jane Doe` stops at the space, so only `Jane` is ever searched for —
    // the mistake that has to be named, because the lookup cannot see it.
    const context = stub(directory);
    const result = await rewriteMentions('@@Jane Doe please look', 'text/plain', context);

    assert.equal(result.unresolved[0]?.token, 'Jane');
    assert.match(result.unresolved[0]?.reason ?? '', /quote it/);
    assert.ok(result.body.includes('@@Jane Doe please look'), result.body);
  });

  it('leaves the hint off a quoted token, where it is not the mistake', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@"Nobody At All" hi', 'text/plain', context);

    assert.equal(result.unresolved[0]?.token, 'Nobody At All');
    assert.equal(result.unresolved[0]?.reason.includes('quote it'), false);
  });

  it('reports a token misspelled the same way twice only once', async () => {
    const context = stub(directory);
    const result = await rewriteMentions(
      '@@nobody@acme.com and again @@nobody@acme.com',
      'text/plain',
      context,
    );

    assert.equal(result.unresolved.length, 1);
  });

  it('stays plain text when no @@token resolves', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('mail me @@nobody@acme.com', 'text/plain', context);

    assert.equal(result.body, 'mail me @@nobody@acme.com');
    assert.equal(result.content_type, 'text/plain', 'nothing was linked, so nothing forced HTML');
  });

  it('reports each mentioned user once', async () => {
    const context = stub(directory);
    const result = await rewriteMentions('@@jdoe @@jane@acme.com @@sam@acme.com', 'text/plain', context);

    assert.deepEqual(
      result.mentioned.map((user) => user.id),
      [42, 7],
    );
  });

  it('handles repeated calls without regex state leaking between them', async () => {
    const context = stub(directory);
    const first = await rewriteMentions('@@jdoe one', 'text/plain', context);
    const second = await rewriteMentions('@@jdoe two', 'text/plain', context);

    assert.equal(first.mentioned.length, 1);
    assert.equal(second.mentioned.length, 1, 'a lastIndex left behind would skip this match');
  });
});

describe('demoteMentions', () => {
  const reason = 'an `sms` article is stored as text, so the anchor cannot survive in it';

  it('stops claiming a mention the channel cannot carry', async () => {
    const context = stub(directory);
    const rewritten = await rewriteMentions('Bitte @@jane@acme.com anrufen', 'text/plain', context);
    const demoted = demoteMentions(rewritten, reason);

    // Zammad subscribes from `a[data-mention-user-id]` alone. A body stored as
    // text has none, so reporting `mentioned` would claim a subscription that
    // was never made.
    assert.deepEqual(demoted.mentioned, []);
    assert.deepEqual(demoted.unresolved, [{ token: 'Jane Doe', reason }]);
  });

  it('keeps the rewritten body, so the reader gets the name and not the token', async () => {
    const context = stub(directory);
    const rewritten = await rewriteMentions('Bitte @@jane@acme.com anrufen', 'text/plain', context);
    const demoted = demoteMentions(rewritten, reason);

    assert.equal(demoted.body, rewritten.body);
    assert.match(demoted.body, /Jane Doe/);
  });

  it('keeps tokens that named nobody alongside the demoted ones', async () => {
    const context = stub(directory);
    const rewritten = await rewriteMentions('@@nobody@acme.com and @@jdoe', 'text/plain', context);
    const demoted = demoteMentions(rewritten, reason);

    assert.deepEqual(
      demoted.unresolved.map((entry) => entry.token),
      ['nobody@acme.com', 'Jane Doe'],
    );
  });

  it('is a no-op when nothing resolved', async () => {
    const context = stub(directory);
    const rewritten = await rewriteMentions('@@nobody@acme.com', 'text/plain', context);

    assert.equal(demoteMentions(rewritten, reason), rewritten);
  });
});
