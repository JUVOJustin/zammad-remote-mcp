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

/**
 * Names the instance these tools reach.
 *
 * A Zammad URL in a ticket, a signature or a customer's mail says nothing about
 * which instance it belongs to. The base URL settles that; the link shapes
 * built from it are obvious enough not to spell out.
 *
 * What earns a bullet here is what no single tool's description can carry,
 * because it is about choosing between tools or reading a result. A bullet that
 * restates one tool is worse than none: it is read on every connection whether
 * that tool is reached for or not, and it is a second copy to keep in step —
 * the reason the delete warning, the tag lookup and the internal-note default
 * are gone. Each is stated where it applies, on the tool itself.
 */
function instructionsFor(zammadUrl: string): string {
  const base = zammadUrl.replace(/\/+$/, '');
  return `Tools for the Zammad support ticket helpdesk at ${base}.

  • Valid states, priorities, groups and macros for *this* instance are in the tool schemas — read the enums
    instead of asking. A wrong value comes back with the valid options.
  • \`zammad_search_tickets\` is the main entry point: express filters as arguments rather than fetching
    tickets and filtering yourself. Names resolve on their own (\`owner: ["me"]\`, \`group: ["1st Level"]\`),
    \`output: "count"\` sizes a broad query, and the response echoes the generated selector under \`search\`.
  • \`zammad_whoami\` shows whose credential is in play; agents and customers see different tickets.`;
}

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
      instructions: instructionsFor(options.config.ZAMMAD_URL),
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
