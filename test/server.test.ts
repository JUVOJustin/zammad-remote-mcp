import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import manifest from '../package.json' with { type: 'json' };
import { createApp } from '../src/core/app.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/util/logger.js';

/**
 * The parts of the server that are the server's own: OAuth discovery, the
 * authorization-server proxy, and the Streamable HTTP transport.
 *
 * No tool call here reaches Zammad, and nothing stands in for its API. There
 * used to be a stub Zammad in this file answering canned JSON for the tool
 * calls; every one of those tests now runs against the real instance in
 * `test/integration/tools.integration.test.ts`. A fake Zammad can only confirm
 * what we already assumed about the real one — which is exactly how a silently
 * ignored `tags` argument and an article nested in the wrong parameter both
 * survived until someone read the response back off a live instance.
 *
 * The one exception is Doorkeeper's token endpoint, answered in-process by
 * `upstream` below. What is under test there is the request this server builds
 * — whose credentials, which redirect URI — and how it relays the verdict; the
 * verdict itself is plain RFC 6749, and a code can only be minted by a person
 * logging in to a real Zammad.
 *
 * `DYNAMIC_TOOL_SCHEMAS` is off so no vocabulary fetch is even attempted.
 */

/** Only ever appears inside URLs that are compared or intercepted, never dialled. */
const ZAMMAD_URL = 'http://zammad.invalid';
const PUBLIC_URL = 'http://127.0.0.1:39999';
const MODERN = '2026-07-28';

let appServer: ReturnType<typeof serve>;
let appPort: number;

/**
 * Outbound requests the app makes to hosts that do not exist, answered by the
 * test that expects them. Everything else goes to the real network stack.
 */
const upstream = new Map<string, (request: Request) => Response | Promise<Response>>();
const upstreamCalls: Request[] = [];
const realFetch = globalThis.fetch;

/** Issue one MCP JSON-RPC call over Streamable HTTP. */
async function mcp(
  method: string,
  params: Record<string, unknown>,
  options: { token?: string | null; id?: number; modern?: boolean } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // The spec requires the client to accept both.
    Accept: 'application/json, text/event-stream',
  };
  const token = options.token === undefined ? 'good-token' : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  // A 2026-07-28 request states its protocol version and capabilities itself,
  // in the headers and in `_meta`, instead of relying on an earlier handshake.
  let body = params;
  if (options.modern) {
    headers['MCP-Protocol-Version'] = MODERN;
    headers['Mcp-Method'] = method;
    if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;
    body = {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
      },
    };
  }

  const response = await fetch(`http://127.0.0.1:${appPort}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, params: body }),
  });

  const text = await response.text();
  if (!text) return { status: response.status, body: undefined, headers: response.headers };

  // Stateless replies may still come back as a single SSE event.
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    return {
      status: response.status,
      body: dataLine ? JSON.parse(dataLine.slice(5).trim()) : undefined,
      headers: response.headers,
    };
  }
  return { status: response.status, body: JSON.parse(text), headers: response.headers };
}

/** Register a client over DCR and return its signed id. */
async function registerTestClient(redirectUri = 'http://localhost:33418/callback'): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${appPort}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test MCP Client', redirect_uris: [redirectUri] }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).client_id;
}

function authorizeUrl(params: Record<string, string>): string {
  return `http://127.0.0.1:${appPort}/authorize?${new URLSearchParams({
    response_type: 'code',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...params,
  })}`;
}

before(async () => {
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const answer = upstream.get(request.url);
    if (!answer) return realFetch(input, init);
    upstreamCalls.push(request.clone());
    return answer(request);
  };

  const config = loadConfig({
    ZAMMAD_URL,
    ZAMMAD_AUTH_MODE: 'oauth',
    ZAMMAD_OAUTH_MODE: 'proxy',
    ZAMMAD_OAUTH_CLIENT_ID: 'zammad-client-id',
    ZAMMAD_OAUTH_CLIENT_SECRET: 'zammad-client-secret',
    OAUTH_STATE_SECRET: 'test-secret-that-is-long-enough',
    PUBLIC_URL,
    LOG_LEVEL: 'silent',
    DYNAMIC_TOOL_SCHEMAS: 'false',
  } as NodeJS.ProcessEnv);

  const app = createApp(config, createLogger('silent'));
  await new Promise<void>((resolve) => {
    appServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      appPort = info.port;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe('discovery endpoints', () => {
  it('serves protected-resource metadata pointing at this server as the AS', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.resource, `${PUBLIC_URL}/mcp`);
    assert.deepEqual(body.authorization_servers, [PUBLIC_URL]);
  });

  it('serves authorization-server metadata for the proxy', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/.well-known/oauth-authorization-server`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.issuer, PUBLIC_URL);
    assert.match(body.authorization_endpoint, /\/authorize$/);
    assert.match(body.token_endpoint, /\/token$/);
    assert.ok(
      body.registration_endpoint,
      'dynamic registration must be advertised — Zammad has none of its own',
    );
    assert.equal(body.client_id_metadata_document_supported, true);
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  });

  it('reports health without a credential', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  });
});

