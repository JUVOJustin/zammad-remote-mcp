import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { presentArticle, presentTicket, withRenderedBody } from '../src/core/mcp/result.js';
import { renderArticleBody } from '../src/core/zammad/article-body.js';

/** Shapes taken from real articles on a live Zammad instance. */
const SIGNATURE_DIV = '<div data-signature="true" data-signature-id="1">';
const SIGNATURE_SPAN = '<span class="js-signatureMarker">';

describe('renderArticleBody', () => {
  it('leaves a plain-text body alone', () => {
    const result = renderArticleBody('Just text.', 'text/plain');
    assert.equal(result.body, 'Just text.');
    assert.deepEqual(result.omitted, []);
  });

  it('returns the stored markup untouched for format html', () => {
    const html = '<div>Hello<blockquote>quoted</blockquote></div>';
    const result = renderArticleBody(html, 'text/html', 'html');
    assert.equal(result.body, html);
    assert.deepEqual(result.omitted, []);
  });

  it('converts markup to markdown and reports nothing omitted', () => {
    const result = renderArticleBody('<p>Line one</p><p>Line two</p>', 'text/html');
    assert.equal(result.body, 'Line one\n\nLine two');
    assert.deepEqual(result.omitted, []);
  });

  it('drops a quoted reply marked type="cite"', () => {
    const html = 'My answer.<blockquote type="cite">Everything they wrote before</blockquote>';
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'My answer.');
    assert.deepEqual(result.omitted, ['quoted_reply']);
  });

  it('drops a bare quote that opens with an attribution line', () => {
    const html =
      'Danke!<blockquote>Am Freitag, 10. November 2023 um 14:27:05, schrieb Thomas Bartsch: Hi Jannik</blockquote><div>Signature line</div>';
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Danke!\n\nSignature line');
    assert.deepEqual(result.omitted, ['quoted_reply']);
  });

  it('drops a bare trailing quote, since top-posting puts the reply above it', () => {
    const html = 'Short answer.<blockquote>the whole thread history</blockquote>';
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Short answer.');
    assert.deepEqual(result.omitted, ['quoted_reply']);
  });

  /**
   * The case blanket removal gets wrong: a blockquote used as formatting, to
   * quote an error message or a document. It is neither marked as a citation,
   * nor introduced by an attribution line, nor trailing — so it is kept.
   */
  it('keeps a mid-body quote that is formatting rather than a reply', () => {
    const html =
      '<p>The installer prints this:</p><blockquote>FATAL: role "zammad" does not exist</blockquote><p>Any idea what causes it?</p>';
    const result = renderArticleBody(html, 'text/html');
    assert.equal(
      result.body,
      'The installer prints this:\n\n> FATAL: role "zammad" does not exist\n\nAny idea what causes it?',
    );
    assert.deepEqual(result.omitted, [], 'nothing was dropped, so nothing may be reported');
  });

  it('marks every line of a kept quote', () => {
    const html = '<p>See:</p><blockquote>line one<br>line two</blockquote><p>Thoughts?</p>';
    assert.equal(renderArticleBody(html, 'text/html').body, 'See:\n\n> line one\n> line two\n\nThoughts?');
  });

  /** Reply chains nest; the deepest seen on a live instance was 13 levels. */
  it('removes a nested reply chain as one unit', () => {
    const html = [
      'Latest answer.',
      '<blockquote type="cite">first level',
      '<blockquote type="cite">second level',
      '<blockquote type="cite">third level</blockquote></blockquote></blockquote>',
    ].join('');
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Latest answer.');
    assert.deepEqual(result.omitted, ['quoted_reply']);
  });

  it('judges each top-level quote separately', () => {
    const html = [
      '<p>Log excerpt:</p><blockquote>ERROR at line 12</blockquote><p>and my reply below</p>',
      '<blockquote type="cite">Am 1.1.2026 schrieb jemand: alter Text</blockquote>',
    ].join('');
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Log excerpt:\n\n> ERROR at line 12\n\nand my reply below');
    assert.deepEqual(result.omitted, ['quoted_reply']);
  });

  it('cuts at a signature div', () => {
    const html = `The actual message<br><br>${SIGNATURE_DIV}Kind regards<br>Justin<br>--<br>Citation Media GmbH</div>`;
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'The actual message');
    assert.deepEqual(result.omitted, ['signature']);
  });

  it('cuts at a signature span', () => {
    const html = `Message body${SIGNATURE_SPAN}</span>Kind regards, Justin`;
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Message body');
    assert.deepEqual(result.omitted, ['signature']);
  });

  /**
   * 18% of customer replies carry a signature marker inside the quoted copy of
   * our own outgoing mail. Cutting at that marker would drop the reply itself,
   * so quotes have to go first.
   */
  it('ignores a signature marker that sits inside the quoted reply', () => {
    const html = [
      'Thanks, that worked!',
      `<blockquote type="cite">Our earlier mail${SIGNATURE_DIV}Kind regards<br>Justin</div></blockquote>`,
    ].join('');
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Thanks, that worked!');
    assert.deepEqual(result.omitted, ['quoted_reply']);
  });

  it('reports both removals when both happened', () => {
    const html = [
      'Answer.',
      `${SIGNATURE_DIV}Kind regards</div>`,
      '<blockquote>older thread</blockquote>',
    ].join('');
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Answer.');
    assert.deepEqual(result.omitted, ['quoted_reply', 'signature']);
  });

  /** An article whose whole body is a signature must not render as empty. */
  it('keeps the signature when cutting it would leave nothing', () => {
    const html = `${SIGNATURE_DIV}Kind regards<br>Justin Vogt</div>`;
    const result = renderArticleBody(html, 'text/html');
    assert.equal(result.body, 'Kind regards\nJustin Vogt');
    assert.deepEqual(result.omitted, []);
  });

  it('keeps the quoted reply when it is the entire body', () => {
    const result = renderArticleBody('<blockquote>only the quote</blockquote>', 'text/html');
    assert.equal(result.body, '> only the quote');
    assert.deepEqual(result.omitted, []);
  });

  it('keeps a link target the anchor text does not name', () => {
    const html = '<a href="https://example.com/ticket/42">the ticket</a>';
    assert.equal(renderArticleBody(html, 'text/html').body, '[the ticket](https://example.com/ticket/42)');
  });

  it('does not repeat a link whose text is already the URL', () => {
    const html = '<a href="https://example.com/x">https://example.com/x</a>';
    assert.equal(renderArticleBody(html, 'text/html').body, 'https://example.com/x');
  });

  it('keeps mailto and cid anchors as their visible text', () => {
    const html = '<a href="mailto:jane@acme.com">jane@acme.com</a>';
    assert.equal(renderArticleBody(html, 'text/html').body, 'jane@acme.com');
  });

  it('keeps headings and lists as markdown', () => {
    const html = '<h2>Schritte</h2><ul><li>eins</li><li>zwei</li></ul>';
    assert.equal(renderArticleBody(html, 'text/html').body, '## Schritte\n\n-   eins\n-   zwei');
  });

  /**
   * Emphasis in support mail is nearly always styling — a coloured brand word,
   * a bolded greeting. The text is kept, the markers are not.
   */
  it('drops emphasis markers but keeps their text', () => {
    const html = '<p>Ein <b>fetter</b> und <em>schräger</em> Satz</p>';
    assert.equal(renderArticleBody(html, 'text/html').body, 'Ein fetter und schräger Satz');
  });

  /** Turndown alone puts every cell on its own line, scattering a small table. */
  it('keeps a table row on one line', () => {
    const html =
      '<table><tr><th>Zeit</th><th>Bestellung</th></tr><tr><td>07:41</td><td>#48211</td></tr></table>';
    assert.equal(renderArticleBody(html, 'text/html').body, 'Zeit | Bestellung\n07:41 | #48211');
  });

  it('does not turn a plain-text body into markdown', () => {
    // Running plain text through a converter would escape its punctuation.
    const body = 'Preis: 5 * 3 = 15 (siehe _Anlage_)';
    assert.equal(renderArticleBody(body, 'text/plain').body, body);
  });

  it('decodes named, decimal and hex entities', () => {
    const html = '<p>Gr&uuml;&szlig;e &amp; Dank &#8364; &#x1F600;</p>';
    assert.equal(renderArticleBody(html, 'text/html').body, 'Grüße & Dank € 😀');
  });

  it('drops scripts, styles and inline images', () => {
    const html = '<style>p{color:red}</style><script>alert(1)</script><p>Text</p><img src="cid:1">';
    assert.equal(renderArticleBody(html, 'text/html').body, 'Text');
  });

  it('trims padding and never runs up more than one blank line', () => {
    const html = '<div>  a  </div>\n\n\n<div>   </div><div>   </div><div>   </div><div>  b  </div>';
    const body = renderArticleBody(html, 'text/html').body;
    // An empty div is a paragraph break, so one blank line is expected — but a
    // run of them must not survive as vertical whitespace.
    assert.equal(body, 'a\n\nb');
    assert.equal(body, body.trim(), 'no leading or trailing whitespace');
    assert.ok(!/\n{3,}/.test(body), 'no runs of blank lines');
    assert.ok(!/[ \t]{2,}/.test(body), 'no runs of spaces');
  });

  /** A pasted screenshot with no accompanying text — real, and easy to render blank. */
  it('says so when an image-only body has no text at all', () => {
    const html =
      '<img style="max-width:100%" src="/api/v1/ticket_attachment/34/106/150?view=inline"><div><br></div>';
    assert.equal(
      renderArticleBody(html, 'text/html').body,
      '[no text content — 1 inline image(s), see attachments]',
    );
  });

  it('handles a missing or empty body', () => {
    assert.equal(renderArticleBody(undefined, 'text/html').body, '');
    assert.equal(renderArticleBody('', 'text/html').body, '');
    assert.equal(renderArticleBody('<div><br></div>', 'text/html').body, '');
  });
});

