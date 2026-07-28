# Integration tests

These run against a real Zammad in Docker. The unit suite proves the markup we
generate is what we meant; only this proves the half we do not control — that
Zammad reads that markup back and turns it into a mention and a notification.

```bash
npm run zammad:up          # boot and seed (first run pulls images, several minutes)
npm run test:integration
npm run zammad:down        # stop and delete the volumes
```

Without a running instance the tests skip rather than fail, so `npm test` and CI
stay green on machines without Docker. `npm run verify` does not include them.

## What `up.sh` does

Boots the stack, waits for the rails server, then applies `seed.rb`.

Two things that are easy to get wrong, both already handled:

- **`AUTOWIZARD_JSON` does not work here.** The entrypoint base64-decodes it and
  writes `tmp/auto_wizard.json` inside the *init* container, whose `tmp/` is
  shared with nothing. The rails server never sees the file, so the instance sits
  in its setup wizard while the logs say `Saving autowizard json payload...`.
  `seed.rb` does the same work where it takes effect.
- **Admin is not enough to open a ticket.** Group access lives in
  `group_ids_access_map`, which the REST API does not expose. Without it ticket
  creation returns a bare 403. `seed.rb` grants it.

## Accounts

| Account                 | Role     | Purpose                       |
| ----------------------- | -------- | ----------------------------- |
| `admin@example.test`    | Admin    | what the MCP server connects as |
| `mira@example.test`     | Agent    | the user the tests mention    |
| `customer@example.test` | Customer | ticket customer               |

Password for all: `IntegrationT3st!`. Throwaway instance — the volumes are meant
to be deleted.

## Trimmed on purpose

No websocket, no backup, and **no Elasticsearch** — a JVM plus an index rebuild
is more than a CI runner should carry on every push.

The **scheduler stays**: notification jobs run there, and a mention that never
notifies is the exact failure this suite exists to catch.

### What dropping Elasticsearch costs

Zammad answers searches from the database without it, so every selector these
tests build is still executed and checked against real results. The gap is
narrower than it sounds but real: `strategy: "fulltext"` is exercised end to end,
yet Zammad parses the query itself rather than handing it to Elasticsearch. A
query string that Zammad accepts and Elasticsearch rejects would pass here.

Production runs with Elasticsearch. To close the gap locally, add the service
back and set `ELASTICSEARCH_ENABLED: "true"`.