describe('dynamic client registration', () => {
  it('mints a signed client_id that carries the redirect URIs', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test MCP Client',
        redirect_uris: ['http://localhost:33418/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.client_id, /^zmcp_/);
    assert.equal(
      body.client_secret,
      undefined,
      'the proxy is a public client; the real secret stays server-side',
    );

    // The registration must survive a round trip through /authorize with no
    // server-side storage in between.
    const authorize = await fetch(
      `http://127.0.0.1:${appPort}/authorize?` +
        new URLSearchParams({
          client_id: body.client_id,
          response_type: 'code',
          redirect_uri: 'http://localhost:33418/callback',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          state: 'client-state',
        }),
      { redirect: 'manual' },
    );

    assert.equal(authorize.status, 302);
    const location = new URL(authorize.headers.get('location')!);
    assert.equal(location.origin, ZAMMAD_URL);
    assert.equal(location.pathname, '/oauth/authorize');
    assert.equal(
      location.searchParams.get('client_id'),
      'zammad-client-id',
      'must use the real Zammad client',
    );
    assert.equal(
      location.searchParams.get('redirect_uri'),
      `${PUBLIC_URL}/oauth/callback`,
      'must swap in the single callback registered with Zammad',
    );
    assert.equal(
      location.searchParams.get('code_challenge'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      'PKCE must reach Doorkeeper untouched',
    );

    // The callback must bounce back to the client's own redirect URI.
    const callback = await fetch(
      `http://127.0.0.1:${appPort}/oauth/callback?` +
        new URLSearchParams({ code: 'zammad-auth-code', state: location.searchParams.get('state')! }),
      { redirect: 'manual' },
    );
    assert.equal(callback.status, 302);

    const back = new URL(callback.headers.get('location')!);
    assert.equal(back.origin + back.pathname, 'http://localhost:33418/callback');
    assert.equal(back.searchParams.get('code'), 'zammad-auth-code');
    assert.equal(
      back.searchParams.get('state'),
      'client-state',
      "the client's original state must be restored",
    );
    assert.equal(back.searchParams.get('iss'), PUBLIC_URL, 'RFC 9207: the response must name its issuer');
  });

  it('registers a hosted MCP client, not only loopback ones', async () => {
    // Claude and other hosted clients complete the flow on their own domain.
    // With a loopback-only allowlist this came back as an opaque 500.
    const response = await fetch(`http://127.0.0.1:${appPort}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      }),
    });

    assert.equal(response.status, 201);
    assert.match((await response.json()).client_id, /^zmcp_/);
  });

  it('refuses a redirect URI outside the allowlist with an actionable 400', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Evil',
        redirect_uris: ['https://attacker.example/steal'],
        token_endpoint_auth_method: 'none',
      }),
    });

    // A plain Error here would surface as 500 "Internal Server Error", which
    // tells the operator nothing about what to change.
    assert.equal(response.status, 400);

    const body = await response.json();
    assert.equal(body.error, 'invalid_redirect_uri');
    assert.match(body.error_description, /attacker\.example/);
    assert.match(body.error_description, /OAUTH_ALLOWED_REDIRECT_HOSTS/);
  });

  it('answers a registration without usable redirect URIs with a 400, not a 500', async () => {
    const register = (body: unknown) =>
      fetch(`http://127.0.0.1:${appPort}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const missing = await register({ client_name: 'No redirect' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'invalid_client_metadata');

    const empty = await register({ client_name: 'Empty redirect', redirect_uris: [] });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'invalid_redirect_uri');
  });

  it('rejects a tampered state on the callback', async () => {
    const response = await fetch(
      `http://127.0.0.1:${appPort}/oauth/callback?code=x&state=bm90LWEtcmVhbC1zdGF0ZQ.deadbeef`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 400);
  });
});

describe('authorization endpoint', () => {
  it('shows an unregistered redirect URI to the user agent instead of following it', async () => {
    const clientId = await registerTestClient();
    const response = await fetch(
      authorizeUrl({ client_id: clientId, redirect_uri: 'http://localhost:33418/elsewhere' }),
      { redirect: 'manual' },
    );

    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    assert.equal((await response.json()).error, 'invalid_request');
  });

  it('sends a missing PKCE challenge back to the client with its state and the issuer', async () => {
    const clientId = await registerTestClient();
    const response = await fetch(
      `http://127.0.0.1:${appPort}/authorize?${new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        state: 'client-state',
      })}`,
      { redirect: 'manual' },
    );

    assert.equal(response.status, 302);
    const back = new URL(response.headers.get('location')!);
    assert.equal(back.origin + back.pathname, 'http://localhost:33418/callback');
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('state'), 'client-state');
    assert.equal(back.searchParams.get('iss'), PUBLIC_URL);
  });
});