describe('presentArticle', () => {
  const article = {
    id: 7,
    ticket_id: 3,
    content_type: 'text/html',
    body: `Hello there<blockquote>old</blockquote>${SIGNATURE_DIV}Regards</div>`,
  };

  it('renders bodies as markdown by default and says so', () => {
    const summary = presentArticle(article);
    assert.equal(summary.body, 'Hello there');
    assert.equal(summary.content_type, 'text/markdown');
    assert.deepEqual(summary.body_omitted, ['quoted_reply', 'signature']);
  });

  it('keeps the original markup and content type for html', () => {
    const summary = presentArticle(article, { bodyFormat: 'html' });
    assert.equal(summary.body, article.body);
    assert.equal(summary.content_type, 'text/html');
    assert.equal(summary.body_omitted, undefined, 'nothing is dropped in html mode');
  });

  it('reports the rendered body, not the markup it came from', () => {
    const long = {
      ...article,
      body: `<p>${'x'.repeat(500)}</p><blockquote>${'q'.repeat(9000)}</blockquote>`,
    };
    // 9500 characters of stored markup, 500 characters of message.
    assert.equal(presentArticle(long).body, 'x'.repeat(500));
  });

  /** Zammad's own API returns the stored body in full; so does this. */
  it('never truncates the body', () => {
    const long = { id: 2, content_type: 'text/html', body: `<p>${'x'.repeat(9000)}</p>` };
    assert.equal(presentArticle(long).body, 'x'.repeat(9000));
  });

  it('omits body_omitted when nothing was removed', () => {
    const summary = presentArticle({ id: 1, content_type: 'text/plain', body: 'plain' });
    assert.equal(summary.body_omitted, undefined);
  });
});

