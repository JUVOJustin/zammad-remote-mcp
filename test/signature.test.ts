import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '../src/core/util/logger.js';
import { text2html } from '../src/core/zammad/compose.js';
import type { LookupService } from '../src/core/zammad/lookup.js';
import {
  appendGroupSignature,
  appendToHtmlBody,
  buildSignatureElement,
  htmlToText,
  placeSignature,
  replaceTags,
} from '../src/core/zammad/signature.js';

/**
 * The signature helpers, checked against Zammad's own frontend.
 *
 * Every expectation below was taken by running the real `App.Utils.replaceTags`
 * out of a Zammad 6 `application-*.js` bundle against the same input. That
 * matters because the interesting cases are the ones nobody would guess: an
 * unresolved placeholder renders as `-` rather than as nothing, markup inside
 * the braces is discarded before the path is split, and values are HTML-escaped.
 * Get any of those wrong and the mistake ships inside a customer's email.
 */

const context = {
  user: {
    firstname: 'Mira',
    lastname: 'Mentioned',
    email: 'mira@example.test',
    blank: '',
    missing: null,
    address: { city: 'Kiel' },
  },
  ticket: { title: 'Tom & Jerry <hi>', group: { name: 'Users' } },
  config: { fqdn: 'zammad.example.com' },
};

describe('replaceTags', () => {
  it('substitutes a dotted path', () => {
    assert.equal(replaceTags('#{user.firstname} #{user.lastname}', context), 'Mira Mentioned');
    assert.equal(replaceTags('#{user.address.city}', context), 'Kiel');
    assert.equal(replaceTags('#{ticket.group.name}', context), 'Users');
  });

  it('tolerates up to two spaces of padding, as the original regex does', () => {
    assert.equal(replaceTags('#{ user.firstname }', context), 'Mira');
    assert.equal(replaceTags('#{  user.firstname  }', context), 'Mira');
  });

  it('strips markup out of the path', () => {
    // The rich-text editor readily splits a placeholder across tags, so Zammad
    // removes them before splitting on ".". Without this the signature would
    // render "-" wherever an agent had ever styled part of a placeholder.
    assert.equal(replaceTags('#{user.<b>first</b>name}', context), 'Mira');
  });

  it('renders anything unresolved as a dash, never as an empty string', () => {
    for (const template of [
      '#{user.nope}',
      '#{user.blank}',
      '#{user.missing}',
      '#{user.firstname.deeper}',
      '#{nothing.at.all}',
    ]) {
      assert.equal(replaceTags(template, context), '-', template);
    }
  });

  it('HTML-escapes what it substitutes', () => {
    // The signature body is HTML and goes out as an email; a customer name
    // carrying markup must not become markup.
    assert.equal(replaceTags('#{ticket.title}', context), 'Tom &amp; Jerry &lt;hi&gt;');
  });

  it('leaves text without placeholders alone', () => {
    assert.equal(replaceTags('Kind regards', context), 'Kind regards');
  });

  it('does not print [object Object] for a path that lands on an object', () => {
    // Zammad's own renderer emits "[object Object]" here. A dash is what an
    // empty value already produces and is the lesser of the two in an email.
    assert.equal(replaceTags('#{user.address}', context), '-');
  });
});

describe('buildSignatureElement', () => {
  it('wraps the body in the marker Zammad recognises', () => {
    assert.equal(
      buildSignatureElement(7, 'Mira Mentioned'),
      '<div data-signature="true" data-signature-id="7">Mira Mentioned</div>',
    );
  });

  it('drops the leading and trailing line breaks, as htmlStrip does', () => {
    // Zammad's stock signature body opens with a <br>.
    assert.equal(
      buildSignatureElement(1, '<br>  Mira<br>--<br>'),
      '<div data-signature="true" data-signature-id="1">  Mira<br>--</div>',
    );
  });
});

describe('appendToHtmlBody', () => {
  it('separates the signature from the body with a blank line', () => {
    assert.equal(appendToHtmlBody('Hello', '<div>sig</div>'), 'Hello<br><br><div>sig</div>');
  });

  it('does not add another break when the body already ends in one', () => {
    assert.equal(appendToHtmlBody('Hello<br>', '<div>sig</div>'), 'Hello<br><div>sig</div>');
    assert.equal(appendToHtmlBody('Hello<br />', '<div>sig</div>'), 'Hello<br /><div>sig</div>');
  });
});

/**
 * Never two signatures in one article.
 *
 * Both UI call sites guard against it — the create screen returns early on
 * `[data-signature-id="N"]` and the composer compares the first top-level
 * marker — so a body that already carries a signature must not gain a second.
 * This is the case a caller reaches by retrying a call or by passing back a body
 * it read off an earlier article.
 */
