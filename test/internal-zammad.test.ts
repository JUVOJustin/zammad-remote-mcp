import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../src/core/app.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/util/logger.js';

/**
 * The shape of examples/docker-compose: Zammad reachable by service name from
 * the server, and not at all from a user's browser.
 *
 * ZAMMAD_URL and ZAMMAD_PUBLIC_URL were one value until this example needed
 * them apart, so what these guard is the leak — an internal hostname reaching a
 * client, which sends the user somewhere that resolves nowhere.
 */
describe('a Zammad reachable only on an internal network', () => {
  let server: ReturnType<typeof serve>;
  let port = 0;

  before(async () => {
    // The shape of examples/docker-compose: the server resolves a service name,
    // the user's browser never can.
    const config = loadConfig({
      ZAMMAD_URL: 'http://zammad-nginx:8080',
      ZAMMAD_PUBLIC_URL: 'https://support.example.com',
      ZAMMAD_AUTH_MODE: 'oauth',
      ZAMMAD_OAUTH_MODE: 'passthrough',
      ZAMMAD_OAUTH_CLIENT_ID: 'registered-in-zammad',
      PUBLIC_URL: 'https://mcp.example.com',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);

    const app = createApp(config, createLogger('silent'));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('publishes only the browser-facing Zammad to clients', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    const body = await response.json();

    assert.equal(body.issuer, 'https://support.example.com');
    assert.equal(body.authorization_endpoint, 'https://support.example.com/oauth/authorize');
    assert.equal(body.token_endpoint, 'https://support.example.com/oauth/token');

    // The container hostname must not escape into anything a client reads —
    // it would send the user somewhere their browser cannot resolve.
    assert.ok(
      !JSON.stringify(body).includes('zammad-nginx'),
      `the internal host leaked into published metadata: ${JSON.stringify(body)}`,
    );
  });

  it('keeps the internal host out of the protected-resource document', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
    const body = await response.json();

    assert.deepEqual(body.authorization_servers, ['https://support.example.com']);
    assert.ok(!JSON.stringify(body).includes('zammad-nginx'));
  });
});
