import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import type { Credential } from '../zammad/client.js';
import { loadVocabulary } from '../zammad/vocabulary.js';
import { createToolContext } from './context.js';
import { registerArticleTools } from './tools/articles.js';
import { registerMetadataTools } from './tools/metadata.js';
import { registerSearchTools } from './tools/search.js';
import { registerTicketTools } from './tools/tickets.js';

const INSTRUCTIONS = `Tools for a Zammad helpdesk.

Getting oriented
  • The valid states, priorities, groups and macros of *this* instance are already listed in the tool schemas —
    read the enum on \`state\`, \`priority\` or \`group\` rather than asking for them. Other names and numeric IDs
    are still accepted, and a wrong value comes back with the valid options.
  • \`zammad_whoami\` shows whose credential is in play. Agents and customers see very different ticket sets.
  • Tags are open-ended and are not in the schemas — \`zammad_list_tags\` checks a spelling before you use it.
  • \`zammad_list_custom_attributes\` reveals Object Manager fields, but needs an admin credential; with an agent
    token it returns 403 and custom fields have to be addressed by name via \`custom\` / \`custom_fields\`.

Searching
  • \`zammad_search_tickets\` is the main entry point. Express filters as arguments — state, priority, group,
    owner, customer, organization, tags, date ranges, article content — rather than fetching tickets and
    filtering them yourself; Zammad evaluates the whole query server-side.
  • Names resolve automatically: \`state: ["open"]\`, \`group: ["1st Level"]\`, \`owner: ["jane@acme.com"]\`.
    \`owner: ["me"]\` and \`customer: ["me"]\` mean the authenticated user; \`organization: ["mine"]\` means their
    organization.
  • Start with \`output: "count"\` when a query might match thousands of tickets, then page with
    \`page\`/\`per_page\`.
  • The response echoes the generated query and selector under \`search\`. Read it when a result looks wrong —
    it shows exactly what Zammad was asked.

Writing
  • Articles default to \`type: "note"\` and \`internal: true\`, which records text without contacting anyone.
    Setting \`type: "email"\` with \`internal: false\` sends real mail to the customer, so only do that when the
    intent is to reply.
  • Closing a ticket is \`zammad_update_ticket\` with \`state: "closed"\`. \`zammad_delete_ticket\` is permanent
    and is rarely what is wanted.
  • Moving a ticket to a pending state requires \`pending_time\`.`;

export interface CreateServerOptions {
  config: Config;
  logger: Logger;
  credential: Credential;
}

/**
 * Builds a fresh `McpServer` for a single request.
 *
 * Instances are cheap (tool registration is a handful of map inserts) and this
 * is what makes stateless operation possible: the server object closes over the
 * credential that arrived on *this* HTTP request and is discarded when the
 * response is written, so no session, token or connection state survives.
 */
export async function createMcpServer(options: CreateServerOptions): Promise<McpServer> {
  const server = new McpServer(
    { name: 'zammad-remote-mcp', version: '1.0.0' },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {}, logging: {} },
      // The SDK otherwise instantiates Ajv eagerly in the Server constructor,
      // and Ajv compiles schemas with `new Function` — which edge runtimes
      // forbid. The validator is only consulted for elicitation responses,
      // which a stateless server never issues, so the pure-JS implementation
      // costs nothing and keeps one build valid on both runtimes.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  const context = createToolContext(options);

  // The instance's own states, priorities, groups and macros, folded into the
  // tool schemas as enums. Served from the lookup cache after the first request,
  // and degrades to plain strings if Zammad is unreachable or the credential
  // cannot read a source — discovery must not depend on Zammad being healthy.
  const vocabulary = await loadVocabulary(context.lookup, options.config, options.logger);
  if (vocabulary.unavailable.length > 0) {
    options.logger.debug('publishing partial tool schemas', { unavailable: vocabulary.unavailable });
  }

  registerSearchTools(server, context, vocabulary);
  registerTicketTools(server, context, vocabulary);
  registerArticleTools(server, context);
  registerMetadataTools(server, context);

  return server;
}
