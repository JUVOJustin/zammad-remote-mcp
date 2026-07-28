# zammad-remote-mcp on Cloudflare Workers

A deployable Worker that runs [`zammad-remote-mcp`](https://www.npmjs.com/package/zammad-remote-mcp)
on the edge. It is a normal consumer of the published package — the whole host is two files.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JUVOJustin/zammad-remote-mcp/tree/main/examples/cloudflare)

## What the button does

Clones this directory into your Cloudflare account, provisions the KV namespace for the lookup
cache, prompts for the secrets in `.dev.vars.example`, and deploys.

Two values it cannot know, to set afterwards under the Worker's **Settings → Variables**:

- `ZAMMAD_URL` — your Zammad instance
- `PUBLIC_URL` — the URL clients actually dial, e.g. `https://<worker>.<subdomain>.workers.dev`.
  It forms the OAuth issuer, the callback URL and the resource identifier, so a wrong value breaks
  the authorization flow silently. The server logs a warning when it does not match the request host.

Then register `<PUBLIC_URL>/oauth/callback` in Zammad under **System → API → Applications**, and
redeploy.

## Running it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the secrets
npm run dev
```

## Why KV

On Node the in-process lookup cache works well because one process serves many requests. A Worker
isolate is short-lived and there are many of them, so an in-process cache mostly misses and every
cold start re-reads the instance's states, priorities and groups from Zammad. KV is shared across
isolates, so that happens roughly once per TTL for the whole deployment instead.

Measured on workerd: `tools/list` took 8.3 s cold and 43 ms once KV was warm.

The binding is optional. Remove it and the Worker falls back to per-isolate memory; a KV outage
degrades to the uncached path rather than failing a request.

## Files

| | |
|---|---|
| `src/index.ts` | the whole host: `env` binding instead of `process.env`, `fetch` export instead of a listener |
| `src/kv-cache.ts` | Workers KV behind the library's `CacheStore` interface |
| `wrangler.jsonc` | vars, KV binding, compatibility flags |
| `.dev.vars.example` | the secrets the deploy flow prompts for |
