// The board as an MCP server (ADR-0010): a few tools over the same board-ops the CLI uses, and instructions that say
// once where the agent is and to read `agent-board --help` for the rest. One set of handlers, two transports: stdio
// here (`agent-board mcp`), and Streamable HTTP in the daemon (`board-mcp-http.ts`).
import {
  addEdge,
  BoardError,
  askUser,
  BoardRefs,
  closeAgent,
  defaultRolesView,
  presentPlan,
  readPlanSource,
  EDGE_CARRIES,
  edgesView,
  handOff,
  removeDefaultRole,
  removeEdge,
  connectionsView,
  identifyView,
  interruptAgent,
  restartAgent,
  newAgent,
  openBoardSession,
  readAgent,
  readBoard,
  sendToAgent,
  setDefaultRole,
  setOwnStatus,
  openOwnPullRequest,
  treeView,
  waitForAgents,
  watchCrew,
  type BoardSession,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import { addNote, arrangeZone, editNote, moveTile, removeNote, type PlaceOptions } from './layout-ops.ts';
import {
  AGENT_ROLES,
  ARRANGE_BYS,
  CREW_EVENT_KINDS,
  ARRANGE_LAYOUTS,
  NOTE_KINDS,
  TILE_SIDES,
  DAEMON_VERSION,
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_PLAN_WAIT_MS,
  MAX_ASK_OPTIONS,
  MAX_ASK_WAIT_MS,
  MAX_OPTION_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_ROLE_NAME_LENGTH,
  MAX_QUESTION_LENGTH,
  FLOW_CONDITION_KINDS,
  FLOW_EDGE_TRIGGERS,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  HARNESSES,
  isCrewSince,
  isWaitState,
  lineSplitter,
  MAX_STATUS_LENGTH,
  RPC_ERROR,
  statusLine,
  type BoardCaller,
  type CrewEventKind,
  type WaitState,
  WAIT_STATES,
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
  'The user lets you orchestrate: you may start, message, watch and close other agents, join them with edges, and keep ' +
  'your zone tidy (move tiles, arrange your crew, notes), with the tools below or the same commands in ' +
  '`agent-board help orchestrate`. A reviewer started from an agent\'s branch is joined to that agent both ways, as ' +
  'manual edges; wire only reviewer ↔ implementer (findings back, next round), never an edge to your own tile, and ' +
  'keep one of the pair manual, as two auto edges in a loop re-trigger each other.';

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
      'understand the work, and again when its direction changes. With done, your work is finished, not only this ' +
      'turn: the agent that started you hears it once. As `agent-board status set`.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', maxLength: MAX_STATUS_LENGTH, description: 'What you are doing now, in a line.' },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: 'How far through you are, if you know.' },
        done: { type: 'boolean', description: 'Your work is finished (handoff says so too). Your next prompt clears it.' },
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

