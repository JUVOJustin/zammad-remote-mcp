import assert from 'node:assert/strict';

// This probe uses no user credentials and never calls a Zammad tool.
const endpoint = process.argv[2];
const redirectUri = process.argv[3] ?? 'https://dash.cloudflare.com/mcp-deployment-check/oauth-callback';
if (!endpoint || !URL.canParse(endpoint)) {
  process.stderr.write('Usage: npm run check:deployment -- https://<worker>/mcp [OAuth callback URL]\n');
  process.exit(1);
}

async function request(url, init) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
}

async function json(url, init) {
  const response = await request(url, init);
  if (!response.ok) {
    const error = await response.json().catch(() => undefined);
    assert.fail(
      `${new URL(url).pathname}: HTTP ${response.status}; ${error?.error_description ?? 'expected JSON, not an Access login redirect'}`,
    );
  }
  assert.ok(
    response.ok,
    `${new URL(url).pathname}: HTTP ${response.status}; expected JSON, not an Access login redirect`,
  );
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/json/,
    `${new URL(url).pathname}: expected JSON`,
  );
  return response.json();
}

try {
  const url = new URL(endpoint);
  const root = await json(new URL('/', url));
  assert.equal(root.mcp_endpoint, endpoint, 'PUBLIC_URL/MCP_PATH does not match the requested endpoint');
  assert.equal(root.auth_mode, 'oauth', 'Use oauth mode for per-user portal authorization');
  assert.equal(root.oauth_mode, 'proxy', 'This probe checks the proxy deployment');
  const challenge = await request(endpoint);
  assert.equal(challenge.status, 401, 'Unauthenticated MCP must return 401, not a browser login redirect');
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    challenge.headers.get('www-authenticate') ?? '',
  )?.[1];
  assert.ok(metadataUrl, 'Missing resource_metadata in WWW-Authenticate');
  const resource = await json(metadataUrl);
  assert.equal(resource.resource, endpoint, 'Protected-resource audience does not match the endpoint');
  assert.ok(resource.authorization_servers?.includes(url.origin), 'Proxy issuer must match PUBLIC_URL');
  const metadata = await json(new URL('/.well-known/oauth-authorization-server', url));
  assert.equal(metadata.issuer, url.origin, 'Authorization server issuer must match PUBLIC_URL');
  assert.ok(metadata.code_challenge_methods_supported?.includes('S256'), 'Missing S256 PKCE support');
  assert.ok(
    metadata.token_endpoint_auth_methods_supported?.includes('none'),
    'DCR proxy must support public clients',
  );
  const registered = await json(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP deployment check',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.ok(registered.client_id, 'Registration did not return a client_id');
  const authorization = new URL(metadata.authorization_endpoint);
  authorization.search = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    resource: endpoint,
    state: 'deployment-check',
  }).toString();
  const consent = await request(authorization);
  assert.equal(consent.status, 200, 'Expected the proxy consent page before Zammad authorization');
  assert.match(consent.headers.get('content-type') ?? '', /text\/html/);
  assert.match(consent.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  await consent.body?.cancel();
  process.stdout.write(`PASS: discovery, unauthenticated challenge, PKCE, DCR and consent at ${endpoint}\n`);
  process.stdout.write(
    `Callback accepted: ${redirectUri}\nComplete a browser login in the portal to verify user authorization and tool discovery.\n`,
  );
} catch (error) {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
