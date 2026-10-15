// `agent-board mcp`: the board as a stdio MCP server (ADR-0010). A few tools over the same board-ops the CLI uses, and
// instructions that say once where the agent is and to read `agent-board --help` for the rest.
import {
  addEdge,
  BoardError,
  askUser,
  BoardRefs,
  closeAgent,
  presentPlan,
  readPlanSource,
  EDGE_CARRIES,
  edgesView,
  handOff,
  removeEdge,
  connectionsView,
  identifyView,
  interruptAgent,
  newAgent,
  openBoardSession,
  readAgent,
  readBoard,
  sendToAgent,
  setOwnStatus,
  openOwnPullRequest,
  treeView,
  waitForAgents,
  type BoardSession,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import {
  AGENT_ROLES,
  AGENT_STATES,
  DAEMON_VERSION,
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_PLAN_WAIT_MS,
  MAX_ASK_OPTIONS,
  MAX_ASK_WAIT_MS,
  MAX_OPTION_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_QUESTION_LENGTH,
  FLOW_CONDITION_KINDS,
  FLOW_EDGE_TRIGGERS,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  HARNESSES,
  isAgentState,
  lineSplitter,
  MAX_STATUS_LENGTH,
  RPC_ERROR,
  statusLine,
  type AgentState,
  type BoardCaller,
} from './protocol.ts';
import { handleRpcLine, RpcMethodError, type RpcHandlers } from './rpc.ts';

/** The MCP revisions it speaks, newest first; it answers a client asking for another with the newest. */
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What the server tells the model once, as it connects: the "tell it once" rule. */
export const BOARD_MCP_INSTRUCTIONS =
  'You are running on agent-board, a desktop app that shows coding agents and shells as tiles in zones on one board, ' +
  'joined by edges that hand work from one agent to the next. Run `agent-board --help` in your shell once to learn the ' +
  'board and its commands; these tools are the few you need most.';

/** What the server adds to its instructions for an agent that may orchestrate as it starts. */
export const ORCHESTRATOR_INSTRUCTIONS =
  'The user lets you orchestrate: you may start, message, watch and close other agents, and join them with edges, with ' +
  'the tools below or the same commands in `agent-board help orchestrate`.';

/** How long the `wait` tool waits by default, in seconds. */
const MCP_WAIT_SECONDS = DEFAULT_ORCHESTRATOR_WAIT_MS / 1000;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

export const BOARD_MCP_TOOLS: Tool[] = [
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
    name: 'handoff',
    description:
      'Hand your finished work to the next agent over your outgoing edges (see connections), or with `to` over your ' +
      'edge to that agent alone. Each edge takes what it carries: a message edge `message`, a handover edge the file ' +
      '`handover_path` (its own file without), a JSON edge `json`. Its conditions are checked first, so it may be held. ' +
      'Call it once the work is ready; your turn\'s end then hands off along your other edges alone. As `agent-board handoff`.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'One agent, by ref or name: along your edge to it, or, with none, a one-off edge in your scope; every edge out of you without.',
        },
        message: { type: 'string', description: 'What a message edge carries: your result, in your words.' },
        handover_path: { type: 'string', description: 'A markdown file in your worktree, relative to it, for a handover edge.' },
        json: { description: 'A JSON value, for a JSON edge.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ask',
    description:
      'Ask the user a question you can\'t settle yourself, and wait for the answer: it shows in their Needs you inbox, ' +
      'each option a button, and your tile says you ask them. Returns their answer, or that they skipped it or no ' +
      `answer came in time (${DEFAULT_ASK_WAIT_MS / 60_000} minutes by default): then carry on with your best judgement. ` +
      'One question at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: MAX_QUESTION_LENGTH, description: 'The question, in a sentence or two.' },
        options: {
          type: 'array',
          items: { type: 'string', maxLength: MAX_OPTION_LENGTH },
          maxItems: MAX_ASK_OPTIONS,
          description: 'Short answers to pick from, one click each. Without, the user replies in their own words.',
        },
        free_text: { type: 'boolean', description: 'Let the user reply in their own words besides the options.' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'How long to wait.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'present_plan',
    description:
      'Show the user your plan before you carry it out, and wait for their decision: it waits in their Needs you inbox ' +
      'and they read it in a Plan tab in your window, kept as v1, v2… in your history; they approve it, ask for ' +
      'changes (with comments) or reject it. Give ' +
      'it as Markdown, as HTML (shown sandboxed, offline: no network, no navigation), or as the path of a .md or .html ' +
      `file. Waits ${DEFAULT_PLAN_WAIT_MS / 60_000} minutes by default. After changes are asked for, present the revised plan again.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What the plan is for, in a line.' },
        markdown: { type: 'string', description: 'The plan as Markdown.' },
        html: { type: 'string', description: 'The plan as a self-contained HTML page.' },
        path: { type: 'string', description: 'A .md or .html file holding the plan, relative to your working directory.' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'How long to wait.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
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
  {
    name: 'open_pr',
    description:
      'Open a pull request of your branch, always as a draft, filled from .agent-board/handover.md. Commit first; in a ' +
      'zone with a gate, the gate must have passed on that commit. Marking it ready and merging stay the user\'s. As ' +
      '`agent-board open-pr`.',
    inputSchema: NO_INPUT,
  },
];

const AGENT_REF = { type: 'string', description: 'The agent, by ref (agent:9c1e) or unique name.' };

/** The orchestrator's tools (ADR-0011), listed only to a session that may orchestrate (a shell's too). As the CLI's commands. */
export const ORCHESTRATOR_MCP_TOOLS: Tool[] = [
  {
    name: 'new_agent',
    description:
      'Start an agent with a prompt as its first message, in its own worktree and branch, in a zone in your scope (yours ' +
      'by default). Returns its ref. A prompt may not start with ! or a /command (a plugin\'s /plugin:command is ' +
      'fine), nor hold a control character. As `agent-board new`.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Its first message: the task.' },
        name: { type: 'string', description: "Its tile's name." },
        zone: { type: 'string', description: 'A zone ref; yours by default.' },
        harness: { type: 'string', enum: [...HARNESSES] },
        model: { type: 'string', description: "The harness's model (opus, sonnet, haiku; gpt-5-codex, gpt-5); its default without." },
        role: {
          type: 'string',
          enum: [...AGENT_ROLES],
          description:
            "Its role: it starts with its zone's template for the role, then the prompt. A reviewer or follow-up-reviewer " +
            'works on a detached checkout of base (the branch it reviews), with no branch of its own.',
        },
        branch: { type: 'string', description: 'Its new branch; made from its name by default. Not for a reviewer.' },
        base: { type: 'string', description: "The branch to cut it from (a reviewer's to review), or an agent ref for that agent's branch." },
        issue: { type: 'string', description: "An issue in the zone's tracker, which comes first in its prompt." },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    description:
      "Send an agent its next message, once its turn has ended (wait first). Never to one that needs the user's " +
      'permission, and never a harness command. As `agent-board send`.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, text: { type: 'string' } },
      required: ['agent', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      'Wait until each agent\'s turn has ended (at its prompt, needing the user, failed or stopped), and say where each ' +
      `is. A turn you started counts only once it began, so call it straight after new_agent or send. Gives up after ` +
      `${MCP_WAIT_SECONDS} s by default, saying so: then call it again. As \`agent-board wait\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: AGENT_REF, minItems: 1 },
        until: { type: 'array', items: { type: 'string', enum: [...AGENT_STATES] }, description: 'Wait for these states instead.' },
        any: { type: 'boolean', description: 'Until one of them is there, not all.' },
        timeout_seconds: { type: 'integer', minimum: 0, description: `How long to wait; ${MCP_WAIT_SECONDS} by default.` },
      },
      required: ['agents'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      "An agent's final message from its last finished turn, or a text file in its worktree (such as " +
      '.agent-board/handover.md). As `agent-board read`.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, path: { type: 'string', description: 'A file, relative to its worktree.' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'interrupt',
    description: "Interrupt an agent's turn, as Ctrl-C would: it waits at its prompt. As `agent-board interrupt`.",
    inputSchema: { type: 'object', properties: { agent: AGENT_REF }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'add_edge',
    description:
      'Join two agents in your scope (or you) with an edge: when `from` hands off, what it carries goes to `to` as its ' +
      'next message. Marked as made by you. A gate or script condition runs nothing until the user approves it. As ' +
      '`agent-board edge add`.',
    inputSchema: {
      type: 'object',
      properties: {
        from: AGENT_REF,
        to: AGENT_REF,
        carries: { type: 'string', enum: Object.keys(EDGE_CARRIES), description: "from's final message, a handover file, or a JSON file." },
        path: { type: 'string', description: "The file it carries, relative to from's worktree; handover.md or handoff.json without." },
        trigger: { type: 'string', enum: [...FLOW_EDGE_TRIGGERS], description: 'auto (as from hands off, the default) or manual (the user sends it).' },
        conditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: [...FLOW_CONDITION_KINDS] },
              command: { type: 'string', description: 'For gate-green and script.' },
              label: { type: 'string', description: 'For issue-label.' },
            },
            required: ['kind'],
          },
          description: 'All must pass before it delivers.',
        },
      },
      required: ['from', 'to', 'carries'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_edges',
    description: 'Every edge on the board: its two agents, what it carries, when, how it stands, and who made it. As `agent-board edge list`.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'remove_edge',
    description: 'Remove an edge you, or an agent you started, made. As `agent-board edge remove`.',
    inputSchema: {
      type: 'object',
      properties: { edge: { type: 'string', description: 'The edge, by ref (edge:e5aa).' } },
      required: ['edge'],
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    description:
      "End an agent's session, keeping its tile, worktree and branch; with remove, delete them too (only an agent you " +
      'started, with nothing unsaved). As `agent-board close`.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, remove: { type: 'boolean' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
];

/** What a call is handled with: a signal that aborts once the client cancels it (`notifications/cancelled`). */
interface McpCall {
  signal: AbortSignal;
}

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

/** A tool argument that must be a string, or undefined when optional and absent. */
function stringArg(args: Record<string, unknown>, name: string, optional: true): string | undefined;
function stringArg(args: Record<string, unknown>, name: string): string;
function stringArg(args: Record<string, unknown>, name: string, optional = false): string | undefined {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new BoardError(`${name} must be a string`);
  return value;
}

/** A tool's `timeout_minutes`, as the daemon's `timeoutMs`; nothing when absent. */
function timeoutArg(args: Record<string, unknown>): { timeoutMs?: number } {
  const minutes = args.timeout_minutes;
  if (minutes === undefined) return {};
  if (!Number.isInteger(minutes) || (minutes as number) < 1) throw new BoardError('timeout_minutes must be a whole number of minutes');
  return { timeoutMs: (minutes as number) * 60_000 };
}

/** What each tool does with a board session and its arguments: the text the model reads. */
const TOOL_CALLS: Record<string, (session: BoardSession, args: Record<string, unknown>) => Promise<string>> = {
  whoami: async (session) => identifyView(new BoardRefs(await readBoard(session.client)), session.caller, session.socketPath).text,
  board: async (session) => treeView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  connections: async (session) => connectionsView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  open_pr: async (session) => (await openOwnPullRequest(session)).text,
  set_status: async (session, { summary, progress }) => {
    if (typeof summary !== 'string') throw new BoardError('summary must be a string');
    if (progress !== undefined && typeof progress !== 'number') throw new BoardError('progress must be a number');
    const agent = await setOwnStatus(session, summary, progress);
    return `Your tile now says: ${statusLine(agent.status!)}`;
  },
  new_agent: async (session, args) =>
    (
      await newAgent(session, {
        prompt: stringArg(args, 'prompt'),
        name: stringArg(args, 'name', true),
        zone: stringArg(args, 'zone', true),
        harness: stringArg(args, 'harness', true),
        model: stringArg(args, 'model', true),
        role: stringArg(args, 'role', true),
        branch: stringArg(args, 'branch', true),
        base: stringArg(args, 'base', true),
        issue: stringArg(args, 'issue', true),
      })
    ).text,
  send: async (session, args) => (await sendToAgent(session, stringArg(args, 'agent'), stringArg(args, 'text'))).text,
  wait: async (session, { agents, until, any, timeout_seconds: seconds = MCP_WAIT_SECONDS }) => {
    if (!Array.isArray(agents) || agents.length === 0 || !agents.every((ref) => typeof ref === 'string')) {
      throw new BoardError('agents must be a list of agent refs');
    }
    if (until !== undefined && (!Array.isArray(until) || !until.every(isAgentState))) {
      throw new BoardError(`until must be a list of states: ${AGENT_STATES.join(', ')}`);
    }
    if (!Number.isInteger(seconds) || (seconds as number) < 0) throw new BoardError('timeout_seconds must be a whole number');
    return (await waitForAgents(session, agents as string[], { until: until as AgentState[] | undefined, any: any === true, timeoutMs: (seconds as number) * 1000 })).text;
  },
  read: async (session, args) => (await readAgent(session, stringArg(args, 'agent'), stringArg(args, 'path', true))).text,
  interrupt: async (session, args) => (await interruptAgent(session, stringArg(args, 'agent'))).text,
  close: async (session, args) => (await closeAgent(session, stringArg(args, 'agent'), args.remove === true)).text,
  handoff: async (session, args) =>
    (
      await handOff(session, {
        to: stringArg(args, 'to', true),
        message: stringArg(args, 'message', true),
        handoverPath: stringArg(args, 'handover_path', true),
        json: args.json,
      })
    ).text,
  add_edge: async (session, args) => {
    const { conditions = [] } = args;
    if (!Array.isArray(conditions)) throw new BoardError('conditions must be a list');
    return (
      await addEdge(session, {
        from: stringArg(args, 'from'),
        to: stringArg(args, 'to'),
        carries: stringArg(args, 'carries'),
        path: stringArg(args, 'path', true),
        trigger: stringArg(args, 'trigger', true),
        conditions,
      })
    ).text;
  },
  ask: async (session, args) => {
    const { options, free_text: freeText } = args;
    if (options !== undefined && (!Array.isArray(options) || !options.every((option) => typeof option === 'string'))) {
      throw new BoardError('options must be a list of strings');
    }
    if (freeText !== undefined && typeof freeText !== 'boolean') throw new BoardError('free_text must be true or false');
    return (
      await askUser(session, {
        question: stringArg(args, 'question'),
        ...(options === undefined ? {} : { options: options as string[] }),
        ...(freeText === undefined ? {} : { freeText }),
        ...timeoutArg(args),
      })
    ).text;
  },
  present_plan: async (session, args) => {
    const source = { markdown: stringArg(args, 'markdown', true), html: stringArg(args, 'html', true), path: stringArg(args, 'path', true) };
    return (await presentPlan(session, { title: stringArg(args, 'title'), ...readPlanSource(source, process.cwd()), ...timeoutArg(args) })).text;
  },
  list_edges: async (session) => edgesView(new BoardRefs(await readBoard(session.client))).text,
  remove_edge: async (session, args) => (await removeEdge(session, stringArg(args, 'edge'))).text,
};

/** Who the env's board token is, or null when there is none or the daemon can't say. Never throws. */
async function whoIs(env: NodeJS.ProcessEnv | undefined): Promise<BoardCaller | null> {
  try {
    const session = await openBoardSession(env);
    session.close();
    return session.caller;
  } catch {
    return null;
  }
}

/**
 * Runs one tool call against the board, connecting afresh, so a daemon restarted meanwhile is found again. Cancelled
 * (`signal`), its connection closes, which ends what it waits on in the daemon: a question, a plan, a wait.
 */
async function callTool(
  call: (typeof TOOL_CALLS)[string],
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal,
): Promise<string> {
  const session = await openBoardSession(env);
  if (signal.aborted) session.close();
  else signal.addEventListener('abort', () => session.close(), { once: true });
  try {
    return await call(session, args);
  } finally {
    session.close();
  }
}

/** The MCP methods, over `env`'s board session. */
function boardMcpHandlers(env?: NodeJS.ProcessEnv): RpcHandlers<McpMethods, McpCall> {
  return {
    initialize: async (params) => {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const orchestrating = (await whoIs(env))?.orchestrate != null;
      return {
        protocolVersion: typeof asked === 'string' && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-board', version: DAEMON_VERSION },
        instructions: orchestrating ? `${BOARD_MCP_INSTRUCTIONS} ${ORCHESTRATOR_INSTRUCTIONS}` : BOARD_MCP_INSTRUCTIONS,
      };
    },
    'notifications/initialized': () => null,
    ping: () => ({}),
    // The control tools only for an orchestrator, as it lists them: a harness lists them once, as it starts.
    'tools/list': async () => ({
      tools: (await whoIs(env))?.orchestrate != null ? [...BOARD_MCP_TOOLS, ...ORCHESTRATOR_MCP_TOOLS] : BOARD_MCP_TOOLS,
    }),
    'tools/call': async (params, { signal }) => {
      const { name, arguments: args = {} } = (params ?? {}) as McpMethods['tools/call']['params'];
      const call = typeof name === 'string' && Object.hasOwn(TOOL_CALLS, name) ? TOOL_CALLS[name]! : undefined;
      if (call === undefined) throw new RpcMethodError(RPC_ERROR.invalidParams, `no tool ${String(name)}`);
      try {
        return { content: [{ type: 'text', text: await callTool(call, args, env, signal) }] };
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
  /** The calls under way, by request id, so the client can cancel one. */
  const calls = new Map<unknown, AbortController>();
  const feed = lineSplitter((line) => {
    if (line.trim() === '') return;
    let message: { id?: unknown; method?: unknown; params?: { requestId?: unknown } } | null = null;
    try {
      message = JSON.parse(line);
    } catch {
      // handleRpcLine answers a parse error.
    }
    // The client gave up on a call (its user interrupted the turn, or its timeout passed): it hears no answer.
    if (message?.method === 'notifications/cancelled') {
      calls.get(message.params?.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    const id = message?.id;
    if (id !== undefined) calls.set(id, controller);
    const handled = handleRpcLine(line, handlers, { signal: controller.signal }).then((response) => {
      if (calls.get(id) === controller) calls.delete(id);
      if (response !== undefined && !controller.signal.aborted) process.stdout.write(`${JSON.stringify(response)}\n`);
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
