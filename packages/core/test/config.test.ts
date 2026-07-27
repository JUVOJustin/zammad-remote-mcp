import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { ZAMMAD_URL: 'https://support.example.com' } as NodeJS.ProcessEnv;

const env = (extra: Record<string, string>) => ({ ...base, ...extra }) as NodeJS.ProcessEnv;

describe('ZAMMAD_OAUTH_MODE follows ZAMMAD_AUTH_MODE', () => {
  it('defaults to proxy under the oauth auth mode', () => {
    const config = loadConfig(
      env({
        ZAMMAD_AUTH_MODE: 'oauth',
        ZAMMAD_OAUTH_CLIENT_ID: 'client',
        OAUTH_STATE_SECRET: 'a-secret-at-least-16-chars',
        PUBLIC_URL: 'https://mcp.example.com',
      }),
    );
    assert.equal(config.ZAMMAD_OAUTH_MODE, 'proxy');
  });

  it('resolves to disabled under token mode without being spelled out', () => {
    const config = loadConfig(env({ ZAMMAD_AUTH_MODE: 'token', ZAMMAD_API_TOKEN: 'tok' }));
    assert.equal(config.ZAMMAD_OAUTH_MODE, 'disabled');
  });

  it('resolves to disabled under basic mode too', () => {
    const config = loadConfig(env({ ZAMMAD_AUTH_MODE: 'basic', ZAMMAD_USERNAME: 'u', ZAMMAD_PASSWORD: 'p' }));
    assert.equal(config.ZAMMAD_OAUTH_MODE, 'disabled');
  });

  it('does not demand OAuth credentials in token mode', () => {
    // The whole point of the derived default: no client id, no state secret, no
    // PUBLIC_URL required just to run against a fixed token.
    assert.doesNotThrow(() => loadConfig(env({ ZAMMAD_AUTH_MODE: 'token', ZAMMAD_API_TOKEN: 'tok' })));
  });

  it('rejects serving OAuth endpoints that the request path would ignore', () => {
    assert.throws(
      () =>
        loadConfig(
          env({
            ZAMMAD_AUTH_MODE: 'token',
            ZAMMAD_API_TOKEN: 'tok',
            ZAMMAD_OAUTH_MODE: 'proxy',
            ZAMMAD_OAUTH_CLIENT_ID: 'client',
            OAUTH_STATE_SECRET: 'a-secret-at-least-16-chars',
            PUBLIC_URL: 'https://mcp.example.com',
          }),
        ),
      /cannot be "proxy" while ZAMMAD_AUTH_MODE=token/,
    );
  });

  it('still allows disabled to be stated explicitly under oauth mode', () => {
    // Bearer tokens are required and forwarded, but discovery is someone else's
    // job — e.g. an API gateway in front.
    const config = loadConfig(env({ ZAMMAD_AUTH_MODE: 'oauth', ZAMMAD_OAUTH_MODE: 'disabled' }));
    assert.equal(config.ZAMMAD_OAUTH_MODE, 'disabled');
  });

  it('still allows passthrough to be chosen under oauth mode', () => {
    const config = loadConfig(
      env({ ZAMMAD_AUTH_MODE: 'oauth', ZAMMAD_OAUTH_MODE: 'passthrough', ZAMMAD_OAUTH_CLIENT_ID: 'client' }),
    );
    assert.equal(config.ZAMMAD_OAUTH_MODE, 'passthrough');
  });
});

describe('credential requirements', () => {
  it('requires a token in token mode', () => {
    assert.throws(() => loadConfig(env({ ZAMMAD_AUTH_MODE: 'token' })), /ZAMMAD_API_TOKEN/);
  });

  it('requires a state secret for the proxy', () => {
    assert.throws(
      () =>
        loadConfig(
          env({
            ZAMMAD_AUTH_MODE: 'oauth',
            ZAMMAD_OAUTH_CLIENT_ID: 'client',
            PUBLIC_URL: 'https://mcp.example.com',
          }),
        ),
      /OAUTH_STATE_SECRET/,
    );
  });
});
