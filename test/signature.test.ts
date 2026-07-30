import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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

    assert.equal(text, 'Mira Mentioned\n\n--\n Email: hot@example.com - Web: http://www.example.com/\n--');
  });

  it('decodes the entities the renderer introduced', () => {
    assert.equal(htmlToText('Tom &amp; Jerry &lt;hi&gt;&nbsp;there'), 'Tom & Jerry <hi> there');
  });
});