/**
 * The tools that hand back the whole Zammad object rather than a summary —
 * `zammad_get_article`'s `raw_article` and `zammad_list_ticket_articles` with
 * `output: "full"`. Zammad offers no representation of its own, so a body that
 * leaves un-rendered here cannot be fixed downstream.
 */
describe('withRenderedBody', () => {
  const article = {
    id: 7,
    ticket_id: 3,
    message_id: '<abc@example.com>',
    content_type: 'text/html',
    body: `Hello there<blockquote type="cite">old thread</blockquote>${SIGNATURE_DIV}Regards</div>`,
  };

  it('renders the body while keeping every other field', () => {
    const full = withRenderedBody(article);
    assert.equal(full.body, 'Hello there');
    assert.equal(full.content_type, 'text/markdown');
    assert.deepEqual(full.body_omitted, ['quoted_reply', 'signature']);
    // Fields the summary drops must survive — that is the point of the raw shape.
    assert.equal(full.message_id, '<abc@example.com>');
    assert.equal(full.ticket_id, 3);
  });

  it('returns the stored markup untouched for html', () => {
    const full = withRenderedBody(article, 'html');
    assert.equal(full.body, article.body);
    assert.equal(full.content_type, 'text/html');
    assert.equal(full.body_omitted, undefined);
  });

  it('does not truncate — the caller asked for the whole object', () => {
    const long = { ...article, body: `<p>${'x'.repeat(9000)}</p>` };
    assert.equal(withRenderedBody(long).body, 'x'.repeat(9000));
  });

  it('leaves the source object alone', () => {
    const source = { ...article };
    withRenderedBody(source);
    assert.equal(source.body, article.body, 'the caller keeps what Zammad sent');
  });

  it('omits body_omitted when nothing was removed', () => {
    const full = withRenderedBody({ id: 1, content_type: 'text/html', body: '<p>plain</p>' });
    assert.equal(full.body_omitted, undefined);
  });
});

