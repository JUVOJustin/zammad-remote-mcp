import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  callTool,
  callToolExpectingError,
  listTools,
  skipReason,
  startHarness,
  stopHarness,
} from './harness.js';
import { CUSTOMER_EMAIL } from './zammad.js';

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

let tools: Array<{ name: string; inputSchema: unknown }>;
let ready = false;

/**
 * The schemas are read off the running Docker instance, not off a stand-in.
 *
 * That matters here more than anywhere: the enums in these schemas are built
 * from the instance's own states, priorities, groups and macros, so a stub would
 * be validating shapes derived from values a stub invented. What a client
 * actually receives is what has to survive the validator.
 */
before(async () => {
  ready = await startHarness();
  if (!ready) return;
  tools = (await listTools()) as Array<{ name: string; inputSchema: unknown }>;
});

after(stopHarness);

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
  it('exposes every tool, including the search tools', (t) => {
    if (!ready) return t.skip(skipReason);
    const names = tools.map((t) => t.name);
    for (const expected of ['zammad_search_tickets', 'zammad_search_users', 'zammad_search_organizations']) {
      assert.ok(names.includes(expected), `${expected} is missing from tools/list`);
    }
    assert.ok(tools.length >= 35, `expected the full tool set, got ${tools.length}`);
  });

  it('uses no $ref, definitions or $defs anywhere', (t) => {
    if (!ready) return t.skip(skipReason);
    // A recursive zod schema (z.lazy) is the way these reappear.
    for (const tool of tools) {
      const hits = findKeys(tool.inputSchema, ['$ref', 'definitions', '$defs']);
      assert.deepEqual(hits, [], `${tool.name} emits ${hits.join(', ')} — inline the schema instead`);
    }
  });

  it('uses no allOf or oneOf', (t) => {
    if (!ready) return t.skip(skipReason);
    // anyOf is fine and is what zod unions produce; allOf/oneOf are not part of
    // the subset the strict validators accept.
    for (const tool of tools) {
      const hits = findKeys(tool.inputSchema, ['allOf', 'oneOf']);
      assert.deepEqual(hits, [], `${tool.name} emits ${hits.join(', ')}`);
    }
  });

  it('avoids the keywords observed to get a tool dropped', (t) => {
    if (!ready) return t.skip(skipReason);
    // A denylist, not an allowlist, and every entry is grounded:
    //
    //  $ref/definitions/$defs/allOf — the three search tools vanished from Codex
    //    while z.lazy() emitted `allOf: [{$ref: '#/definitions/…'}]`.
    //  pattern — after that was fixed zammad_search_tickets was still missing,
    //    and `pattern` was the only remaining keyword present in it and absent
    //    from the two search tools Codex did accept.
    //  oneOf — never observed, listed with allOf because zod has no reason to
    //    emit it and its appearance would mean something unexpected changed.
    //
    // Keywords the accepted tools demonstrably use — propertyNames, const,
    // maxItems, minItems, minLength, enum, anyOf — are deliberately not here.
    const denied = ['$ref', 'definitions', '$defs', 'allOf', 'oneOf', 'pattern'];

    for (const tool of tools) {
      const hits = findKeys(tool.inputSchema, denied);
      assert.deepEqual(hits, [], `${tool.name} uses ${hits.join(', ')}`);
    }
  });

  it('never renders items as an array', (t) => {
    if (!ready) return t.skip(skipReason);
    // z.tuple() emits `items: [schema, schema]`, which is invalid in JSON Schema
    // 2020-12 — that is `prefixItems` — and gets the tool discarded.
    for (const tool of tools) {
      const offenders: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((item, i) => {
            walk(item, `${path}[${i}]`);
          });
          return;
        }
        for (const [key, value] of Object.entries(node)) {
          if (key === 'items' && Array.isArray(value)) offenders.push(`${path}.items`);
          walk(value, `${path}.${key}`);
        }
      };
      walk(tool.inputSchema, '$');
      assert.deepEqual(offenders, [], `${tool.name} has tuple-form items at ${offenders.join(', ')}`);
    }
  });

  it('keeps the property count within reach of the tools clients accept', (t) => {
    if (!ready) return t.skip(skipReason);
    // No published limit to cite, but zammad_search_users (75 properties) is
    // accepted where the far larger ticket search was not, so runaway growth is
    // a plausible second cause and worth bounding.
    const countProperties = (node: unknown): number => {
      if (!node || typeof node !== 'object') return 0;
      if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + countProperties(item), 0);

      const schema = node as Record<string, unknown>;
      let total = 0;
      if (schema.properties && typeof schema.properties === 'object') {
        const properties = schema.properties as Record<string, unknown>;
        total += Object.keys(properties).length;
        for (const value of Object.values(properties)) total += countProperties(value);
      }
      if (schema.items) total += countProperties(schema.items);
      for (const key of ['anyOf', 'oneOf']) {
        if (Array.isArray(schema[key])) total += countProperties(schema[key]);
      }
      return total;
    };

    for (const tool of tools) {
      const total = countProperties(tool.inputSchema);
      assert.ok(total <= 200, `${tool.name} declares ${total} properties`);
    }
  });

  it('constrains every sub-schema', (t) => {
    if (!ready) return t.skip(skipReason);
    // z.unknown() / z.any() produce `{}`, which means "anything".
    for (const tool of tools) {
      const hits = findEmptySchemas(tool.inputSchema);
      assert.deepEqual(hits, [], `${tool.name} has unconstrained sub-schemas at ${hits.join(', ')}`);
    }
  });

  it('declares an object schema with a properties map', (t) => {
    if (!ready) return t.skip(skipReason);
    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string; properties?: unknown };
      assert.equal(schema.type, 'object', `${tool.name} must take an object`);
      assert.ok(schema.properties !== undefined, `${tool.name} must declare properties`);
    }
  });

  it('keeps each schema small enough to send to a model', (t) => {
    if (!ready) return t.skip(skipReason);
    // Not a hard protocol limit, but tool lists are sent on every request and
    // some clients cap them. The search schema is the one that grows.
    for (const tool of tools) {
      const size = JSON.stringify(tool.inputSchema).length;
      assert.ok(size < 64 * 1024, `${tool.name} schema is ${(size / 1024).toFixed(1)} KB`);
    }

    const total = JSON.stringify(tools).length;
    assert.ok(total < 256 * 1024, `the whole tool list is ${(total / 1024).toFixed(1)} KB`);
  });

  it('names and describes every tool', (t) => {
    if (!ready) return t.skip(skipReason);
    for (const tool of tools) {
      const t = tool as { name: string; description?: string };
      assert.match(t.name, /^zammad_[a-z0-9_]+$/, `${t.name} is not a plain snake_case tool name`);
      assert.ok((t.description?.length ?? 0) > 40, `${t.name} needs a usable description`);
    }
  });
});

