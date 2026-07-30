import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../src/core/app.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/util/logger.js';

/**
 * The parts of the server that are the server's own: OAuth discovery, the
 * dynamic-client-registration proxy, and the Streamable HTTP transport.
 *
 * Nothing here talks to Zammad, and nothing here stands in for it. There used to
 * be a stub Zammad in this file answering canned JSON for the tool calls; every
 * one of those tests now runs against the real instance in
 * `test/integration/tools.integration.test.ts`. A fake Zammad can only confirm
 * what we already assumed about the real one — which is exactly how a silently
 * ignored `tags` argument and an article nested in the wrong parameter both
 * survived until someone read the response back off a live instance.
 *
 * `DYNAMIC_TOOL_SCHEMAS` is off so no vocabulary fetch is even attempted:
 * `ZAMMAD_URL` below is used to build redirect targets and is never dialled.
 */

/** Only ever appears inside URLs that are compared, never requested. */
const ZAMMAD_URL = 'http://zammad.invalid';

let appServer: ReturnType<typeof serve>;
let appPort: number;

/** Issue one MCP JSON-RPC call over Streamable HTTP. */
async function mcp(
  method: string,
  params: unknown,
  options: { token?: string | null; id?: number } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // The spec requires the client to accept both.
    Accept: 'application/json, text/event-stream',
  };
  const token = options.token === undefined ? 'good-token' : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`http://127.0.0.1:${appPort}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, params }),
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

before(async () => {
  const config = loadConfig({
    ZAMMAD_URL,
    ZAMMAD_AUTH_MODE: 'oauth',
    ZAMMAD_OAUTH_MODE: 'proxy',
    ZAMMAD_OAUTH_CLIENT_ID: 'zammad-client-id',
    ZAMMAD_OAUTH_CLIENT_SECRET: 'zammad-client-secret',
    OAUTH_STATE_SECRET: 'test-secret-that-is-long-enough',
    PUBLIC_URL: 'http://127.0.0.1:39999',
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
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe('discovery endpoints', () => {
  it('serves protected-resource metadata pointing at this server as the AS', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.resource, 'http://127.0.0.1:39999/mcp');
    assert.deepEqual(body.authorization_servers, ['http://127.0.0.1:39999']);
  });

  it('serves authorization-server metadata for the proxy', async () => {
    const response = await fetch(`http://127.0.0.1:${appPort}/.well-known/oauth-authorization-server`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.issuer, 'http://127.0.0.1:39999');
    assert.match(body.authorization_endpoint, /\/authorize$/);
    assert.match(body.token_endpoint, /\/token$/);
    assert.ok(
      body.registration_endpoint,
      'dynamic registration must be advertised — Zammad has none of its own',
    );
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
      'http://127.0.0.1:39999/oauth/callback',
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
    assert.equal(body.error, 'invalid_client_metadata');
    assert.match(body.error_description, /attacker\.example/);
    assert.match(body.error_description, /OAUTH_ALLOWED_REDIRECT_HOSTS/);
  });

  it('rejects a tampered state on the callback', async () => {
    const response = await fetch(
      `http://127.0.0.1:${appPort}/oauth/callback?code=x&state=bm90LWEtcmVhbC1zdGF0ZQ.deadbeef`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 400);
  });
});

describe('mcp endpoint', () => {
  it('rejects a request with no bearer token and points at the metadata', async () => {
    const response = await mcp('initialize', {}, { token: null });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  });

  it('completes the handshake', async () => {
    const response = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.result.serverInfo.name, 'zammad-remote-mcp');
    assert.match(response.body.result.instructions, /zammad_search_tickets/);

    // The configured instance, not a placeholder: a Zammad link carries no clue
    // as to which instance it belongs to, so the client has to be told.
    const instructions: string = response.body.result.instructions;
    assert.ok(
      instructions.includes(ZAMMAD_URL),
      `the instructions do not name the instance: ${instructions.slice(0, 200)}`,
    );
  });

  it('issues no session id — the transport is stateless', async () => {
    const response = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.equal(response.headers.get('mcp-session-id'), null);
  });
});
