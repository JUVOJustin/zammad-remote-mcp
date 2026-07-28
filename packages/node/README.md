# @zammad-mcp/node

Node.js host for the [Zammad remote MCP server](https://github.com/JUVOJustin/zammad-remote-mcp).

A stateless [MCP](https://modelcontextprotocol.io) server over Zammad's REST API: full ticket
operations, an intelligent search layer, and OAuth 2.1 against Zammad's own authorization server.

```bash
npx @zammad-mcp/node
```

Configuration comes from the environment or a `.env` file. The minimum for a local run against a
Zammad API token:

```bash
ZAMMAD_URL=https://support.example.com \
ZAMMAD_AUTH_MODE=token \
ZAMMAD_API_TOKEN=your-token \
npx @zammad-mcp/node
```

The MCP endpoint is then `http://localhost:3000/mcp`.

For OAuth setup, the full settings list, the search filters and the tool reference, see the
[repository README](https://github.com/JUVOJustin/zammad-remote-mcp#readme).

The server logic lives in [`@zammad-mcp/core`](https://www.npmjs.com/package/@zammad-mcp/core),
which is runtime-agnostic — this package only adds `.env` loading, socket binding and signal
handling.

## License

MIT
