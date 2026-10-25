# Deploy Zammad MCP and connect Cloudflare MCP Portals

This Worker consumes the published [`zammad-remote-mcp`](https://www.npmjs.com/package/zammad-remote-mcp)
package. Deploy the Worker first, then add its `/mcp` endpoint to a Cloudflare MCP Portal. The portal
is an MCP client and access-control layer; it does not build or deploy this repository.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JUVOJustin/zammad-remote-mcp/tree/main/examples/cloudflare)

## Deploy the Worker

You need Node.js 22+, permission to deploy a Worker, and permission to register an OAuth application
in Zammad. Work from this directory when using a full source checkout, or from the root of a
repository created by the deployment button.

1. Run `npm ci`. On a headless machine, sign in with
   `npx wrangler login --device --browser=false` and approve the displayed code in your own browser.
2. Create the cache namespace with `npx wrangler kv namespace create LOOKUP_CACHE --jurisdiction=eu`. Replace the
   placeholder namespace ID in `wrangler.jsonc`. Verify that its durable-storage jurisdiction is `eu`.
   If the deployment button provisions a namespace without EU jurisdiction, replace this reconstructible
   cache with a newly created EU namespace before production use; jurisdiction cannot be changed in place.
3. Set `ZAMMAD_URL` to your instance and `PUBLIC_URL` to the exact externally reachable Worker origin,
   for example `https://<worker>.<account-subdomain>.workers.dev`. Keep `MCP_PATH=/mcp`.
4. In Zammad, create an application under **System → API → Applications**. Register only
   `<PUBLIC_URL>/oauth/callback` as the proxy application's callback.
5. Provision `ZAMMAD_OAUTH_CLIENT_ID`, `ZAMMAD_OAUTH_CLIENT_SECRET` and `OAUTH_STATE_SECRET` as Worker
   secrets through the dashboard or your deployment's Varlock-backed secret provisioning. For a
   standalone installation, `npx wrangler secret put <NAME>` accepts each value privately. Use a
   random `OAUTH_STATE_SECRET` of at least 32 bytes and keep it stable. Never put values in Wrangler
   `vars`, Git, build logs or chat. Required secret names are declared in `secrets.required`.
6. Run `npm run typecheck` and `npm run build`, then `npm run deploy`. The first command generates
   types from the actual Wrangler bindings, secrets and runtime configuration. The build is a dry run.

For local development, use the same three names in a gitignored `.dev.vars` file, using
[`.dev.vars.example`](.dev.vars.example) as the template, then run `npm run dev`. Completing browser
OAuth requires a reachable HTTPS callback registered in Zammad. A local token-mode configuration
can exercise tools without OAuth: change `ZAMMAD_AUTH_MODE` to `token`, replace `secrets.required`
with `["ZAMMAD_API_TOKEN"]` and supply that secret. Token/basic modes expose a shared credential's
permissions to anyone who can reach the endpoint; restrict access before exposing them remotely.

## Register the server in MCP Portals

Use **OAuth** with **Automatic / Dynamic Client Registration (DCR)**. Do not enter the Zammad
application ID or secret in the portal: those belong to the proxy's upstream connection. DCR returns
a public client with `token_endpoint_auth_method=none`; PKCE protects its code exchange.

The following callback URLs belong at different boundaries:

| Boundary | Callback | Configuration |
| --- | --- | --- |
| Zammad → Worker proxy | `https://<worker>/oauth/callback` | Register the exact URL in the Zammad application. |
| Worker → portal administrator | `https://dash.cloudflare.com/<account-tag>/one/access-controls/ai-controls/mcp-server/oauth-callback/<server-id>` | Keep `dash.cloudflare.com` in the Worker's `OAUTH_ALLOWED_REDIRECT_HOSTS`. |
| Worker → user, shared callback enabled | `https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback` | Keep `oauth-callbacks.cloudflareaccess.com` in the Worker's allowlist. |
| Worker → user, shared callback disabled | `https://<portal-hostname>/servers-callback` | Append the exact portal hostname to the Worker's allowlist. |

