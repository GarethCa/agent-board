// `agent-board <command>`: the board's command line for agents and people (ADR-0010). Its help is the documentation an
// agent reads, so it teaches the concepts as well as the commands.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  activityView,
  addEdge,
  agentsView,
  BoardError,
  BoardRefs,
  closeAgent,
  edgesView,
  handOff,
  identifyView,
  interruptAgent,
  newAgent,
  openBoardSession,
  edgeRules,
  readAgent,
  readBoard,
  removeEdge,
  sendToAgent,
  setOrchestrate,
  setOwnStatus,
  shellsView,
  showView,
  treeView,
  waitForAgents,
  zonesView,
  type BoardSession,
  type BoardView,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import {
  AGENT_STATES,
  BOARD_CALLER_METHODS,
  DEFAULT_ACTIVITY_LIMIT,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  isAgentState,
  isStatusProgress,
  MAX_ACTIVITY_LIMIT,
  ORCHESTRATE_SETTING,
  MAX_ORCHESTRATOR_WAIT_MS,
  MAX_STATUS_LENGTH,
  ORCHESTRATE_SCOPES,
  ORCHESTRATOR_METHODS,
  statusLine,
  type AgentState,
  type OrchestrateScope,
} from './protocol.ts';

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
  edge    A flow from one agent to another. When the first hands off (it runs
          \`agent-board handoff\`, its turn ends, or the user presses Send), what the edge
          carries (a message, a handover file or JSON) is sent to the second as its next
          message, once the edge's conditions pass. \`connections\` in the MCP, or
          \`show me\`, lists yours.
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
  handoff [--to <ref>] [--message <text>] [--handover <path>] [--data <json>]
                        Hand your finished work to the next agent over your own outgoing
                        edges, once it is ready. See \`handoff --help\`.
  mcp                   Serve these as MCP tools on stdio, for a harness.
  rpc <method> [json]   Call a daemon method directly and print its JSON result. In a session,
                        only the reads above and your own status (and, for an orchestrator,
                        the orchestrator commands).

  Read commands take --json. \`agent-board <command> --help\` says more about one.

ORCHESTRATING
  An agent the user lets orchestrate can start, message, watch and close other agents, as a
  lead does with workers: in its zone (or its repo, or the whole board, as the user chose),
  and always the agents it started. \`identify\` says whether you may. The agents you start are
  linked to you on the board and never orchestrate. Each start, message, interrupt and close
  is logged for the user. \`agent-board help orchestrate\` shows the loop.

  new [options] [--] <prompt>
                        Start an agent with <prompt> as its first message.
  send <ref> [--] <message>
                        Send an agent its next message, once its turn has ended.
  wait <ref>...         Wait until each agent's turn has ended: it is at its prompt, needs
                        the user, or has stopped.
  read <ref> [<path>]   An agent's final message, or a file in its worktree.
  interrupt <ref>       Stop an agent's turn; it waits at its prompt.
  close <ref> [--remove]
                        End an agent's session. --remove deletes it with its worktree and
                        branch: only an agent you started, with nothing unsaved.
  edge add <from> <to> --carries message|handover|json
                        Join two agents (or you) with an edge, marked as made by you.
  edge list             Every edge (as \`edges\`).
  edge remove <ref>     Remove an edge you made.

FOR THE USER
  orchestrate on|off <ref> [--scope zone|repo|board]
                        Let an agent orchestrate, or stop it: in a terminal outside
                        agent-board, never from a session on the board.
  activity [--of <ref>] What orchestrators did and tried, newest first.

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
    text: `Serves the board as MCP tools on stdio: whoami, board, connections, handoff and set_status, and
for an agent that may orchestrate as it starts, new_agent, send, wait, read, interrupt, close,
add_edge and remove_edge. The
app adds it to the agents it starts; add it to another Claude with:

  claude mcp add agent-board -- agent-board mcp`,
  },
  orchestrate: {
    usage: 'agent-board orchestrate on|off <ref> [--scope zone|repo|board]',
    text: `Orchestrating: one agent leading others, as a lead hands work to workers and reviewers and
reads what they hand back.

The agents the user starts in a zone may orchestrate there, unless the user turns that off
for the zone (${ORCHESTRATE_SETTING}). An agent an orchestrator starts
never does. The user can also let one agent orchestrate with \`agent-board orchestrate on <ref>\`
in a terminal outside agent-board; never from a session on the board, a shell tile's included,
so no agent lets itself or another orchestrate.
--scope says where it may act:
  zone    the agents in the zone its tile is in, and starting agents there (the default)
  repo    the agents of its repo, in any zone of it
  board   any agent, in any zone
It may always act on the agents it started, wherever they are, and never on itself. It may
read and wait for another orchestrator, but steer one (send, interrupt, close) only with the
board scope: a message runs under the permissions of the agent that gets it.

As an orchestrator, a loop of implementing and reviewing looks like this:
  agent-board new --name impl -- 'Fix the flaky login test. Commit on your branch, write
    .agent-board/handover.md, and end with STATUS: done.'
  agent-board wait impl                      until its turn ends
  agent-board read impl                      its final message
  agent-board read impl .agent-board/handover.md
  agent-board new --base agent:impl --role reviewer --name review -- 'Review the diff against main'
  agent-board wait review && agent-board read review
  agent-board send impl -- 'Fix the review points: ...'
  agent-board close review --remove

Or wire them once and let hand-offs carry the work: the implementer hands its handover to the
reviewer by itself (\`agent-board handoff\`, or as its turn ends), once the gate is green:
  agent-board edge add impl review --carries handover --path .agent-board/handover.md \\
    --condition 'gate:pnpm check:local'
A gate or script condition runs nothing until the user approves it in the edge's rules.

What it can't do: answer a permission prompt (the user does), approve an edge's gate or
script, change a permission mode, a model or a setting, send a harness command (a prompt or
message starting with ! or a /command; a plugin's namespaced /plugin:command is fine) or any
control character, start an agent from a base whose project config (.claude, .mcp.json,
.codex) differs from the repo's HEAD, remove an agent or an edge it didn't make, or start an
agent that orchestrates. An agent it starts works in its own worktree and branch, as any
agent does.

  --scope <scope>   zone (the default), repo or board.
  --json            Print the agent as JSON.`,
  },
  new: {
    usage:
      'agent-board new [--zone <ref>] [--name <name>] [--harness claude|codex] [--model <model>] [--role <role>] ' +
      '[--branch <branch>] [--base <branch or agent ref>] [--issue <id>] [--file <path>] [--] <prompt>',
    text: `Starts an agent with <prompt> (or the text of --file) as its first message, in a new worktree and
branch of its zone's repo, as the user starts one. You must be an orchestrator: see
\`agent-board help orchestrate\`. It prints the new agent's ref.

  --zone <ref>       A zone in your scope; your own by default.
  --name <name>      Its tile's name; made from the prompt without.
  --harness <h>      claude (the default) or codex.
  --model <model>    The harness's model; its default without.
  --role <role>      implementer, reviewer or follow-up-reviewer.
  --branch <name>    Its new branch; made from its name without.
  --base <b>         The branch to cut it from, or an agent's ref (agent:9c1e, agent:impl) for
                     that agent's branch, as for a reviewer of its work; the repo's HEAD without.
                     Refused when its project config (.claude, .mcp.json, .codex) differs
                     from HEAD's.
  --issue <id>       An issue in the zone's tracker: it comes first in the prompt.
  --file <path>      Read the prompt from a file.
  --json             Print the agent as JSON.`,
  },
  send: {
    usage: 'agent-board send <ref> [--file <path>] [--] <message>',
    text: `Sends the agent <message> (or the text of --file) as its next message, as the user typing it
would. Only once its turn has ended: wait for it first, or interrupt it. Never to an agent
that needs the user's permission, and never a harness command (a message starting with ! or
a /command other than a plugin's /plugin:command). Only printable text, tabs and line
breaks: no control characters.

  --file <path>   Read the message from a file.
  --json          Print the agent as JSON.`,
  },
  wait: {
    usage: 'agent-board wait <ref>... [--until <state,...>] [--any] [--timeout <seconds>]',
    text: `Waits until each agent's turn has ended: it is at its prompt (idle or waiting), needs the user,
failed, was rate-limited, or has stopped. A turn you started with \`new\` or \`send\` counts
only once it has begun, so wait straight after them. Prints each agent's line.

Exits 0 when they are there, and 3 when it gave up first: wait again.

  --until <states>   Wait for these states instead, by comma: ${AGENT_STATES.join(', ')}.
  --any              Until one of them is there, not all.
  --timeout <s>      Give up after this many seconds: ${DEFAULT_ORCHESTRATOR_WAIT_MS / 1000} by default, at most ${MAX_ORCHESTRATOR_WAIT_MS / 1000}.
                     Your shell tool may stop a command sooner (Claude's Bash, after 2 minutes).
  --json             Print them as JSON.`,
  },
  read: {
    usage: 'agent-board read <ref> [<path>] [--json]',
    text: `Prints the agent's final message from the turn it last finished, or with <path> a text file in
its worktree (relative to it, such as .agent-board/handover.md), which must stay inside it.

${READ_FLAGS}`,
  },
  interrupt: {
    usage: 'agent-board interrupt <ref> [--json]',
    text: `Interrupts the agent's turn, as Ctrl-C in its terminal would: it waits at its prompt.

  --json   Print the agent as JSON.`,
  },
  close: {
    usage: 'agent-board close <ref> [--remove] [--json]',
    text: `Ends the agent's session, as the user stopping it would. Its tile, worktree and branch stay.

  --remove   Delete it with its worktree and branch instead: only an agent you started, never
             one with uncommitted changes or commits no other branch has, and never one
             with a reviewer the user started.
  --json     Print the agent as JSON.`,
  },
  activity: {
    usage: 'agent-board activity [--of <ref>] [--limit <n>] [--json]',
    text: `What orchestrators did and tried, newest first: each start, message, interrupt and close, done
or refused (and why).

  --of <ref>     One orchestrator's alone.
  --limit <n>    At most this many lines: ${DEFAULT_ACTIVITY_LIMIT} by default.
  --json         Print it as JSON instead.`,
  },
  handoff: {
    usage: 'agent-board handoff [--to <ref>] [--message <text>] [--handover <path>] [--data <json>] [--json]',
    text: `Hands your finished work to the next agent: along each edge out of your tile (\`agent-board show
me\` lists them), or with --to along your edge to that agent alone. You hand off only along
your own edges; an edge's conditions are checked first, so a hand-off may be held until they
pass. A manual edge is left for the user to send. Each hand-off is logged for the user.

Each edge takes what it carries: an edge carrying a message takes --message (your result, in
your words); a handover edge the file --handover (its own file, such as handover.md, without);
a JSON edge --data (its own file without). Call it once the work is ready: when your turn
ends, the edges you handed off along aren't handed off along again.

  --to <ref>         One agent you have an edge to.
  --message <text>   The message.
  --handover <path>  A markdown file in your worktree, relative to it.
  --data <json>      A JSON value.
  --json             Print how it went as JSON.`,
  },
  edge: {
    usage:
      'agent-board edge add <from> <to> --carries message|handover|json [--path <file>] [--trigger auto|manual] ' +
      '[--condition <c>]... | edge list | edge remove <ref>',
    text: `Edges between agents, for an orchestrator (\`agent-board help orchestrate\`). \`edge list\` lists
every edge, as \`agent-board edges\` does, and anyone may.

\`edge add\` joins <from> to <to>: when <from> hands off, what the edge carries goes to <to> as
its next message. Both must be in your scope, or you (\`me\`); <to> may not be another
orchestrator unless your scope is the whole board. The edge is marked as made by you, and the
user can change or remove it like any other. \`edge remove\` removes an edge you made.

  --carries <c>      message (<from>'s final message, or what it hands off), handover (a
                     markdown file) or json (a JSON file).
  --path <file>      The file, relative to <from>'s worktree: handover.md or handoff.json without.
  --trigger <t>      auto (the default: as <from> hands off) or manual (the user sends it).
  --condition <c>    Must pass first; repeat for more: gate:<command> (it passes in <from>'s
                     worktree), pr-checks, label:<label> (on <from>'s issue), script:<command>
                     (it exits 0). A gate or script runs nothing until the user approves it.
  --json             Print the edge as JSON.`,
  },
  rpc: {
    usage: "agent-board rpc <method> ['<json params>']",
    text: `Calls one of the daemon's JSON-RPC methods (as the app does) and prints its result as JSON, such as
\`agent-board rpc agent.list\`.

In an agent-board session, which has AGENT_BOARD_IDENTITY, it reaches only what the other
commands do:

${[...BOARD_CALLER_METHODS].map((method) => `  ${method}`).join('\n')}

and, for an agent the user lets orchestrate, the orchestrator commands:

${[...ORCHESTRATOR_METHODS].map((method) => `  ${method}`).join('\n')}

Everything else (typing to, answering for or stopping a session directly, changing a setting) is
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
 * a bad ref, a refused call), 2 for bad arguments, 3 when `wait` gave up first. `out` and `err` take what it prints.
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
    const { text, code } = typeof result === 'string' ? { text: result, code: 0 } : result;
    io.out(text.endsWith('\n') ? text : `${text}\n`);
    return code;
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

/** Exit code of a `wait` that gave up before the agents were there. */
const WAIT_TIMED_OUT = 3;

const OPTIONS = {
  json: { type: 'boolean' },
  progress: { type: 'string' },
  zone: { type: 'string' },
  name: { type: 'string' },
  harness: { type: 'string' },
  model: { type: 'string' },
  role: { type: 'string' },
  branch: { type: 'string' },
  base: { type: 'string' },
  issue: { type: 'string' },
  file: { type: 'string' },
  until: { type: 'string' },
  any: { type: 'boolean' },
  timeout: { type: 'string' },
  remove: { type: 'boolean' },
  scope: { type: 'string' },
  of: { type: 'string' },
  limit: { type: 'string' },
  to: { type: 'string' },
  message: { type: 'string' },
  handover: { type: 'string' },
  data: { type: 'string' },
  carries: { type: 'string' },
  path: { type: 'string' },
  trigger: { type: 'string' },
  condition: { type: 'string', multiple: true },
} as const;

type Option = keyof typeof OPTIONS;

/** The options each command takes beyond `--json` (which every one but `status`'s set, `rpc` and `mcp` takes too). */
export const COMMAND_OPTIONS: Record<string, readonly Option[]> = {
  status: ['progress'],
  new: ['zone', 'name', 'harness', 'model', 'role', 'branch', 'base', 'issue', 'file'],
  send: ['file'],
  wait: ['until', 'any', 'timeout'],
  close: ['remove'],
  orchestrate: ['scope'],
  activity: ['of', 'limit'],
  handoff: ['to', 'message', 'handover', 'data'],
  edge: ['carries', 'path', 'trigger', 'condition'],
};

/** A command's result: what it prints, and its exit code (0 for a bare string). */
type CommandResult = string | { text: string; code: number };

/** A command's arguments, checked before any connection is made, as what to run once one is. */
function parseCommand(command: string, args: string[]): (session: BoardSession) => Promise<CommandResult> {
  let values: Partial<Record<Option, string | boolean | string[]>>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const takes = new Set<Option>(['json', ...(COMMAND_OPTIONS[canonical(command)] ?? [])]);
  for (const option of Object.keys(values) as Option[]) {
    if (!takes.has(option)) {
      throw new UsageError(option === 'progress' ? '--progress is only for `status set`' : `--${option} is not an option of ${command}`);
    }
  }
  const string = (option: Option) => values[option] as string | undefined;
  const print = (view: BoardView) => (values.json ? JSON.stringify(view.json, null, 2) : view.text);
  const noPositionals = () => {
    if (positionals.length > 0) throw new UsageError(`unexpected ${positionals.join(' ')}`);
  };
  const read = (view: (refs: BoardRefs, session: BoardSession) => BoardView) => {
    noPositionals();
    return async (session: BoardSession) => print(view(new BoardRefs(await readBoard(session.client)), session));
  };
  /** The text of --file, or else the positionals from `from` on, joined by spaces. */
  const text = (from: number): string => {
    const file = string('file');
    if (file === undefined) return positionals.slice(from).join(' ');
    if (positionals.length > from) throw new UsageError('give the text or --file, not both');
    try {
      // A file's CRLF line ends are line breaks; a carriage return alone would be refused as a control character.
      return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    } catch (error) {
      throw new UsageError(`can't read ${file}: ${(error as Error).message}`);
    }
  };
  /** One agent ref, the only positional. */
  const oneRef = () => {
    if (positionals.length !== 1) throw new UsageError('give one agent ref');
    return positionals[0]!;
  };
  const wholeNumber = (option: Option, max: number) => {
    const raw = string(option);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new UsageError(`--${option} must be a whole number from 0 to ${max}`);
    return value;
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
      const progress = string('progress') === undefined ? undefined : Number(string('progress'));
      if (progress !== undefined && !isStatusProgress(progress)) {
        throw new UsageError('--progress must be a whole number from 0 to 100');
      }
      return async (session) => {
        const agent = await setOwnStatus(session, summary, progress);
        if (values.json) return JSON.stringify(agent, null, 2);
        return `status set: ${statusLine(agent.status!)}`;
      };
    }
    case 'new': {
      const prompt = text(0);
      return async (session) =>
        print(
          await newAgent(session, {
            prompt,
            zone: string('zone'),
            name: string('name'),
            harness: string('harness'),
            model: string('model'),
            role: string('role'),
            branch: string('branch'),
            base: string('base'),
            issue: string('issue'),
          }),
        );
    }
    case 'send': {
      const ref = positionals[0];
      if (ref === undefined) throw new UsageError('give an agent ref and a message');
      const message = text(1);
      if (message.trim() === '') throw new UsageError('give a message');
      return async (session) => print(await sendToAgent(session, ref, message));
    }
    case 'wait': {
      if (positionals.length === 0) throw new UsageError('give one or more agent refs');
      const until = string('until')?.split(',').map((state) => state.trim()) as AgentState[] | undefined;
      const unknown = until?.find((state) => !isAgentState(state));
      if (unknown !== undefined) throw new UsageError(`${unknown} is not a state: ${AGENT_STATES.join(', ')}`);
      const seconds = wholeNumber('timeout', MAX_ORCHESTRATOR_WAIT_MS / 1000);
      return async (session) => {
        const view = await waitForAgents(session, positionals, {
          until,
          any: values.any === true,
          timeoutMs: seconds === undefined ? undefined : seconds * 1000,
        });
        return { text: print(view), code: view.timedOut ? WAIT_TIMED_OUT : 0 };
      };
    }
    case 'read': {
      if (positionals.length < 1 || positionals.length > 2) throw new UsageError('give an agent ref, and optionally a path');
      const [ref, path] = positionals as [string, string | undefined];
      return async (session) => {
        const view = await readAgent(session, ref, path);
        return values.json ? print(view) : view.text;
      };
    }
    case 'interrupt': {
      const ref = oneRef();
      return async (session) => print(await interruptAgent(session, ref));
    }
    case 'close': {
      const ref = oneRef();
      return async (session) => print(await closeAgent(session, ref, values.remove === true));
    }
    case 'orchestrate': {
      const [onOff, ref, ...rest] = positionals;
      if ((onOff !== 'on' && onOff !== 'off') || ref === undefined || rest.length > 0) throw new UsageError('give on or off, and one agent ref');
      const scope = string('scope') ?? 'zone';
      if (!ORCHESTRATE_SCOPES.includes(scope as OrchestrateScope)) throw new UsageError(`--scope must be ${ORCHESTRATE_SCOPES.join(', ')}`);
      if (onOff === 'off' && string('scope') !== undefined) throw new UsageError('--scope is only for `orchestrate on`');
      return async (session) => print(await setOrchestrate(session, ref, onOff === 'on' ? (scope as OrchestrateScope) : null));
    }
    case 'handoff': {
      noPositionals();
      const raw = string('data');
      let json: unknown;
      if (raw !== undefined) {
        try {
          json = JSON.parse(raw);
        } catch {
          throw new UsageError('--data must be JSON');
        }
      }
      return async (session) =>
        print(await handOff(session, { to: string('to'), message: string('message'), handoverPath: string('handover'), json }));
    }
    case 'edge': {
      const [sub, ...rest] = positionals;
      const flags = (['carries', 'path', 'trigger', 'condition'] as const).filter((option) => values[option] !== undefined);
      if (sub !== 'add' && flags.length > 0) throw new UsageError(`--${flags[0]} is only for \`edge add\``);
      if (sub === 'list') {
        if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
        return async (session) => print(edgesView(new BoardRefs(await readBoard(session.client))));
      }
      if (sub === 'remove') {
        if (rest.length !== 1) throw new UsageError('give one edge ref');
        return async (session) => print(await removeEdge(session, rest[0]!));
      }
      if (sub !== 'add') throw new UsageError('the edge commands are `edge add`, `edge list` and `edge remove`');
      if (rest.length !== 2) throw new UsageError('give the agent it flows from and the one it flows to');
      const [from, to] = rest as [string, string];
      const options = { from, to, carries: string('carries'), path: string('path'), trigger: string('trigger'), conditions: (values.condition as string[] | undefined) ?? [] };
      // Checked before it connects, as every command's arguments are.
      try {
        edgeRules(options);
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
      return async (session) => print(await addEdge(session, options));
    }
    case 'activity': {
      noPositionals();
      const limit = wholeNumber('limit', MAX_ACTIVITY_LIMIT);
      return async (session) => print(await activityView(session, string('of'), limit));
    }
    case 'rpc': {
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
