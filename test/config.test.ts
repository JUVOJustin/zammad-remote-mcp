import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/core/config.js';

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

describe('ZAMMAD_PUBLIC_URL', () => {
  const base = {
    ZAMMAD_URL: 'http://zammad-nginx:8080',
    ZAMMAD_AUTH_MODE: 'oauth',
    ZAMMAD_OAUTH_MODE: 'proxy',
    ZAMMAD_OAUTH_CLIENT_ID: 'id',
    ZAMMAD_OAUTH_CLIENT_SECRET: 'secret',
    OAUTH_STATE_SECRET: 'a-secret-that-is-long-enough-to-pass',
    PUBLIC_URL: 'https://mcp.example.com',
  } as NodeJS.ProcessEnv;

  it('falls back to ZAMMAD_URL when unset', () => {
    const config = loadConfig({ ...base, ZAMMAD_URL: 'https://support.example.com' });

    // The single-host case, which is every deployment that existed before this
    // setting: nothing may change for it.
    assert.equal(config.zammadPublicUrl, 'https://support.example.com');
    assert.equal(config.zammadAuthorizeUrl, 'https://support.example.com/oauth/authorize');
    assert.equal(config.zammadTokenUrl, config.zammadPublicTokenUrl);
  });

  it('sends the browser to the public host and keeps API calls internal', () => {
    const config = loadConfig({ ...base, ZAMMAD_PUBLIC_URL: 'https://support.example.com' });

    // A browser cannot resolve `zammad-nginx`, so anything it follows has to
    // carry the public host.
    assert.equal(config.zammadAuthorizeUrl, 'https://support.example.com/oauth/authorize');
    assert.equal(config.zammadPublicTokenUrl, 'https://support.example.com/oauth/token');
    assert.equal(config.zammadPublicRevokeUrl, 'https://support.example.com/oauth/revoke');

    // This server exchanges the code itself and stays on the compose network,
    // which is the whole point of running the two side by side.
    assert.equal(config.zammadTokenUrl, 'http://zammad-nginx:8080/oauth/token');
    assert.equal(config.ZAMMAD_URL, 'http://zammad-nginx:8080');
  });

  it('rejects a public URL that is not a URL', () => {
    assert.throws(() => loadConfig({ ...base, ZAMMAD_PUBLIC_URL: 'support.example.com' }));
  });
});
