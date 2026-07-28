import { serve } from '@hono/node-server';
import { createApp } from '../../src/core/app.js';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/util/logger.js';
import { ADMIN_LOGIN, ADMIN_PASSWORD, BASE_URL, isReachable } from './zammad.js';

/**
 * Drives the MCP server against the Docker Zammad.
 *
 * Tools are called over the real /mcp endpoint rather than by importing their
 * handlers, so schema parsing, name resolution and error mapping are all part
 * of what is under test — the layers where a mistake reaches users.
 */

// biome-ignore lint/suspicious/noExplicitAny: MCP envelopes are asserted field by field.
export type Json = any;

let server: ReturnType<typeof serve> | undefined;
let port = 0;
let reachable: boolean | undefined;

/** False when no instance answers, which is the suites' cue to skip. */
export async function startHarness(): Promise<boolean> {
  if (reachable === undefined) reachable = await isReachable();
  if (!reachable) return false;
  if (server) return true;

  const config = loadConfig({
    ZAMMAD_URL: BASE_URL,
    ZAMMAD_AUTH_MODE: 'basic',
    ZAMMAD_USERNAME: ADMIN_LOGIN,
    ZAMMAD_PASSWORD: ADMIN_PASSWORD,
    LOG_LEVEL: 'silent',
    // Metadata is read back within a run, so cached enums would hide changes.
    METADATA_CACHE_TTL_SECONDS: '0',
  } as NodeJS.ProcessEnv);

  const app = createApp(config, createLogger('silent'));
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
  return true;
}

export async function stopHarness(): Promise<void> {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
}

export const skipReason = `no Zammad on ${BASE_URL} — run npm run zammad:up`;

/** Calls a tool and returns its parsed payload, throwing on a JSON-RPC error. */
export async function callTool(name: string, args: unknown): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim()
    : text;

  const body = JSON.parse(payload ?? '{}');
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);

  const content = body.result?.content?.[0]?.text;
  if (!content) throw new Error(`${name} returned no content: ${JSON.stringify(body).slice(0, 300)}`);

  // Tool errors come back as prose, not JSON. Parsing first would bury the
  // message under a syntax error and make every failure look identical.
  if (body.result.isError) throw new Error(`${name} failed: ${content}`);

  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${name} returned text rather than JSON: ${content.slice(0, 300)}`);
  }
}

/** The tool list as a client receives it, enums and all. */
export async function listTools(): Promise<Json[]> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim()
    : text;
  return JSON.parse(payload ?? '{}').result.tools;
}

/** For the few tools whose payload is prose rather than JSON. */
export async function callToolText(name: string, args: unknown): Promise<string> {
  try {
    const result = await callTool(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const marker = 'returned text rather than JSON: ';
    if (message.includes(marker)) return message.slice(message.indexOf(marker) + marker.length);
    throw error;
  }
}

/** Calls a tool expecting it to fail, and returns the error text. */
export async function callToolExpectingError(name: string, args: unknown): Promise<string> {
  try {
    const result = await callTool(name, args);
    throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(result).slice(0, 200)}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
