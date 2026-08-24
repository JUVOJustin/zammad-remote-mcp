import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authoredContentType,
  composeBody,
  ensureHtml,
  looksLikeMarkup,
  mentionsNotCarried,
  spaceParagraphs,
  text2html,
  textCleanup,
} from '../src/core/zammad/compose.js';
import { htmlToText } from '../src/core/zammad/signature.js';

describe('textCleanup', () => {
  it('mirrors App.Utils.textCleanup', () => {
    assert.equal(textCleanup('  a\r\nb\rc  \n'), 'a\nb\nc');
    assert.equal(textCleanup('a \nb'), 'a\nb');
    assert.equal(textCleanup('a\n\n\n\n\nb'), 'a\n\nb');
    assert.equal(textCleanup(''), '');
  });
});

describe('text2html', () => {
  it('turns each line into a <div> and an empty line into <div><br></div>', () => {
    assert.equal(
      text2html('Hallo,\n\ndanke für Ihre Nachricht.\nViele Grüße'),
      '<div>Hallo,</div><div><br></div><div>danke für Ihre Nachricht.</div><div>Viele Grüße</div>',
    );
  });

  it('wraps a single line in <span>, as the UI does', () => {
    assert.equal(text2html('Alles klar.'), '<span>Alles klar.</span>');
  });

  it('escapes markup instead of interpreting it', () => {
    assert.equal(text2html('a < b & "c"\nd'), '<div>a &lt; b &amp; &quot;c&quot;</div><div>d</div>');
  });

  it('keeps doubled spaces via &nbsp;, as the UI does', () => {
    assert.equal(text2html('a  b'), '<span>a &nbsp;b</span>');
  });

  it('round-trips through htmlToText', () => {
    // The <div>-per-line shape is exactly what htmlToText folds back into
    // lines — a converted body must read back as authored.
    const authored = 'Hallo,\n\ndanke für Ihre Nachricht.\n\nViele Grüße';
    assert.equal(htmlToText(text2html(authored)), authored);
  });
});

describe('looksLikeMarkup', () => {
  it('recognises a complete tag and nothing less', () => {
    for (const markup of ['<p>Hi</p>', 'vor <b>fett</b> nach', '<br/>', '<a href="x">y</a>', '</div>']) {
      assert.equal(looksLikeMarkup(markup), true, markup);
    }
    for (const prose of [
      'Bitte an <info@example.com> antworten.',
      'x < y > z',
      'Ich <3 Support',
      'kein Markup weit und breit',
    ]) {
      assert.equal(looksLikeMarkup(prose), false, prose);
    }
  });
});

describe('spaceParagraphs', () => {
  it('separates adjacent paragraphs with a blank line the mail template keeps', () => {
    assert.equal(
      spaceParagraphs('<p>Lieber Benjamin,</p><p>vielen Dank.</p><p>Viele Grüße</p>'),
      '<div>Lieber Benjamin,</div><div><br></div><div>vielen Dank.</div><div><br></div><div>Viele Grüße</div>',
    );
  });

  it('drops the layout whitespace between two paragraphs', () => {
    assert.equal(
      spaceParagraphs('<p style="margin: 0;">eins</p>\n\n  <p>zwei</p>'),
      '<div>eins</div><div><br></div><div>zwei</div>',
    );
  });

  it('adds no trailing blank line, since the signature brings its own break', () => {
    assert.equal(spaceParagraphs('<p>nur ein Absatz</p>'), '<div>nur ein Absatz</div>');
  });

  it('leaves markup without paragraphs alone', () => {
    const authored = '<div>Zeile 1</div><div><br></div><div>Zeile 2</div><ul><li>a</li></ul>';
    assert.equal(spaceParagraphs(authored), authored);
  });

  it('keeps a deliberately empty paragraph as the one blank line it stood for', () => {
    assert.equal(
      spaceParagraphs('<p>eins</p><p><br></p><p>zwei</p>'),
      '<div>eins</div><div><br></div><div>zwei</div>',
    );
  });

  it('leaves an unclosed paragraph alone rather than opening a div nothing closes', () => {
    assert.equal(spaceParagraphs('<p>eins<p>zwei'), '<p>eins<p>zwei');
  });

  it('adds no filler across a block that already separates', () => {
    assert.equal(
      spaceParagraphs('<p>eins</p><ul><li>a</li></ul><p>zwei</p>'),
      '<div>eins</div><ul><li>a</li></ul><div>zwei</div>',
    );
  });

  it('reads back as the paragraphs it was written from', () => {
    // htmlToText is what the signature preview and the outgoing text part both
    // fold this shape back into — a blank line has to survive the round trip.
    assert.equal(
      htmlToText(spaceParagraphs('<p>Hallo,</p><p>danke für Ihre Nachricht.</p>')),
      'Hallo,\n\ndanke für Ihre Nachricht.',
    );
  });
});

