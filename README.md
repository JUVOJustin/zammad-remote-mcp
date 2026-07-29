# zammad-remote-mcp

A remote [MCP](https://modelcontextprotocol.io) server for [Zammad](https://zammad.org), built on
[Hono](https://hono.dev) and deployable to **Node.js or Cloudflare Workers from one codebase**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JUVOJustin/zammad-remote-mcp/tree/main/examples/cloudflare)

- **Stateless.** No sessions, no token store, no sticky routing — see [below](#is-the-server-stateless).
- **Runtime-agnostic core.** All the logic lives in `src/core`, which imports no Node built-ins. The two
  hosts differ only in where the environment comes from and how the app is served.
- **OAuth 2.1 against Zammad.** Zammad's own Doorkeeper provider is the authorization server; this
  server proxies the flow and adds the dynamic client registration Doorkeeper lacks.
- **Full ticket coverage.** Create, read, update, delete, merge, mass-update, macros, articles,
  attachments, tags, links, time accounting, history.
- **A search layer that builds real queries** from structured filters, and tool schemas whose enums
  are read live from your instance.
- **Zod everywhere.** Environment, tool inputs and selector structures are all schema-validated.

## One package, three entry points

Everything lives in `zammad-remote-mcp`. The source keeps the runtimes apart, but there is a single
version and a single publish.

| Import | What it is |
|---|---|
| `zammad-remote-mcp` | the runtime-agnostic core: Hono app, MCP server, 39 tools, Zammad client, search builder, OAuth proxy. Uses only WebCrypto, `fetch`, `TextEncoder` and `atob`/`btoa`. |
| `zammad-remote-mcp/node` | Node host: `.env` loading, socket binding, signal handling |
| `examples/cloudflare` | a deployable Workers host, ~60 lines, consuming the package like any other dependency |
| `npx zammad-remote-mcp` | the CLI — the Node host with a shebang |

Both hosts call the same `bootstrap({ env, cache })` and serve the same `fetch` handler. Anything
runtime-specific that could not be avoided — reading a file from disk, binding a port — lives in
`src/node` or `src/cloudflare` and nowhere else.

## Quick start — Node.js

```bash
npm install && npm run build
```

Register an application in Zammad's admin panel under **System → API → Applications → New**. Set
**Callback URL** to `<PUBLIC_URL>/oauth/callback` (the form takes one URI per line). Zammad shows the
client ID and secret afterwards. Then:

```bash
cp .env.example .env
```

`.env` is read from the working directory at startup via Node's built-in `process.loadEnvFile` — no
dependency, and **real environment variables take precedence over the file**, so `PORT=3999 npm start`
overrides it and container/systemd environments stay authoritative. Point `ENV_FILE` at another path
to use a different one (a missing `ENV_FILE` is an error; a missing `.env` is not).

```bash
npm start
```

The MCP endpoint is `<PUBLIC_URL>/mcp`. Point an MCP client at it and it will discover the
authorization server on its own.

## Quick start — Cloudflare Workers

```bash
cp .dev.vars.example .dev.vars   # fill in the secrets
npm run dev:cf
```

Edit `vars` in [`wrangler.jsonc`](wrangler.jsonc) — at minimum `ZAMMAD_URL` and
`PUBLIC_URL`, which must match the URL clients actually dial. Then push the secrets and deploy:

```bash
npx wrangler secret put ZAMMAD_OAUTH_CLIENT_ID
npx wrangler secret put ZAMMAD_OAUTH_CLIENT_SECRET
npx wrangler secret put OAUTH_STATE_SECRET
npm run deploy
```

`OAUTH_STATE_SECRET` must be stable across deployments — rotating it invalidates registered clients
and in-flight logins. Generate one with `openssl rand -base64 48`.

### One-click deploy

The button at the top of this README clones the repository into your own Cloudflare account,
**provisions the KV namespace** for the lookup cache, prompts for the secrets listed in
`.dev.vars.example`, and deploys. The `id` committed in `wrangler.jsonc` is a placeholder and is
rewritten with the newly created namespace.

You still have to set `ZAMMAD_URL` and `PUBLIC_URL` afterwards — `PUBLIC_URL` cannot be known before
the Worker has a hostname, and it must match what clients dial, since it forms the OAuth issuer and
the callback URL. Set both under the Worker's **Settings → Variables**, then redeploy.

## Docker

```bash
docker build -t zammad-remote-mcp .
docker run -p 3000:3000 \
  -e ZAMMAD_URL=https://support.example.com \
  -e ZAMMAD_AUTH_MODE=token \
  -e ZAMMAD_API_TOKEN=your-token \
  zammad-remote-mcp
```

Or with Compose, which reads the same variables from a local `.env`:

```bash
docker compose up --build
```

The image is a multi-stage build: TypeScript is compiled with the full dependency tree, the runtime
stage keeps only production dependencies, and the process runs as the unprivileged `node` user. A
`HEALTHCHECK` polls `/health` using Node's global `fetch`, so no `curl` has to be installed.

`docker stop` is a graceful shutdown, not a timeout: `CMD` uses the exec form, so Node runs as PID 1
and receives `SIGTERM` directly, and the server closes its listener on it.

### Deploying with Coolify

Point Coolify at this repository and choose **Dockerfile** as the build pack — it will find
`/Dockerfile` without further configuration. Then:

1. Set the environment variables (at minimum `ZAMMAD_URL`, and either `ZAMMAD_API_TOKEN` for token
   mode or the three OAuth values). Everything in [`.env.example`](.env.example) is accepted.
2. Set **`PUBLIC_URL` to the public URL Coolify assigns**, not the container address. It forms the
   OAuth issuer, the callback URL and the resource identifier, and a wrong value breaks the
   authorization flow in a way that points nowhere near the cause — the server logs a warning when
   it does not match the host a request arrived on.
3. Leave the port at `3000`, or set `PORT` and match it in Coolify's port mapping.
4. Use `/health` as the health check path.

Then register `<PUBLIC_URL>/oauth/callback` in Zammad under **System → API → Applications**.

`OAUTH_STATE_SECRET` must be stable across restarts and identical on every replica — it signs the
`client_id` and the OAuth state, which is what lets the proxy stay stateless. Generate it once with
`openssl rand -base64 48` and store it as a Coolify secret.

### What differs between the two runtimes

| | Node | Workers |
|---|---|---|
| Config source | `process.env` (+ `.env` file) | `env` binding (vars + secrets) |
| Lookup cache | one long-lived process, high hit rate | per isolate, so more Zammad calls |
| OAuth endpoint rate limiting | effective (in-process store) | **per isolate, so largely ineffective** — use [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) in front |
| Everything else | identical | identical |

---

## Testing on localhost

### The quickest path: token mode

Skip OAuth entirely. Create a personal token in Zammad under **avatar → Profile → Token Access**
(needs the `ticket.agent` permission), then:

```bash
ZAMMAD_URL=https://support.example.com ZAMMAD_AUTH_MODE=token ZAMMAD_API_TOKEN=your-token PORT=3000 npm run dev
```

> In this mode the MCP endpoint requires no credential of its own — anyone who can reach the port
> acts as that token's user. Keep it bound to localhost and never expose it.

Check it is alive:

```bash
curl -s http://localhost:3000/health
```

Drive it with raw JSON-RPC. Note the `Accept` header — the MCP spec requires both types:

```bash
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Because the server is stateless there is no session to carry — every call stands alone, so you can
go straight to a tool without repeating the handshake:

```bash
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zammad_whoami","arguments":{}}}'
```

A search, with the generated selector echoed back under `search`:

```bash
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"zammad_search_tickets","arguments":{"state":["open"],"updated_at":{"more_than_ago":"7d"},"output":"summary"}}}'
```

### With the MCP Inspector

The UI opens a browser and proxies to the server; choose **Streamable HTTP** as the transport and
enter `http://localhost:3000/mcp`:

```bash
npx @modelcontextprotocol/inspector
```

There is also a scriptable CLI mode, which is usually quicker. Note the target URL is a **positional
argument** — `--server-url` is only for the UI's own config:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list
```

Call a tool. Arguments are repeated `--tool-arg key=value` pairs; single values are accepted wherever
the schema takes an array, so `state=open` works:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/call --tool-name zammad_search_tickets --tool-arg state=open --tool-arg output=count
```

For nested arguments (`tags`, `created_at`, `article`, …) `--tool-arg` is too flat — use the curl form
above with a JSON body instead.

If the server runs with `ZAMMAD_AUTH_MODE=oauth`, pass the token through:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --header "Authorization: Bearer YOUR_ZAMMAD_TOKEN" --method tools/list
```

### With Claude Code

```bash
claude mcp add --transport http zammad-local http://localhost:3000/mcp
```

### Testing OAuth mode locally

There is a real obstacle here, so it is worth stating up front. Zammad leaves Doorkeeper's
`force_ssl_in_redirect_uri` at its default, which is `true` outside Rails development mode, and
Doorkeeper's redirect validator has **no loopback exemption**. A production Zammad will therefore
*reject* `http://localhost:3000/oauth/callback` when you try to register the application. Three ways
around it:

1. **Use token mode locally** (above) and leave OAuth for the deployed environment. Simplest, and it
   exercises every tool identically — only the credential source differs.
2. **Give the server an HTTPS public URL** with a tunnel (`cloudflared tunnel --url
   http://localhost:3000`, `ngrok http 3000`) or a local TLS reverse proxy (Caddy). Register that
   HTTPS callback in Zammad and set `PUBLIC_URL` to match — it must be the URL clients actually dial,
   since it forms the issuer and the callback.
3. **Run Zammad itself in development mode**, where the default flips to `false` and plain
   `http://localhost` callbacks are accepted.

The OAuth *plumbing* can still be exercised on plain localhost without touching Zammad, because the
metadata and registration endpoints are served locally:

```bash
ZAMMAD_URL=https://support.example.com ZAMMAD_AUTH_MODE=oauth ZAMMAD_OAUTH_MODE=proxy ZAMMAD_OAUTH_CLIENT_ID=x ZAMMAD_OAUTH_CLIENT_SECRET=y OAUTH_STATE_SECRET=local-dev-secret-at-least-16-chars PUBLIC_URL=http://localhost:3000 PORT=3000 npm run dev
```

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
```

An unauthenticated call returns a `401` whose `WWW-Authenticate` header points at that metadata —
which is exactly how a client discovers where to authorize:

```bash
curl -si -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i www-authenticate
```

Once you hold a Zammad access token, pass it directly and skip the browser flow:

```bash
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer YOUR_ZAMMAD_TOKEN' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zammad_whoami","arguments":{}}}'
```

### Without any Zammad at all

`test/server.test.ts` runs the real Hono app against a stub Zammad over real HTTP, covering the OAuth
registration/authorize/callback round trip and the MCP handshake. `npm test` needs no network and no
Zammad instance.

---

## Is the server stateless?

**Yes — fully.** Nothing is retained between HTTP requests, so any replica can serve any request and
scaling out needs no shared store, no sticky sessions and no session affinity at the load balancer.

Three things make that work:

**1. The transport runs in stateless mode.** `StreamableHTTPTransport` is constructed with
`sessionIdGenerator: undefined`, so no `Mcp-Session-Id` is ever issued or expected. Each POST gets a
fresh `McpServer` and transport, both discarded once the response is written. `enableJsonResponse`
returns a complete JSON body rather than an SSE stream, which is what makes that teardown safe.

**2. Credentials are never stored.** In the default `oauth` mode the MCP client sends its Zammad
access token on every request, and the server forwards it to the Zammad API unchanged. Zammad is the
authorization server and the source of truth for identity; this server holds no token database and
no refresh-token bookkeeping. It also means Zammad's own permission model applies unchanged — an
agent sees agent tickets, a customer sees their own.

**3. The OAuth proxy carries its state in signed parameters.** Doorkeeper has no dynamic client
registration and a Zammad application is pinned to fixed redirect URIs, which does not fit MCP
clients that self-register on an ephemeral localhost port. Instead of a client database:

- Registration mints a `client_id` of the form `zmcp_<payload>.<hmac>`, where the payload *is* the
  registration record (the client's redirect URIs and name). `getClient` verifies and decodes it.
- `/authorize` swaps the client's redirect URI for this server's single `/oauth/callback` — the one
  URI registered in Zammad — and packs the original URI plus the client's `state` into an
  HMAC-signed `state`.
- `/oauth/callback` verifies that signature and bounces the code back to the client's own URI.
- `/token` substitutes the real Zammad client credentials.

PKCE flows through untouched: the client's `code_challenge` reaches Doorkeeper directly and its
`code_verifier` is forwarded on exchange, so the proxy is never trusted with proof of possession.
All replicas need is the same `OAUTH_STATE_SECRET`.

### The one caveat

There *is* an in-process cache (`METADATA_CACHE_TTL_SECONDS`) for slow-moving lookups — groups,
states, priorities, resolved user and organization IDs. It is per-instance, per-credential and
TTL-bounded, and no request depends on a cache another request populated: every entry is rebuilt
from Zammad on miss. It is a latency optimisation, not state. Set it to `0` to disable it entirely
and the behaviour is identical, just chattier.

### What statelessness costs

Server-initiated messages are out of scope: no resource subscriptions, no server-driven sampling or
elicitation, no mid-tool progress notifications. For a tool-only helpdesk server none of that is
needed, and the operational simplicity is worth far more.

---

## Authentication

`ZAMMAD_AUTH_MODE` selects how the server talks to the Zammad REST API. All three are the schemes
Zammad documents in its [API introduction](https://docs.zammad.org/en/latest/api/intro.html#authentication).

| Mode | Header sent to Zammad | Use it for |
|---|---|---|
| `oauth` *(default)* | `Authorization: Bearer <token>` | Multi-user deployments. Each MCP client authorizes itself; the server stores nothing. |
| `token` | `Authorization: Token token=<token>` | Single-tenant automation, local development. |
| `basic` | `Authorization: Basic <base64>` | Legacy instances only — Zammad advises against it. |

`ZAMMAD_OAUTH_MODE` then selects how MCP clients authorize. It is a **sub-setting of
`ZAMMAD_AUTH_MODE`, not an independent axis**: only `oauth` reads the caller's bearer token, so only
there is there anything for the OAuth endpoints to be for. Leave it unset and it follows —
`proxy` under `oauth`, `disabled` under `token`/`basic` — so `token` mode needs no OAuth settings at
all. Combining `token`/`basic` with `proxy` or `passthrough` is rejected at startup rather than
silently issuing tokens the request path would discard.

| Mode | Behaviour |
|---|---|
| `proxy` *(default under `oauth`)* | This server is the authorization server from the client's perspective and proxies to Zammad. Supports dynamic client registration and ephemeral redirect URIs. One callback URL to register in Zammad. |
| `passthrough` | Clients talk to Zammad directly. Every client redirect URI must be registered in Zammad by hand, and Doorkeeper publishes no authorization-server metadata, so this server publishes it on Zammad's behalf. Brittle with clients that self-register. |
| `disabled` *(automatic under `token`/`basic`)* | No OAuth metadata is served. Worth setting explicitly under `oauth` only when an API gateway in front already handles discovery and just forwards the bearer token. |

Tools accept an optional `on_behalf_of` argument, which maps to Zammad's `X-On-Behalf-Of` header for
impersonation (requires admin rights).

---

## The search layer

`zammad_search_tickets` is the centrepiece. Rather than exposing Zammad's raw `query` parameter, it
takes structured filters and compiles them.

### Why it compiles two things

Reading Zammad's `CanSearch#search` shows two facts that shape everything:

1. Zammad routes to Elasticsearch **only when the `query` parameter is non-blank**. With a blank
   `query` it runs the SQL search — even on an instance that has Elasticsearch installed.
2. The `condition` selector is honoured on **both** paths (`Selector::Sql` for SQL,
   `Selector::SearchIndex` for Elasticsearch).

So the default `auto` strategy puts genuine free text in `query`, where it becomes a full-text query
with Elasticsearch and degrades to a `LIKE` over title/number/article fields without it, and puts
every structured filter in `condition`, where it is exact and behaves identically either way. **The
server therefore does not need to know whether Elasticsearch is installed.**

| `strategy` | `query` | `condition` | Needs Elasticsearch |
|---|---|---|---|
| `auto` *(default)* | free text only | all filters | no |
| `fulltext` | everything, as one Lucene `query_string` | – | yes |
| `structured` | *(none)* | all filters | no — forces the exact DB search |

### What it does for you

- **Name resolution.** `state: ["open"]`, `priority: ["3 high"]`, `group: ["1st Level"]`,
  `owner: ["jane@acme.com"]` are resolved to the numeric IDs selectors filter on. A wrong value comes
  back as an error listing the valid options, which the model can act on.
- **Identity shortcuts.** `owner: ["me"]`, `customer: ["me"]` and `organization: ["mine"]` compile to
  Zammad `pre_condition`s (`current_user.id`, `current_user.organization_id`) rather than a baked-in
  ID — cheaper and correct for whoever is authenticated.
- **`state_type`.** Filter by category (`open`, `pending reminder`, `closed`, …) and it expands to
  every matching state ID, so it keeps working on instances with custom states.
- **Boolean structure.** `match: "any"` ORs the positive filters, while `*_not` exclusions stay ANDed
  on top — otherwise "any of these states, but never closed" would match closed tickets.
- **Relative dates.** `created_at: { within_last: "7d" }`, `{ more_than_ago: "30d" }`,
  `{ between: ["2026-01-01", "2026-02-01"] }`, `{ today: true }` — compiled to Zammad's
  `(relative)` / `in range` operators, or to Elasticsearch date math in `fulltext` mode.
- **Correct encodings.** Tag values are comma-joined strings because that is the only form both
  selector backends accept; `in range` gets a two-element array; article types and senders map to
  their seeded primary keys.
- **Escape hatches.** `custom` for Object Manager attributes, `raw_condition` for a hand-written
  selector, `raw_query` for raw Lucene.
- **Explainability.** The response echoes the generated `query` and `condition` under `search`, so a
  query that returns too much or too little can be corrected directly.

```jsonc
// "high-priority tickets in 1st Level that I own, untouched for a fortnight,
//  tagged vip, excluding anything closed"
{
  "owner": ["me"],
  "group": ["1st Level"],
  "priority": ["3 high"],
  "state_not": ["closed", "merged"],
  "updated_at": { "more_than_ago": "14d" },
  "tags": { "any": ["vip"] },
  "sort_by": "updated_at",
  "order_by": "asc",
  "output": "summary"
}
```

Start with `output: "count"` to size a result set before paging through it.

---

## Instance values live in the tool schemas

The states, priorities, groups and macros of the connected instance are read at `tools/list` time and
folded into the tool schemas as enums. A model reading `zammad_search_tickets` sees
`"state": {"enum": ["new", "open", "pending reminder", "closed", "merged", "pending close"]}` for
*that* Zammad, so it never has to call a discovery tool first, and never has to guess a state name.

That replaced four tools — `zammad_list_ticket_states`, `zammad_list_ticket_priorities`,
`zammad_list_groups` and `zammad_list_macros` are gone, and `zammad_apply_macro` now takes a macro
*name* instead of a numeric ID.

Three properties keep this from becoming brittle:

- **Advisory, not binding.** Each field is `enum | string | number`, so a state created after a
  client cached the tool list is still accepted. Resolution stays in `LookupService`, which returns
  the valid options when a value really is wrong.
- **Never fatal.** Each source is fetched independently and tolerated. A 403, a timeout or an outage
  yields plain-string fields — `tools/list` keeps working, which matters because it is how a client
  discovers anything at all. Set `DYNAMIC_TOOL_SCHEMAS=false` to publish static schemas and have
  `tools/list` need no Zammad contact.
- **Bounded.** Above `SCHEMA_ENUM_MAX_VALUES` (default 150) the enum is dropped rather than
  truncated: a partial list looks authoritative while silently hiding valid values.

### What deliberately stays a lookup

Not everything is a closed set, and with an **agent-level token** — the sensible default for this
server — Zammad withholds some catalogues entirely:

| | Enumerable? | Why |
|---|---|---|
| States, priorities, groups, macros | ✅ in the schema | Small, closed, readable by agents |
| Article types and senders | ✅ static enum | Seeded in Zammad with fixed primary keys |
| Users, customers, organizations | ❌ | Unbounded |
| Tags | ❌ | Open-ended; `/api/v1/tag_list` is admin-only, so `zammad_list_tags` searches by prefix |
| Object Manager attributes | ❌ | `/api/v1/object_manager_attributes` requires `admin.object_manager`; an agent token gets 403, so neither the model nor this server can enumerate custom fields |

## Tools

**Search** — `zammad_search_tickets`, `zammad_search_users`, `zammad_search_organizations`,
`zammad_search_global`

**Tickets** — `zammad_get_ticket`, `zammad_list_tickets`, `zammad_create_ticket`,
`zammad_update_ticket`, `zammad_update_ticket_title`, `zammad_update_ticket_customer`,
`zammad_delete_ticket`, `zammad_merge_tickets`, `zammad_mass_update_tickets`, `zammad_apply_macro`,
`zammad_get_ticket_history`, `zammad_get_related_tickets`, `zammad_get_customer_tickets`,
`zammad_get_recent_tickets`

**Articles** — `zammad_list_ticket_articles`, `zammad_get_article`, `zammad_create_article`,
`zammad_update_article`, `zammad_delete_article`, `zammad_get_article_plain`,
`zammad_download_attachment`

**Tags, links, time** — `zammad_add_ticket_tags`, `zammad_remove_ticket_tags`,
`zammad_link_tickets`, `zammad_unlink_tickets`, `zammad_list_ticket_links`,
`zammad_list_time_accounting`, `zammad_create_time_accounting`

**Discovery** — `zammad_whoami`, `zammad_get_user`, `zammad_get_organization`, `zammad_list_tags`,
`zammad_list_overviews`, `zammad_list_custom_attributes`, `zammad_refresh_metadata_cache`

Write tools default to the safe option: articles are created as internal notes, so nothing reaches a
customer unless `type: "email"` and `internal: false` are set deliberately. Destructive tools carry
`destructiveHint` and require an explicit `confirm: true`.

### Article bodies

Zammad stores most email articles as `text/html`, where the markup dwarfs the message. Every tool
that returns an article renders the body as **Markdown** by default — headings, lists, link targets
and quote levels keep their meaning, at almost no cost over flat text — and drops two things:

- quoted replies, which in a ticket thread are already present as an earlier article. Only
  blockquotes that identify themselves as citations (`type="cite"`), open with a mail client's
  attribution line, or trail the message are removed. A customer quoting an error message keeps it,
  rendered as a Markdown quote;
- the signature block, located by the marker Zammad itself emits
  (`<span class="js-signatureMarker">`, `data-signature`).

Quotes are removed first and the signature is then located in what remains, because a customer's
reply often quotes our own outgoing mail *including* its signature marker — cutting at the first
marker found would truncate at that copy instead of at their own signature.

Signatures with no Zammad marker, such as a foreign sender's legal footer, are left alone.
Recognising those means matching on wording, which is not reliable enough to risk cutting real
content.

Across 377 articles from a live instance this cut 2.04M characters of stored body to 244K (−88%),
and the share of articles hitting the 4000-character cap fell from 43% to 2% — the truncation that
otherwise makes a model re-fetch the same article in full. `body_omitted` on each article records
what was dropped, and `body_format: "html"` returns the stored markup untouched.

Conversion uses [turndown](https://github.com/mixmark-io/turndown). On Node it works as shipped; on
Cloudflare Workers it needs its bundled DOM rather than the host's, which the `alias` block in
`examples/cloudflare/wrangler.jsonc` arranges — see the comment there for why.

---

## HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (stateless) |
| `GET /health` | Liveness probe |
| `GET /` | Server info: transport, auth mode, metadata URL |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 protected-resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| `GET,POST /authorize` · `POST /token` · `POST /register` · `POST /revoke` | OAuth proxy (proxy mode) |
| `GET /oauth/callback` | The URL to register in Zammad |

---

## Development

```bash
npm install
npm run dev        # Node host, watch mode
npm run dev:cf     # Cloudflare Worker via wrangler dev
npm run verify     # biome check + tsc --noEmit + tests, across all packages
npm run check:fix  # apply Biome formatting and safe lint fixes
```

Lint and formatting are handled by [Biome](https://biomejs.dev) (`biome.json`).

The test suite covers the search builder's compilation rules against a fake lookup service, and runs
the real Hono app end to end against a stub Zammad — including the OAuth registration/authorize/
callback round trip and the MCP handshake. It needs no network and no Zammad instance.

### Layout

```
src/
  core/                      runtime-agnostic — no Node built-ins
    index.ts                 public surface: bootstrap(), createApp(), loadConfig()
    config.ts                Zod-validated environment
    app.ts                   Hono app: CORS, auth extraction, MCP endpoint
    auth/                    oauth.ts (stateless proxy) · signing.ts (WebCrypto HMAC)
    util/                    base64 · cache · logger · errors
    zammad/                  client · lookup · vocabulary · selector · search/
    mcp/                     server · context · result · tools/
  node/                      Node host: serve(), signals, .env

test/                        config · cache · search-builder · server · env-file · tool-schema

Dockerfile                   multi-stage build of the Node host
compose.yaml                 the same, for `docker compose` and Coolify

examples/
  cloudflare/                a deployable Worker consuming the published package
    src/index.ts             export default { fetch }
    src/kv-cache.ts          Workers KV behind the library's CacheStore
    wrangler.jsonc           vars, KV binding, compatibility flags
    package.json             depends on zammad-remote-mcp like any consumer
```

The Cloudflare host lives in `examples/` rather than in the package. It is a *deployment*, not
something anyone installs from npm — and keeping it as an ordinary consumer of the published package
means the example proves the public API is usable, instead of reaching into internals a real user
could not reach.

`src/core` must stay free of Node built-ins. `npm run build:worker` is what enforces that — it links
this checkout into the example and runs a wrangler dry-run against the workerd target. CI runs it on
every push.

### Why the core has no Node built-ins

Three substitutions were enough, and each is a plain platform API rather than a shim:

| Was | Now | Why |
|---|---|---|
| `node:crypto` `createHmac` / `timingSafeEqual` | `crypto.subtle` HMAC | Signing becomes async; `subtle.verify` already compares in constant time |
| `Buffer` | `atob` / `btoa` / `TextEncoder` | Would otherwise tie the core to the `nodejs_compat` flag |
| `process.stderr.write` | injectable sink, default `console.error` | `process.stderr` is not reliably present off Node |

Two further changes made one build valid on both runtimes:

- The transport is the SDK's own `WebStandardStreamableHTTPServerTransport` (`Request` → `Response`),
  not a Node- or Hono-specific one.
- `McpServer` is constructed with `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()`. The SDK
  otherwise instantiates Ajv eagerly, and Ajv compiles schemas with `new Function`, which edge
  runtimes forbid. The validator is only consulted for elicitation responses, which a stateless
  server never issues.

## Releasing

One package, one publish. The name is unscoped, so **no npm organisation is needed** — it belongs to
whoever publishes it first.

### One-time setup: trusted publishing

Releases authenticate over OIDC, so there is no npm token anywhere — not in the repository secrets,
not in the workflow. npm exchanges a short-lived GitHub-signed token for publish rights at the moment
of publishing.

There is one ordering constraint: **npm can only accept a trusted publisher for a package that
already exists.** (PyPI allows pre-registering a name; npm does not.) So the very first version is
published by hand, and every release after that runs unattended:

```bash
npm login
npm publish          # once, to create the package
```

Then on npmjs.com → the package → **Settings → Trusted Publisher**, add a GitHub Actions publisher:

| Field | Value |
|---|---|
| Organization or user | `JUVOJustin` |
| Repository | `zammad-remote-mcp` |
| Workflow filename | `deploy.yml` |
| Environment | *(leave empty)* |

From then on `NPM_TOKEN` is not needed and should not exist. The workflow already declares
`id-token: write`, which is what makes the exchange possible, and npm generates
[provenance](https://docs.npmjs.com/generating-provenance-statements) automatically for public
repositories — which is why `publishConfig` deliberately does *not* set `provenance: true`. Setting
it explicitly would additionally break any publish outside a CI OIDC environment, including the
first manual one.

### Cutting a release

Push a tag. `.github/workflows/deploy.yml` does the rest:

```bash
git tag v1.1.0 && git push origin v1.1.0
```

The workflow bumps the version to match the tag, runs lint/typecheck/build/test, builds the Worker,
commits the version bump back to `main`, publishes to npm over OIDC and opens a GitHub release. A tag
with a prerelease suffix (`v1.1.0-rc.1`) publishes under the `next` dist-tag instead of `latest`.

### Checking a release before tagging

```bash
npm run verify
npm pack --dry-run
```

The tarball should contain `dist`, `.env.example`, `README.md` and `LICENSE` — no `src`, no tests,
no `.tsbuildinfo`.

## License

MIT
