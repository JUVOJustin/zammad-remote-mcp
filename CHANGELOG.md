# Changelog

Notable changes per release. The section matching a tag is used as that release's
notes, with the pull-request list appended automatically — see
`.github/workflows/deploy.yml`.

## 3.1.0

A pass over what the tools *say* rather than what they do. 3.0.0 made every
write HTML without telling the caller to write HTML, and the instruction surface
had grown copies of itself: bullets restating the tool they named, and two tools
that were presets of a third.

### The tools ask for HTML, not Markdown

The conversion 3.0.0 introduced is a safety net, not a formatter: it escapes a
body and keeps its line breaks, so Markdown passes through intact and reaches
the reader as `**` and `[…](…)`. Reading pulls the other way — bodies come back
as Markdown by default — so a caller mirroring the format it just read writes
the one thing nothing renders. The descriptions said "plain text or HTML, either
is stored as HTML", which reads as a choice between equals and is not one.

Every writing tool now asks for HTML outright, in one shared sentence rather
than four that drift apart. Prose without markup is still accepted and still
keeps its line breaks — it simply arrives unformatted, which the note says
rather than leaving it to be discovered.

`zammad_mass_update_tickets` was the one writing tool whose article carried no
note about the body format at all; it has one now. Its behaviour was already
correct.

`zammad_update_article` deliberately does not carry the note. It no longer takes
a `body` at all — see below.

### The server instructions say only what no tool can

They are read on every connection, whether the tool they mention is reached for
or not, and every line in them is a second copy to keep in step. Three restated
the tool they named and are gone — the `zammad_delete_ticket` warning, the
`zammad_list_tags` spelling hint and the internal-note default, each of which
the tool itself already says, in more detail and at the point of use.

What is left is the two things no single description can carry, because they are
about choosing between tools or reading a result: that the schemas hold this
instance's valid values, and that `zammad_search_tickets` is where filtering
belongs. One more joins them: which credential is in play changes how every
search result should be read, and no tool that returns those results says so —
`zammad_get_user` with `me` answers it.

### Two tools removed, both answerable by one that stays

A minor release rather than a major: neither capability is gone, only the second
way to reach it. A tool that is a preset of another tool is one more thing to
choose wrongly between, and the preset is the part a caller can supply.

- **`zammad_get_customer_tickets`** wrapped `/api/v1/ticket_customer`, the
  customer sidebar's open/closed split. `zammad_search_tickets` answers it with
  `customer` plus `state` — a filter it already documents and resolves by login
  or email.
- **`zammad_whoami`** read `/api/v1/users/me`. `/api/v1/users/:id` with `expand`
  returns a strict superset of that record — verified field for field against a
  live instance — and returns roles and group access as *names* where `me` has
  only ids. Its one irreplaceable part was not needing to know your own id, so
  `zammad_get_user` now takes `me`, resolved to the authenticated user the way
  the search filters already resolve `owner: ["me"]`. The `permissions` field
  `whoami` reported was always null; Zammad puts it on neither endpoint.

`me` is resolved wherever a user is, not only on `zammad_get_user`, so it works
for any argument that takes a login or an email. `roles` joins the user summary
for the same reason it mattered on `whoami`: it is what separates an agent from
a customer, and that decides what a credential can see at all.

### `zammad_update_article` refuses what Zammad would drop

Zammad discards a replacement `body` and `subject` on
`PUT /api/v1/ticket_articles/:id`: it answers `200` and stores neither. Verified
against 7.1.1 as admin, reading the article back after each field on its own —
only `internal` is ever applied. The tool accepted both and reported
`updated: true` regardless, which is the same silent no-op 2.0.0 fixed for
`zammad_mass_update_tickets`: nothing downstream could tell the write from a
write that did not happen.

Both arguments are gone, so the strict schema now answers `Unrecognized key`
instead. `internal` is required, being the only thing left to change, and the
tool is titled for what it does. To correct the text of an article, add a new
one with `zammad_create_article`.

## 3.0.0

Every article the writing tools produce is now `text/html`, and the
`content_type` argument is gone. One breaking change, one consequence, one fix —
all three from the same finding.

### Every write is HTML

Verified against Zammad's own source and empirically against a live instance:
the agent UI composes nothing but HTML, an article's `content_type` *is* the
send format (there is no "store HTML, send as text" switch), and a `text/html`
article goes out as `multipart/alternative` with a plain-text part **Zammad
generates itself** via its `html2text`. A `text/plain` article, by contrast, is
sent verbatim — markup in such a body reaches the reader as literal angle
brackets, and Zammad converts nothing for it.

So the format knob was an invitation to pick wrongly, and its default —
`text/plain` — made every emailed signature degrade. Both are gone:

- `body` may be authored as plain text or as HTML. Plain prose is converted the
  way the UI converts pasted text (`App.Utils.text2html`, mirrored: escaped,
  line breaks kept, each line a `<div>`, an empty line a `<div><br></div>`); a
  body already carrying a complete HTML tag is stored as it is.
