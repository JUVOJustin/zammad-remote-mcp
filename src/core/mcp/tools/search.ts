import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Query } from '../../zammad/client.js';
import {
  type BuiltSearch,
  buildOrganizationSearch,
  buildTicketSearch,
  buildUserSearch,
  renderSearchExplanation,
} from '../../zammad/search/builder.js';
import {
  searchOrganizationsInputSchema,
  searchTicketsInputSchema,
  searchUsersInputSchema,
} from '../../zammad/search/schema.js';
import type { Vocabulary } from '../../zammad/vocabulary.js';
import type { ToolContext } from '../context.js';
import { withOnBehalfOf } from '../context.js';
import { guard, jsonResult, presentTicket, summarizeOrganization, summarizeUser } from '../result.js';
import { referenceField } from './enrich.js';

/**
 * Shape of `model_search_render` responses.
 *
 * With `expand=true&with_total_count=true` Zammad returns
 * `{records: [...], total_count: n}`; with `only_total_count=true` it returns
 * `{total_count: n}`. Without either it returns a bare array.
 */
interface SearchResponse<T> {
  records?: T[];
  total_count?: number;
}

function searchQueryParams(built: BuiltSearch, page: number, perPage: number, output: string): Query {
  const query: Query = { page, per_page: perPage };

  if (built.query) query.query = built.query;
  if (built.sort_by?.length) query.sort_by = built.sort_by;
  if (built.order_by?.length) query.order_by = built.order_by;

  if (output === 'count') {
    query.only_total_count = true;
  } else {
    query.with_total_count = true;
    // `expand` swaps association IDs for their names, which is what makes the
    // rows directly useful to a model.
    if (output !== 'ids') query.expand = true;
  }
  return query;
}

function rowsOf<T>(response: SearchResponse<T> | T[] | undefined): T[] {
  if (Array.isArray(response)) return response;
  return response?.records ?? [];
}

function totalOf(response: SearchResponse<unknown> | unknown[] | undefined, fallback: number): number {
  if (Array.isArray(response)) return fallback;
  return response?.total_count ?? fallback;
}

