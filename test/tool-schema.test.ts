import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../src/core/app.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/util/logger.js';

/**
 * Every tool's input schema must survive a strict JSON Schema validator.
 *
 * MCP clients do not all accept the full JSON Schema vocabulary. Codex and
 * OpenAI-style function calling validate tool schemas against a narrow subset
 * and, when a tool fails, **drop it silently** — no error, the tool is simply
 * absent. `zammad_search_tickets` disappeared from Codex exactly this way,
 * because `z.lazy()` on the recursive selector type emitted
 * `allOf: [{$ref: "#/definitions/…"}]`.
 *
 * Silent removal is the reason these assertions exist: nothing in the server's
 * own behaviour reveals the problem, so it has to be caught here.
 */

let zammad: Server;
let appServer: ReturnType<typeof serve>;
let appPort: number;
let tools: Array<{ name: string; inputSchema: unknown }>;

/** A stub answering only what building the tool list requires. */
function startZammad(): Promise<number> {
  zammad = createServer((req, res) => {
    req.resume();
    const send = (payload: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === '/api/v1/ticket_states') {
      return send([{ id: 2, name: 'open', active: true, state_type: 'open' }]);
    }
    if (path === '/api/v1/ticket_priorities') return send([{ id: 3, name: '3 high', active: true }]);
    if (path === '/api/v1/groups') return send([{ id: 2, name: '1st Level', active: true }]);
    if (path === '/api/v1/macros') return send([{ id: 9, name: 'Close as spam', active: true }]);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  return new Promise((resolve) => {
    zammad.listen(0, '127.0.0.1', () => resolve((zammad.address() as { port: number }).port));
  });
}

before(async () => {
  const zammadPort = await startZammad();
  const config = loadConfig({
    ZAMMAD_URL: `http://127.0.0.1:${zammadPort}`,
    ZAMMAD_AUTH_MODE: 'token',
    ZAMMAD_API_TOKEN: 'stub',
    LOG_LEVEL: 'silent',
    METADATA_CACHE_TTL_SECONDS: '0',
  } as NodeJS.ProcessEnv);

  const app = createApp(config, createLogger('silent'));
  await new Promise<void>((resolve) => {
    appServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      appPort = info.port;
      resolve();
    });
  });

  const response = await fetch(`http://127.0.0.1:${appPort}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  tools = (await response.json()).result.tools;
});

after(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => zammad.close(() => resolve()));
});

/**
 * Keywords whose value is itself a schema, or a container of schemas.
 *
 * Walking blindly over every key confuses values with schemas — `default: true`
 * is a boolean value, not a `true` schema — so traversal follows only these.
 */
const SCHEMA_VALUED = ['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames'] as const;
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'] as const;
const SCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;

type Visitor = (node: Record<string, unknown> | boolean, path: string) => void;

/** Visit every schema node, and only schema nodes. */
function walkSchema(node: unknown, path: string, visit: Visitor): void {
  if (typeof node === 'boolean') {
    visit(node, path);
    return;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;

  const schema = node as Record<string, unknown>;
  visit(schema, path);

  for (const key of SCHEMA_VALUED) {
    if (key in schema) walkSchema(schema[key], `${path}.${key}`, visit);
  }
  // `additionalProperties` is a schema when it is not a boolean.
  if (typeof schema.additionalProperties === 'object') {
    walkSchema(schema.additionalProperties, `${path}.additionalProperties`, visit);
  }
  for (const key of SCHEMA_MAPS) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [name, child] of Object.entries(map)) {
        walkSchema(child, `${path}.${key}.${name}`, visit);
      }
    }
  }
  for (const key of SCHEMA_LISTS) {
    const list = schema[key];
    if (Array.isArray(list)) {
      list.forEach((child, index) => {
        walkSchema(child, `${path}.${key}[${index}]`, visit);
      });
    }
  }
}

/** Paths at which any of `keys` appears as a schema keyword. */
function findKeys(schema: unknown, keys: readonly string[]): string[] {
  const found: string[] = [];
  walkSchema(schema, '$', (node, path) => {
    if (typeof node === 'boolean') return;
    for (const key of keys) if (key in node) found.push(`${path}.${key}`);
  });
  return found;
}

/**
 * Sub-schemas that constrain nothing (`{}` or `true`). They mean "any value",
 * which tells a model nothing and which strict validators reject.
 */
function findEmptySchemas(schema: unknown): string[] {
  const found: string[] = [];
  walkSchema(schema, '$', (node, path) => {
    if (node === true) {
      found.push(path);
      return;
    }
    if (typeof node === 'object' && Object.keys(node).length === 0) found.push(path);
  });
  return found;
}

describe('tool input schemas stay portable across MCP clients', () => {
  it('exposes every tool, including the search tools', () => {
    const names = tools.map((t) => t.name);
    for (const expected of [
      'zammad_search_tickets',
      'zammad_search_users',
      'zammad_search_organizations',
      'zammad_search_global',
    ]) {
      assert.ok(names.includes(expected), `${expected} is missing from tools/list`);
    }
    assert.ok(tools.length >= 35, `expected the full tool set, got ${tools.length}`);
  });

  it('uses no $ref, definitions or $defs anywhere', () => {
    // A recursive zod schema (z.lazy) is the way these reappear.
    for (const tool of tools) {
      const hits = findKeys(tool.inputSchema, ['$ref', 'definitions', '$defs']);
      assert.deepEqual(hits, [], `${tool.name} emits ${hits.join(', ')} — inline the schema instead`);
    }
  });

  it('uses no allOf or oneOf', () => {
    // anyOf is fine and is what zod unions produce; allOf/oneOf are not part of
    // the subset the strict validators accept.
    for (const tool of tools) {
      const hits = findKeys(tool.inputSchema, ['allOf', 'oneOf']);
      assert.deepEqual(hits, [], `${tool.name} emits ${hits.join(', ')}`);
    }
  });

  it('constrains every sub-schema', () => {
    // z.unknown() / z.any() produce `{}`, which means "anything".
    for (const tool of tools) {
      const hits = findEmptySchemas(tool.inputSchema);
      assert.deepEqual(hits, [], `${tool.name} has unconstrained sub-schemas at ${hits.join(', ')}`);
    }
  });

  it('declares an object schema with a properties map', () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string; properties?: unknown };
      assert.equal(schema.type, 'object', `${tool.name} must take an object`);
      assert.ok(schema.properties !== undefined, `${tool.name} must declare properties`);
    }
  });

  it('keeps each schema small enough to send to a model', () => {
    // Not a hard protocol limit, but tool lists are sent on every request and
    // some clients cap them. The search schema is the one that grows.
    for (const tool of tools) {
      const size = JSON.stringify(tool.inputSchema).length;
      assert.ok(size < 64 * 1024, `${tool.name} schema is ${(size / 1024).toFixed(1)} KB`);
    }

    const total = JSON.stringify(tools).length;
    assert.ok(total < 256 * 1024, `the whole tool list is ${(total / 1024).toFixed(1)} KB`);
  });

  it('names and describes every tool', () => {
    for (const tool of tools) {
      const t = tool as { name: string; description?: string };
      assert.match(t.name, /^zammad_[a-z0-9_]+$/, `${t.name} is not a plain snake_case tool name`);
      assert.ok((t.description?.length ?? 0) > 40, `${t.name} needs a usable description`);
    }
  });
});
