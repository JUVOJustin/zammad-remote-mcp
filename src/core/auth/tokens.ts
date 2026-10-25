import { OAuthError, OAuthErrorCode, type OAuthTokens } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Config } from '../config.js';
import { decrypt, encrypt } from './signing.js';

const GrantSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  resource: z.string().min(1),
  scope: z.string(),
});

const CredentialSchema = GrantSchema.extend({
  upstream: z.string().min(1),
  exp: z.number().int().positive(),
});

export type OAuthGrant = z.infer<typeof GrantSchema>;
type ProxyCredential = z.infer<typeof CredentialSchema>;
type CredentialKind = 'code' | 'access' | 'refresh';

export function requireResource(config: Config, resource: string | undefined): void {
  if (resource === undefined) return; // Older clients omit RFC 8707; their grants still use our sole audience.
  try {
    const url = new URL(resource);
    if (!url.hash && !url.username && !url.password && url.href === new URL(config.resourceIdentifier).href) {
      return;
    }
  } catch {
    // Use the same OAuth error for malformed and foreign resource identifiers.
  }
  throw new OAuthError(OAuthErrorCode.InvalidRequest, 'resource must identify this MCP endpoint.');
}

export async function issueCredential(
  config: Config,
  kind: CredentialKind,
  grant: OAuthGrant,
  upstream: string,
  ttl: number,
): Promise<string> {
  return `zmcp_${kind}_${await encrypt(
    config.OAUTH_STATE_SECRET!,
    { ...grant, upstream, exp: Math.floor(Date.now() / 1000) + ttl },
    `${config.resourceIdentifier}:${kind}`,
  )}`;
}

export async function readCredential(
  config: Config,
  kind: CredentialKind,
  token: string,
  clientId?: string,
): Promise<ProxyCredential> {
  try {
    const prefix = `zmcp_${kind}_`;
    if (!token.startsWith(prefix)) throw new Error('wrong credential type');
    const payload = CredentialSchema.parse(
      await decrypt(
        config.OAUTH_STATE_SECRET!,
        token.slice(prefix.length),
        `${config.resourceIdentifier}:${kind}`,
      ),
    );
    if (
      payload.resource !== config.resourceIdentifier ||
      payload.exp <= Math.floor(Date.now() / 1000) ||
      (clientId !== undefined && payload.client_id !== clientId)
    ) {
      throw new Error('invalid binding or expiry');
    }
    return payload;
  } catch {
    throw new OAuthError(
      kind === 'access' ? OAuthErrorCode.InvalidToken : OAuthErrorCode.InvalidGrant,
      'The credential is invalid, expired, or was issued for another client or MCP server. Authorize again.',
    );
  }
}

export async function issueTokens(
  config: Config,
  grant: OAuthGrant,
  upstream: OAuthTokens,
): Promise<OAuthTokens> {
  const ttl = Math.min(
    upstream.expires_in ?? config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  );
  const scope = upstream.scope ?? grant.scope;
  if (scope.split(' ').some((value) => value && !grant.scope.split(' ').includes(value))) {
    throw new OAuthError(OAuthErrorCode.ServerError, 'Zammad returned scopes outside the authorized grant.');
  }
  const bound = { ...grant, scope };
  return {
    token_type: 'Bearer',
    access_token: await issueCredential(config, 'access', bound, upstream.access_token, ttl),
    expires_in: ttl,
    scope,
    ...(upstream.refresh_token
      ? {
          refresh_token: await issueCredential(
            config,
            'refresh',
            bound,
            upstream.refresh_token,
            config.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
          ),
        }
      : {}),
  };
}