describe('ensureHtml', () => {
  it('converts plain prose and spaces markup paragraphs', () => {
    assert.equal(ensureHtml('Zeile 1\nZeile 2', 'text/plain'), '<div>Zeile 1</div><div>Zeile 2</div>');
    assert.equal(ensureHtml('<p>schon Markup</p>', 'text/html'), '<div>schon Markup</div>');
  });

  it('keeps angle-bracketed prose as visible text', () => {
    const body = 'Bitte an <info@example.com> antworten.';
    assert.equal(authoredContentType(body), 'text/plain');
    assert.equal(
      ensureHtml(body, authoredContentType(body)),
      '<span>Bitte an &lt;info@example.com&gt; antworten.</span>',
    );
  });
});

describe('composeBody', () => {
  const compose = (body: string, type: string) => composeBody(body, type, authoredContentType(body));

  it('stores HTML for the types Zammad renders as HTML', () => {
    for (const type of ['email', 'note', 'phone', 'web']) {
      assert.deepEqual(compose('<p>eins</p><p>zwei</p>', type), {
        body: '<div>eins</div><div><br></div><div>zwei</div>',
        content_type: 'text/html',
      });
    }
  });

  it('finishes the text itself for a channel that sends the body raw', () => {
    // communicate_sms_job.rb sends article.body.first(160) — nothing converts
    // it, so a <div> would be delivered spelled out and billed for.
    for (const type of ['sms', 'telegram personal-message', 'whatsapp message', 'facebook feed post']) {
      assert.deepEqual(compose('<p>eins</p><p>zwei</p>', type), {
        body: 'eins\n\nzwei',
        content_type: 'text/plain',
      });
    }
  });

  it('leaves prose for such a channel as authored', () => {
    assert.deepEqual(compose('Ihr Termin ist bestätigt.', 'sms'), {
      body: 'Ihr Termin ist bestätigt.',
      content_type: 'text/plain',
    });
  });

  it('converts a markup body for those channels rather than escaping it', () => {
    assert.deepEqual(compose('<div>Hallo</div><div><br></div><div><b>Ada</b></div>', 'sms'), {
      body: 'Hallo\n\nAda',
      content_type: 'text/plain',
    });
  });
});

describe('mentionsNotCarried', () => {
  it('says nothing for the types that store their body as HTML', () => {
    for (const type of ['email', 'note', 'phone', 'web', 'chat', 'fax']) {
      assert.equal(mentionsNotCarried(type), null, type);
    }
  });

  it('gives a refusal a caller can act on for a type stored as text', () => {
    for (const type of ['sms', 'telegram personal-message', 'whatsapp message', 'facebook feed post']) {
      const reason = mentionsNotCarried(type);
      assert.ok(reason, type);
      assert.ok(reason.includes(type), reason);
      assert.match(reason, /internal note/, 'it has to say where the mention does work');
    }
  });
});
