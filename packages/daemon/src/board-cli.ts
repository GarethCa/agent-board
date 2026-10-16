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
  defaultRolesView,
  edgesView,
  handOff,
  identifyView,
  interruptAgent,
  restartAgent,
  newAgent,
  openBoardSession,
  edgeRules,
  readAgent,
  readBoard,
  removeDefaultRole,
  removeEdge,
  sendToAgent,
  setDefaultRole,
  setOrchestrate,
  setOwnStatus,
  openOwnPullRequest,
  shellsView,
  showView,
  treeView,
  waitForAgents,
  watchCrew,
  zonesView,
  type BoardSession,
  type BoardView,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import { addGroup, addNote, arrangeZone, changeGroup, checkArrange, checkNote, checkPlace, editNote, moveTile, pointOf, removeGroup, removeNote, sizeOf } from './layout-ops.ts';
import {
  ARRANGE_BYS,
  ARRANGE_LAYOUTS,
  BOARD_CALLER_METHODS,
  CREW_EVENT_KINDS,
  DEFAULT_ACTIVITY_LIMIT,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  isCrewSince,
  isStatusProgress,
  isWaitState,
  MAX_ACTIVITY_LIMIT,
  ORCHESTRATE_SETTING,
  MAX_ORCHESTRATOR_WAIT_MS,
  MAX_STATUS_LENGTH,
  ORCHESTRATE_SCOPES,
  ORCHESTRATOR_METHODS,
  USER_SIDE_METHODS,
  statusLine,
  WAIT_STATES,
  type CrewEventKind,
  type OrchestrateScope,
  type WaitState,
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
          state (starting, running, thinking, waiting, needs-permission, idle, rate-limited, failed,
          done, ...) and a status: one line it sets to say what it is doing now.
  shell   A tile of plain shell panes.
  edge    A flow from one agent to another. When the first hands off (it runs
          \`agent-board handoff\`, its turn ends, or the user presses Send), what the edge
          carries (a message, a handover file or JSON) is sent to the second as its next
          message, once the edge's conditions pass. \`connections\` in the MCP, or
          \`show me\`, lists yours.
  item    A sticky note, text, shape, image, link card, issue card or agent note on the board.

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
  status set <summary> [--progress <0-100>] [--done]
                        Set your own tile's status (agents only); --done says your work is
                        finished. See \`status --help\`.
  open-pr               Open a draft pull request of your branch (agents only).
  handoff [--to <ref>] [--message <text>] [--handover <path>] [--data <json>]
                        Hand your finished work to the next agent over your own outgoing
                        edges, once it is ready, and say it is finished. See \`handoff --help\`.
  mcp                   Serve these as MCP tools on stdio, for a harness. Two are MCP tools
                        alone, as they wait on the user longer than a shell command runs:
                        ask (a question in the user's Needs you inbox) and present_plan (a
                        plan for them to approve, send back with changes, or reject).
  rpc <method> [json]   Call a daemon method directly and print its JSON result. In an agent's
                        session, only the reads above and your own status (and, for an
                        orchestrator, the orchestrator commands).

  Read commands take --json. \`agent-board <command> --help\` says more about one.

ORCHESTRATING
  An agent the user lets orchestrate can start, message, watch and close other agents, as a
  lead does with workers: in its zone (or its repo, or the whole board, as the user chose),
  and always the agents it started. \`identify\` says whether you may. The agents you start are
  linked to you on the board, and orchestrate as their zone lets them, up to three deep. In a
  shell, or a terminal outside agent-board, these act for the user on any agent. Each start,
  message, interrupt, restart and close is logged for the user. \`agent-board help
  orchestrate\` shows the loop.

  new [options] [--] <prompt>
                        Start an agent with <prompt> as its first message.
  send <ref> [--] <message>
                        Send an agent its next message, once its turn has ended.
  wait [<ref>...] [--crew] [--until finished]
                        Wait until each agent's turn has ended: it is at its prompt, needs
                        the user, or has stopped; or until it says its work is finished.
  watch [<ref>...] [--crew]
                        Print a line as each thing happens to your crew: a turn ended, it
                        finished, needs the user, failed, was rate-limited, ended, or a pull
                        request was opened. Each once.
  read <ref> [<path>]   An agent's final message, or a file in its worktree.
  interrupt <ref>       Stop an agent's turn; it waits at its prompt.
  restart <ref> [--fresh [--] [<prompt>]]
                        Start an ended agent again in its tile, worktree and branch, carrying
                        on its conversation; --fresh starts a new one instead.
  close <ref> [--remove]
                        End an agent's session. --remove deletes it with its worktree and
                        branch: only an agent you started (any, from a shell), with nothing
                        unsaved.
  edge add <from> <to> --carries message|handover|json
                        Join two agents (or you) with an edge, marked as made by you.
  edge list             Every edge (as \`edges\`).
  edge remove <ref>     Remove an edge you, or an agent you started, made.

  Laying out your zone, its tiles anywhere in your scope (and you), on its grid, what is in
  the way moving aside:
  move <ref> [--to <zone ref>] [--at <x>,<y>] [--near <ref> [--side below|right|left|above]]
                        Move a tile (an agent, a shell) or a note.
  arrange [<zone ref>] [--by issue|role|state] [--layout rows|grid]
                        Lay out your zone's tiles: you first, then a cluster per issue, its
                        agent note first, then its implementer and its reviewer.
  zone add --group --name <name> [--color <c>] [--at <x>,<y>] [--size <w>,<h>]
                        Make a group beside your zone. \`zone rename|resize|remove\` change
                        the groups you, or an agent you started, made.
  note add [--] <text> [--near <ref> [--side <s>]] [--color <c>] [--kind sticky|text]
                        Put a note on the board: --near an agent, in its cluster.
                        \`note edit|remove\` change yours.

  The app's default roles, for \`new --role <name>\` in any zone with no template of its own
  for the name:
  roles [list]          Each default role and its template's first line.
  roles set <name> [--file <path>] [--] <template>
                        Add or replace one. \`roles remove <name>\` removes one.

FOR THE USER
  orchestrate on|off <ref> [--scope zone|repo|board]
                        Let an agent orchestrate, or stop it: in a terminal or any shell,
                        never from an agent's own session.
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
  'open-pr': {
    usage: 'agent-board open-pr',
    text: `Opens a pull request of your branch, always as a draft: it pushes the commit at your worktree's
head and fills the repo's pull request template from .agent-board/handover.md, as the user's
Open PR does. Commit everything first; in a zone with a gate, the gate must have passed on that
commit. Marking it ready, running the gate and merging stay the user's.

  --json           Print the pull request as JSON.`,
  },
  status: {
    usage: 'agent-board status set <summary> [--progress <0-100>] [--done]',
    text: `Sets your own tile's status: one line, at most ${MAX_STATUS_LENGTH} characters, saying what you are doing
now, as the change you are making ("Moving session ids to the daemon"), not the task you were
given. Your tile shows it in place of your task. Set it once you understand the work, and again
when its direction changes. --progress is how far through you are, 0 to 100.

Only an agent can, and only its own. Setting it again replaces it; a person editing it by hand
is replaced the same way, whoever writes last. A summary that starts with a dash goes after --:
\`agent-board status set --progress 50 -- -v now works\`.

--done says your work is finished, not only this turn: your tile shows it, and an orchestrator
waiting with \`wait --until finished\` or watching with \`watch\` hears it once. Handing off
says so too. A turn that ends while your background work runs is not finished. Your next
prompt clears it.

  --progress <n>   0 to 100.
  --done           Your work is finished.
  --json           Print the agent as JSON.`,
  },
  mcp: {
    usage: 'agent-board mcp',
    text: `Serves the board as MCP tools on stdio: whoami, board, connections, handoff, ask, present_plan,
set_status and open_pr, and for an agent that may orchestrate as it starts, new_agent, send, wait, read,
interrupt, restart, close, add_edge, remove_edge, move, arrange, add_note, edit_note, remove_note,
roles, set_role and remove_role. The app adds it to the agents it starts; add it to another Claude
with:

  claude mcp add agent-board -- agent-board mcp`,
  },
  orchestrate: {
    usage: 'agent-board orchestrate on|off <ref> [--scope zone|repo|board]',
    text: `Orchestrating: one agent leading others, as a lead hands work to workers and reviewers and
reads what they hand back.

A live agent in a zone may orchestrate there while the zone lets it, unless the user turns
that off for the zone (${ORCHESTRATE_SETTING}) or for the agent. The agents an
orchestrator starts do too, up to three deep: the agents its agents start never do. The user
can also let one agent orchestrate with \`agent-board orchestrate on <ref>\`, in a terminal or
any shell on the board; never from an agent's own session, so no agent lets itself or another
orchestrate.

In a shell on the board (a shell tile, a tab, an ended agent's shell) or a terminal outside
agent-board, the orchestrator commands act for the user, on any agent and in any zone, logged
as that shell (or as you). The agents they start are the user's own.
--scope says where it may act:
  zone    the agents in the zone its tile is in, and starting agents there (the default)
  repo    the agents of its repo, in any zone of it
  board   any agent, in any zone
It may always act on the agents it started, wherever they are, and never on itself. It may
read and wait for another orchestrator, but not steer one (send, interrupt, restart, close, or
wire an edge into it) whose scope is wider than its own (board > repo > zone): a message runs
under the permissions of the agent that gets it.

As an orchestrator, a loop of implementing and reviewing looks like this:
  agent-board new --name impl -- 'Fix the flaky login test. Commit on your branch, write
    .agent-board/handover.md, and end with STATUS: done.'
  agent-board wait impl                      until its turn ends
  agent-board wait impl --until finished     or until it says its work is finished
  agent-board read impl                      its final message
  agent-board read impl .agent-board/handover.md
  agent-board new --base agent:impl --role reviewer --name review -- 'Review the diff against main'
  agent-board wait review && agent-board read review
  agent-board send impl -- 'Fix the review points: ...'
  agent-board close review --remove

Or watch the whole crew, a line as each finishes, needs the user, fails or opens a pull request:
  agent-board watch --crew --count 1 --since <c>   one line at a time, from the last line's [c]

Give an agent that is neither an implementer nor a reviewer a role of its own name, which its
tile, \`tree\` and its \`identify\` show: \`--role designer\`, \`--role 'release prep'\`. It starts
with its zone's template for the name, else the app's default role of that name, else with
your prompt alone. Only the reviewer roles start on a detached checkout. Keep a template for a
name every zone can use with \`agent-board roles set designer -- '<template>'\`.

Or wire them once and let hand-offs carry the work: the implementer hands its handover to the
reviewer by itself (\`agent-board handoff\`, or as its turn ends), once the gate is green:
  agent-board edge add impl review --carries handover --path .agent-board/handover.md \\
    --condition 'gate:pnpm check:local'
A gate or script condition runs nothing until the user approves it in the edge's rules.

A reviewer you start from an agent's branch (--base agent:impl, or --base <its branch>) is joined to that
agent by itself, both ways, as manual edges: findings back, and the next round. Wire them to hand off
by themselves with edge add, reviewer to impl (findings back) and impl to reviewer (next round), but
keep one of the two manual: two auto edges in a loop re-trigger each other, and a loop of them is
refused. Never join them to your own tile: lines from you to every agent you start only clutter the board.

Keep the crew tidy as it grows: arrange lays out your zone, you first, then one cluster per
issue (or unit of work): its label, an agent note saying where each agent stands,
then the implementer and its reviewer, left to right. Send fix rounds back
to the same implementer and reviewer, so each unit stays one pair. move, zone and note do the
rest:
  agent-board arrange                        or: --by role, --by state, --layout grid
  agent-board move review --near impl --side right
  agent-board zone add --group --name 'Done'
  agent-board move impl --to Done
  agent-board note add --near impl -- 'Waiting on the gate'
Each places what it moves clear of what is there, growing the zone to hold it, never over
another zone. You may move any tile in your scope, and yourself within your zone (at zone
scope your zone is your scope: you can't leave it), but never an agent into a zone that would
let it orchestrate; you may change or remove only the groups and notes you, or an agent you
started, made. A group you make lets no agent orchestrate. A zone bound to a repo is the
user's.

What it can't do: answer a permission prompt (the user does), approve an edge's gate or
script, change a permission mode, a model or a setting, send a harness command (a prompt or
message starting with ! or a /command; a plugin's namespaced /plugin:command is fine) or any
control character, start an agent from a base whose project config (.claude, .mcp.json,
.codex) differs from the repo's HEAD, remove an agent it didn't start or an edge its crew
didn't make, or start an agent when it is itself the third deep in a crew. An agent it starts
works in its own worktree and branch, as any agent does.

  --scope <scope>   zone (the default), repo or board.
  --json            Print the agent as JSON.`,
  },
  new: {
    usage:
      'agent-board new [--zone <ref>] [--name <name>] [--harness claude|codex] [--model <model>] [--role <role>] ' +
      '[--branch <branch>] [--base <branch or agent ref>] [--issue <id>] [--file <path>] [--] <prompt>',
    text: `Starts an agent with <prompt> (or the text of --file) as its first message, in a new worktree and
branch of its zone's repo, as the user starts one. You must be an orchestrator, a shell, or
outside agent-board: see \`agent-board help orchestrate\`. It prints the new agent's ref.

  --zone <ref>       A zone in your scope; your own by default (needed outside agent-board).
  --name <name>      Its tile's name; made from the prompt without.
  --harness <h>      claude (the default) or codex.
  --model <model>    The harness's model (opus, sonnet, haiku; gpt-5-codex, gpt-5); its default
                     without.
  --role <role>      implementer, reviewer, follow-up-reviewer, custom, or any other name
                     (designer, 'release prep': 24 characters at most) for a custom role of
                     that name, which its tile shows. It starts with its zone's template for
                     the role (for a name, else the app's default role of that name: see
                     \`agent-board roles\`), filled in, then <prompt>; a name with neither starts
                     with <prompt> alone. A reviewer works on a detached checkout of --base,
                     the branch it reviews, with no branch of its own.
  --no-template      Start it without its role's template: its first message is exactly <prompt>
                     (and the issue, if --issue). For when you write the whole prompt.
  --branch <name>    Its new branch; made from its name without. Not for a reviewer.
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
    usage: 'agent-board wait [<ref>...] [--crew] [--until <state,...>] [--any] [--timeout <seconds>]',
    text: `Waits until each agent's turn has ended: it is at its prompt (idle or waiting), needs the user,
failed, was rate-limited, or has stopped. A turn you started with \`new\` or \`send\` counts
only once it has begun, so wait straight after them. Prints each agent's line.

A turn ending is not the work being finished: an agent may end turns while a gate runs in its
background. \`--until finished\` waits until it says it is finished (it ran \`agent-board handoff\`
or \`status set --done\`); \`--until finished,failed,done\` also stops on a failed turn or an
ended session. An agent its idle prompt moved from idle to waiting, a minute after its turn,
is still idle here: only a question, a plan or a permission prompt make it waiting. (The
daemon keeps that only while it runs: after it restarts, such an agent is waiting until its
state next changes.)

Exits 0 when they are there, and 3 when it gave up first: wait again.

  --crew             Your crew too: the agents you started, and theirs. With no refs, it is.
  --until <states>   Wait for these instead, by comma: ${WAIT_STATES.join(', ')}.
  --any              Until one of them is there, not all.
  --timeout <s>      Give up after this many seconds: ${DEFAULT_ORCHESTRATOR_WAIT_MS / 1000} by default, at most ${MAX_ORCHESTRATOR_WAIT_MS / 1000}.
                     Your shell tool may stop a command sooner (Claude's Bash, after 2 minutes).
  --json             Print them as JSON.`,
  },
  watch: {
    usage: 'agent-board watch [<ref>...] [--crew] [--only <kind,...>] [--since <cursor>] [--count <n>] [--timeout <seconds>]',
    text: `Prints a line as each thing happens to the agents named, and with --crew (or no refs) to your
crew, the agents you started and theirs, as it grows:
  [mfx3k2a1.12] agent:9c1e impl  finished: PR open
Each comes once, however often the agent's state flips:
  ${CREW_EVENT_KINDS.join(', ')}
turn-ended is a turn ending at its prompt (its idle prompt a minute later is none); finished
is the agent saying its work is done (\`handoff\`, \`status set --done\`), in place of
turn-ended for that turn, and for the turns after it until its next prompt; needs-you is a
permission prompt, or a question or plan of its own; pr-opened an open pull request new since
the daemon started; ended is its session ending: closed, exited <code>, or removed. A removed
agent's last lines still come.

It runs until --count lines or --timeout, else until stopped. Run it in the background, or
with --count 1 in a loop: the cursor in [ ] is each line's place, and --since <cursor> prints
only what came after it, so nothing is missed between runs. The daemon keeps the last 1000,
in memory: a cursor from before it restarted prints every line since, after one saying some
were missed.

Exits 0, or 3 when --timeout came before --count lines.

  --crew            Your crew too (the default with no refs).
  --only <kinds>    Only these, by comma.
  --since <cursor>  After this line's cursor; all for every one kept. Now by default.
  --count <n>       Stop after this many lines.
  --timeout <s>     Stop after this many seconds.
  --json            Print each as a line of JSON.`,
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
  restart: {
    usage: 'agent-board restart <ref> [--fresh [--] [<prompt>] | --file <path>] [--json]',
    text: `Starts an ended agent again, as its tile's Restart does: in the same tile, worktree and branch,
carrying on its conversation (Claude with --resume, Codex with codex resume, or a new
conversation when Codex can't resume it). For an agent that exited, was ended with \`close\`
or the user's Stop, or was stopped by a restart of agent-board. Refused while the agent runs,
for a reviewer whose round is over, and while the shell its pane dropped into runs something:
that is the user's to end.

  --fresh   Start a new conversation instead, under a new session id, in the same tile, worktree
            and branch. The old conversation's transcript stays on disk, and the agent lists it
            (--json: earlierConversations). Text after \`--\` (or --file) is its first message,
            held to the same rules as \`send\` and \`new\`; with none, it starts on its task, if it
            had one. Without --fresh a prompt is refused.
  --json    Print the agent as JSON.`,
  },
  close: {
    usage: 'agent-board close <ref> [--remove] [--json]',
    text: `Ends the agent's session, as the user stopping it would. Its tile, worktree and branch stay.

  --remove   Delete it with its worktree and branch instead: as an agent, only one you started,
             and never one with a reviewer the user started; in a shell, or outside
             agent-board, any. Never one with uncommitted changes or commits no other branch
             has.
  --json     Print the agent as JSON.`,
  },
  roles: {
    usage: 'agent-board roles [list] [--json] | roles set <name> [--zone <ref>] [--file <path>] [--] <template> | roles remove <name> [--zone <ref>]',
    text: `The app's default roles: a custom role's name and the template an agent started in it
begins with (\`agent-board new --role <name>\`), in any zone that has saved no template of its own
for the name (the zone tab's ⋯ › Role templates…). A zone's own template for a name wins.

\`roles\` (or \`roles list\`) lists them. \`roles set\` adds one, or replaces one of the same name in
any case; its template fills in {{issue}}, {{branch}}, {{worktree}} and {{prev_review}} as a
zone's does. \`roles remove\` removes one. A built-in role (implementer, reviewer,
follow-up-reviewer, custom) has no default here: its template is each zone's. Setting and
removing are orchestrator commands, logged for the user (\`agent-board activity\`).

The app's list reaches every zone, so only an orchestrator of the whole board (or the user, in a
shell or terminal) changes it. A narrower one sets a zone's own template for a name with --zone.
A template is checked as a prompt is, when it is set and when an agent starts with it: no
leading ! or /command (but a plugin's /plugin:command), and no control or format characters
but tabs and line breaks.

  --zone <ref>    Set or remove that zone's template for the name, not the app's.
  --file <path>   Read the template from a file.
  --json          Print them as JSON.`,
  },
  activity: {
    usage: 'agent-board activity [--of <ref>] [--limit <n>] [--json]',
    text: `What orchestrators did and tried, newest first: each start, message, interrupt, restart and
close, edge, hand-off, move, arrange, group and note, done or refused (and why).

  --of <ref>     One orchestrator's alone.
  --limit <n>    At most this many lines: ${DEFAULT_ACTIVITY_LIMIT} by default.
  --json         Print it as JSON instead.`,
  },
  handoff: {
    usage: 'agent-board handoff [--to <ref>] [--message <text>] [--handover <path>] [--data <json>] [--json]',
    text: `Hands your finished work to the next agent: along each edge out of your tile (\`agent-board show
me\` lists them), or with --to along your edge to that agent alone. An edge's conditions are
checked first, so a hand-off may be held until they pass. A manual edge is left for the user to
send. With --to an agent you have no edge to, in your zone (or your orchestrator scope), it goes
at once over a one-off edge drawn from you to it, which the user sees and can send again. Each
hand-off is logged for the user.

Each edge takes what it carries: an edge carrying a message takes --message (your result, in
your words); a handover edge the file --handover (its own file, such as handover.md, without);
a JSON edge --data (its own file without). Call it once the work is ready: when your turn
ends, the edges you handed off along aren't handed off along again.

Handing off also says your work is finished, not only this turn: your tile shows it, and the
agent that started you hears it once (\`wait --until finished\`, \`watch\`). With no edge out of
your tile, and no --to, that is all it does.

  --to <ref>         One agent: along your edge to it, or a one-off edge if you have none.
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
its next message. Both must be in your scope, or you (\`me\`); <to> may not be an orchestrator
whose scope is wider than yours. An agent's edge is marked as made by it, and the user can
change or remove it like any other. \`edge remove\` removes an edge you, or an agent you
started, made; in a shell, or outside agent-board, any edge.

  --carries <c>      message (<from>'s final message, or what it hands off), handover (a
                     markdown file) or json (a JSON file).
  --path <file>      The file, relative to <from>'s worktree: handover.md or handoff.json without.
  --trigger <t>      auto (the default: as <from> hands off) or manual (the user sends it).
  --condition <c>    Must pass first; repeat for more: gate:<command> (it passes in <from>'s
                     worktree), pr-checks, label:<label> (on <from>'s issue), script:<command>
                     (it exits 0). A gate or script runs nothing until the user approves it.
  --json             Print the edge as JSON.`,
  },
  move: {
    usage: 'agent-board move <ref> [--to <zone ref>|board] [--at <x>,<y>] [--near <ref> [--side below|right|left|above]] [--json]',
    text: `Moves a tile (an agent's or a shell's) or a note (any board item), as dragging it would, for an
orchestrator (\`agent-board help orchestrate\`). In a zone it lands exactly where you say, and
what is in the way moves aside: right along its row, a whole grid column at a time, so rows
keep their order. The zone grows to hold them all.

It stays in its zone without --to. --at is relative to the zone, and lands on the zone's grid
cell nearest it (a column a tile wide, a row a tile tall, from the zone's first slot); loose on
the board (a board position) it moves the least distance clear of what is there.
--near puts it a gap beside that tile or note, in its zone, below it unless --side says.
Without --at or --near it takes the zone's first free slot. Only what arrange may move moves
aside (shells, agents in your scope, notes and cards you or your crew made): where the user's
notes or cards, a tile outside your scope, or an external session's tile are, it is refused.

What you may move: any tile or note in your scope (your zone, unless the user let you
orchestrate wider), the agents you started, and yourself (at zone scope, only within your
zone). Where: a zone in your scope, or a group you made; loose on the board (--to board) only
at board scope. Never an agent into a zone that would let it orchestrate where it can't now.
An --at more than 1000 px past the zone's edge is put at that reach; a move that would grow
the zone over another zone is refused.

  --to <ref>       The zone (or group) to move it into; \`board\` for loose on the board.
  --at <x>,<y>     Where, relative to the zone.
  --near <ref>     Beside this tile or note.
  --side <side>    below (the default), right, left or above.
  --json           Print where it went as JSON.`,
  },
  arrange: {
    usage: 'agent-board arrange [<zone ref>] [--by issue|role|state] [--layout rows|grid] [--json]',
    text: `Lays out the tiles of your zone (or <zone ref>, in your scope) that you may move, for an
orchestrator: you first, then

  --by issue   a cluster per issue (the default), a row each: its label and an agent
               note by you saying where each of its agents stands (its status line, else
               its latest STATUS, else its state, and its PR; never its task), in the
               first column; then its agents as their
               work flows (an implementer, then its reviewer: a reviewer always after what it
               reviews, whatever their roles); no card for its pull request, as each tile shows
               its own, and any an earlier arrange made go. Arranging again moves the label
               and sticky with it; a sticky anyone has edited keeps its text. One whose unit
               has gone is removed.
               Without an issue, a unit is the agents joined by edges or sharing a ticket in
               their branch (acme-199-… is ACME-199), labelled by that ticket, else the words
               its agents' names start with, else its implementer's name.
  --by role    a row per role (implementers, then the others doing the work, then
               reviewers), each reviewer under the agent it reviews
  --by state   a row per state, the ones needing the user first

and shells last. --layout grid fills the zone's width in the same order instead of a row each,
but only with the tiles no edge joins: a unit whose tiles an edge joins (you too, if one joins
you) is laid out exactly as rows lay it out, from the top, and the grid fills round it, clear
of its rails. By role or state, or as a grid, an arrange by issue's labels and stickies line
up beside the crew until you arrange by issue again. Agents joined by an edge get a grid
column's room (or a row's) past every tile and row the rail between them runs by, so the rail
has room for its document and label at either end.
Every tile lands on the zone's grid, so rows and columns line up across clusters. What it may
not move (the user's notes and cards, tiles outside your scope) stays put, and the rows keep
clear of it. The zone grows to hold them, never shrinking. The same board always arranges the
same way, so arranging again moves nothing. A reviewer you start on a clustered agent's branch
(--base agent:<ref> --role reviewer) joins its cluster, after it.

  --by <b>         ${ARRANGE_BYS.join(', ')}.
  --layout <l>     ${ARRANGE_LAYOUTS.join(' or ')}.
  --json           Print what moved as JSON.`,
  },
  zone: {
    usage:
      'agent-board zone add --group --name <name> [--color <#rrggbb>] [--at <x>,<y>] [--size <w>,<h>] | ' +
      'zone rename <ref> <name> [--color <c>] | zone resize <ref> --size <w>,<h> [--at <x>,<y>] | zone remove <ref>',
    text: `Groups (zones bound to no repo) for an orchestrator to sort its crew into
(\`agent-board help orchestrate\`). \`agent-board zones\` lists every zone.

\`zone add --group\` makes one, marked as made by you: beside your zone, or at --at (a board
position), stepped right past any zone or loose tile there, as the app's Zone tool places one:
never inside another zone. It lets no agent orchestrate (the user can turn that on). Its name
is at most 80 characters, with no control characters, and it is at most 8000 px a side. Move
tiles into it with \`agent-board move <ref> --to <its ref>\`.

\`zone rename\`, \`zone resize\` and \`zone remove\` change only a group you, or an agent you
started, made; in a shell, or outside agent-board, any group. Resizing never covers another
zone; shrinking it past its tiles moves the ones its edge cuts through, as the app's resize
does, and is refused when they have nowhere to go. Removing it leaves its tiles and notes
loose on the board, where they were.

  --group          Make a group (an orchestrator makes no other zone).
  --name <name>    Its name.
  --color <c>      #rrggbb.
  --at <x>,<y>     Where its top-left goes on the board.
  --size <w>,<h>   Its size: 720,480 by default.
  --json           Print the zone as JSON.`,
  },
  note: {
    usage:
      'agent-board note add [--text <text> | [--] <text>] [--kind sticky|text] [--color <c>] [--to <zone ref>] [--at <x>,<y>] ' +
      '[--near <ref> [--side <s>]] | note edit <ref> [--text <text>] [--color <c>] | note remove <ref>',
    text: `Notes on the board for an orchestrator (\`agent-board help orchestrate\`), marked as made by
you. From an agent, \`note add\` makes an agent note: a typed card with your badge (your name
and role) and the time, never one of the user's stickies, so it has no colour (--color is
ignored, with a warning); --kind sticky makes a sticky note and --kind text makes text, each
signed with 🤖, your name and the time (signed again when edited). In a shell, or outside agent-board, it makes a sticky note (the
default) or text. It puts the note in your zone (or --to's, in your scope or a group you made)
at its first free spot, or exactly at --at or beside --near, what is there moving aside as for
\`agent-board move\`. A note (not text) --near an agent, with no --side, goes in its cluster's
slot: added to the end of the note of the cluster \`agent-board arrange\` put it in, after
what it says (arranging again keeps that text), else in the slot before the agent, which moves
along with its row (beside it, below, for an agent outside your scope). Its text is short
markdown: bold, italics, \`code\`, lists and links; tabs and line breaks, but no other control
character.

\`note edit\` and \`note remove\` change only a note you, or an agent you started, made; in a
shell, or outside agent-board, any note or text. Rewriting an agent note the user edited makes
it yours again. \`note remove\` removes such a link card too.

  --text <text>    Its text (or give it after --).
  --kind <k>       sticky or text. From an agent, a note with no --kind is an agent note and
                   --kind sticky makes a signed sticky; elsewhere sticky is the default.
  --color <c>      A sticky note's yellow, orange, pink, violet, blue, green, grey or white;
                   text's ink, grey, red, orange, green, blue or violet; or #rrggbb.
  --to, --at, --near, --side
                   Where, as for \`agent-board move\`.
  --json           Print the note as JSON.`,
  },
  rpc: {
    usage: "agent-board rpc <method> ['<json params>']",
    text: `Calls one of the daemon's JSON-RPC methods (as the app does) and prints its result as JSON, such as
\`agent-board rpc agent.list\`.

In an agent's own session, which has AGENT_BOARD_IDENTITY, it reaches only what the other
commands do:

${[...BOARD_CALLER_METHODS].map((method) => `  ${method}`).join('\n')}

and, for an agent the user lets orchestrate, the orchestrator commands:

${[...ORCHESTRATOR_METHODS].map((method) => `  ${method}`).join('\n')}

A shell on the board reaches those (acting for the user), and also:

${[...USER_SIDE_METHODS].map((method) => `  ${method}`).join('\n')}

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
 * a bad ref, a refused call), 2 for bad arguments, 3 when `wait` or `watch` gave up first. `out` and `err` take what it prints.
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
    const result = await parsed(session, (line) => io.out(`${line}\n`));
    const { text, code } = typeof result === 'string' ? { text: result, code: 0 } : result;
    // A command that printed as it went (`watch`) has nothing left to say.
    if (text !== '') io.out(text.endsWith('\n') ? text : `${text}\n`);
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
  'no-template': { type: 'boolean' },
  branch: { type: 'string' },
  base: { type: 'string' },
  issue: { type: 'string' },
  file: { type: 'string' },
  until: { type: 'string' },
  any: { type: 'boolean' },
  timeout: { type: 'string' },
  crew: { type: 'boolean' },
  only: { type: 'string' },
  since: { type: 'string' },
  count: { type: 'string' },
  done: { type: 'boolean' },
  remove: { type: 'boolean' },
  fresh: { type: 'boolean' },
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
  at: { type: 'string' },
  near: { type: 'string' },
  side: { type: 'string' },
  by: { type: 'string' },
  layout: { type: 'string' },
  group: { type: 'boolean' },
  color: { type: 'string' },
  size: { type: 'string' },
  text: { type: 'string' },
  kind: { type: 'string' },
} as const;

type Option = keyof typeof OPTIONS;

/** The options each command takes beyond `--json` (which every one but `status`'s set, `rpc` and `mcp` takes too). */
export const COMMAND_OPTIONS: Record<string, readonly Option[]> = {
  status: ['progress', 'done'],
  new: ['zone', 'name', 'harness', 'model', 'role', 'no-template', 'branch', 'base', 'issue', 'file'],
  roles: ['file', 'zone'],
  send: ['file'],
  wait: ['until', 'any', 'timeout', 'crew'],
  watch: ['crew', 'only', 'since', 'count', 'timeout'],
  restart: ['fresh', 'file'],
  close: ['remove'],
  orchestrate: ['scope'],
  activity: ['of', 'limit'],
  handoff: ['to', 'message', 'handover', 'data'],
  edge: ['carries', 'path', 'trigger', 'condition'],
  move: ['to', 'at', 'near', 'side'],
  arrange: ['by', 'layout'],
  zone: ['group', 'name', 'color', 'at', 'size'],
  note: ['text', 'kind', 'color', 'to', 'at', 'near', 'side'],
};

/** A command's result: what it prints, and its exit code (0 for a bare string). */
type CommandResult = string | { text: string; code: number };

/** A command's arguments, checked before any connection is made, as what to run once one is. */
function parseCommand(command: string, args: string[]): (session: BoardSession, out: (line: string) => void) => Promise<CommandResult> {
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
      throw new UsageError(
        option === 'progress' || option === 'done' ? `--${option} is only for \`status set\`` : `--${option} is not an option of ${command}`,
      );
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
  /** One ref, the only positional. */
  const oneRef = (usage = 'give one agent ref') => {
    if (positionals.length !== 1) throw new UsageError(usage);
    return positionals[0]!;
  };
  /** Runs a check of the arguments, its `BoardError` a usage error: checked before anything connects. */
  const checked = (check: () => void) => {
    try {
      check();
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
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
    case 'open-pr': {
      noPositionals();
      return async (session) => print(await openOwnPullRequest(session));
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
        const agent = await setOwnStatus(session, summary, progress, values.done === true);
        if (values.json) return JSON.stringify(agent, null, 2);
        return `status set: ${statusLine(agent.status!)}${agent.workFinishedAt === null ? '' : ' (finished)'}`;
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
            noTemplate: values['no-template'] === true,
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
      const until = string('until')?.split(',').map((state) => state.trim()) as WaitState[] | undefined;
      const unknown = until?.find((state) => !isWaitState(state));
      if (unknown !== undefined) throw new UsageError(`${unknown} is not a state: ${WAIT_STATES.join(', ')}`);
      const seconds = wholeNumber('timeout', MAX_ORCHESTRATOR_WAIT_MS / 1000);
      return async (session) => {
        const view = await waitForAgents(session, positionals, {
          until,
          any: values.any === true,
          // As `watch` and the MCP tool: no refs is your crew.
          crew: values.crew === true || positionals.length === 0,
          timeoutMs: seconds === undefined ? undefined : seconds * 1000,
        });
        return { text: print(view), code: view.timedOut ? WAIT_TIMED_OUT : 0 };
      };
    }
    case 'watch': {
      const kinds = string('only')?.split(',').map((kind) => kind.trim()) as CrewEventKind[] | undefined;
      const unknown = kinds?.find((kind) => !CREW_EVENT_KINDS.includes(kind));
      if (unknown !== undefined) throw new UsageError(`${unknown} is not a kind: ${CREW_EVENT_KINDS.join(', ')}`);
      const from = string('since');
      if (from !== undefined && !isCrewSince(from)) throw new UsageError(`--since takes a line's cursor (such as mfx3k2a1.12), now or all, not ${from}`);
      const count = wholeNumber('count', Number.MAX_SAFE_INTEGER);
      const seconds = wholeNumber('timeout', Number.MAX_SAFE_INTEGER);
      return async (session, out) => {
        const crew = values.crew === true;
        const until = seconds === undefined ? Infinity : Date.now() + seconds * 1000;
        // From now, unless --since says from when; then on from where each answer read up to.
        let since = from ?? 'now';
        let printed = 0;
        while (count === undefined || printed < count) {
          const left = until - Date.now();
          if (left <= 0) return { text: '', code: count === undefined ? 0 : WAIT_TIMED_OUT };
          const news = await watchCrew(session, positionals, { crew, since, kinds, timeoutMs: Math.min(left, MAX_ORCHESTRATOR_WAIT_MS) });
          if (news.missed) out(values.json ? JSON.stringify({ missed: true }) : 'Some lines were missed: the daemon keeps only the latest, or it restarted.');
          const lines = values.json ? news.json.map((event) => JSON.stringify(event)) : news.lines;
          for (const line of count === undefined ? lines : lines.slice(0, count - printed)) {
            out(line);
            printed++;
          }
          since = news.cursor;
        }
        return { text: '', code: 0 };
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
    case 'restart': {
      const ref = positionals[0];
      if (ref === undefined) throw new UsageError('give one agent ref');
      const prompt = text(1);
      if (prompt.trim() !== '' && values.fresh !== true) throw new UsageError('a prompt needs --fresh: a restart that carries on its conversation takes none');
      return async (session) =>
        print(await restartAgent(session, ref, values.fresh === true ? { prompt: prompt.trim() === '' ? undefined : prompt } : undefined));
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
    case 'move': {
      const ref = oneRef('give one tile or note ref');
      const place = { to: string('to'), at: string('at'), near: string('near'), side: string('side') };
      checked(() => checkPlace(place));
      return async (session) => print(await moveTile(session, ref, place));
    }
    case 'arrange': {
      if (positionals.length > 1) throw new UsageError('give at most one zone ref');
      const options = { by: string('by'), layout: string('layout') };
      checked(() => checkArrange(options));
      return async (session) => print(await arrangeZone(session, positionals[0], options));
    }
    case 'zone': {
      const [sub, ref, ...rest] = positionals;
      const given = (['group', 'name', 'color', 'at', 'size'] as const).filter((option) => values[option] !== undefined);
      const only = (allowed: readonly Option[]) => {
        const stray = given.find((option) => !allowed.includes(option));
        if (stray !== undefined) throw new UsageError(`--${stray} is not an option of \`zone ${sub}\``);
      };
      const options = { name: string('name'), color: string('color'), at: string('at'), size: string('size') };
      checked(() => {
        if (options.at !== undefined) pointOf(options.at, '--at');
        if (options.size !== undefined) sizeOf(options.size);
      });
      if (sub === 'add') {
        only(['group', 'name', 'color', 'at', 'size']);
        if (ref !== undefined) throw new UsageError(`unexpected ${positionals.slice(1).join(' ')}`);
        if (values.group !== true) throw new UsageError('an orchestrator makes only groups: give --group (a zone bound to a repo is the user\'s to make)');
        if (options.name === undefined || options.name.trim() === '') throw new UsageError('give the group --name');
        return async (session) => print(await addGroup(session, { ...options, name: options.name! }));
      }
      if (sub === 'rename') {
        only(['color']);
        if (ref === undefined || rest.length === 0) throw new UsageError('give the group ref and its new name');
        const name = rest.join(' ');
        return async (session) => print(await changeGroup(session, ref, { name, color: options.color }));
      }
      if (sub === 'resize') {
        only(['size', 'at']);
        if (ref === undefined || rest.length > 0) throw new UsageError('give one group ref');
        if (options.size === undefined && options.at === undefined) throw new UsageError('give its new --size (and --at to move it)');
        return async (session) => print(await changeGroup(session, ref, { size: options.size, at: options.at }));
      }
      if (sub === 'remove') {
        only([]);
        if (ref === undefined || rest.length > 0) throw new UsageError('give one group ref');
        return async (session) => print(await removeGroup(session, ref));
      }
      throw new UsageError('the zone commands are `zone add --group`, `zone rename`, `zone resize` and `zone remove`');
    }
    case 'note': {
      const [sub, ...rest] = positionals;
      const place = { to: string('to'), at: string('at'), near: string('near'), side: string('side') };
      const color = string('color');
      if (sub === 'add') {
        if (rest.length > 0 && string('text') !== undefined) throw new UsageError('give the text or --text, not both');
        const noteText = string('text') ?? rest.join(' ');
        if (noteText.trim() === '') throw new UsageError('give the note its text');
        const options = { ...place, text: noteText, kind: string('kind'), color };
        checked(() => checkNote(options));
        return async (session) => print(await addNote(session, options));
      }
      const placed = (['to', 'at', 'near', 'side', 'kind'] as const).find((option) => values[option] !== undefined);
      if (placed !== undefined) throw new UsageError(`--${placed} is only for \`note add\` (move a note with \`agent-board move\`)`);
      if (sub === 'edit') {
        if (rest.length !== 1) throw new UsageError('give one note ref');
        if (string('text') === undefined && color === undefined) throw new UsageError('give its new --text or --color');
        return async (session) => print(await editNote(session, rest[0]!, { text: string('text'), color }));
      }
      if (sub === 'remove') {
        if (rest.length !== 1) throw new UsageError('give one note ref');
        if (string('text') !== undefined || color !== undefined) throw new UsageError('`note remove` takes no options');
        return async (session) => print(await removeNote(session, rest[0]!));
      }
      throw new UsageError('the note commands are `note add`, `note edit` and `note remove`');
    }
    case 'roles': {
      const [sub = 'list', ...rest] = positionals;
      if (sub !== 'set' && string('file') !== undefined) throw new UsageError('--file is only for `roles set`');
      if (sub === 'list' && string('zone') !== undefined) throw new UsageError('--zone is only for `roles set` and `roles remove`');
      if (sub === 'list') {
        if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
        return async (session) => print(await defaultRolesView(session));
      }
      if (sub === 'set') {
        const name = rest[0];
        const body = text(2);
        if (name === undefined || body.trim() === '') throw new UsageError('give the role’s name and its template');
        return async (session) => print(await setDefaultRole(session, name, body, string('zone')));
      }
      if (sub === 'remove') {
        if (rest.length !== 1) throw new UsageError('give one role name');
        return async (session) => print(await removeDefaultRole(session, rest[0]!, string('zone')));
      }
      throw new UsageError('the roles commands are `roles list`, `roles set` and `roles remove`');
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
