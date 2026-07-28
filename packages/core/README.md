# @zammad-mcp/core

The runtime-agnostic core of the [Zammad remote MCP server](https://github.com/JUVOJustin/zammad-remote-mcp):
Hono app, MCP server, 39 tools, Zammad REST client, search query builder and a stateless OAuth proxy.

**It imports no Node built-ins** — only WebCrypto, `fetch`, `TextEncoder` and `atob`/`btoa` — so the
same build runs on Node.js, Cloudflare Workers, Deno and Bun.

Most people want a ready-to-run host instead:

- **Node.js** → [`@zammad-mcp/node`](https://www.npmjs.com/package/@zammad-mcp/node)
- **Cloudflare Workers** → [`packages/cloudflare`](https://github.com/JUVOJustin/zammad-remote-mcp/tree/main/packages/cloudflare) in the repository

Use this package directly to embed the server in your own host:

```ts
import { bootstrap } from '@zammad-mcp/core';

const { fetch } = bootstrap({
  env: process.env,          // or a Worker's `env` binding
  cache: myCacheStore,       // optional; defaults to an in-process store
});

export default { fetch };
```

`bootstrap` validates the configuration with Zod and throws with a readable message listing every
problem. See the [repository README](https://github.com/JUVOJustin/zammad-remote-mcp#readme) for the
full settings list and tool reference.

## License

MIT