- The group signature is appended **one to one as stored**, wrapped in Zammad's
  own `data-signature` marker — never pre-rendered to text. What a text-only
  reader sees is Zammad's rendering, not ours.
- Text-only readers lose nothing: the plain part of every outgoing mail is
  generated by Zammad from the same HTML.

### Breaking changes

- **`content_type` is refused** on `zammad_create_ticket`, `zammad_update_ticket`
  and `zammad_create_article` — the schemas are strict, so passing it is an
  error, not a no-op. There is no format to pick any more.
- **Plain bodies are stored as HTML.** A note written as `line one\nline two`
  is stored as `<div>line one</div><div>line two</div>` (a single line as
  `<span>…</span>`), exactly as the UI would have written it. The Markdown
  rendering on read returns the text as written.

### Fixed

- `htmlToText` — now serving the signature previews and the duplicate check —
  reads line structure from the markup the way a browser lays it out, instead
  of from how the HTML happens to be indented. A signature pasted into Zammad
  from a word processor (block elements and `<br>`s mixed) previously came out
  with paragraphs glued together in some places and blank lines invented in
  others.
- A body an older release signed as `text/plain`, read back and resent, is
  recognised as already signed by its trailing text and is not signed twice,
  even though the conversion leaves it without a `data-signature` marker.

## 2.0.0

A major release: several tool inputs and response shapes changed in ways that
break callers written against 1.x. Read **Breaking changes** before upgrading.

### Email articles are signed, as the agent UI signs them

Zammad adds no signature server-side — the agent UI composes one into the body
before it posts, so an article written through the API went out unsigned where
the same article written by hand would not. `append_signature`, **on by default**,
closes that gap on `zammad_create_ticket`, `zammad_update_ticket` and
`zammad_create_article`.

It follows the UI rather than approximating it: only on the email channel
(`type: "email"`, `sender: "Agent"`), only when the group has an active signature,
and a group changed in the same call wins over the one the ticket already has.
Placeholders resolve the way `App.Utils.replaceTags` resolves them, down to
rendering anything unresolved as `-`. A note or a phone article is never signed.

Never two signatures in one article: a body already carrying the same
`data-signature-id` comes back byte for byte, any other top-level signature is
replaced, and a signature inside a `blockquote` is the other side's and is left
alone.

The lookup never fails a write. An unsigned group, a signature an admin switched
off, an empty template, a group that cannot be resolved — each writes the article
exactly as given and reports why nothing was appended.

### New: `zammad_get_group_signature`

The one thing signing cannot de-duplicate is prose: `Kind regards, Jane` typed
into the body is indistinguishable from the message. Whether the body still needs
a closing depends on the signature — some carry one above the name, Zammad's own
default does not — so this tool returns the exact text that would be appended,
with placeholders already resolved. It renders through the same code that writes,
so preview and article cannot drift.

### Mass update writes the note it promised

`zammad_mass_update_tickets` accepted an `article` and silently wrote nothing:
Zammad reads it from a top-level parameter, and it was nested inside `attributes`,
where `clean_update_params` discards it. The call returned `200` and reported
success. The `@@mention` rewrite fed that same dead path, so those mentions were
resolved and then thrown away.

### Tests run against a real Zammad

The stub Zammad is gone. It could only confirm what we already believed about the
real one, and twice that belief was wrong in ways it happily reproduced. Every
assertion that depends on Zammad agreeing now runs against the Docker instance
and reads its result back off it.

### Breaking changes

- **Every tool schema is strict.** An argument that is not declared is refused by
  name instead of being dropped. A misspelled `stat` used to be discarded and the
  search answered *unfiltered* — a wrong answer presented as a right one. Callers
  passing stray keys will now see `Unrecognized key: "…"`.
- **`zammad_update_ticket_title` is gone.** Use `zammad_update_ticket` with
  `title`.
- **Ticket and article responses changed shape.** `raw_ticket` and `raw_article`
  are replaced by `output: "full"`, which is asked for rather than always
  attached. The default shape is everything Zammad returned minus its internal
  bookkeeping and the numeric twin of any field already spelled out.
- **Article bodies come back as Markdown**, with the quoted reply and signature
  removed. Pass `body_format: "html"` for the stored markup.
- **`zammad_mass_update_tickets` takes a note and only a note.** Its article is
  `{body, internal}`; `type`, `sender`, `to`, `cc`, `subject`, `content_type`,
  `in_reply_to`, `time_unit`, `origin_by` and `attachments` are refused. Zammad's
  own bulk form offers no other article type, and one article applied to a whole
  batch has no sensible recipient. Reply per ticket with
  `zammad_create_article`.
- **Email articles are now signed by default.** Set `append_signature: false` to
  restore the 1.x body, and do not write the sender's own name at the end of a
  body you leave signed, or it appears twice.

### Fixed

- `article_count` ranges are routed through Elasticsearch, which is the only
  backend that can answer them.
- `@@mentions` are resolved when an article rides along with `zammad_create_ticket`,
  `zammad_update_ticket` or `zammad_mass_update_tickets`, not only on
  `zammad_create_article`.
