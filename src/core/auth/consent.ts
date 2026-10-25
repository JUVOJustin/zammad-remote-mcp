import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import type { Config } from '../config.js';
import type { RegisteredClient } from './clients.js';
import { sealWithExpiry, unsealWithExpiry } from './signing.js';

interface ConsentRequest {
  params: Record<string, string | undefined>;
  nonce: string;
  exp?: number;
}

function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: config.OAUTH_STATE_TTL_SECONDS,
  };
}

export async function consentPage(
  c: Context,
  config: Config,
  client: RegisteredClient,
  redirectUri: string,
  params: Record<string, string | undefined>,
): Promise<Response> {
  const nonce = crypto.randomUUID();
  const token = await sealWithExpiry(
    config.OAUTH_STATE_SECRET!,
    { params, nonce },
    config.OAUTH_STATE_TTL_SECONDS,
    'consent_',
  );
  setCookie(c, `__Host-zmcp-consent-${nonce}`, nonce, cookieOptions(config));
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  return c.html(html`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize Zammad MCP</title><body>
    <main><h1>Connect to Zammad</h1>
    <p><strong>${client.client_name ?? 'MCP client'}</strong> is requesting access to your Zammad account.</p>
    <p>Client identifier: <code>${client.client_id}</code></p>
    <p>Zammad instance: <code>${config.zammadPublicUrl}</code></p>
    <p>Requested permissions: <code>${params.scope || config.ZAMMAD_OAUTH_SCOPES.join(' ')}</code></p>
    <p>Authorization will return to: <code>${redirectUri}</code></p>
    <form method="post" action="/authorize"><input type="hidden" name="consent_request" value="${token}">
    <button name="decision" value="allow" type="submit">Continue to Zammad</button>
    <button name="decision" value="deny" type="submit">Cancel</button></form></main></body></html>`);
}

export async function approvedParams(
  c: Context,
  config: Config,
  token: string,
): Promise<Record<string, string | undefined>> {
  try {
    const request = await unsealWithExpiry<ConsentRequest>(config.OAUTH_STATE_SECRET!, token, 'consent_');
    if (getCookie(c, `__Host-zmcp-consent-${request.nonce}`) !== request.nonce)
      throw new Error('cookie mismatch');
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(config.publicUrl).origin) throw new Error('origin mismatch');
    deleteCookie(c, `__Host-zmcp-consent-${request.nonce}`, cookieOptions(config));
    return request.params;
  } catch {
    throw new OAuthError(
      OAuthErrorCode.InvalidRequest,
      'Consent is invalid or expired. Restart authorization in the same browser.',
    );
  }
}

export function trackUpstreamState(c: Context, config: Config, nonce: string, state: string): void {
  setCookie(c, `__Host-zmcp-state-${nonce}`, state, cookieOptions(config));
}

export function consumeUpstreamState(c: Context, config: Config, nonce: string, state: string): void {
  if (getCookie(c, `__Host-zmcp-state-${nonce}`) !== state) {
    throw new OAuthError(
      OAuthErrorCode.InvalidRequest,
      'OAuth state does not match this browser. Restart authorization.',
    );
  }
  deleteCookie(c, `__Host-zmcp-state-${nonce}`, cookieOptions(config));
}