export function registerSearchTools(server: McpServer, base: ToolContext, vocabulary: Vocabulary): void {
  // The instance's own states/priorities/groups replace the `state` / `priority`
  // / `group` fields with enums, so the model can pick valid values straight
  // from the schema instead of calling a discovery tool first.
  const ticketSearchShape = {
    ...searchTicketsInputSchema.shape,
    state: referenceField(vocabulary.states, 'Ticket states.').optional(),
    state_not: referenceField(vocabulary.states, 'Exclude these states.').optional(),
    priority: referenceField(vocabulary.priorities, 'Priorities.').optional(),
    priority_not: referenceField(vocabulary.priorities, 'Exclude these priorities.').optional(),
    group: referenceField(vocabulary.groups, 'Groups/queues.').optional(),
    group_not: referenceField(vocabulary.groups, 'Exclude these groups.').optional(),
  };

  // ------------------------------------------------------------- tickets ---
  server.registerTool(
    'zammad_search_tickets',
    {
      title: 'Search Zammad tickets',
      description:
        'Search tickets with structured filters that are compiled into a Zammad selector, plus optional free text.\n\n' +
        'Filters (state, priority, group, owner, customer, organization, tags, dates, article content, custom ' +
        'attributes) are combined into one query and evaluated server-side by Zammad — prefer them over fetching ' +
        'tickets and filtering yourself. Names are resolved to IDs automatically, so `state: ["open"]`, ' +
        '`group: ["1st Level"]` and `owner: ["jane@acme.com"]` all work; `owner: ["me"]` and `customer: ["me"]` mean ' +
        'the authenticated user.\n\n' +
        'Strategies: `auto` (default) puts free text in the search backend and filters in the selector, which is ' +
        'correct with or without Elasticsearch. `fulltext` compiles everything into one Elasticsearch query_string ' +
        '(wildcards, phrases, nested article fields) and requires Elasticsearch. `structured` skips the text query ' +
        "entirely and forces Zammad's exact database search.\n\n" +
        'A note on `article_count`: an exact count or a list works under any strategy, but a `{min, max}` range ' +
        'is compiled into the Elasticsearch query, so on an instance that has Elasticsearch it needs ' +
        '`strategy: "fulltext"` — the selector backend Zammad uses there rejects numeric comparison. To simply ' +
        'find the longest threads, sort by `article_count` instead of filtering.\n\n' +
        'Use `output: "count"` to size a result set cheaply before paging through it. The generated query and ' +
        'selector are echoed back under `search`, so a search that returns too much or too little can be refined ' +
        'directly.',
      inputSchema: ticketSearchShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = searchTicketsInputSchema.parse(rawInput);
      const context = withOnBehalfOf(base, input.on_behalf_of);

      const built = await buildTicketSearch(input, context.lookup);
      const params = searchQueryParams(built, input.page, input.per_page, input.output);

      // `condition` is a nested object, so the search has to go out as a POST
      // body rather than as query parameters. Zammad routes GET and POST to the
      // same `tickets#search` action.
      const body: Record<string, unknown> = { ...params };
      if (built.condition) body.condition = built.condition;

      const response = await context.client.post<
        SearchResponse<Record<string, unknown>> | Record<string, unknown>[]
      >('/api/v1/tickets/search', body);

      const search = input.explain
        ? {
            strategy: input.strategy,
            query: built.query ?? null,
            condition: built.condition ?? null,
            explanation: renderSearchExplanation(built),
          }
        : undefined;

      if (input.output === 'count') {
        return jsonResult({
          total_count: (response as SearchResponse<unknown>)?.total_count ?? 0,
          search,
        });
      }

      const rows = rowsOf(response);
      const total = totalOf(response, rows.length);

      const tickets =
        input.output === 'ids'
          ? rows.map((row) => row.id)
          : input.output === 'full'
            ? rows
            : rows.map((row) => presentTicket(row));

      return jsonResult({
        total_count: total,
        page: input.page,
        per_page: input.per_page,
        returned: rows.length,
        has_more: input.page * input.per_page < total,
        tickets,
        search,
      });
    }),
  );

  // --------------------------------------------------------------- users ---
  server.registerTool(
    'zammad_search_users',
    {
      title: 'Search Zammad users',
      description:
        'Find agents and customers by free text or by structured filters (email, login, name, organization, role, ' +
        'active, vip, custom attributes). Useful for resolving a person before filtering tickets by owner or customer.',
      inputSchema: searchUsersInputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = searchUsersInputSchema.parse(rawInput);
      const built = await buildUserSearch(input, base.lookup);
      const body: Record<string, unknown> = searchQueryParams(
        built,
        input.page,
        input.per_page,
        input.output,
      );
      if (built.condition) body.condition = built.condition;

      const response = await base.client.post<
        SearchResponse<Record<string, unknown>> | Record<string, unknown>[]
      >('/api/v1/users/search', body);

      if (input.output === 'count') {
        return jsonResult({ total_count: (response as SearchResponse<unknown>)?.total_count ?? 0 });
      }

      const rows = rowsOf(response);
      return jsonResult({
        total_count: totalOf(response, rows.length),
        page: input.page,
        per_page: input.per_page,
        users:
          input.output === 'ids'
            ? rows.map((row) => row.id)
            : input.output === 'full'
              ? rows
              : rows.map(summarizeUser),
        search: input.explain
          ? { query: built.query ?? null, condition: built.condition ?? null }
          : undefined,
      });
    }),
  );

  // ------------------------------------------------------- organizations ---
  server.registerTool(
    'zammad_search_organizations',
    {
      title: 'Search Zammad organizations',
      description:
        'Find customer organizations by free text or by structured filters (name, domain, vip, active, custom ' +
        'attributes).',
      inputSchema: searchOrganizationsInputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = searchOrganizationsInputSchema.parse(rawInput);
      const built = await buildOrganizationSearch(input);
      const body: Record<string, unknown> = searchQueryParams(
        built,
        input.page,
        input.per_page,
        input.output,
      );
      if (built.condition) body.condition = built.condition;

      const response = await base.client.post<
        SearchResponse<Record<string, unknown>> | Record<string, unknown>[]
      >('/api/v1/organizations/search', body);

      if (input.output === 'count') {
        return jsonResult({ total_count: (response as SearchResponse<unknown>)?.total_count ?? 0 });
      }

      const rows = rowsOf(response);
      return jsonResult({
        total_count: totalOf(response, rows.length),
        page: input.page,
        per_page: input.per_page,
        organizations:
          input.output === 'ids'
            ? rows.map((row) => row.id)
            : input.output === 'full'
              ? rows
              : rows.map(summarizeOrganization),
        search: input.explain
          ? { query: built.query ?? null, condition: built.condition ?? null }
          : undefined,
      });
    }),
  );

  // -------------------------------------------------------------- global ---
  const globalSearchInput = z.object({
    query: z.string().min(1).describe('Free-text query, e.g. "printer offline" or "number:67001".'),
    objects: z
      .array(z.enum(['Ticket', 'User', 'Organization', 'KnowledgeBase::Answer::Translation']))
      .min(1)
      .optional()
      .describe('Restrict the search to these object types. Defaults to everything the user may see.'),
    limit: z.number().int().positive().max(100).default(10),
  });

  server.registerTool(
    'zammad_search_global',
    {
      title: 'Search across all Zammad objects',
      description:
        "Zammad's global search — the one behind the magnifier in the UI. Searches tickets, users, organizations " +
        'and knowledge base answers in one call. Use it for a broad "where does this term appear at all?" sweep; ' +
        'use `zammad_search_tickets` when you need real filtering.',
      inputSchema: globalSearchInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (rawInput) => {
      const input = globalSearchInput.parse(rawInput);
      const path = input.objects?.length === 1 ? `/api/v1/search/${input.objects[0]}` : '/api/v1/search';

      const response = await base.client.post<unknown>(path, {
        query: input.query,
        limit: input.limit,
        ...(input.objects && input.objects.length > 1 ? { objects: input.objects } : {}),
      });

      return jsonResult({ query: input.query, results: response });
    }),
  );
}
