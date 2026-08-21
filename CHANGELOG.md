# Changelog

Notable changes per release. The section matching a tag is used as that release's
notes, with the pull-request list appended automatically — see
`.github/workflows/deploy.yml`.

## Unreleased

### A `@@mention` that named nobody now says so

`@@name` is resolved to a real user and rewritten into the anchor Zammad turns
into a mention. When the name resolves to nobody the token is left as written,
deliberately — a typo must not cost the caller the note they were writing. But
that was all that happened: the article was created, the response omitted
`mentioned`, and an omitted `mentioned` reads exactly like a body that never
contained a mention. Which is the failure this whole path exists to prevent: the
note looks right to whoever wrote it and the colleague is never told.

Seen on a real internal note written as `@@Jannik Pollmeier`. The unquoted form
stops at the first space, so only `Jannik` was ever searched for; that matched
four users, the lookup declined to guess, and the note was filed with the
literal text in it.

Every writing tool now returns `mentions_unresolved` alongside `mentioned` — the
token as written and why it resolved to nobody, in the lookup's own words, so an
ambiguous name comes back with its candidates. An unquoted token also carries
the hint the lookup cannot give, because it never saw the rest of the name:
quote it as `@@"First Last"`.

### A paragraph written as `<p>` reaches the reader as one

The tools ask for HTML, and `<p>` is the tag a paragraph is written with — but
it is the one tag an outgoing Zammad mail does not separate anything with.
`Channel::EmailBuild` wraps the article in its own template, and that template
ends `p { margin: 0 }`, inlined onto every element; the text part is derived by
`html2text`, which reads `</p><p>` as a single newline. A six-paragraph reply
therefore arrived as one block of text in the HTML part and as six unseparated
lines in the text part, while the article read back as correctly spaced Markdown
— the round trip through the renderer put the blank lines back, so nothing about
the stored article showed the problem.

The agent UI never hits this because its composer writes no `<p>`: one `<div>`
per line, `<div><br></div>` for a blank one, which is also what the plain-prose
conversion produces. A written body's paragraphs are now folded into that same
shape, so a `<p>`-separated body and a UI-composed one send the same mail.

Only the boundary between two adjacent paragraphs is filled, and only when
neither side is already blank: an author's own empty paragraph stays the one
empty line it asked for. Paragraphs with a list or another block between them
are left alone, as is an unclosed `<p>`, whose end only a parser could infer.

### A channel that can only carry text is no longer sent markup

3.0.0 made every written article `text/html`, on the strength of what the email
channel does with it: the article's content type is the send format, and
`Channel::EmailBuild` derives the plain-text part itself, so nothing is lost.
That reasoning holds for email and for the article types that are read in the
browser — notes, phone articles, web articles — and for nothing else.

The other channels do not convert at all. SMS sends `article.body.first(160)`
(`communicate_sms_job.rb`), Telegram `text: article.body`
(`communicate_telegram_job.rb`), Facebook `body: article.body`
(`communicate_facebook_job.rb`), WhatsApp the same
(`service/ticket/article/type/whatsapp_message/deliver.rb`). An HTML body on any
of them is delivered spelled out — and on SMS the tags are billed, counting
against the 160 characters. `Ticket::Article#body_as_text` exists but is not on
these paths.

The agent UI settles it in the browser: `sms_reply.coffee`, `telegram.coffee`,
`facebook_reply.coffee` and `whatsapp_reply.coffee` each end
`params.content_type = 'text/plain'` and
`params.body = App.Utils.html2text(params.body, true)`, while the email, phone
and note composers post `text/html` untouched. The channel decides, not the
author.

So the content type is now chosen from the article type rather than fixed. HTML
where the channel renders HTML — unchanged, and Zammad's own conversion of it
stays where it was. For a text-only channel the body is finished here instead,
folded into lines by the same pass the signature preview uses, because there is
no later conversion to leave it to. Callers still write HTML on every type; the
note on `body` now says what becomes of it on a channel that cannot carry it.

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

### `guess:` works where it is documented

The `customer` field has always said "Prefix with `guess:` to create the user if
unknown". It never did: Zammad resolves a `customer` name against existing users
and answers 422 when there is none, and the create-if-unknown path reads the
prefix off `customer_id` — which this schema types as a number, so the feature
was unreachable through these tools entirely. Verified against 7.1.1, the same
address both ways: 422 as `customer`, 201 and a new user as `customer_id`. A
prefixed value now moves across on the way out, so the documentation is true
rather than removed.

### Two more silent no-ops named instead of dropped

- **`tags` on `zammad_mass_update_tickets`.** Same finding as the single update,
  one layer out: a batch carrying `{tags, state}` closes every ticket and tags
  none of them, answering 200. Refused now. There is no `add_tags` counterpart —
  Zammad's own bulk form has no tag field, and a tag call per ticket per tag is
  a different operation from a batch. Tag per ticket with `zammad_update_ticket`.
