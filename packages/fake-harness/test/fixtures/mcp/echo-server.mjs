// A stdio MCP server for the fakes' tests: says who it is, lists whoami and set_status, and answers each tool call with its name, arguments and the
// BOARD_VISIBLE and SECRET env vars it was started with.
import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, instructions: 'You are on the echo board.' });
  if (method === 'tools/list') reply(id, { tools: ['whoami', 'set_status'].map((name) => ({ name, inputSchema: { type: 'object' } })) });
  if (method === 'tools/call') {
    const env = `${process.env.BOARD_VISIBLE ?? '-'}|${process.env.SECRET ?? '-'}`;
    reply(id, { content: [{ type: 'text', text: `${params.name} ${JSON.stringify(params.arguments)} env:${env}` }] });
  }
});