describe('every tool refuses arguments nobody declared', () => {
  /**
   * All of them, without exception.
   *
   * The MCP SDK runs `safeParseAsync` over the arguments before the handler is
   * invoked, and a permissive object simply *drops* what it does not recognise —
   * so a caller that misspells an argument, or reaches for one that was removed,
   * is told the call succeeded and never learns its intent was discarded. That
   * is the same shape of failure as an argument Zammad itself ignores, and it is
   * only catchable here: a handler cannot check for a key the parser deleted.
   *
   * The tools carrying Object Manager passthrough are strict too. Their dynamic
   * data lives in *declared* fields — `custom_fields` is a record, `custom` an
   * array of conditions, `raw_condition` a nested selector — none of which a
   * strict outer object touches. The two tests below hold that apart, because
   * "strict" and "takes arbitrary attribute names" sound contradictory and are
   * not.
   */
  it('publishes additionalProperties: false on every tool', (t) => {
    if (!ready) return t.skip(skipReason);

    for (const tool of tools) {
      const schema = tool.inputSchema as { additionalProperties?: unknown };
      assert.equal(schema.additionalProperties, false, `${tool.name} still accepts unknown arguments`);
    }
  });

  it('refuses an unknown argument by name rather than dropping it', async (t) => {
    if (!ready) return t.skip(skipReason);

    // A typo, which is the case that matters: near-miss keys are what a caller
    // actually produces, and a silent drop reads as success.
    assert.match(
      await callToolExpectingError('zammad_get_ticket', { ticket_id: 1, artikel_limit: 5 }),
      /artikel_limit/,
    );
    assert.match(
      await callToolExpectingError('zammad_search_tickets', { stat: ['open'], output: 'count' }),
      /stat/,
    );
  });

  it('still takes Object Manager attributes by arbitrary name', async (t) => {
    if (!ready) return t.skip(skipReason);

    // `custom_fields` is a record: its *keys* are whatever the instance defines,
    // and a strict outer object has no opinion about them.
    const created = await callTool('zammad_create_ticket', {
      title: 'Strict with custom fields',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      custom_fields: { an_attribute_this_instance_does_not_have: 'value' },
      article: { body: 'x', type: 'note', internal: true },
    });
    assert.ok(created.ticket.id, 'a declared record field was refused');
  });

  it('still takes a raw selector as an escape hatch', async (t) => {
    if (!ready) return t.skip(skipReason);

    const result = await callTool('zammad_search_tickets', {
      raw_condition: {
        operator: 'AND',
        conditions: [{ name: 'ticket.state_id', operator: 'is', value: [2] }],
      },
      output: 'count',
    });
    assert.equal(typeof result.total_count, 'number', 'the escape hatch was refused');
  });

  it('still takes the arguments it declares', async (t) => {
    if (!ready) return t.skip(skipReason);

    // Strictness must not have cost a real argument on the way in.
    assert.ok(await callTool('zammad_get_recent_tickets', { limit: 3 }));
  });

  it('is strict at every level, not only at the top', async (t) => {
    if (!ready) return t.skip(skipReason);

    // 2.0.0 made the tools strict and stopped at their outermost object, which
    // left `article` and `attachments` dropping what they did not recognise —
    // the very keys where dropping one is worst. `internal` misspelled inside
    // `article` publishes to the customer and reports success.
    //
    // A map whose `additionalProperties` is itself a schema is open on purpose
    // (`custom_fields` keys are the instance's own attribute names), so it is
    // the boolean `false` that is asserted, not mere presence.
    const open: string[] = [];
    const walk = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object') return;
      const node = schema as Record<string, unknown>;
      const properties = node.properties as Record<string, unknown> | undefined;
      if (properties) {
        if (node.additionalProperties !== false) open.push(path);
        for (const [key, value] of Object.entries(properties)) walk(value, `${path}.${key}`);
      }
      if (node.items) walk(node.items, `${path}[]`);
      for (const branch of (node.anyOf as unknown[]) ?? []) walk(branch, `${path}|`);
    };

    for (const tool of tools) walk(tool.inputSchema, tool.name);
    assert.deepEqual(open, [], `these objects still drop unknown keys: ${open.join(', ')}`);
  });

  it('names a misspelled key inside a nested article', async (t) => {
    if (!ready) return t.skip(skipReason);

    // The failure this exists for, end to end: `internl` is not `internal`, and
    // the default is to hide the article. Dropped, it would have been published.
    const message = await callToolExpectingError('zammad_create_ticket', {
      title: 'Misspelled internal',
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: { body: 'x', type: 'note', internl: false },
    });
    assert.match(message, /internl/, message);
  });
});