describe('client ID metadata documents', () => {
  const documentUrl = (name: string) => `https://client.example/${name}.json`;

  function publish(url: string, document: Record<string, unknown>, headers: HeadersInit = {}): void {
    upstream.set(url, () => Response.json(document, { headers }));
  }

  it('authorizes a client identified by the URL of its metadata document', async () => {
    const clientId = documentUrl('valid');
    publish(clientId, {
      client_id: clientId,
      client_name: 'Document Client',
      redirect_uris: ['http://localhost:4567/callback'],
      token_endpoint_auth_method: 'none',
    });
    const before = upstreamCalls.length;

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(
        authorizeUrl({ client_id: clientId, redirect_uri: 'http://localhost:4567/callback', state: 's' }),
        { redirect: 'manual' },
      );
      assert.equal(response.status, 302);
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.origin, ZAMMAD_URL);
      assert.equal(location.searchParams.get('client_id'), 'zammad-client-id');
    }

    assert.equal(upstreamCalls.length - before, 1, 'the document must be fetched once and then cached');
  });

  it('accepts a loopback redirect on the port the client picked, not the one it listed', async () => {
    // Claude Code's published document lists `http://localhost/callback` and
    // then listens on an ephemeral port (RFC 8252 §7.3).
    const clientId = documentUrl('loopback');
    publish(clientId, {
      client_id: clientId,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    });

    const response = await fetch(
      authorizeUrl({ client_id: clientId, redirect_uri: 'http://localhost:51234/callback' }),
      { redirect: 'manual' },
    );
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')!).origin, ZAMMAD_URL);
  });

  it('refuses a document that names a different client_id', async () => {
    const clientId = documentUrl('impostor');
    publish(clientId, {
      client_id: 'https://someone-else.example/client.json',
      client_name: 'Impostor',
      redirect_uris: ['http://localhost:4567/callback'],
    });

    const response = await fetch(authorizeUrl({ client_id: clientId }), { redirect: 'manual' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, 'invalid_client');
    assert.match(body.error_description, /different client_id/);
  });

  it('refuses a document asking for client authentication it cannot verify', async () => {
    const clientId = documentUrl('private-key-jwt');
    publish(clientId, {
      client_id: clientId,
      client_name: 'Confidential',
      redirect_uris: ['http://localhost:4567/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
    });

    const response = await fetch(authorizeUrl({ client_id: clientId }), { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error_description, /private_key_jwt/);
  });

  it('holds a listed redirect URI to the same allowlist as a registered one', async () => {
    const clientId = documentUrl('foreign-redirect');
    publish(clientId, {
      client_id: clientId,
      client_name: 'Foreign',
      redirect_uris: ['https://attacker.example/callback'],
    });

    const response = await fetch(authorizeUrl({ client_id: clientId }), { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    assert.match((await response.json()).error_description, /OAUTH_ALLOWED_REDIRECT_HOSTS/);
  });

  it('never fetches from an address, a local or single-label name, or a custom port', async () => {
    const before = upstreamCalls.length;
    for (const clientId of [
      'https://169.254.169.254/latest/meta-data',
      'https://localhost./client.json',
      'https://intranet/client.json',
      'https://localhost.localdomain/client.json',
      'https://printer.local/client.json',
      'https://client.example:8443/client.json',
    ]) {
      const response = await fetch(authorizeUrl({ client_id: clientId }), { redirect: 'manual' });
      assert.equal(response.status, 400, clientId);
      assert.equal((await response.json()).error, 'invalid_client', clientId);
    }
    assert.equal(upstreamCalls.length, before);
  });

  it("answers an outage at the client's host as a server fault, not an unknown client", async () => {
    // A client told its id is invalid discards its tokens; a brief outage at
    // its own host must not cost the user their connection.
    const clientId = documentUrl('outage');
    upstream.set(clientId, () => new Response('upstream down', { status: 503 }));

    const response = await fetch(`http://127.0.0.1:${appPort}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'r' }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'server_error');
  });

  it('fetches a document once for concurrent requests', async () => {
    const clientId = documentUrl('concurrent');
    upstream.set(clientId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({
        client_id: clientId,
        client_name: 'Concurrent',
        redirect_uris: ['http://localhost:4567/callback'],
      });
    });
    const before = upstreamCalls.length;

    const responses = await Promise.all(
      [1, 2, 3].map(() => fetch(authorizeUrl({ client_id: clientId }), { redirect: 'manual' })),
    );
    for (const response of responses) assert.equal(response.status, 302);
    assert.equal(upstreamCalls.length - before, 1);
  });

  it('can be switched off for a server without outbound internet access', async () => {
    const offline = createApp(
      loadConfig({
        ZAMMAD_URL,
        ZAMMAD_OAUTH_CLIENT_ID: 'zammad-client-id',
        OAUTH_STATE_SECRET: 'test-secret-that-is-long-enough',
        PUBLIC_URL,
        LOG_LEVEL: 'silent',
        OAUTH_CLIENT_ID_METADATA_DOCUMENTS: 'false',
      } as NodeJS.ProcessEnv),
      createLogger('silent'),
    );

    const metadata = await (
      await offline.fetch(new Request(`${PUBLIC_URL}/.well-known/oauth-authorization-server`))
    ).json();
    assert.equal(metadata.client_id_metadata_document_supported, false);
    assert.ok(metadata.registration_endpoint, 'clients must still be able to register');

    const before = upstreamCalls.length;
    const response = await offline.fetch(
      new Request(
        `${PUBLIC_URL}/authorize?${new URLSearchParams({ client_id: documentUrl('offline'), response_type: 'code' })}`,
      ),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_client');
    assert.equal(upstreamCalls.length, before);
  });
});

describe('token endpoint', () => {
  const tokenUrl = `${ZAMMAD_URL}/oauth/token`;

  async function exchange(clientId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${appPort}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: 'zammad-auth-code',
        code_verifier: 'the-verifier',
        redirect_uri: 'http://localhost:33418/callback',
      }),
    });
  }

  it('redeems the code with the Zammad credentials and the proxy callback', async () => {
    upstream.set(tokenUrl, () =>
      Response.json({ access_token: 'zammad-access', token_type: 'Bearer', refresh_token: 'zammad-refresh' }),
    );
    const clientId = await registerTestClient();
    const before = upstreamCalls.length;

    const response = await exchange(clientId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).access_token, 'zammad-access');

    assert.equal(upstreamCalls.length - before, 1);
    const sent = new URLSearchParams(await upstreamCalls.at(-1)!.text());
    assert.equal(sent.get('client_id'), 'zammad-client-id', 'the MCP client id means nothing to Doorkeeper');
    assert.equal(sent.get('client_secret'), 'zammad-client-secret');
    assert.equal(sent.get('redirect_uri'), `${PUBLIC_URL}/oauth/callback`);
    assert.equal(sent.get('code_verifier'), 'the-verifier', 'PKCE must reach Doorkeeper untouched');
  });

  it("passes Doorkeeper's invalid_grant through so the client authorizes again", async () => {
    upstream.set(tokenUrl, () =>
      Response.json({ error: 'invalid_grant', error_description: 'The grant is expired.' }, { status: 400 }),
    );

    const response = await exchange(await registerTestClient());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'invalid_grant',
      error_description: 'The grant is expired.',
    });
  });

  it("reports a refusal of the proxy's own credentials as a gateway failure", async () => {
    upstream.set(tokenUrl, () => Response.json({ error: 'invalid_client' }, { status: 401 }));

    const response = await exchange(await registerTestClient());
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'server_error');
    assert.match(body.error_description, /ZAMMAD_OAUTH_CLIENT_SECRET/);
  });

  it('refuses an unknown client before contacting Zammad', async () => {
    const before = upstreamCalls.length;
    const response = await exchange('zmcp_forged.signature');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_client');
    assert.equal(upstreamCalls.length, before);
  });
});

describe('mcp endpoint', () => {
  it('rejects a request with no bearer token and points at the metadata', async () => {
    const response = await mcp('server/discover', {}, { token: null, modern: true });
    assert.equal(response.status, 401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /resource_metadata=/);
    assert.match(challenge, /scope="full"/);
  });

  it('confirms the token with Zammad first when asked to, and says whose fault a refusal is', async () => {
    const eager = createApp(
      loadConfig({
        ZAMMAD_URL,
        ZAMMAD_OAUTH_CLIENT_ID: 'zammad-client-id',
        OAUTH_STATE_SECRET: 'test-secret-that-is-long-enough',
        PUBLIC_URL,
        LOG_LEVEL: 'silent',
        DYNAMIC_TOOL_SCHEMAS: 'false',
        VALIDATE_TOKEN_EAGERLY: 'true',
      } as NodeJS.ProcessEnv),
      createLogger('silent'),
    );
    const discover = () =>
      eager.fetch(
        new Request(`${PUBLIC_URL}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: 'Bearer dead-token',
            'MCP-Protocol-Version': MODERN,
            'Mcp-Method': 'server/discover',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'server/discover',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': MODERN,
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
      );
    const me = `${ZAMMAD_URL}/api/v1/users/me`;

    upstream.set(me, () => Response.json({ error: 'Invalid token' }, { status: 401 }));
    const refused = await discover();
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get('www-authenticate') ?? '', /error="invalid_token".*resource_metadata=/);

    // Zammad being down is not the token's fault; a 401 would send the client
    // through a pointless re-authorization.
    upstream.set(me, () => new Response('maintenance', { status: 503 }));
    const unavailable = await discover();
    assert.equal(unavailable.status, 500);
    assert.equal(unavailable.headers.get('www-authenticate'), null);

    upstream.delete(me);
  });

  it('answers a 2026-07-28 discovery request with its version and identity', async () => {
    const response = await mcp('server/discover', {}, { modern: true });

    assert.equal(response.status, 200);
    assert.ok(response.body.result.supportedVersions.includes(MODERN));
    // Nothing is ever published, so no client should hold a listen stream open for it.
    assert.equal(response.body.result.capabilities.tools.listChanged, false);
    assert.deepEqual(response.body.result._meta['io.modelcontextprotocol/serverInfo'], {
      name: 'zammad-remote-mcp',
      version: manifest.version,
    });
    assert.ok(
      response.body.result.instructions.includes(ZAMMAD_URL),
      'the instructions must name the instance',
    );
  });

  it('lets a client cache the tool list for as long as the lookup cache holds', async () => {
    const response = await mcp('tools/list', {}, { modern: true });

    assert.equal(response.status, 200);
    assert.ok(response.body.result.tools.length > 0);
    // METADATA_CACHE_TTL_SECONDS defaults to 300.
    assert.equal(response.body.result.ttlMs, 300_000);
    assert.equal(response.body.result.cacheScope, 'private');
  });

  it('completes the 2025-era handshake for clients that still negotiate with initialize', async () => {
    const response = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.result.serverInfo.name, 'zammad-remote-mcp');
    assert.equal(response.body.result.serverInfo.version, manifest.version);
    assert.match(response.body.result.instructions, /zammad_search_tickets/);

    // The configured instance, not a placeholder: a Zammad link carries no clue
    // as to which instance it belongs to, so the client has to be told.
    const instructions: string = response.body.result.instructions;
    assert.ok(
      instructions.includes(ZAMMAD_URL),
      `the instructions do not name the instance: ${instructions.slice(0, 200)}`,
    );
  });

  it('answers a 2025-era request that skips the handshake', async () => {
    const response = await mcp('tools/list', {});
    assert.equal(response.status, 200);
    assert.ok(response.body.result.tools.length > 0);
  });

  it('issues no session id — the transport is stateless', async () => {
    const response = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.equal(response.headers.get('mcp-session-id'), null);
  });

  it('lets a browser send the 2026-07-28 request headers', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://inspector.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'authorization, content-type, mcp-method, mcp-name, mcp-protocol-version',
      },
    });

    const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of ['mcp-method', 'mcp-name', 'mcp-protocol-version', 'authorization']) {
      assert.ok(allowed.includes(header), `${header} is missing from ${allowed}`);
    }
  });
});
