import { base64UrlToBytes, base64UrlToText, bytesToBase64Url, textToBase64Url } from '../util/base64.js';

/**
 * Compact HMAC-signed payloads (`<base64url(json)>.<base64url(sig)>`).
 *
 * These are what keep the OAuth proxy stateless: instead of persisting
 * registered clients and in-flight authorization requests in a database, the
 * data is carried inside the `client_id` and the upstream `state` parameter and
 * verified on the way back. Any replica holding the same OAUTH_STATE_SECRET can
 * therefore serve any leg of the flow.
 *
 * Built on WebCrypto rather than `node:crypto`, which is what lets the core run
 * unchanged on Node and on edge runtimes. The cost is that signing is async —
 * every call site is already in an async path, so that stays invisible.
 */

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

const encoder = new TextEncoder();

/**
 * Imported HMAC keys, cached by secret. Key import is pure computation over a
 * value that never changes at runtime, so this is memoisation rather than state.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    keyCache.set(secret, key);
  }
  return key;
}

async function sign(secret: string, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(payload) as BufferSource,
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function seal(secret: string, data: unknown, prefix = ''): Promise<string> {
  const payload = textToBase64Url(JSON.stringify(data));
  return `${prefix}${payload}.${await sign(secret, payload)}`;
}

export async function unseal<T>(secret: string, token: string, prefix = ''): Promise<T> {
  if (prefix && !token.startsWith(prefix)) {
    throw new SignatureError('Token has an unexpected prefix');
  }
  const body = prefix ? token.slice(prefix.length) : token;
  const separator = body.lastIndexOf('.');
  if (separator <= 0) throw new SignatureError('Token is malformed');

  const payload = body.slice(0, separator);
  const signature = body.slice(separator + 1);

  let valid = false;
  try {
    // `crypto.subtle.verify` compares in constant time, so no separate
    // timing-safe comparison is needed.
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64UrlToBytes(signature) as BufferSource,
      encoder.encode(payload) as BufferSource,
    );
  } catch {
    // A signature that is not even valid base64 is simply not a valid signature.
    throw new SignatureError('Token signature does not verify');
  }
  if (!valid) throw new SignatureError('Token signature does not verify');

  try {
    return JSON.parse(base64UrlToText(payload)) as T;
  } catch {
    throw new SignatureError('Token payload is not valid JSON');
  }
}

/** Seal with an embedded expiry (seconds since epoch). */
export function sealWithExpiry(
  secret: string,
  data: object,
  ttlSeconds: number,
  prefix = '',
): Promise<string> {
  return seal(secret, { ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds }, prefix);
}

export async function unsealWithExpiry<T extends { exp?: number }>(
  secret: string,
  token: string,
  prefix = '',
): Promise<T> {
  const data = await unseal<T>(secret, token, prefix);
  if (typeof data.exp !== 'number' || data.exp <= Math.floor(Date.now() / 1000)) {
    throw new SignatureError('Token has expired');
  }
  return data;
}

const cipherKeys = new Map<string, Promise<CryptoKey>>();

function cipherKey(secret: string): Promise<CryptoKey> {
  let key = cipherKeys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', encoder.encode(secret) as BufferSource, 'HKDF', false, ['deriveKey'])
      .then((material) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: encoder.encode('zammad-remote-mcp/oauth/v1') as BufferSource,
            info: encoder.encode('credential-encryption') as BufferSource,
          },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    cipherKeys.set(secret, key);
  }
  return key;
}

// Upstream credentials must stay confidential even when the envelope is held by an MCP client.
// The context binds ciphertext to its purpose and deployment, independently of its contents.
export async function encrypt(secret: string, data: unknown, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) as BufferSource },
    await cipherKey(secret),
    encoder.encode(JSON.stringify(data)) as BufferSource,
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decrypt(secret: string, token: string, context: string): Promise<unknown> {
  try {
    const [iv, payload, extra] = token.split('.');
    if (!iv || !payload || extra !== undefined) throw new Error('malformed');
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(iv) as BufferSource,
        additionalData: encoder.encode(context) as BufferSource,
      },
      await cipherKey(secret),
      base64UrlToBytes(payload) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new SignatureError('Credential is invalid or belongs to another deployment');
  }
}
