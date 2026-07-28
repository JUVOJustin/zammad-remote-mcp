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

## Fronting it

Nothing here terminates TLS. Put your usual reverse proxy in front of the
`zammad-mcp` port, and — if people also use the Zammad web UI on this host —
publish `zammad-nginx` as well and point `ZAMMAD_PUBLIC_URL` at it.

`PUBLIC_URL` must be the address clients actually connect to. It is used for the
OAuth callback and as the resource identifier clients verify, so a wrong value
fails the handshake rather than degrading quietly.

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
