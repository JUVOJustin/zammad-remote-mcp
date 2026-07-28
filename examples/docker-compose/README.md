# Zammad and the MCP server in one Compose stack

Runs both side by side on one host. The MCP container reaches Zammad over the
Compose network, so API traffic never leaves the machine and Zammad's port does
not have to be published at all — only the MCP server is exposed.

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
```

The first boot migrates and seeds Zammad, which takes a few minutes. Then finish
Zammad's setup wizard and point your MCP client at `<PUBLIC_URL>/mcp`.

## The two Zammad URLs

This is the part worth understanding before changing anything.

| Variable            | Who follows it              | Example                        |
| ------------------- | --------------------------- | ------------------------------ |
| `ZAMMAD_URL`        | the MCP server              | `http://zammad-nginx:8080`     |
| `ZAMMAD_PUBLIC_URL` | the user's browser          | `https://support.example.com`  |

The server resolves `zammad-nginx` because it shares a network with it. A browser
never can. In OAuth mode the user approves access **on Zammad itself**, so the
redirect and the published metadata have to carry an address their browser can
reach — that is `ZAMMAD_PUBLIC_URL`.

Set only `ZAMMAD_URL` and it is used for both, which is correct for every
deployment where the server and the browser reach Zammad at the same address.
Here they do not.

The code exchange runs the other way: the server itself calls Zammad's token
endpoint, so that one stays on the internal URL and never crosses the internet.

## Modes

**OAuth (default).** Each user connects with their own Zammad account, so
permissions and ticket visibility are theirs. Register an application in Zammad
under *Manage > Applications* with the callback URI `<PUBLIC_URL>/oauth/callback`,
then fill in `ZAMMAD_OAUTH_CLIENT_ID`, `ZAMMAD_OAUTH_CLIENT_SECRET` and
`OAUTH_STATE_SECRET`.

**Token.** One shared Zammad token for everyone. Simpler, and every action is
attributed to that single user. Set `ZAMMAD_AUTH_MODE=token` and
`ZAMMAD_API_TOKEN`; `ZAMMAD_PUBLIC_URL` is then unused, because no browser is
involved.

## Routing

Caddy is included and does this for you: `MCP_DOMAIN` reaches the MCP server,
`ZAMMAD_DOMAIN` reaches Zammad, and certificates arrive on their own once both
records point at the host. Neither application port is published.

Point your MCP client at `https://<MCP_DOMAIN>/mcp`.

### Why two hostnames rather than one with a `/mcp` prefix

The MCP server serves more than `/mcp`. OAuth discovery and the handshake need:

```
/mcp
/authorize   /token   /register
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
/oauth/callback
```

And there is the catch: **Zammad's own OAuth provider owns `/oauth/authorize` and
`/oauth/token`**, while this server owns `/oauth/callback`. On one hostname
`/oauth/*` has two owners, and the rule separating them decides whether logging
in works. Two hostnames make the split obvious instead.

### If you only have one hostname

It can be done, with an exact match for the callback placed before the general
`/oauth` rule. In a Caddyfile:

```caddyfile
example.com {
	handle /mcp*             { reverse_proxy zammad-mcp:3000 }
	handle /authorize*       { reverse_proxy zammad-mcp:3000 }
	handle /token*           { reverse_proxy zammad-mcp:3000 }
	handle /register*        { reverse_proxy zammad-mcp:3000 }
	handle /.well-known/oauth-* { reverse_proxy zammad-mcp:3000 }
	handle /oauth/callback   { reverse_proxy zammad-mcp:3000 }
	handle                   { reverse_proxy zammad-nginx:8080 }
}
```

Order matters: `/oauth/callback` has to be matched before the fallback hands the
rest of `/oauth/*` to Zammad. Set `MCP_SCHEME`/`MCP_DOMAIN` and
`ZAMMAD_SCHEME`/`ZAMMAD_DOMAIN` to the same host, and keep in mind that Zammad
occupies the root, so anything it adds later could collide with a path above.

### Trying it locally

Caddy issues locally-trusted certificates for `*.localhost`, so no public DNS is
required. Uncomment that block in `.env.example`, then:

```bash
curl -k -H 'Host: mcp.localhost' https://127.0.0.1:8443/health
```

Keep the scheme as `https`. In OAuth mode the server refuses to start behind a
plain-HTTP address — the SDK rejects a non-HTTPS issuer, and the container
restarts with `Issuer URL must be HTTPS`. Only `ZAMMAD_AUTH_MODE=token`, which
involves no browser, runs over plain HTTP.

Note that `HTTPS_PORT=8443` only moves where Caddy listens. `PUBLIC_URL` stays
`https://mcp.localhost`, so the endpoints the server advertises carry no port and
a real client would dial 443. That is fine for a smoke test; use the default 443
if you want the advertised URLs to be dialable as published.

## Using a published image

The stack builds the Dockerfile from the repository root. To skip the build,
replace the `build:` block in `docker-compose.yml` with:

```yaml
    image: ghcr.io/juvojustin/zammad-remote-mcp:latest
```

## Resources

Elasticsearch dominates: the JVM heap defaults to 1 GB, adjustable with
`ELASTICSEARCH_JAVA_OPTS`. Budget roughly 4 GB for the whole stack. Zammad runs
without Elasticsearch (`ELASTICSEARCH_ENABLED=false`) and answers searches from
the database, which is slower on large instances but much lighter.
