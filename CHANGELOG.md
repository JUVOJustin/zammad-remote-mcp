# Changelog

Notable changes per release. The section matching a tag is used as that release's
notes, with the pull-request list appended automatically — see
`.github/workflows/deploy.yml`.

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
