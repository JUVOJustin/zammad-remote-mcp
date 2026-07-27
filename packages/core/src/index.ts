/**
 * Public surface of the runtime-agnostic core.
 *
 * Everything a host package needs is here: build a `Config` from a plain
 * environment record, build a Hono app from it, and serve `app.fetch`. The core
 * imports no Node built-ins — only WebCrypto, `fetch`, `TextEncoder` and
 * `atob`/`btoa` — so the Node and Cloudflare packages differ only in how they
 * obtain the environment and how they hand the app to a listener.
 */

export { createApp } from './app.js';
export type { Config, Env, EnvSource, OAuthMode } from './config.js';
export { loadConfig } from './config.js';
export { createMcpServer } from './mcp/server.js';
export { describeError, MissingCredentialError, ToolInputError, ZammadApiError } from './util/errors.js';
export type { Logger, LogSink } from './util/logger.js';
export { createLogger } from './util/logger.js';
export type { Credential } from './zammad/client.js';
export { clearLookupCache } from './zammad/lookup.js';

/**
 * Convenience wrapper for a host that just wants a `fetch` handler.
 *
 * Both runtime packages use this, which is why neither needs to know anything
 * about how the app is assembled.
 */
import { createApp } from './app.js';
import { type Config, loadConfig } from './config.js';
import { createLogger, type LogSink } from './util/logger.js';

export interface BootstrapOptions {
  /** Environment source: `process.env` on Node, the `env` binding on Workers. */
  env: Record<string, string | undefined>;
  /** Override where log lines go. Defaults to `console.error`. */
  sink?: LogSink;
}

export interface Bootstrapped {
  config: Config;
  fetch: (request: Request) => Response | Promise<Response>;
}

export function bootstrap(options: BootstrapOptions): Bootstrapped {
  const config = loadConfig(options.env);
  const logger = createLogger(config.LOG_LEVEL, { service: 'zammad-remote-mcp' }, options.sink);
  const app = createApp(config, logger);
  return { config, fetch: app.fetch };
}