describe('placeSignature', () => {
  const element = '<div data-signature="true" data-signature-id="1">Mira</div>';

  it('appends when the body has no signature', () => {
    const placed = placeSignature('Hello', 1, element);
    assert.equal(placed.changed, true);
    assert.equal(placed.body, `Hello<br><br>${element}`);
  });

  it('leaves a body that already carries this signature untouched', () => {
    const body = `Hello<br><br>${element}`;
    const placed = placeSignature(body, 1, element);

    assert.equal(placed.changed, false);
    assert.equal(placed.body, body, 'the body must come back byte for byte');
  });

  it('replaces a different signature rather than stacking on it', () => {
    const other = '<div data-signature="true" data-signature-id="9">Someone else</div>';
    const placed = placeSignature(`Hello<br><br>${other}`, 1, element);

    assert.equal(placed.changed, true);
    assert.equal(placed.body, `Hello<br><br>${element}`);
    assert.ok(!placed.body.includes('Someone else'), placed.body);
    // The separator the removed signature sat behind is reused, not doubled —
    // `appendToBottom` sees a body already ending in a break.
    assert.equal(placed.body.match(/<br>/g)?.length, 2, placed.body);
  });

  it('removes every top-level signature, not just the first', () => {
    const a = '<div data-signature="true" data-signature-id="7">A</div>';
    const b = '<div data-signature="true" data-signature-id="8">B</div>';
    const placed = placeSignature(`Hi<br><br>${a}${b}`, 1, element);

    assert.equal(placed.body, `Hi<br><br>${element}`);
  });

  it('keeps nested markup inside the signature it removes', () => {
    const nested = '<div data-signature="true" data-signature-id="9"><div>inner</div>tail</div>';
    const placed = placeSignature(`Hello<br><br>${nested}`, 1, element);

    // A naive scan for the first </div> would leave "tail</div>" behind.
    assert.equal(placed.body, `Hello<br><br>${element}`);
  });

  it('does not touch a signature inside a quoted reply', () => {
    // The other side's signature in a quote is theirs. `removeTopLevel` excludes
    // `blockquote [data-signature=true]`, and rewriting a quote would be exactly
    // the kind of side effect to avoid.
    const quoted =
      '<blockquote type="cite"><div data-signature="true" data-signature-id="9">Them</div></blockquote>';
    const placed = placeSignature(`Hello<br><br>${quoted}`, 1, element);

    assert.equal(placed.changed, true);
    assert.ok(placed.body.includes('Them'), 'the quoted signature was destroyed');
    assert.equal(placed.body, `Hello<br><br>${quoted}<br><br>${element}`);
  });

  it('still recognises its own signature when the attributes are single-quoted', () => {
    const single = "<div data-signature='true' data-signature-id='1'>Mira</div>";
    assert.equal(placeSignature(`Hello<br><br>${single}`, 1, element).changed, false);
  });

  it('leaves a signature whose markup never closes, and everything after it', () => {
    // Treating "no closing tag" as "the rest of the body is the signature" would
    // splice the caller's own words out of an outgoing email — far worse than
    // leaving a stale signature in place.
    const broken = '<div data-signature="true" data-signature-id="9">old sig<p>Important question?</p>';
    const placed = placeSignature(`Hello<br><br>${broken}`, 1, element);

    assert.ok(placed.body.includes('Important question?'), `caller content was deleted: ${placed.body}`);
    assert.ok(placed.body.endsWith(element), placed.body);
  });

  it('treats a marker without an id as someone else’s and replaces it', () => {
    const noId = '<div data-signature="true">Legacy</div>';
    const placed = placeSignature(`Hello<br><br>${noId}`, 1, element);

    assert.equal(placed.changed, true);
    assert.ok(!placed.body.includes('Legacy'), placed.body);
  });
});

