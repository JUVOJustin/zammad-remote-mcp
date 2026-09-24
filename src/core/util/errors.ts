/** Raised for any non-2xx response from the Zammad REST API. */
export class ZammadApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(args: { status: number; method: string; path: string; body: unknown; message?: string }) {
    super(args.message ?? `Zammad API ${args.method} ${args.path} failed with HTTP ${args.status}`);
    this.name = 'ZammadApiError';
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.body = args.body;
  }

  /** True when the caller's credentials were rejected — surfaced as a 401 to the MCP client. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * Zammad returns `{"error":"...","error_human":"..."}` for most failures.
   * `error_human` is the message intended for end users, so prefer it.
   */
  get detail(): string {
    const body = this.body;
    if (typeof body === 'string' && body.trim()) return body.slice(0, 2000);
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      const human = rec.error_human ?? rec.error ?? rec.message;
      if (typeof human === 'string' && human.trim()) return human;
      return JSON.stringify(body).slice(0, 2000);
    }
    return this.message;
  }
}

/** Raised when the MCP request carries no usable credential. */
export class MissingCredentialError extends Error {
  constructor(message = 'No Zammad credential available for this request') {
    super(message);
    this.name = 'MissingCredentialError';
  }
}

/** Raised by tool input post-validation that Zod cannot express on its own. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ZammadApiError) {
    const hint =
      error.status === 401
        ? ' — the Zammad access token is missing, expired or revoked; re-authorize the connection.'
        : error.status === 403
          ? ' — the authenticated Zammad user lacks permission for this action.'
          : error.status === 404
            ? ' — the requested record does not exist or is not visible to this user.'
            : error.status === 422
              ? ' — Zammad rejected the payload; check required attributes and their allowed values.'
              : '';
    return `Zammad API error (HTTP ${error.status}) on ${error.method} ${error.path}: ${error.detail}${hint}`;
  }
  if (error instanceof MissingCredentialError || error instanceof ToolInputError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
