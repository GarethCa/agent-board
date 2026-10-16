// A Streamable HTTP MCP server for the fakes' tests: as echo-server.mjs, but each tool call's answer names the
// Authorization header it came with, and comes as an event stream behind a keep-alive comment, as a long call's would.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startEchoHttpServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      if (id === undefined) return response.writeHead(202).end();
      const json = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });
      if (method === 'initialize') {
        return response.writeHead(200, { 'content-type': 'application/json' }).end(json({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, instructions: 'You are on the echo board.' }));
      }
      if (method === 'tools/list') {
        const tools = ['whoami', 'set_status'].map((name) => ({ name, inputSchema: { type: 'object' } }));
        return response.writeHead(200, { 'content-type': 'application/json' }).end(json({ tools }));
      }
      const text = `${params.name} ${JSON.stringify(params.arguments)} auth:${request.headers.authorization ?? '-'}`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': keep-alive\n\n');
      response.end(`event: message\ndata: ${json({ content: [{ type: 'text', text }] })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
