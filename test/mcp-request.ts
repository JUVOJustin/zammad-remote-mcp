/**
 * How the tests speak MCP over HTTP, shared by the unit and integration suites
 * so a protocol revision is changed in one place.
 */

export const PROTOCOL_VERSION = '2026-07-28';

/**
 * Headers and params for a 2026-07-28 request. It states its protocol version
 * and client capabilities itself, in the headers and in `_meta`, instead of
 * relying on an earlier handshake.
 */
export function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  clientName = 'test',
): { headers: Record<string, string>; params: Record<string, unknown> } {
  const headers: Record<string, string> = { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': method };
  if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;
  return {
    headers,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1' },
      },
    },
  };
}

/** The JSON-RPC envelope of a response, whether it came as plain JSON or as a single SSE event. */
export async function readEnvelope(response: Response): Promise<any> {
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim()
    : text;
  return payload ? JSON.parse(payload) : undefined;
}
