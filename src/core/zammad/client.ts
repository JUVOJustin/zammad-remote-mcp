import type { Config } from '../config.js';
import { textToBase64 } from '../util/base64.js';
import { MissingCredentialError, ZammadApiError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Query;
  body?: unknown;
  /** Return the raw Response instead of parsed JSON (used for attachments). */
  raw?: boolean;
  signal?: AbortSignal;
}

/**
 * The credential used for a single MCP request.
 *
 * In `oauth` mode this is derived from the incoming `Authorization` header, so
 * nothing is retained between requests — that is the core of the stateless
 * design. In `token`/`basic` mode it is derived from the process environment.
 */
export type Credential =
  | { kind: 'bearer'; token: string }
  | { kind: 'token'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'none' };

export function credentialHeader(credential: Credential): string | undefined {
  switch (credential.kind) {
    case 'bearer':
      return `Bearer ${credential.token}`;
    case 'token':
      // Zammad's token scheme, see docs.zammad.org/en/latest/api/intro.html
      return `Token token=${credential.token}`;
    case 'basic':
      return `Basic ${textToBase64(`${credential.username}:${credential.password}`)}`;
    case 'none':
      return undefined;
  }
}

/** Stable, non-reversible cache key for a credential (never log the token itself). */
export function credentialFingerprint(credential: Credential): string {
  const header = credentialHeader(credential) ?? 'anonymous';
  let hash = 0x811c9dc5;
  for (let i = 0; i < header.length; i++) {
    hash ^= header.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface ZammadClientOptions {
  config: Config;
  credential: Credential;
  logger: Logger;
  /** Zammad's X-On-Behalf-Of header — act as another user (requires admin rights). */
  onBehalfOf?: string;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export class ZammadClient {
  private readonly config: Config;
  private readonly credential: Credential;
  private readonly logger: Logger;
  private readonly onBehalfOf?: string;

  constructor(options: ZammadClientOptions) {
    this.config = options.config;
    this.credential = options.credential;
    this.logger = options.logger;
    this.onBehalfOf = options.onBehalfOf;
  }

  get baseUrl(): string {
    return this.config.ZAMMAD_URL;
  }

  get fingerprint(): string {
    return credentialFingerprint(this.credential);
  }

  /** A clone that impersonates a different Zammad user for the next calls. */
  withOnBehalfOf(user: string | undefined): ZammadClient {
    if (!user) return this;
    return new ZammadClient({
      config: this.config,
      credential: this.credential,
      logger: this.logger,
      onBehalfOf: user,
    });
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const authorization = credentialHeader(this.credential);
    if (!authorization) {
      throw new MissingCredentialError(
        'No Zammad credential for this request. In ZAMMAD_AUTH_MODE=oauth the MCP client must send ' +
          'an `Authorization: Bearer <zammad access token>` header.',
      );
    }

    const method = options.method ?? 'GET';
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: authorization,
      Accept: 'application/json',
      'User-Agent': 'zammad-remote-mcp/1.0',
    };
    if (this.onBehalfOf) headers['X-On-Behalf-Of'] = this.onBehalfOf;
    // Zammad requires application/json on every request that carries data.
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.ZAMMAD_MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      const timeout = AbortSignal.timeout(this.config.ZAMMAD_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
          redirect: 'follow',
        });
      } catch (error) {
        lastError = error;
        // A caller-initiated abort must not be retried.
        if (options.signal?.aborted) throw error;
        this.logger.warn('zammad request failed, retrying', {
          method,
          path,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (response.ok) {
        if (options.raw) return response as T;
        if (response.status === 204) return undefined as T;
        return (await parseJson(response)) as T;
      }

      const shouldRetry = RETRYABLE_STATUS.has(response.status) && attempt < this.config.ZAMMAD_MAX_RETRIES;
      if (shouldRetry) {
        const retryAfter = Number(response.headers.get('retry-after'));
        // Drain the body so the socket can be reused.
        await response.text().catch(() => undefined);
        if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 10_000));
        this.logger.warn('zammad request rate-limited or unavailable, retrying', {
          method,
          path,
          status: response.status,
          attempt,
        });
        continue;
      }

      throw new ZammadApiError({
        status: response.status,
        method,
        path,
        body: await parseJson(response).catch(() => undefined),
      });
    }

    throw new ZammadApiError({
      status: 599,
      method,
      path,
      body: lastError instanceof Error ? lastError.message : String(lastError),
      message: `Zammad API ${method} ${path} unreachable after ${this.config.ZAMMAD_MAX_RETRIES + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    });
  }

  get<T = unknown>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: 'GET', query, signal });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, query, signal });
  }

  put<T = unknown>(path: string, body?: unknown, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body, query, signal });
  }

  delete<T = unknown>(path: string, query?: Query, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: 'DELETE', query, body, signal });
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.config.ZAMMAD_URL}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          // Rails parses repeated `key[]` params into an array.
          for (const item of value) url.searchParams.append(`${key}[]`, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function backoffMs(attempt: number): number {
  // Exponential with jitter: ~250ms, ~500ms, ~1s …
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.random() * base * 0.5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
