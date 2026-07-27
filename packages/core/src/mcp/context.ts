import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { type Credential, ZammadClient } from '../zammad/client.js';
import { LookupService } from '../zammad/lookup.js';

/**
 * Everything a tool handler needs for one MCP request.
 *
 * A fresh context is built per HTTP request from the credential on that request
 * — nothing is carried over between requests, which is what makes the server
 * safe to run stateless behind a load balancer.
 */
export interface ToolContext {
  config: Config;
  logger: Logger;
  client: ZammadClient;
  lookup: LookupService;
}

export function createToolContext(args: {
  config: Config;
  logger: Logger;
  credential: Credential;
}): ToolContext {
  const client = new ZammadClient({
    config: args.config,
    credential: args.credential,
    logger: args.logger,
  });

  return {
    config: args.config,
    logger: args.logger,
    client,
    lookup: new LookupService(client, args.config),
  };
}

/**
 * A context that impersonates another Zammad user via `X-On-Behalf-Of`.
 * Used by the `on_behalf_of` tool argument.
 */
export function withOnBehalfOf(context: ToolContext, user: string | undefined): ToolContext {
  if (!user) return context;
  const client = context.client.withOnBehalfOf(user);
  return {
    ...context,
    client,
    lookup: new LookupService(client, context.config),
  };
}