/** Where the layout tools put something, as `agent-board move` takes it. */
const PLACE_PROPERTIES = {
  to: { type: 'string', description: 'The zone or group to put it in, by ref; `board` for loose on the board. Its own zone without.' },
  at: { type: 'string', description: 'x,y relative to the zone, such as 40,120.' },
  near: { type: 'string', description: 'A tile or note to put it a gap beside, by ref.' },
  side: { type: 'string', enum: [...TILE_SIDES], description: 'Which side of near: below by default.' },
};

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
          maxLength: MAX_ROLE_NAME_LENGTH,
          description:
            `Its role: ${AGENT_ROLES.join(', ')}, or any other name (designer, release prep) for a custom role of that ` +
            "name, which its tile shows. It starts with its zone's template for the role (for a name, else the app's " +
            'default role of that name: see the roles tool), then the prompt; a name with neither starts with the prompt ' +
            'alone. A reviewer or follow-up-reviewer works on a detached checkout of base (the branch it reviews), with no ' +
            'branch of its own.',
        },
        template: {
          type: 'boolean',
          description:
            "false starts it without its role's template: its first message is exactly your prompt (and the issue). For when you write the whole prompt. The result says which template was applied. As --no-template.",
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
      `is. A turn you started counts only once it began, so call it straight after new_agent or send. until finished ` +
      `waits until it says its work is finished (it handed off, or set its status done), which a turn ending while its ` +
      `background work runs is not. With no agents, it waits on your crew (the agents you started, and theirs). With ` +
      `since, it waits instead for what happens to them next, each once: ${CREW_EVENT_KINDS.join(', ')}; it answers ` +
      `with each as a line (at most 100) and a cursor to pass as since next time: "now" the first time. Gives up ` +
      `after ${MCP_WAIT_SECONDS} s by default, saying so: then call it again. As \`agent-board wait\` and ` +
      `\`agent-board watch\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: AGENT_REF },
        crew: { type: 'boolean', description: 'Your crew too, besides the agents named: the agents you started, and theirs.' },
        until: { type: 'array', items: { type: 'string', enum: [...WAIT_STATES] }, description: 'Wait for these states instead.' },
        any: { type: 'boolean', description: 'Until one of them is there, not all.' },
        since: { type: 'string', description: 'Wait for what happens after this cursor instead: "now", a cursor it answered with, or "all".' },
        kinds: { type: 'array', items: { type: 'string', enum: [...CREW_EVENT_KINDS] }, description: 'With since, only these.' },
        timeout_seconds: { type: 'integer', minimum: 0, description: `How long to wait; ${MCP_WAIT_SECONDS} by default.` },
      },
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
    name: 'restart',
    description:
      "Start an ended agent again in its tile, worktree and branch, carrying on its conversation, as its tile's Restart " +
      'does. With `fresh` it starts a new conversation instead, under a new session id (the old one is kept in the ' +
      "agent's earlierConversations), on `prompt` as its first message. As `agent-board restart`.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_REF,
        fresh: { type: 'boolean', description: 'Start a new conversation instead of carrying on the old one.' },
        prompt: { type: 'string', description: 'With fresh: its first message.' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
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
    name: 'move',
    description:
      'Move a tile (an agent, a shell, or you) or a note in your scope, as dragging it would: into a zone in your scope ' +
      "or a group you made, exactly at a place (on the zone's grid) or beside another, what is in the way moving aside. " +
      'As `agent-board move`.',
    inputSchema: {
      type: 'object',
      properties: { tile: { type: 'string', description: 'The tile or note, by ref (agent:9c1e, shell:07bd, item:31f0) or name.' }, ...PLACE_PROPERTIES },
      required: ['tile'],
      additionalProperties: false,
    },
  },
  {
    name: 'arrange',
    description:
      "Lay out your zone's tiles that you may move, on its grid: you first, then a cluster per issue or branch ticket (a " +
      'label and a sticky you sign saying what each agent is doing, then its implementer and its reviewer, a rail apart ' +
      'where an edge joins them), or a row per role or state. Arranging again moves the stickies with their clusters, ' +
      'keeping any edited text. As ' +
      '`agent-board arrange`.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: 'The zone, by ref; yours by default.' },
        by: { type: 'string', enum: [...ARRANGE_BYS], description: 'What a row holds: issue by default.' },
        layout: { type: 'string', enum: [...ARRANGE_LAYOUTS], description: 'A row per group (rows, the default), or filling the zone (grid) with the tiles no edge joins, units joined by edges laid out as rows.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_note',
    description:
      'Put a note of short markdown on the board, marked as made by you, in your zone or beside a tile, what is there moving ' +
      'aside: an agent note (a card with your badge and the time, never a sticky) by default, or a signed sticky or text with kind. Near an agent with no ' +
      "side, it is added to its cluster's note, else goes in the slot before it. As `agent-board note add`.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: [...NOTE_KINDS], description: 'Left out, an agent note from you; sticky makes a signed sticky; or text.' },
        color: { type: 'string', description: 'Text only (an agent note has none, and ignores one): yellow, orange, pink, violet, blue, green, grey or white (text: ink, grey, red, …), or #rrggbb.' },
        ...PLACE_PROPERTIES,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_note',
    description: 'Change the text (or text item\'s colour) of a note you, or an agent you started, made. As `agent-board note edit`.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The note, by ref (item:31f0).' }, text: { type: 'string' }, color: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_note',
    description: 'Remove a note or link card you, or an agent you started, made. As `agent-board note remove`.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The note, by ref (item:31f0).' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'roles',
    description:
      "The app's default roles: a custom role's name and the template an agent started in it begins with, in any zone " +
      'with no template of its own for the name. As `agent-board roles`.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'set_role',
    description:
      "Add one of the app's default roles, or replace the one of the same name, logged for the user: an orchestrator of " +
      "the whole board's alone. With zone, that zone's own template for the name instead. Not for a built-in role. The " +
      'template may not start with ! or a /command, nor hold a control character. As `agent-board roles set`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: MAX_ROLE_NAME_LENGTH, description: 'The role\'s name: designer, release prep.' },
        zone: { type: 'string', description: "A zone ref in your scope: set its own template for the name, not the app's." },
        template: {
          type: 'string',
          description: 'What an agent in the role starts with, before its prompt: {{issue}}, {{branch}}, {{worktree}} and {{prev_review}} are filled in.',
        },
      },
      required: ['name', 'template'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_role',
    description: "Remove one of the app's default roles, or with zone that zone's template for the name, logged for the user. As `agent-board roles remove`.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, zone: { type: 'string', description: 'A zone ref in your scope.' } },
      required: ['name'],
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
export interface McpCall {
  signal: AbortSignal;
}

export interface McpMethods {
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

/**
 * Where the board MCP's calls go: a board session opened afresh for each, as the client's token (ADR-0010), and the
 * folder a relative path is read from, where its agent started.
 */
export interface BoardMcpContext {
  openSession(): Promise<BoardSession>;
  cwd(): string;
}

/** What each tool does with a board session, its arguments and the caller's folder: the text the model reads. */
const TOOL_CALLS: Record<string, (session: BoardSession, args: Record<string, unknown>, cwd: string) => Promise<string>> = {
  whoami: async (session) => identifyView(new BoardRefs(await readBoard(session.client)), session.caller, session.socketPath).text,
  board: async (session) => treeView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  connections: async (session) => connectionsView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  open_pr: async (session) => (await openOwnPullRequest(session)).text,
  set_status: async (session, { summary, progress, done }) => {
    if (typeof summary !== 'string') throw new BoardError('summary must be a string');
    if (progress !== undefined && typeof progress !== 'number') throw new BoardError('progress must be a number');
    const agent = await setOwnStatus(session, summary, progress, done === true);
    return `Your tile now says: ${statusLine(agent.status!)}${agent.workFinishedAt === null ? '' : ', and that your work is finished'}`;
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
        noTemplate: args.template === false,
        branch: stringArg(args, 'branch', true),
        base: stringArg(args, 'base', true),
        issue: stringArg(args, 'issue', true),
      })
    ).text,
  send: async (session, args) => (await sendToAgent(session, stringArg(args, 'agent'), stringArg(args, 'text'))).text,
  wait: async (session, { agents = [], crew, until, any, since, kinds, timeout_seconds: seconds = MCP_WAIT_SECONDS }) => {
    if (!Array.isArray(agents) || !agents.every((ref) => typeof ref === 'string')) throw new BoardError('agents must be a list of agent refs');
    // As `agent-board watch`: no agents named is your crew.
    const wholeCrew = crew === true || agents.length === 0;
    if (until !== undefined && (!Array.isArray(until) || !until.every(isWaitState))) {
      throw new BoardError(`until must be a list of states: ${WAIT_STATES.join(', ')}`);
    }
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.every((kind) => CREW_EVENT_KINDS.includes(kind)))) {
      throw new BoardError(`kinds must be a list of: ${CREW_EVENT_KINDS.join(', ')}`);
    }
    if (since !== undefined && (typeof since !== 'string' || !isCrewSince(since))) throw new BoardError('since must be a cursor it answered with, "now" or "all"');
    if (!Number.isInteger(seconds) || (seconds as number) < 0) throw new BoardError('timeout_seconds must be a whole number');
    const timeoutMs = (seconds as number) * 1000;
    if (since === undefined) {
      return (await waitForAgents(session, agents as string[], { until: until as WaitState[] | undefined, any: any === true, crew: wholeCrew, timeoutMs })).text;
    }
    const news = await watchCrew(session, agents as string[], { crew: wholeCrew, since, kinds: kinds as CrewEventKind[] | undefined, timeoutMs });
    return [
      ...(news.missed ? ['Some were missed: the daemon keeps only the latest, or it restarted.'] : []),
      ...(news.timedOut ? ['Nothing yet.'] : news.lines),
      `Cursor ${news.cursor}: pass it as since next time to hear only what comes after.`,
    ].join('\n');
  },
  read: async (session, args) => (await readAgent(session, stringArg(args, 'agent'), stringArg(args, 'path', true))).text,
  interrupt: async (session, args) => (await interruptAgent(session, stringArg(args, 'agent'))).text,
  restart: async (session, args) => {
    const prompt = stringArg(args, 'prompt', true);
    if (args.fresh !== true && prompt !== undefined && prompt.trim() !== '') throw new BoardError('prompt needs fresh');
    const anew = args.fresh === true ? { prompt: prompt === undefined || prompt.trim() === '' ? undefined : prompt } : undefined;
    return (await restartAgent(session, stringArg(args, 'agent'), anew)).text;
  },
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
  present_plan: async (session, args, cwd) => {
    const source = { markdown: stringArg(args, 'markdown', true), html: stringArg(args, 'html', true), path: stringArg(args, 'path', true) };
    return (await presentPlan(session, { title: stringArg(args, 'title'), ...readPlanSource(source, cwd), ...timeoutArg(args) })).text;
  },
  list_edges: async (session) => edgesView(new BoardRefs(await readBoard(session.client))).text,
  remove_edge: async (session, args) => (await removeEdge(session, stringArg(args, 'edge'))).text,
  move: async (session, args) => (await moveTile(session, stringArg(args, 'tile'), placeArgs(args))).text,
  arrange: async (session, args) =>
    (await arrangeZone(session, stringArg(args, 'zone', true), { by: stringArg(args, 'by', true), layout: stringArg(args, 'layout', true) })).text,
  add_note: async (session, args) =>
    (
      await addNote(session, {
        text: stringArg(args, 'text'),
        kind: stringArg(args, 'kind', true),
        color: stringArg(args, 'color', true),
        ...placeArgs(args),
      })
    ).text,
  edit_note: async (session, args) => {
    const text = stringArg(args, 'text', true);
    const color = stringArg(args, 'color', true);
    if (text === undefined && color === undefined) throw new BoardError('give the text or the color');
    return (await editNote(session, stringArg(args, 'note'), { text, color })).text;
  },
  remove_note: async (session, args) => (await removeNote(session, stringArg(args, 'note'))).text,
  roles: async (session) => (await defaultRolesView(session)).text,
  set_role: async (session, args) =>
    (await setDefaultRole(session, stringArg(args, 'name'), stringArg(args, 'template'), stringArg(args, 'zone', true))).text,
  remove_role: async (session, args) => (await removeDefaultRole(session, stringArg(args, 'name'), stringArg(args, 'zone', true))).text,
};

/** A layout tool's place, as `agent-board move` takes it. */
function placeArgs(args: Record<string, unknown>): PlaceOptions {
  return { to: stringArg(args, 'to', true), at: stringArg(args, 'at', true), near: stringArg(args, 'near', true), side: stringArg(args, 'side', true) };
}

/** Who the context's board token is, or null when there is none or the daemon can't say. Never throws. */
async function whoIs(context: BoardMcpContext): Promise<BoardCaller | null> {
  try {
    const session = await context.openSession();
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
  context: BoardMcpContext,
  signal: AbortSignal,
): Promise<string> {
  const session = await context.openSession();
  if (signal.aborted) session.close();
  else signal.addEventListener('abort', () => session.close(), { once: true });
  try {
    return await call(session, args, context.cwd());
  } finally {
    session.close();
  }
}

/** The MCP methods, over the context's board sessions: the same for either transport. */
export function boardMcpHandlers(context: BoardMcpContext): RpcHandlers<McpMethods, McpCall> {
  return {
    initialize: async (params) => {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const orchestrating = (await whoIs(context))?.orchestrate != null;
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
      tools: (await whoIs(context))?.orchestrate != null ? [...BOARD_MCP_TOOLS, ...ORCHESTRATOR_MCP_TOOLS] : BOARD_MCP_TOOLS,
    }),
    'tools/call': async (params, { signal }) => {
      const { name, arguments: args = {} } = (params ?? {}) as McpMethods['tools/call']['params'];
      const call = typeof name === 'string' && Object.hasOwn(TOOL_CALLS, name) ? TOOL_CALLS[name]! : undefined;
      if (call === undefined) throw new RpcMethodError(RPC_ERROR.invalidParams, `no tool ${String(name)}`);
      try {
        return { content: [{ type: 'text', text: await callTool(call, args, context, signal) }] };
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
  const handlers = boardMcpHandlers({ openSession: () => openBoardSession(options.env), cwd: () => process.cwd() });
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
