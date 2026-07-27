/**
 * Base64 helpers built on Web APIs only.
 *
 * `Buffer` exists on Node and, with `nodejs_compat`, on Workers — but relying on
 * it would tie the core package to a compatibility flag. `atob`/`btoa` and
 * `TextEncoder` are part of the platform everywhere the core is meant to run
 * (Node 18+, workerd, Deno, Bun), so the core needs no polyfill and no flag.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Raw bytes → standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  // `btoa` takes a binary string, so the bytes are widened one char at a time.
  // Chunked to stay clear of the argument limit on large attachments.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** UTF-8 text → standard base64. Used for HTTP basic auth. */
export function textToBase64(value: string): string {
  return bytesToBase64(encoder.encode(value));
}

/** UTF-8 text → base64url (no padding), the encoding used for signed tokens. */
export function textToBase64Url(value: string): string {
  return toBase64Url(textToBase64(value));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return toBase64Url(bytesToBase64(bytes));
}

export function base64UrlToText(value: string): string {
  return decoder.decode(base64ToBytes(fromBase64Url(value)));
}

export function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(fromBase64Url(value));
}

export function textFromBytes(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  return base64 + padding;
}