- **`body_format` on `zammad_update_article`.** It chooses how a returned body
  is rendered, which every article-returning tool offers — but this tool changes
  no content, and a rendering knob on a visibility toggle reads as though it
  might. Gone; the confirmation comes back as Markdown like every default.

### The instance's tags are in the schema, so `zammad_list_tags` is gone

Tags were the one value set left to a discovery tool, on the grounds that the
full list is admin-only. Half true: `/api/v1/tag_list` is admin CRUD and 403s
for an agent, but `tag_search` — the endpoint agents may call — returns every
tag for an empty `term`, provided a `limit` is given. Without one it silently
caps at ten. Verified against 7.1.1: 10 of 32 without, all 32 with.

So tags now travel the same road as states, priorities and groups. They appear
as enums on every argument that takes one — `tags` on create, `add_tags` and
`remove_tags` on update, and all three tag filters on `zammad_search_tickets` —
and a spelling is checked by reading the argument rather than by calling a tool
first.

The enum is advisory, as the others are, and here that is the normal case
rather than the stale-cache case: a tag is created by using it, so an unknown
name has to stay acceptable. There is no numeric-ID branch either — Zammad's
`tags/add` takes an `item`, not an id. Above `SCHEMA_ENUM_MAX_VALUES` (150 by
default) the list is dropped like every other over-long enum and the fields
fall back to free strings, which is what a tag is anyway.

### Tagging moved onto `zammad_update_ticket`

`zammad_add_ticket_tags` and `zammad_remove_ticket_tags` are gone; the update
tool takes `add_tags` and `remove_tags` and runs the same endpoints
(`POST /api/v1/tags/add`, `DELETE /api/v1/tags/remove`, one request per tag).
Tagging rarely travels alone — a triage step is a state change *and* a tag, and
as two calls that pair could half-succeed with nothing able to report it. The
response now carries the resulting tag list, read back rather than assumed,
because whether an unknown tag is created on the fly is the instance's decision.

It also retires a trap. `tags` on an update was accepted and ignored: verified
against 7.1.1, a ticket created with `[alpha, beta]` and then updated with
`[gamma]` still carries `[alpha, beta]`, and the update reports success. The
argument said only "on update, prefer add/remove", which understates a field
that does nothing. It is create-only now, and the strict schema names it on an
update instead of dropping it.

### Three tools removed, each answerable by one that stays

A minor release rather than a major: no capability is gone, only the second way
to reach it. A tool that is a preset of another tool is one more thing to choose
wrongly between, and the preset is the part a caller can supply.

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

- **`zammad_update_ticket_customer`** called
  `PUT /api/v1/tickets/:id/update_customer`. `zammad_update_ticket` matches it
  exactly: passing `customer` on the ordinary update moves the ticket and lets
  the organization follow. Verified against 7.1.1 by reassigning between two
  organizations down both paths and reading the ticket back — same customer,
  same organization. The identifiers matched as well; both took `ticket_id` or
  `ticket_number`, and a customer by login, email or id.

`me` is resolved wherever `LookupService` resolves a user — `zammad_get_user`
and the search filters — not on the ticket write arguments, which hand `owner`
and `customer` to Zammad as names for its own resolver to read and would answer
422 for a literal `me`. `roles` joins the user summary
for the same reason it mattered on `whoami`: it is what separates an agent from
a customer, and that decides what a credential can see at all.

### `zammad_search_global` is gone

It could not do what it said. Its `objects` argument was an array, and Zammad's
`SearchController` calls `.downcase` on that parameter, so the multi-type sweep
the description promised — "tickets, users, organizations and knowledge base
answers in one call" — answered `500 undefined method 'downcase' for an instance
of Array`. A comma-separated string is no better: read as one class name nobody
has, it answers `200` with nothing. Both verified against 7.1.1, the 500 traced
to the exception in the rails log. `/api/v1/search` restricts to everything or
to exactly one type, and offers no third option.

What was left once that was true is a tool that searches everything, or one type
less well than the tool dedicated to it. The idea worth keeping — one free-text
sweep across object types, knowledge base included — needs a fan-out over the
per-type endpoints, not a wrapper around a parameter that cannot express it. It
is removed until that exists rather than kept as the narrower thing it had
silently become.

### Strict at every level, not only at the top

2.0.0 made every tool schema strict and stopped at its outermost object. Five
nested ones went on dropping what they did not recognise: the `article` of
`zammad_create_ticket` and `zammad_update_ticket`, and the `attachments` entries
of those two and of `zammad_create_article`.

Those are the worst places to drop a key. `internal` decides whether a customer
sees an article at all, and a misspelling of it inside `article` published the
article and reported success. `mime-type` carries Zammad's hyphen, so
`mime_type` — the spelling anyone would guess — was discarded and every
attachment went out as `application/octet-stream`.

All five are strict now, and a test walks every schema the server publishes and
fails on any object that still accepts unknown keys, so the next nested schema
cannot repeat this. Maps whose keys are the instance's own (`custom_fields`)
stay open, which is what they are for.

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