The dashboard and shared callback hosts are included by default. An existing explicit
`OAUTH_ALLOWED_REDIRECT_HOSTS` value replaces the default: update it too. Use exact hostnames;
wildcards are unsupported. The proxy still checks the exact redirect URI registered for each client.
Cloudflare documents these boundaries in [upstream OAuth callback URLs](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#upstream-oauth-callback-urls).

1. In **Zero Trust → Access controls → MCP Portals → MCP servers**, add the exact Worker URL
   `https://<worker>.<account-subdomain>.workers.dev/mcp` and choose OAuth with automatic registration.
2. Enable **Use the Cloudflare-hosted OAuth callback** in advanced settings, or explicitly allow your
   portal hostname as described above.
3. Complete administrator authorization. The proxy shows the requesting client, permissions and
   return URL before continuing to Zammad. Keep this browser flow in the same browser so its secure
   state cookie returns to the Worker callback.
4. Attach an Access policy to the server. Add it to a portal that also has its own Access policy.
5. Keep **Require user auth** enabled so each user accesses Zammad with their own permissions.
6. Connect an MCP client to the portal's URL and authorize Zammad as a user. Confirm the server becomes
   **Ready**, its tools appear, and `zammad_get_user` with `user: "me"` identifies the intended user.

Service-token sessions use the server's administrator credential and exclude servers requiring
per-user authorization. They do not replace the browser login for a per-user portal.

## Cloudflare Access in front of the Worker

The portal must reach OAuth metadata, registration and the MCP authentication challenge without a
human's existing Access cookie. A generic self-hosted Access login redirect in front of every Worker
route can prevent discovery before the server's own OAuth flow begins. Either use the Worker's OAuth
as its upstream protection and enforce Access at the portal, or configure an explicitly supported
Access-for-SaaS/portal authentication architecture. Do not add a second browser-only Access gate
without testing the portal's server-to-server requests.

From a fresh client, `GET /mcp` should return **401** with `WWW-Authenticate` and `resource_metadata`.
Discovery endpoints should return JSON **200**, never an Access login page or HTML challenge.
Investigate the matching Access/WAF logs before changing policies; avoid blanket bypass policies.
See [Cloudflare's portal authentication guide](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/).

## Verify and troubleshoot

From the source repository root, run:

```bash
npm run check:deployment -- https://<worker>.<account-subdomain>.workers.dev/mcp
npm run check:deployment -- https://<worker>.<account-subdomain>.workers.dev/mcp https://<portal-hostname>/servers-callback
```

This checks public discovery, the audience, the 401 challenge, PKCE advertisement, stateless client
registration and the consent page. It never logs in or calls a tool. A successful probe still needs
a real portal browser login and a read-only identity check before acceptance.

Consent approval and cancellation finish with HTTP 200 HTML and an immediate `Refresh` navigation,
with a continuation link as a fallback. This ends the form submission before following Zammad,
SSO and client redirects. The consent form's CSP permits only same-origin submissions; it does not
need to allow every hostname in the later login flow. Test the complete browser flow, because an
HTTP-only probe cannot detect a browser blocking a later redirect.

| Symptom | Check |
| --- | --- |
| “An error occurred while registering the MCP server” | POST `/register` with Cloudflare's callback. `invalid_redirect_uri` naming `dash.cloudflare.com` means the Worker's allowlist is missing the administrator callback host. |
| Discovery redirects to Access or returns HTML | Inspect the Access/WAF rule blocking the portal backend; verify the URLs from a cookie-free client. |
| User login fails after administrator setup works | Allow the shared callback host or the exact portal hostname; per-user callbacks differ from the dashboard callback. |
| First consent click leaves the page visible; second click says consent expired | Upgrade the deployed runtime to 5.0.2 or later. Check the browser console for a blocked `form-action` redirect, then start a fresh authorization. |
| Zammad rejects the callback | Its application must list the Worker's `/oauth/callback`, not Cloudflare's callback. |
| `invalid_client` after a restart | Check secret stability and the Zammad application's ID/secret; re-register after a state-secret rotation. |
| Old bearer token gets 401 after an upgrade | Reauthorize. Proxy mode accepts only encrypted MCP-issued credentials. |
| `No allowed servers available` | Check Access policies on both the portal and the server, and the server's authentication status. |
| Tools are slow on first registration | Dynamic schemas fetch Zammad vocabulary. Verify upstream reachability or temporarily set `DYNAMIC_TOOL_SCHEMAS=false`. |

## Update an existing deployment

The deploy button creates an independent repository. Its lockfile pins a published package version;
updating the open-source source tree or rerunning `npm ci` does not advance that pin. After the
maintainer publishes the reviewed release, run `npm install zammad-remote-mcp@<released-version>` in
the deployment repository, review the manifest and lockfile, run its typecheck/build, then redeploy.
Copy host/configuration improvements deliberately; package upgrades do not update `src/index.ts` or
`wrangler.jsonc`. Reauthorize clients when upgrading from raw Zammad proxy tokens.

Source maintainers run `npm run build:worker` from the repository root to test unpublished changes.
It installs the example's locked toolchain, links the current source without rewriting its lockfile,
generates binding types, typechecks and builds the Worker. Publishing the library follows the root
README's release process; deploying a Worker does not publish a library release.

## Cache and residency

`LOOKUP_CACHE` is optional and holds reconstructible, per-credential metadata. KV failure falls back
to upstream reads. Remove the binding and regenerate types to use per-isolate memory instead.
OAuth credentials and browser state are never stored in this cache.

| Resource | Residency scope | Verification evidence |
| --- | --- | --- |
| Worker on `workers.dev` | Global execution; no EU-only processing guarantee. Regional Services requires a supported custom-domain/account setup. | `wrangler.jsonc` declares no regionalized custom domain; [Workers localization scope](https://developers.cloudflare.com/data-localization/how-to/workers/). Account controls are unverified. |
| Workers KV lookup cache | Provision an `eu` namespace for EU durable storage. KV caches and Worker processing may still occur globally. | `kv_namespaces` uses a placeholder ID; the provisioning step explicitly selects `eu`. [KV jurisdiction scope](https://developers.cloudflare.com/kv/reference/data-location/). Verify the real namespace ID and jurisdiction before use. |
| Workers observability | Enabled in Wrangler; no EU guarantee is made. | `observability.enabled=true` in `wrangler.jsonc`; no account log destination/residency evidence is available in source. Verify account controls before claiming residency or retention. |
| Worker code and secret bindings | Globally deployed; this example does not claim EU-only storage. | `secrets.required` names bindings only; [Workers localization limitations](https://developers.cloudflare.com/data-localization/how-to/workers/). Deployed secret settings are not inspected by this example. |

For deployments requiring an EU boundary, verify the account's controls before handling production
data and record the resulting guarantees and uncovered paths. The deploy button does not establish
an EU residency boundary. See [Cloudflare Workers data localization](https://developers.cloudflare.com/data-localization/how-to/workers/).

## Serve MCP on an existing application hostname

Keep `PUBLIC_URL` on the Worker's OAuth hostname and set `MCP_RESOURCE_URL` to the full routed
endpoint, for example `https://support.example.com/mcp`. This separates the MCP audience and its
protected-resource discovery from the authorization issuer; the existing Zammad application callback
remains `<PUBLIC_URL>/oauth/callback`.

Add HTTPS Worker routes for `support.example.com/mcp*` and
`support.example.com/.well-known/oauth-protected-resource*` in the hostname's active zone. The hostname
must already have a proxied DNS record and a valid edge certificate covering it. Route only these
paths; keep the application's root, assets, `/api/*` and its own `/oauth/*` endpoints on its origin.
The trailing wildcard includes query strings, as required by [Workers route matching](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior).

The Worker host below passes unmatched paths within those prefixes through to the application
origin, while MCP and its two discovery paths are handled locally. Do not install an entire-host
Worker Custom Domain over an existing application. Confirm TLS with normal certificate verification,
check that the original application's homepage still loads, then run `check:deployment` against the
new canonical MCP URL. Set the portal's upstream server URL to that URL and reauthorize clients.
The deployment probe follows the discovered authorization issuer, so the hostname's `/` may serve
its existing application rather than Worker metadata.
