#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { bootstrap } from '@zammad-mcp/core';
import { loadEnvFile } from './env-file.js';

/**
 * Node.js host.
 *
 * Everything specific to Node lives here and nowhere else: reading a `.env` from
 * disk, binding a socket, handling signals. The server itself comes from
 * `@zammad-mcp/core` and is the same code the Cloudflare Worker runs.
 */
async function main(): Promise<void> {
  // Before configuration is read, so a `.env` can satisfy required settings.
  // Real environment variables still take precedence over the file.
  const envFile = loadEnvFile(process.env.ENV_FILE);
  if (envFile.status === 'failed') {
    process.stderr.write(`Could not read env file ${envFile.path}: ${envFile.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (envFile.status === 'unsupported') {
    process.stderr.write(
      `Found ${envFile.path} but this Node build has no process.loadEnvFile (needs >= 20.12; running ${process.version}).\n` +
        'Upgrade Node, or export the variables into the environment instead.\n',
    );
    process.exitCode = 1;
    return;
  }

  let started: ReturnType<typeof bootstrap>;
  try {
    started = bootstrap({ env: process.env });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(
      envFile.status === 'loaded'
        ? `Values were read from ${envFile.path} (real environment variables override it).\n`
        : `No env file was loaded — looked for ${envFile.path}. Create one from .env.example, ` +
            'point ENV_FILE at another path, or export the variables directly.\n',
    );
    process.stderr.write('See .env.example for the full list of settings.\n');
    process.exitCode = 1;
    return;
  }

  const { config, fetch } = started;

  const log = (msg: string, meta: Record<string, unknown> = {}) => {
    const record = { time: new Date().toISOString(), level: 'info', msg, service: 'zammad-remote-mcp', meta };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  };

  if (envFile.status === 'loaded') log('loaded env file', { path: envFile.path });

  const server = serve({ fetch, hostname: config.HOST, port: config.PORT }, (info) => {
    log('zammad remote mcp server listening', {
      address: `http://${config.HOST}:${info.port}`,
      public_url: config.publicUrl,
      mcp_endpoint: `${config.publicUrl}${config.MCP_PATH}`,
      zammad_url: config.ZAMMAD_URL,
      auth_mode: config.ZAMMAD_AUTH_MODE,
      oauth_mode: config.ZAMMAD_OAUTH_MODE,
      stateless: true,
    });

    if (config.ZAMMAD_OAUTH_MODE === 'proxy') {
      log('register this callback URL in Zammad: admin panel → System → API → Applications → New', {
        callback_url: config.oauthCallbackUrl,
      });
    }
  });

  // Without this, a bind failure surfaces as an unhandled 'error' event and a
  // raw stack trace. The two that actually happen deserve a plain sentence.
  server.on('error', (error: NodeJS.ErrnoException) => {
    const address = `${config.HOST}:${config.PORT}`;
    const message =
      error.code === 'EADDRINUSE'
        ? `Port ${config.PORT} is already in use — another process is bound to ${address}. ` +
          'Stop it, or start this one with a different PORT.'
        : error.code === 'EACCES'
          ? `Not permitted to bind ${address}. Ports below 1024 need elevated privileges; pick a higher PORT.`
          : `Server error: ${error.message}`;

    process.stderr.write(`${JSON.stringify({ level: 'error', msg: message, code: error.code })}\n`);
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log('shutting down', { signal });
    server.close(() => process.exit(0));
    // Do not let a hung connection block the exit indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
