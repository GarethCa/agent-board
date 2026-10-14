// `agent-board mcp`: the board as a stdio MCP server (ADR-0010). A few tools over the same board-ops the CLI uses, and
// instructions that say once where the agent is and to read `agent-board --help` for the rest.
import {
  BoardError,
  BoardRefs,
  connectionsView,
  identifyView,
  openBoardSession,
  readBoard,
  setOwnStatus,
  treeView,
  type BoardSession,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import { DAEMON_VERSION, lineSplitter, MAX_STATUS_LENGTH, RPC_ERROR, statusLine } from './protocol.ts';
import { handleRpcLine, RpcMethodError, type RpcHandlers } from './rpc.ts';

/** The MCP revisions it speaks, newest first; it answers a client asking for another with the newest. */
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What the server tells the model once, as it connects: the "tell it once" rule. */
export const BOARD_MCP_INSTRUCTIONS =
  'You are running on agent-board, a desktop app that shows coding agents and shells as tiles in zones on one board, ' +
  'joined by edges that hand work from one agent to the next. Run `agent-board --help` in your shell once to learn the ' +
  'board and its commands; these tools are the few you need most.';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

const BOARD_MCP_TOOLS: Tool[] = [
  {
    name: 'whoami',
    description: 'Who and where you are on the board: your tile, its zone, your state and status. As `agent-board identify`.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'board',
    description: 'Every zone with its tiles (agents and shells, with state and status) and items. As `agent-board tree`.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'connections',
    description:
      'The edges into and out of your tile: which agents you hand off to and which hand off to you, what each edge ' +
      'carries, when, its conditions, and those agents\' states.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'set_status',
    description:
      'Set the one line your tile shows: the change you are making now, not the task you were given. Call it once you ' +
      'understand the work, and again when its direction changes. As `agent-board status set`.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', maxLength: MAX_STATUS_LENGTH, description: 'What you are doing now, in a line.' },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: 'How far through you are, if you know.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

interface McpMethods {
  initialize: { params: { protocolVersion?: string }; result: unknown };
  'notifications/initialized': { params: unknown; result: null };
  ping: { params: unknown; result: Record<string, never> };
  'tools/list': { params: unknown; result: { tools: Tool[] } };
  'tools/call': { params: { name?: string; arguments?: Record<string, unknown> }; result: ToolResult };
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** What each tool does with a board session and its arguments: the text the model reads. */
const TOOL_CALLS: Record<string, (session: BoardSession, args: Record<string, unknown>) => Promise<string>> = {
  whoami: async (session) => identifyView(new BoardRefs(await readBoard(session.client)), session.caller, session.socketPath).text,
  board: async (session) => treeView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  connections: async (session) => connectionsView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  set_status: async (session, { summary, progress }) => {
    if (typeof summary !== 'string') throw new BoardError('summary must be a string');
    if (progress !== undefined && typeof progress !== 'number') throw new BoardError('progress must be a number');
    const agent = await setOwnStatus(session, summary, progress);
    return `Your tile now says: ${statusLine(agent.status!)}`;
  },
};

/** Runs one tool call against the board, connecting afresh, so a daemon restarted meanwhile is found again. */
async function callTool(call: (typeof TOOL_CALLS)[string], args: Record<string, unknown>, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  const session = await openBoardSession(env);
  try {
    return await call(session, args);
  } finally {
    session.close();
  }
}

/** The MCP methods, over `env`'s board session. */
function boardMcpHandlers(env?: NodeJS.ProcessEnv): RpcHandlers<McpMethods> {
  return {
    initialize: (params) => {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        protocolVersion: typeof asked === 'string' && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-board', version: DAEMON_VERSION },
        instructions: BOARD_MCP_INSTRUCTIONS,
      };
    },
    'notifications/initialized': () => null,
    ping: () => ({}),
    'tools/list': () => ({ tools: BOARD_MCP_TOOLS }),
    'tools/call': async (params) => {
      const { name, arguments: args = {} } = (params ?? {}) as McpMethods['tools/call']['params'];
      const call = typeof name === 'string' && Object.hasOwn(TOOL_CALLS, name) ? TOOL_CALLS[name]! : undefined;
      if (call === undefined) throw new RpcMethodError(RPC_ERROR.invalidParams, `no tool ${String(name)}`);
      try {
        return { content: [{ type: 'text', text: await callTool(call, args, env) }] };
      } catch (error) {
        // A refusal is the tool's answer, for the model to read; anything else is the server's failure.
        if (error instanceof BoardError || error instanceof DaemonRpcError) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        throw error;
      }
    },
  };
}

/** Serves MCP on stdin and stdout until stdin ends. Resolves to the exit code. */
export async function serveBoardMcp(options: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const handlers = boardMcpHandlers(options.env);
  const pending = new Set<Promise<void>>();
  const feed = lineSplitter((line) => {
    if (line.trim() === '') return;
    const handled = handleRpcLine(line, handlers, undefined).then((response) => {
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
    pending.add(handled);
    void handled.finally(() => pending.delete(handled));
  });
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (!feed(chunk as string)) return 1;
  }
  await Promise.all(pending);
  return 0;
}