/**
 * The reason the curated field lists were replaced. They kept twelve ticket
 * fields and dropped thirty-six, which was fine until an instance added an
 * Object Manager attribute: it vanished on read while the write tools still
 * accepted it. A denylist cannot have that failure mode.
 */
describe('presentTicket', () => {
  const ticket = {
    id: 26909,
    number: '8126901',
    title: 'ZG: Error in Workflow',
    state: 'closed',
    state_id: 4,
    group: 'Users',
    group_id: 1,
    owner: 'umar.janjua@citation.media',
    owner_id: 381,
    note: 'internal remark',
    last_contact_at: '2026-04-16T11:56:37.931Z',
    article_count: 47,
    article_ids: [1, 2, 3],
    first_response_in_min: null,
    update_escalation_at: null,
    preferences: { channel_id: 9 },
    referencing_checklists: [],
    // what an Object Manager attribute looks like on the wire
    kundennummer: 'K-4711',
    sla_stufe: 2,
  };

  it('keeps a field it has never heard of', () => {
    const out = presentTicket(ticket);
    assert.equal(out.kundennummer, 'K-4711');
    assert.equal(out.sla_stufe, 2);
  });

  it('keeps the resolved name and drops its numeric twin', () => {
    const out = presentTicket(ticket);
    assert.equal(out.state, 'closed');
    assert.equal(out.state_id, undefined);
    assert.equal(out.group, 'Users');
    assert.equal(out.group_id, undefined);
    assert.equal(out.owner, 'umar.janjua@citation.media');
    assert.equal(out.owner_id, undefined);
  });

  it('keeps content the old field list dropped', () => {
    const out = presentTicket(ticket);
    assert.equal(out.note, 'internal remark');
    assert.equal(out.last_contact_at, '2026-04-16T11:56:37.931Z');
  });

  it('drops bookkeeping, and article_ids since the count and the articles are there', () => {
    const out = presentTicket(ticket);
    for (const key of ['first_response_in_min', 'update_escalation_at', 'preferences', 'article_ids']) {
      assert.equal(out[key], undefined, `${key} should not survive`);
    }
    assert.equal(out.article_count, 47, 'the count stays');
  });

  it('drops nulls and empty collections', () => {
    const out = presentTicket(ticket);
    assert.ok(!('referencing_checklists' in out));
  });
});