describe('htmlToText', () => {
  it('turns a signature body into something a text/plain article can carry', () => {
    const text = htmlToText(
      '<br>  Mira Mentioned<br><br>--<br> Email: hot@example.com - Web: ' +
        '<a href="http://www.example.com/">http://www.example.com/</a><br>--',
    );

    assert.equal(text, 'Mira Mentioned\n\n--\nEmail: hot@example.com - Web: http://www.example.com/\n--');
  });

  it('decodes the entities the renderer introduced', () => {
    assert.equal(htmlToText('Tom &amp; Jerry &lt;hi&gt;&nbsp;there'), 'Tom & Jerry <hi> there');
  });

  it('breaks once between adjacent blocks, however the source is indented', () => {
    // The same two paragraphs, formatted three ways. All render alike, so all
    // three have to come out alike — the old pass turned the source's own
    // newlines into blank lines.
    assert.equal(htmlToText('<p>One</p><p>Two</p>'), 'One\nTwo');
    assert.equal(htmlToText('<p>One</p>\n\n<p>Two</p>'), 'One\nTwo');
    assert.equal(htmlToText('<p>One</p>\n  <div>Two</div>'), 'One\nTwo');
  });

  it('leaves a blank line where the author put one', () => {
    // An empty paragraph and a doubled break are the two ways of asking for it.
    assert.equal(htmlToText('<p>One</p><p><br></p><p>Two</p>'), 'One\n\nTwo');
    assert.equal(htmlToText('<p>One</p><p>&nbsp;</p><p>Two</p>'), 'One\n\nTwo');
    assert.equal(htmlToText('One<br><br>Two'), 'One\n\nTwo');
    // ...but a break that merely ends a line before a block starts is not one.
    assert.equal(htmlToText('--<br><p>One</p>'), '--\nOne');
    // ...nor is a paragraph of collapsible whitespace, which a browser gives no
    // line box at all. `&nbsp;` above is the spacer that does.
    assert.equal(htmlToText('<p>One</p><p> </p><p>Two</p>'), 'One\nTwo');
  });

  it('renders a signature pasted in from a word processor', () => {
    // Verbatim from a live instance: <div> and <p> mixed within one signature,
    // inline <span style> wrappers, and stray newlines between the tags.
    const text = htmlToText(
      '<div>Viele Grüße</div>  Justin Vogt<br><br>--<br><p><b>Citation Media GmbH </b></p>\n\n' +
        '<p>Vertreten durch Justin Vogt</p><div>Mülheimer Str. 7</div>' +
        '<p><span style=" color: var(--text-normal);">40239 Düsseldorf</span></p>' +
        '<p><span style=" color: var(--text-normal);"><br></span></p>' +
        '<p><b>Telefon:</b><span style=" color: var(--text-normal);"> +49 211 94253737</span></p><p>\n' +
        '<b>E-Mail:</b> <a href="mailto:info@citation.media">info@citation.media</a><br>\n' +
        '<b>Website:</b> <a href="http://citation.media/" target="_blank">citation.media</a> </p>' +
        '<p><br></p>\n\n<p> </p>\n\n<p><b>Steuernummer:</b> 103/5791/0940<br>\n' +
        '<b>Umsatzsteuer ID:</b> DE360429258<br>\n' +
        '<b>Amtsgericht Düsseldorf - HRB 100294</b> </p>\n\n' +
        '<p>AGB: <a href="http://citation.media/AGB" target="_blank">citation.media/AGB</a> </p>--',
    );

    assert.equal(
      text,
      [
        'Viele Grüße',
        'Justin Vogt',
        '',
        '--',
        'Citation Media GmbH',
        'Vertreten durch Justin Vogt',
        'Mülheimer Str. 7',
        '40239 Düsseldorf',
        '',
        'Telefon: +49 211 94253737',
        'E-Mail: info@citation.media',
        'Website: citation.media',
        '',
        'Steuernummer: 103/5791/0940',
        'Umsatzsteuer ID: DE360429258',
        'Amtsgericht Düsseldorf - HRB 100294',
        'AGB: citation.media/AGB',
        '--',
      ].join('\n'),
    );
  });
});

describe('appendGroupSignature across the content-type boundary', () => {
  /** The lookup as a signed group answers it, nothing more. */
  const lookup = {
    resolveGroups: async () => [1],
    groups: async () => [{ id: 1, name: 'Users', signature_id: 9 }],
    signatures: async () => [
      { id: 9, name: 'default', active: true, body: 'Viele Grüße<br>#{user.firstname}' },
    ],
    me: async () => ({ firstname: 'Ada' }),
    frontendConfig: async () => ({}),
  } as unknown as LookupService;
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as Logger;

  const email = { type: 'email', sender: 'Agent' };

  it('does not re-sign a plain-signed body the HTML conversion re-encoded', async () => {
    // The retry the README promises to keep safe, crossing formats: an article
    // an older release signed as text/plain, read back, and resent. The
    // conversion leaves no data-signature marker to recognise, so only the
    // trailing text can say it is already signed.
    const readBack = 'Hallo!\n\nViele Grüße\nAda';
    const result = await appendGroupSignature({
      lookup,
      logger,
      article: { ...email, body: text2html(readBack) },
      group: 'Users',
    });

    assert.equal(result.appended, false);
    assert.match(result.reason ?? '', /already ends with this signature/);
    assert.equal(result.body, text2html(readBack), 'the body must be returned untouched');
  });

  it('still signs prose that does not end with the signature', async () => {
    const result = await appendGroupSignature({
      lookup,
      logger,
      article: { ...email, body: text2html('Bitte melden Sie sich bei Ada') },
      group: 'Users',
    });

    assert.equal(result.appended, true, result.reason);
    assert.ok(result.body.includes('data-signature-id="9"'), result.body);
  });
});
