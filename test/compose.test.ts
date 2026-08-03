import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authoredContentType,
  ensureHtml,
  looksLikeMarkup,
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

describe('ensureHtml', () => {
  it('converts plain prose and passes markup through', () => {
    assert.equal(ensureHtml('Zeile 1\nZeile 2', 'text/plain'), '<div>Zeile 1</div><div>Zeile 2</div>');
    assert.equal(ensureHtml('<p>schon Markup</p>', 'text/html'), '<p>schon Markup</p>');
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
