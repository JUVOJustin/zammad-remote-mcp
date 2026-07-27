import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clearLookupCache } from '../../zammad/lookup.js';
import type { ToolContext } from '../context.js';
import { compact, guard, jsonResult, summarizeOrganization, summarizeUser, textResult } from '../result.js';

/**
 * Lookup tools for the things that *cannot* be baked into a tool schema.
 *
 * States, priorities, groups and macros are closed sets that this server reads
 * from the instance and folds into the tool schemas as enums (see
 * `zammad/vocabulary.ts`), so the discovery tools that used to list them are
 * gone — the values are already in front of the model.
 *
 * What remains here is what genuinely resists that treatment:
 *  - identity and permissions (`whoami`), which govern what is visible at all;
 *  - users and organizations, which are unbounded;
 *  - tags, which are open-ended and whose full list is admin-only;
 *  - Object Manager attributes, which Zammad exposes only to admin credentials,
 *    so neither the model nor this server can enumerate them from an agent token.
 */
export function registerMetadataTools(server: McpServer, base: ToolContext): void {
  server.registerTool(
    'zammad_whoami',
    {
      title: 'Show the authenticated Zammad user',
      description:
        'Identity and permissions behind the current credential. Call this first when it matters whether the ' +
        'caller is an agent or a customer — visibility of tickets differs sharply between the two.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const me = await base.client.get<Record<string, unknown>>('/api/v1/users/me');
      return jsonResult({
        user: summarizeUser(me),
        role_ids: me.role_ids,
        group_ids: me.group_ids,
        permissions: me.permissions,
      });
    }),
  );

  server.registerTool(
    'zammad_get_user',
    {
      title: 'Get a Zammad user',
      description: 'Fetch one user by ID, login or email address.',
      inputSchema: {
        user: z.union([z.string().min(1), z.number().int().positive()]).describe('User ID, login or email.'),
        output: z.enum(['summary', 'full']).default('summary'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = z
        .object({
          user: z.union([z.string().min(1), z.number().int().positive()]),
          output: z.enum(['summary', 'full']).default('summary'),
        })
        .parse(rawInput);

      const id = (await base.lookup.resolveUsers([input.user]))[0]!;
      const user = await base.client.get<Record<string, unknown>>(`/api/v1/users/${id}`, { expand: true });
      return jsonResult(input.output === 'full' ? user : summarizeUser(user));
    }),
  );

  server.registerTool(
    'zammad_get_organization',
    {
      title: 'Get a Zammad organization',
      description: 'Fetch one organization by ID or exact name, including its members.',
      inputSchema: {
        organization: z.union([z.string().min(1), z.number().int().positive()]),
        output: z.enum(['summary', 'full']).default('summary'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = z
        .object({
          organization: z.union([z.string().min(1), z.number().int().positive()]),
          output: z.enum(['summary', 'full']).default('summary'),
        })
        .parse(rawInput);

      const id = (await base.lookup.resolveOrganizations([input.organization]))[0]!;
      const org = await base.client.get<Record<string, unknown>>(`/api/v1/organizations/${id}`, {
        expand: true,
      });
      return jsonResult(input.output === 'full' ? org : summarizeOrganization(org));
    }),
  );

  server.registerTool(
    'zammad_list_tags',
    {
      title: 'Search the Zammad tag list',
      description:
        'Find existing tags by prefix — worth doing before tagging so spellings stay consistent. Tags are ' +
        'open-ended and can be created on the fly, so unlike states or groups they are not part of the tool ' +
        'schemas and have to be looked up.',
      inputSchema: {
        term: z
          .string()
          .min(1)
          .describe('Prefix to search for. Zammad has no agent-readable endpoint for the complete tag list.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const { term } = z.object({ term: z.string().min(1) }).parse(rawInput);
      // `/api/v1/tag_list` is the admin CRUD endpoint and 403s for agent tokens;
      // `tag_search` is the one agents may call.
      const tags = await base.client.get<unknown>('/api/v1/tag_search', { term });
      return jsonResult({ tags });
    }),
  );

  server.registerTool(
    'zammad_list_overviews',
    {
      title: 'List Zammad overviews',
      description:
        'The saved ticket overviews visible to the user (e.g. "My Assigned Tickets", "Unassigned & Open"), with ' +
        'the number of tickets in each. Overviews are a good starting point for "what should I work on" questions.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      // `/api/v1/overviews` is admin CRUD and 403s for an agent token. The
      // agent-facing endpoint is `/api/v1/ticket_overviews` (plural) called
      // *without* a `view` parameter — `TicketOverviewsController#show` then
      // returns the navbar list with each overview's ticket count. Note the
      // singular `/api/v1/ticket_overview` is a different action entirely: it
      // serves bulk-edit form metadata, not overviews.
      const response = await base.client.get<Array<Record<string, unknown>>>('/api/v1/ticket_overviews');
      const rows = Array.isArray(response) ? response : [];

      return jsonResult({
        overviews: rows.map((o) =>
          compact({ id: o.id, name: o.name, link: o.link, ticket_count: o.count, prio: o.prio }),
        ),
        note: 'The selector behind an overview is only readable with admin rights; use zammad_search_tickets to filter directly.',
      });
    }),
  );

  server.registerTool(
    'zammad_list_custom_attributes',
    {
      title: 'List Zammad Object Manager attributes',
      description:
        'The custom fields defined on tickets, users or organizations. Use the returned `name` values with the ' +
        '`custom` filter in zammad_search_tickets and with `custom_fields` when creating or updating tickets.\n\n' +
        'Requires an admin-level credential: Zammad only exposes the attribute catalogue to `admin.object_manager`, ' +
        'so an agent token gets 403 here. That is also why custom attributes are not part of the tool schemas the ' +
        'way states, priorities and groups are — the server cannot read them either.',
      inputSchema: {
        object: z.enum(['Ticket', 'User', 'Organization', 'Group']).default('Ticket'),
        only_custom: z
          .boolean()
          .default(true)
          .describe("Hide Zammad's built-in attributes and show only ones added to this instance."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = z
        .object({
          object: z.enum(['Ticket', 'User', 'Organization', 'Group']).default('Ticket'),
          only_custom: z.boolean().default(true),
        })
        .parse(rawInput);

      const attributes = await base.client.get<Array<Record<string, unknown>>>(
        '/api/v1/object_manager_attributes',
        { per_page: 500 },
      );

      const rows = (Array.isArray(attributes) ? attributes : [])
        .filter((a) => a.object === input.object)
        .filter((a) => !input.only_custom || a.editable === true);

      return jsonResult({
        object: input.object,
        attributes: rows.map((a) =>
          compact({
            name: a.name,
            display: a.display,
            data_type: a.data_type,
            options: (a.data_option as Record<string, unknown> | undefined)?.options,
            editable: a.editable,
            active: a.active,
            selector_path: `${input.object.toLowerCase()}.${a.name}`,
          }),
        ),
      });
    }),
  );

  server.registerTool(
    'zammad_refresh_metadata_cache',
    {
      title: 'Refresh cached Zammad metadata',
      description:
        "Drop this process's cached states, priorities, groups and resolved user/organization lookups. Call it after " +
        'changing configuration in Zammad if a lookup still returns stale values.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async () => {
      clearLookupCache();
      return textResult('Metadata cache cleared. Subsequent lookups will re-fetch from Zammad.');
    }),
  );
}
