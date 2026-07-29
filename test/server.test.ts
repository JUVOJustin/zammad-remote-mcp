import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../src/core/app.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/util/logger.js';

/**
 * End-to-end coverage: a stub Zammad, the real Hono app, and MCP traffic over
 * Streamable HTTP. This is what verifies the stateless claim — every request
 * below is independent, with no session header carried between them.
 */

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body?: unknown;
}

let zammad: Server;
let zammadPort: number;
let appServer: ReturnType<typeof serve>;
let appPort: number;
const requests: RecordedRequest[] = [];

/** A stub Zammad that answers just enough of the REST API. */
function startZammad(): Promise<void> {
  zammad = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push({
        method: req.method ?? 'GET',
        url: url.pathname + url.search,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.headers.authorization !== 'Bearer good-token') {
        return send(401, { error: 'authentication failed' });
      }

      switch (url.pathname) {
        case '/api/v1/users/me':
          return send(200, {
            id: 3,
            login: 'agent',
            firstname: 'Ann',
            lastname: 'Agent',
            email: 'ann@example.com',
          });
        case '/api/v1/ticket_states':
          return send(200, [
            { id: 2, name: 'open', active: true, state_type_id: 2, state_type: 'open' },
            { id: 4, name: 'closed', active: true, state_type_id: 5, state_type: 'closed' },
          ]);
        case '/api/v1/ticket_priorities':
          return send(200, [{ id: 3, name: '3 high', active: true }]);
        case '/api/v1/groups':
          return send(200, [{ id: 2, name: '1st Level', active: true }]);
        case '/api/v1/macros':
          return send(200, [{ id: 9, name: 'Close as spam', active: true }]);
        case '/api/v1/tickets/search': {
          // Mirror Zammad's `Selector::Base.migrate_selector`: a condition with
          // no `conditions` key is read as the legacy attribute-keyed form, and
          // a bare leaf makes it merge a String into a Hash — a real 500.
          const condition = (raw ? JSON.parse(raw) : {}).condition;
          if (condition && typeof condition === 'object' && !('conditions' in condition)) {
            const legacyShape = Object.values(condition).every(
              (v) => v && typeof v === 'object' && !Array.isArray(v),
            );
            if (!legacyShape) {
              return send(500, { error: 'Error ID stub: no implicit conversion of String into Hash' });
            }
          }
          return send(200, {
            records: [
              {
                id: 101,
                number: '67001',
                title: 'Printer offline',
                state: 'open',
                priority: '3 high',
                group: '1st Level',
                customer: 'jane@acme.com',
                created_at: '2026-07-01T10:00:00Z',
                updated_at: '2026-07-02T08:00:00Z',
              },
            ],
            total_count: 1,
          });
        }
        case '/api/v1/tickets':
          if (req.method === 'POST')
            return send(201, { id: 202, number: '67002', title: 'New ticket', state: 'new' });
          return send(200, []);
        case '/api/v1/tickets/101':
          return send(200, { id: 101, number: '67001', title: 'Printer offline' });
        case '/api/v1/links/add':
          return send(201, { id: 1 });
        case '/api/v1/links/remove':
          return send(201, {});
        default:
          return send(404, { error: `stub has no route for ${url.pathname}` });
      }
    });
  });

  return new Promise((resolve) => {
    zammad.listen(0, '127.0.0.1', () => {
      zammadPort = (zammad.address() as { port: number }).port;
      resolve();
    });
  });
}

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
  await startZammad();

  const config = loadConfig({
    ZAMMAD_URL: `http://127.0.0.1:${zammadPort}`,
    ZAMMAD_AUTH_MODE: 'oauth',
    ZAMMAD_OAUTH_MODE: 'proxy',
    ZAMMAD_OAUTH_CLIENT_ID: 'zammad-client-id',
    ZAMMAD_OAUTH_CLIENT_SECRET: 'zammad-client-secret',
    OAUTH_STATE_SECRET: 'test-secret-that-is-long-enough',
    PUBLIC_URL: 'http://127.0.0.1:39999',
    LOG_LEVEL: 'silent',
    METADATA_CACHE_TTL_SECONDS: '0',
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
  await new Promise<void>((resolve) => zammad.close(() => resolve()));
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
    assert.equal(location.origin, `http://127.0.0.1:${zammadPort}`);
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
      instructions.includes(`http://127.0.0.1:${zammadPort}`),
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

  it('lists every tool without a prior initialize on the same connection', async () => {
    // No handshake first: proof that nothing is remembered between requests.
    const response = await mcp('tools/list', {}, { id: 7 });
    assert.equal(response.status, 200);

    const names: string[] = response.body.result.tools.map((t: { name: string }) => t.name);
    for (const expected of [
      'zammad_search_tickets',
      'zammad_search_users',
      'zammad_search_organizations',
      'zammad_search_global',
      'zammad_get_ticket',
      'zammad_create_ticket',
      'zammad_update_ticket',
      'zammad_delete_ticket',
      'zammad_merge_tickets',
      'zammad_mass_update_tickets',
      'zammad_create_article',
      'zammad_whoami',
      'zammad_list_custom_attributes',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });

  it("folds the instance's own states, priorities and groups into the tool schema", async () => {
    // This is what replaces the old zammad_list_ticket_states / _priorities /
    // _groups tools: the values are in the schema the model is already reading.
    const response = await mcp('tools/list', {});
    const search = response.body.result.tools.find(
      (t: { name: string }) => t.name === 'zammad_search_tickets',
    );

    const collectEnums = (node: unknown, found: string[] = []): string[] => {
      if (!node || typeof node !== 'object') return found;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum)) found.push(...(record.enum as string[]));
      for (const value of Object.values(record)) collectEnums(value, found);
      return found;
    };

    const stateEnum = collectEnums(search.inputSchema.properties.state);
    assert.ok(stateEnum.includes('open'), `expected the stub's states, got ${stateEnum.join(',')}`);
    assert.ok(stateEnum.includes('closed'));

    assert.ok(collectEnums(search.inputSchema.properties.priority).includes('3 high'));
    assert.ok(collectEnums(search.inputSchema.properties.group).includes('1st Level'));
  });

  it('still accepts a value that is not in the published enum', async () => {
    // Schemas get cached by clients, so a state created after discovery must not
    // be rejected client-side. The enum is a hint; the server resolves.
    const response = await mcp('tools/call', {
      name: 'zammad_search_tickets',
      arguments: { state: 'brand-new-state' },
    });

    // Rejected by Zammad's value set, not by schema validation — the difference
    // matters, because the former carries a message the model can act on.
    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result.content[0].text, /Unknown ticket state/);
  });

  it('no longer exposes the superseded discovery tools', async () => {
    const response = await mcp('tools/list', {});
    const names: string[] = response.body.result.tools.map((t: { name: string }) => t.name);

    for (const gone of [
      'zammad_list_ticket_states',
      'zammad_list_ticket_priorities',
      'zammad_list_groups',
      'zammad_list_macros',
    ]) {
      assert.ok(!names.includes(gone), `${gone} should have been replaced by schema enums`);
    }
  });

  it('takes a macro by name rather than by ID', async () => {
    const response = await mcp('tools/list', {});
    const macro = response.body.result.tools.find((t: { name: string }) => t.name === 'zammad_apply_macro');

    assert.ok(macro.inputSchema.properties.macro, 'expected a `macro` argument');
    assert.ok(!macro.inputSchema.properties.macro_id, '`macro_id` should be gone');
  });

  it("runs a ticket search and forwards the caller's token to Zammad", async () => {
    requests.length = 0;

    const response = await mcp('tools/call', {
      name: 'zammad_search_tickets',
      arguments: { text: 'printer', state: ['open'], priority: ['3 high'] },
    });

    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body.result.content[0].text);
    assert.equal(payload.total_count, 1);
    assert.equal(payload.tickets[0].number, '67001');
    assert.equal(payload.tickets[0].state, 'open');

    // The generated query is echoed back so it can be refined.
    assert.equal(payload.search.query, 'printer*');
    assert.ok(payload.search.condition);

    const search = requests.find((r) => r.url.startsWith('/api/v1/tickets/search'));
    assert.ok(search, 'expected a call to the search endpoint');
    assert.equal(search.method, 'POST', 'a nested condition has to be POSTed');
    assert.equal(search.authorization, 'Bearer good-token', "the caller's own token must be used");

    const body = search.body as Record<string, any>;
    assert.equal(body.query, 'printer*');
    assert.equal(body.expand, true);
    assert.equal(body.with_total_count, true);
    // Names were resolved to IDs against the stub's state/priority lists.
    const json = JSON.stringify(body.condition);
    assert.match(json, /"ticket\.state_id"/);
    assert.match(json, /\[2\]/);
    assert.match(json, /"ticket\.priority_id"/);
  });

  it('surfaces a Zammad 401 as a tool error rather than crashing', async () => {
    const response = await mcp(
      'tools/call',
      { name: 'zammad_whoami', arguments: {} },
      { token: 'bad-token' },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result.content[0].text, /HTTP 401/);
  });

  it('reports invalid filter values with the valid options', async () => {
    const response = await mcp('tools/call', {
      name: 'zammad_search_tickets',
      arguments: { state: ['definitely-not-a-state'] },
    });

    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result.content[0].text, /Unknown ticket state/);
    // The message lists what the instance actually supports, so the model can retry.
    assert.match(response.body.result.content[0].text, /Available: closed, open/);
  });

  it('requires group and customer when creating a ticket', async () => {
    const response = await mcp('tools/call', {
      name: 'zammad_create_ticket',
      arguments: { title: 'No group', article: { body: 'hi' } },
    });

    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result.content[0].text, /requires a group/);
  });

  it('creates a ticket with an internal note by default', async () => {
    requests.length = 0;

    const response = await mcp('tools/call', {
      name: 'zammad_create_ticket',
      arguments: {
        title: 'New ticket',
        group: '1st Level',
        customer: 'jane@acme.com',
        article: { body: 'Something broke' },
      },
    });

    const payload = JSON.parse(response.body.result.content[0].text);
    assert.equal(payload.created, true);
    assert.equal(payload.ticket.number, '67002');

    // The path carries `?expand=true`, so match the path rather than the whole URL.
    const create = requests.find((r) => r.method === 'POST' && r.url.startsWith('/api/v1/tickets'));
    assert.ok(create, 'the create request should have gone out');
    assert.ok(create.url.includes('expand=true'), 'without expand the response has no association names');
    const body = create!.body as Record<string, any>;
    assert.equal(body.group, '1st Level', 'association names go through untouched');
    assert.equal(body.article.internal, true, 'articles must default to internal');
    assert.equal(body.article.type, 'note', 'articles must default to a note, not an email');
  });

  it('links tickets with Zammad’s required ticket number and ID pair', async () => {
    requests.length = 0;

    const response = await mcp('tools/call', {
      name: 'zammad_link_tickets',
      arguments: { ticket_id: 101, target_ticket_id: 102, type: 'child' },
    });

    assert.equal(response.body.result.isError, undefined);
    const source = requests.find(
      (request) => request.method === 'GET' && request.url === '/api/v1/tickets/101',
    );
    assert.ok(source, 'expected the source ticket number lookup');

    const link = requests.find((request) => request.method === 'POST' && request.url === '/api/v1/links/add');
    assert.ok(link, 'expected a link request');
    assert.deepEqual(link.body, {
      link_type: 'child',
      link_object_source: 'Ticket',
      link_object_source_number: '67001',
      link_object_target: 'Ticket',
      link_object_target_value: 102,
    });
  });

  it('unlinks tickets using their internal IDs', async () => {
    requests.length = 0;

    const response = await mcp('tools/call', {
      name: 'zammad_unlink_tickets',
      arguments: { ticket_id: 101, target_ticket_id: 102, type: 'child' },
    });

    assert.equal(response.body.result.isError, undefined);
    const unlink = requests.find(
      (request) => request.method === 'DELETE' && request.url === '/api/v1/links/remove',
    );
    assert.ok(unlink, 'expected an unlink request');
    assert.deepEqual(unlink.body, {
      link_type: 'child',
      link_object_source: 'Ticket',
      link_object_source_value: 101,
      link_object_target: 'Ticket',
      link_object_target_value: 102,
    });
  });
});
