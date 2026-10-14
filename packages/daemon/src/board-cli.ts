// `agent-board <command>`: the board's command line for agents and people (ADR-0010). Its help is the documentation an
// agent reads, so it teaches the concepts as well as the commands.
import { parseArgs } from 'node:util';
import {
  agentsView,
  BoardError,
  BoardRefs,
  edgesView,
  identifyView,
  openBoardSession,
  readBoard,
  setOwnStatus,
  shellsView,
  showView,
  treeView,
  zonesView,
  type BoardSession,
  type BoardView,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import { BOARD_CALLER_METHODS, isStatusProgress, MAX_STATUS_LENGTH, statusLine } from './protocol.ts';

export const BOARD_HELP = `agent-board: the board you are on. agent-board is a desktop app that shows coding agents
(Claude Code, Codex) and plain shells as tiles on one infinite board. This command reads that
board, and lets an agent say what it is doing.

CONCEPTS
  zone    A coloured region of the board. A repo zone is bound to a git repo (or a folder in
          one); a group is bound to none. Where a tile sits is only where it is drawn: moving
          it changes nothing about its session.
  tile    One session on the board, in a zone or loose: an agent or a shell.
  agent   A session running claude or codex in its own git worktree and branch. It has a
          state (running, thinking, waiting, needs-permission, idle, rate-limited, failed,
          done, ...) and a status: one line it sets to say what it is doing now.
  shell   A tile of plain shell panes.
  edge    A flow from one agent to another. When the first hands off (its turn ends, or the
          user presses Send), what the edge carries (that agent's final message, or a file
          from its worktree) is sent to the second as its next message, once the edge's
          conditions pass.
  item    A sticky note, text, shape, image, link card or issue card on the board.

REFS
  Commands name things by ref: <kind>:<start of its id>, as the board lists them
  (zone:4f2a, agent:9c1e, shell:07bd, edge:e5aa, item:31f0). A whole id works, and so does a
  unique name, alone or after its kind (fix-tests, zone:web). \`me\` is your own tile. A name
  that more than one thing has is an error listing them.

COMMANDS
  identify              Who and where you are: your tile, its zone, your state and status.
  tree                  Every zone with its tiles and items, then what is loose on the board.
  zones                 Every zone.
  agents (or ls)        Every agent: state, status (or task) and zone.
  shells                Every shell tile.
  edges                 Every edge: its two agents, what it carries, when, and how it stands.
  show <ref>            Everything about one zone, agent, shell, edge or item.
  status set <summary> [--progress <0-100>]
                        Set your own tile's status (agents only). See \`status --help\`.
  mcp                   Serve these as MCP tools on stdio, for a harness.
  rpc <method> [json]   Call a daemon method directly and print its JSON result. In a session,
                        only the reads above and your own status.

  Read commands take --json. \`agent-board <command> --help\` says more about one.
  Starting, messaging and stopping other agents is not here yet.

ENVIRONMENT
  The app sets these in every session it starts:
  AGENT_BOARD_SOCKET      The daemon's socket.
  AGENT_BOARD_IDENTITY    Your session's board token: it says which tile you are.
  AGENT_BOARD_SESSION_ID  Your session.
  AGENT_BOARD_ZONE_ID     The zone your tile was in as it started. It may have moved since;
                          \`identify\` says where it is now.
  Outside a session the CLI finds the daemon of $AGENT_BOARD_DATA_DIR, else the app's own,
  and reads the board as you, setting no status.
`;

interface CommandHelp {
  usage: string;
  text: string;
}

const READ_FLAGS = '  --json   Print it as JSON instead.';

export const COMMAND_HELP: Record<string, CommandHelp> = {
  identify: {
    usage: 'agent-board identify [--json]',
    text: `Who and where you are: your tile's ref and name, whether it is an agent or a shell tile, the zone
it is in now (or loose), and for an agent its state, status and branch.

Outside an agent-board session it says so: you can read the board, but have no tile.

${READ_FLAGS}`,
  },
  tree: {
    usage: 'agent-board tree [--json]',
    text: `Every zone, with the tiles and items in it, then the tiles and items loose on the board. A zone
line says what it is bound to (repo, folder, or group); an agent line its state in [brackets]
and its status, or its task until it sets one. ← marks you.

${READ_FLAGS}`,
  },
  zones: {
    usage: 'agent-board zones [--json]',
    text: `Every zone: its ref, name, what it is bound to and how many tiles it holds.

${READ_FLAGS}`,
  },
  agents: {
    usage: 'agent-board agents [--json]   (or: agent-board ls)',
    text: `Every agent: its ref, name, [state], status (or task) and zone.

${READ_FLAGS}`,
  },
  shells: {
    usage: 'agent-board shells [--json]',
    text: `Every shell tile: its ref, name, the folder its first pane is in, and its zone.

${READ_FLAGS}`,
  },
  edges: {
    usage: 'agent-board edges [--json]',
    text: `Every edge: the agent it flows from and the one it flows to (with their states), what it carries
(the first agent's final message, or a file from its worktree), when (as that agent's turn
ends, or when the user presses Send), the conditions that must pass first, and how it stands
(paused, holding a hand-off, last delivered or skipped).

${READ_FLAGS}`,
  },
  show: {
    usage: 'agent-board show <ref> [--json]',
    text: `Everything about one zone, agent, shell, edge or item. \`agent-board show me\` shows your own tile.

${READ_FLAGS}`,
  },
  status: {
    usage: 'agent-board status set <summary> [--progress <0-100>]',
    text: `Sets your own tile's status: one line, at most ${MAX_STATUS_LENGTH} characters, saying what you are doing
now, as the change you are making ("Moving session ids to the daemon"), not the task you were
given. Your tile shows it in place of your task. Set it once you understand the work, and again
when its direction changes. --progress is how far through you are, 0 to 100.

Only an agent can, and only its own. Setting it again replaces it; a person editing it by hand
is replaced the same way, whoever writes last. A summary that starts with a dash goes after --:
\`agent-board status set --progress 50 -- -v now works\`.

  --progress <n>   0 to 100.
  --json           Print the agent as JSON.`,
  },
  mcp: {
    usage: 'agent-board mcp',
    text: `Serves the board as MCP tools on stdio: whoami, board, connections and set_status. The app adds it
to the agents it starts; add it to another Claude with:

  claude mcp add agent-board -- agent-board mcp`,
  },
  rpc: {
    usage: "agent-board rpc <method> ['<json params>']",
    text: `Calls one of the daemon's JSON-RPC methods (as the app does) and prints its result as JSON, such as
\`agent-board rpc agent.list\`.

In an agent-board session, which has AGENT_BOARD_IDENTITY, it reaches only what the other
commands do:

${[...BOARD_CALLER_METHODS].map((method) => `  ${method}`).join('\n')}

Everything else (starting, typing to, answering for or stopping a session, changing a setting) is
refused. Outside a session it reaches every method, as the app does.`,
  },
};

/** The command `command` names: `ls` is `agents`. */
const canonical = (command: string) => (command === 'ls' ? 'agents' : command);

/** The help for `command`, or undefined if there is no such command. */
function commandHelp(command: string): string | undefined {
  const help = COMMAND_HELP[canonical(command)];
  return help === undefined ? undefined : `usage: ${help.usage}\n\n${help.text}\n`;
}

export const BOARD_COMMANDS = new Set([...Object.keys(COMMAND_HELP), 'ls', 'help']);

/** An exit code with a message for stderr. */
class UsageError extends Error {}

/**
 * Runs a board command (`BOARD_COMMANDS`) and resolves to its exit code: 0 when it worked, 1 when it failed (no daemon,
 * a bad ref, a refused call), 2 for bad arguments. `out` and `err` take what it prints.
 */
export async function runBoardCommand(
  command: string,
  args: string[],
  io: { out(text: string): void; err(text: string): void; env?: NodeJS.ProcessEnv } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
): Promise<number> {
  if (command === 'help') {
    const help = args[0] === undefined || args[0] === '--help' || args[0] === '-h' ? BOARD_HELP : commandHelp(args[0]);
    if (help === undefined) {
      io.err(`agent-board: no command ${args[0]}\n\n${BOARD_HELP}`);
      return 2;
    }
    io.out(help);
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    io.out(commandHelp(command)!);
    return 0;
  }
  if (command === 'mcp') {
    const { serveBoardMcp } = await import('./board-mcp.ts');
    return serveBoardMcp({ env: io.env });
  }
  let session: BoardSession | undefined;
  try {
    const parsed = parseCommand(command, args);
    session = await openBoardSession(io.env);
    const result = await parsed(session);
    io.out(result.endsWith('\n') ? result : `${result}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`agent-board ${command}: ${error.message}\nusage: ${COMMAND_HELP[canonical(command)]!.usage}\n`);
      return 2;
    }
    if (error instanceof BoardError || error instanceof DaemonRpcError) {
      io.err(`agent-board ${command}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    session?.close();
  }
}

/** A command's arguments, checked before any connection is made, as what to run once one is. */
function parseCommand(command: string, args: string[]): (session: BoardSession) => Promise<string> {
  const options = {
    json: { type: 'boolean' },
    progress: { type: 'string' },
  } as const;
  let values: { json?: boolean; progress?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const print = (view: BoardView) => (values.json ? JSON.stringify(view.json, null, 2) : view.text);
  const noPositionals = () => {
    if (positionals.length > 0) throw new UsageError(`unexpected ${positionals.join(' ')}`);
  };
  const noProgress = () => {
    if (values.progress !== undefined) throw new UsageError('--progress is only for `status set`');
  };
  const read = (view: (refs: BoardRefs, session: BoardSession) => BoardView) => {
    noPositionals();
    noProgress();
    return async (session: BoardSession) => print(view(new BoardRefs(await readBoard(session.client)), session));
  };

  switch (command) {
    case 'identify':
      return read((refs, session) => identifyView(refs, session.caller, session.socketPath));
    case 'tree':
      return read((refs, session) => treeView(refs, session.caller));
    case 'zones':
      return read((refs) => zonesView(refs));
    case 'agents':
    case 'ls':
      return read((refs, session) => agentsView(refs, session.caller));
    case 'shells':
      return read((refs, session) => shellsView(refs, session.caller));
    case 'edges':
      return read((refs) => edgesView(refs));
    case 'show': {
      noProgress();
      if (positionals.length !== 1) throw new UsageError('give one ref');
      return async (session) => {
        const refs = new BoardRefs(await readBoard(session.client));
        return print(showView(refs, refs.resolve(positionals[0]!, session.caller), session.caller));
      };
    }
    case 'status': {
      if (positionals[0] !== 'set') throw new UsageError('the only status command is `status set`');
      const summary = positionals.slice(1).join(' ');
      if (summary.trim() === '') throw new UsageError('give a summary');
      const progress = values.progress === undefined ? undefined : Number(values.progress);
      if (progress !== undefined && !isStatusProgress(progress)) {
        throw new UsageError('--progress must be a whole number from 0 to 100');
      }
      return async (session) => {
        const agent = await setOwnStatus(session, summary, progress);
        if (values.json) return JSON.stringify(agent, null, 2);
        return `status set: ${statusLine(agent.status!)}`;
      };
    }
    case 'rpc': {
      noProgress();
      const [method, raw] = positionals;
      if (method === undefined || positionals.length > 2) throw new UsageError('give a method, and optionally its params as JSON');
      let params: unknown;
      try {
        params = raw === undefined ? undefined : JSON.parse(raw);
      } catch {
        throw new UsageError('the params must be JSON');
      }
      return async (session) => {
        const call = session.client.call as (method: string, params?: unknown) => Promise<unknown>;
        return JSON.stringify(await call(method, params), null, 2);
      };
    }
    default:
      throw new Error(`not a board command: ${command}`);
  }
}
