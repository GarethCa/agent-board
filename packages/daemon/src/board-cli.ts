// `agent-board <command>`: the board's command line for agents and people (ADR-0010). Its help is the documentation an
// agent reads, so it teaches the concepts as well as the commands.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  activityView,
  addEdge,
  agentsView,
  BoardError,
  BoardRefs,
  closeAgent,
  pauseAgent,
  wakeAgent,
  defaultRolesView,
  exportPrefab,
  importPrefab,
  prefabsView,
  prefabView,
  removePrefab,
  crewsView,
  stopCrew,
  crewRound,
  waitForCrew,
  startPrefab,
  usageView,
  edgesView,
  handOff,
  identifyView,
  interruptAgent,
  setAgentEffort,
  continueAgent,
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
  handOver,
  categoryAnswer,
  characterAnswer,
  setCrewStatus,
  setOwnStatus,
  recordEntry,
  pinEntry,
  setOwnPage,
  unpinEntry,
  flagLine,
  flagOwn,
  openOwnPullRequest,
  showDoc,
  leavePlan,
  readPlanSource,
  shellsView,
  showView,
  treeView,
  waitForAgents,
  watchCrew,
  zonesView,
  type BoardSession,
  type BoardView,
} from './board-ops.ts';
import { AGENT_FACES, AGENT_POSES, AGENT_PROPS, characterChoices, NO_POSE, parseCharacter, type CharacterSet } from './character.ts';
import { parseWorkCategorySet } from './work-category.ts';
import { DaemonRpcError } from './client.ts';
import { documentTitle } from './document-names.ts';
import { addSchedule, checkOwnSchedule, checkSchedule, checkTemplate, listSchedules, listTemplates, removeSchedule, removeTemplate, saveTemplate, setOwnSchedule } from './clock-ops.ts';
import { listSteps, newSteps, readStepsCard, updateSteps } from './steps-ops.ts';
import { listMemories, listQueues, memoryHistory, newMemory, newQueue, queueHistory, readMemory, readQueue, updateMemory, updateQueue, type QueueUpdate } from './memory-ops.ts';
import { changeTodo, readTodos, remind } from './todo-ops.ts';
import {
  addDiagram,
  addGroup,
  addNote,
  addShape,
  arrangeZone,
  setZoneLayout,
  changeGroup,
  checkArrange,
  checkConnector,
  checkNote,
  checkPlace,
  checkShape,
  connectItems,
  editConnector,
  editNote,
  editShape,
  exportDiagram,
  moveTile,
  noteSizeOf,
  pointOf,
  removeConnector,
  removeGroup,
  removeNote,
  removeShape,
  sizeOf,
  zoneMap,
  writeZoneScreenshot,
} from './layout-ops.ts';
import {
  ARRANGE_BYS,
  ARRANGE_LAYOUTS,
  BOARD_CALLER_METHODS,
  RELATIONS,
  CREW_EVENT_KINDS,
  DEFAULT_ACTIVITY_LIMIT,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  isCrewSince,
  isStatusProgress,
  isWaitState,
  MAX_ACTIVITY_LIMIT,
  MAX_CAPTURE_SIDE,
  ORCHESTRATE_SETTING,
  MAX_ORCHESTRATOR_WAIT_MS,
  MAX_FLAG_LENGTH,
  MAX_FIGURE_VALUE,
  MAX_PAGE_BLOCKS,
  MAX_PAGE_FIGURES,
  MAX_PAGE_ITEMS,
  MAX_PAGE_NAME,
  MAX_PAGE_TEXT,
  MAX_PIN_LABEL,
  MAX_PIN_NOTE,
  PAGE_ICONS,
  PAGE_TONES,
  MAX_STATUS_LENGTH,
  ORCHESTRATE_SCOPES,
  ORCHESTRATOR_METHODS,
  USER_SIDE_METHODS,
  statusLine,
  WAIT_STATES,
  type CrewEventKind,
  type OrchestrateScope,
  type PageParams,
  type RecordParams,
  type WaitState,
  type WorkCategoryParams,
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
          A shape has text in it; a class's has attributes and methods under its name.
  connector
          A line between two things on the board, carrying nothing: a note's arrow, or a
          diagram's relation (inheritance, composition, ...), with a label on its middle and
          one by each end (a multiplicity such as 0..*, or a role).

REFS
  Commands name things by ref: <kind>:<start of its id>, as the board lists them
  (zone:4f2a, agent:9c1e, shell:07bd, edge:e5aa, item:31f0, connector:8a2c). A whole id
  works, and so does a unique name, alone or after its kind (fix-tests, zone:web). \`me\` is
  your own tile. A name that more than one thing has is an error listing them.

COMMANDS
  identify              Who and where you are: your tile, its zone, your state and status.
  tree                  Every zone with its tiles and items, then what is loose on the board.
  zones                 Every zone.
  agents (or ls)        Every agent: state, status (or task) and zone.
  shells                Every shell tile.
  edges                 Every edge: its two agents, what it carries, when, and how it stands.
  show <ref>            Everything about one zone, agent, shell, edge, item or connector.
  usage                 The 5-hour and weekly plan usage. See \`usage --help\`.
  status set <summary> [--progress <0-100>] [--done] [--pose <pose>]
                        Set your own tile's status (agents only); --done says your work is
                        finished; --pose your character's pose. See \`status --help\`.
  needs-you [--] <reason> [--via <ref>] | --clear
                        Ask for a look: blocked, ready for review, or a decision needed. A
                        turn ending tells no one. See \`needs-you --help\`.
  open-pr               Open a draft pull request of your branch (agents only).
  doc <path> [--title <text>] [--board] [--plan]
                        Show the user a Markdown or HTML file of yours as a document: a Doc
                        tab in your window (agents only). With --plan it is a plan for them
                        to decide, and the command returns at once. See \`doc --help\`.
  steps new [--title <text>] [--file <path>|-] [--] <line>...
                        Put a steps card beside your tile (agents only): questions for the
                        user to step through, answered together on Send and typed at your
                        prompt, and to-dos ticked by whoever each names. \`steps ls|read|done|
                        wait|add|answer|close\` work with cards. See \`steps --help\`.
  memory ls|read|add|edit|rm|history|restore|new ...
                        Shared context: keyed values, notes and whole files that agents in
                        scope read and write, and people on the board. See \`memory --help\`.
  remind "<text>"... | remind ls [--mine] | remind done|undo|rm <n>
                        Add a to-do for the user to your to-do list, under your tile (agents
                        only): something only they can do. A tick tells you nothing; \`remind
                        ls --mine\` shows which are done. See \`remind --help\`.
  queue ls|read|add|take|drop|done|edit|rm|history|restore|new ...
                        Jobs to take one at a time, and notes, for agents or for the user.
                        A job you take goes back if your session ends. See \`queue --help\`.
  record pr <url> | record doc <path> [--for orchestrator]
                        Put a pull request you opened, or a hand-off doc you wrote, on your
                        sidebar (agents only). See \`record --help\`.
  pin <path|url> [--label <text>] | pin --note <text> --label <text>
                        Pin a file, a link or a note you want the user to see on your
                        sidebar (agents only); \`unpin\` takes it off. See \`pin --help\`.
  page --file <path|-> [--name <text>] [--icon <icon>] | page --clear
                        Write your page, the shelf your sidebar opens on, from blocks:
                        a heading, figures, a checklist, a callout, links, a note (agents
                        only). See \`page --help\`.
  handoff [--to <ref>] [--message <text>] [--handover <path>] [--data <json>]
                        Hand your finished work to the next agent over your own outgoing
                        edges, once it is ready, and say it is finished. See \`handoff --help\`.
  schedule add '<cron>' --self [--after hibernate|idle] [--] <prompt>
                        Add a clock of your own beside your tile, for a long watch: it
                        messages you at each fire time (agents only). \`schedule set|stop\`
                        change what it does with you after each run, or turn it off, saying
                        why. See \`schedule --help\`.
  schedule template save <name> --from <clock> | schedule template list | schedule template remove <name>
                        Save a clock to start new ones from: \`schedule add --template <name>\`.
  mcp                   Serve these as MCP tools on stdio, for a harness. Two are MCP tools
                        alone, as they wait on the user longer than a shell command runs:
                        ask (a question in the user's Needs you inbox) and show_doc with plan
                        (a plan for them to approve, send back with changes, or reject;
                        present_plan still works), which holds your turn for the decision.
                        From a shell, \`doc --plan\` presents a plan and returns at once, the
                        decision coming to your prompt later. An agent an orchestrator started
                        puts both to that orchestrator instead.
  rpc <method> [json]   Call a daemon method directly and print its JSON result. In an agent's
                        session, only the reads above, your own status and records (and, for an
                        orchestrator, the orchestrator commands).

  Read commands take --json. \`agent-board <command> --help\` says more about one.

ORCHESTRATING
  An agent the user lets orchestrate can start, message, watch and close other agents, as a
  lead does with workers: in its zone (or its repo, or the whole board, as the user chose),
  and always the agents it started. \`identify\` says whether you may. The agents you start are
  linked to you on the board, and orchestrate as their zone lets them, up to three deep. In a
  shell, or a terminal outside agent-board, these act for the user on any agent. Each start,
  message, interrupt, effort, continue, restart, pause, wake and close is logged for the user.
  \`agent-board help orchestrate\` shows the loop.

  new [options] [--] <prompt>
                        Start an agent with <prompt> as its first message. In a group, --repo
                        <path> picks the repo it works in, task by task.
  send <ref> [--] <message>
                        Send an agent its next message, once its turn has ended. Also, from
                        any agent, a reply to an agent that messaged it. --submit or --clear
                        sends or clears a message left unsent at its prompt.
  wait [<ref>...] [--crew] [--until finished]
                        Wait until each agent's turn has ended: it is at its prompt, needs
                        the user, or has stopped; or until it says its work is finished.
  watch [<ref>...] [--crew]
                        Print a line as each thing happens to your crew: a turn ended, it
                        finished, needs the user, failed, was rate-limited, was paused, ended,
                        or a pull request was opened. Each once.
  read <ref> [<path>]   An agent's final message, or a file in its worktree.
  interrupt <ref>       Stop an agent's turn; it waits at its prompt.
  effort <ref> <level>  Change an agent's reasoning effort: low, medium, high, xhigh or max.
  continue <ref>        Continue on credits: resume a turn its usage limit stopped.
  restart <ref> [--fresh [--] [<prompt>]]
                        Start an ended agent again in its tile, worktree and branch, carrying
                        on its conversation; --fresh starts a new one instead.
  pause <ref>           Hibernate an idle agent to free its memory; a message wakes it.
  wake <ref>            Start a paused agent again, carrying on its conversation.
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
  arrange [<zone ref>] [--by issue|role|state] [--layout rows|columns|cards|grid|wrap|masonry|treemap] [--auto on|off]
                        Lay out your zone's tiles: you first, then a lane per issue, its
                        implementer, reviewer and follow-up in columns, then its note.
                        --auto on arranges by itself as you start agents and add notes.
                        arrange board lays out the whole board's zones and loose tiles,
                        at board scope.
  zone map [<zone ref>] [--boxes]
                        Your zone as a table of its lanes and what is amiss, to check a
                        layout; --boxes draws it in characters.
  zone screenshot [<zone ref>] [--out <file>] [--style board|lofi]
                        A PNG of your zone as the app draws it, terminals hidden.
  zone layout free|shelves|clusters [<zone ref>]
                        How your zone draws what it holds: free (as placed), shelves
                        (To do, Doing, Waiting, Done) or clusters. Moves no tile.
  zone add --group --name <name> [--color <c>] [--at <x>,<y>] [--size <w>,<h>]
                        Make a group beside your zone. \`zone rename|resize|remove\` change
                        the groups you, or an agent you started, made.
  note add [--] <text> [--near <ref> [--side <s>]] [--color <c>] [--kind sticky|text]
                        Put a note on the board: --near an agent, in its cluster.
                        \`note edit|remove\` change yours.

  Drawing a diagram, only when asked for one:
  shape add <kind> [--] <text> [--attribute <line>]... [--method <line>]... [--near <ref>]
                        Draw a shape with text: a class's attributes and methods under its
                        name. \`shape edit|remove\` change yours.
  connect <from ref> <to ref> [--relation <r>] [--label <t>] [--from-label <t>] [--to-label <t>]
                        Join two items with a connector, from → to as the relation reads.
                        \`connector edit|remove\` change yours.
  diagram add [--file <path>|-] [--to <zone ref>] [--near <ref>] [--] <mermaid>
                        Draw a Mermaid flowchart or class diagram as shapes and connectors.
  diagram export [<zone or shape ref>...]
                        Print shapes and the connectors between them as Mermaid.

  Schedules, each a clock on the board:
  schedule add '<cron>' (--to <ref> | --fresh [--role <r>]) [--] <prompt>
                        Message an agent at each fire time, or start a fresh agent with the
                        task, wait for its turn to end, keep its result and close it.
                        \`schedule list\` lists them; \`schedule remove <ref>\` removes yours.

  The app's default roles, for \`new --role <name>\` in any zone with no template of its own
  for the name:
  roles [list]          Each default role and its template's first line.
  roles set <name> [--file <path>] [--] <template>
                        Add or replace one. \`roles remove <name>\` removes one.

  Crew prefabs, a saved crew shape, from one library for every board:
  new --prefab <name> [--zone <ref>] [--issue <id>] [--] <prompt>
                        Start a crew: its builder (or its lead) gets <prompt>.
  prefab [ls]           Each prefab, built-ins first: its members and what it is for.
  prefab show <name>    One prefab: its members in words, then its .crew.json file.
  prefab export <name> [--out <path>]
                        Write its .crew.json file, to share.
  prefab import <file> [--add [--replace]]
                        Show a .crew.json file whole; with --add, add it to the library.
                        \`prefab remove <name>\` removes one you added.
  crew [ls]             The running crews: each one's round, whose turn it is, and its reviews.
  crew show|stop|round <crew>
                        One crew; stop its loop; or one more round (or a failed start again).
  wait <crew>           Until the crew stops: ready to merge, at its limit, or stopped.

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
  doc: {
    usage: 'agent-board doc <path> [--title <text>] [--board] [--plan]',
    text: `Shows the user a longer Markdown (.md) or HTML (.html) file of yours as a document, nicer to read
than your terminal: a Document tab in your window, and with --board a card beside your tile too. Nothing
waits. Showing the same file again shows the same document.

It stays live: write the file again and the user sees the new version. They may edit a Markdown
document there; their edit is written to the file, and you are told what changed, typed at your
prompt once your turn is over. An HTML document is view-only (sandboxed, offline), and the user
may send you comments on it.

With --plan the file is a plan for the user to approve, send back with changes, or reject (it may
be edited first: Markdown only). It waits in their Needs you inbox and the Plan tab, kept as v1, v2…
as you present each revision, and with --board a plan card goes beside your tile. The command
returns at once: a shell command can't wait the hour the user may take. Their decision, with their
comments and any edits of theirs, is typed at your prompt once your turn is over, as a document
edit is. It waits as long as the user takes, with no timeout. End your turn and wait for it, and
don't carry the plan out before. After changes are asked for, or to revise it sooner, write the
revised plan and run it again: the new version takes the old one's place. To hold your turn for the
decision instead, use the MCP tool \`show_doc\` with plan.

  --title <text>   What it is, in a line; else its first heading (or page title).
  --board          Also put it on the board, beside your tile.
  --plan           It is your plan to decide on, not a document: returns at once, the decision
                   arrives at your prompt later.
  --json           Print the document as JSON.`,
  },
  status: {
    usage:
      'agent-board status set [<summary>] [--agent <ref>] [--progress <0-100>] [--done] [--pose <pose> [--face <face>] [--prop <prop>]] [--category <category> [--label <text>] [--on "<who> · <ref>"]] | status poses',
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

As an orchestrator, --agent <ref> sets the line of an agent in your crew (the agents you started,
and theirs) instead of your own, and its tile says who set it. Keep your crew's lines current: what
each is doing now, from what you see of it. The latest write wins, its own or yours. An agent
outside your crew is refused.

--pose sets the pose your tile's character strikes, with or without a summary: thinking,
running-a-tool, reading, writing or testing for the work you are doing now, and
waiting-on-review as your turn ends with your work up for review. --face and --prop give it a
face and a prop of their own; \`status poses\` lists them all. A word outside the lists is
refused. A working pose goes when your turn ends, or 20 minutes after you set it;
waiting-on-review when your next turn starts; \`--pose none\` gives the board's back now. The
board's own states (needs you, a problem, a usage limit, paused, done) are drawn over yours,
which shows again after. Setting a pose often is fine: the tile draws the last one.

--category says what kind of wait your work is in, for the overview the user reads at a glance:
needs-help, ready-for-review, blocked, waiting-on-others, in-review, working or done. Set it
when that changes, above all when your work waits on someone other than the user: \`--category
waiting-on-others --on "Northwind Pay support · #48213"\`. --on names who it waits on, with their
reference after " · ", and is only for waiting-on-others and in-review. --label is your own word
for it, at most 40 characters ("With Legal"), shown in place of the category's name. A category
stays until you set another, and a set replaces all of it; --done with no category is done, which
your next prompt clears; \`--category none\` gives the board's guess back. While a question or a
permission prompt of yours waits on the user, the overview shows needs-help over yours.

  --agent <ref>    Set this crew member's line, pose or category, not your own.
  --progress <n>   0 to 100.
  --done           Your work is finished (not with --agent).
  --pose <pose>    Your character's pose, or none (\`status poses\`).
  --face <face>    Its face, with --pose.
  --prop <prop>    Its prop, with --pose.
  --category <c>   Your work's category, or none.
  --label <text>   Your own word for it, with --category.
  --on <who · ref> Who it waits on, with --category waiting-on-others or in-review.
  --json           Print the agent as JSON (with --agent, as \`show --json\` prints it).`,
  },
  record: {
    usage: 'agent-board record pr <url> [--title <title>] | record doc <path> [--for orchestrator]',
    text: `Puts an entry on your sidebar, the details beside your terminal in your session window, as you
make it: the board's own guesses (gh, hooks) only fill the gaps, and what you record wins.

  record pr <url>       A pull request you opened, by its GitHub URL, on any branch, not only
                        yours. Record it as soon as you open it. \`open-pr\` records its own.
  record doc <path>     A hand-off doc you wrote: a handover, findings, a plan. The user opens it
                        in a Doc tab. A relative path is from where you are.

Recording an entry again replaces it, and brings it back if the user deleted it. The user may
delete a record, not edit it.

  --title <title>       The pull request's title, shown until gh is asked.
  --for orchestrator    Record the doc on the orchestrator that started you instead, saying you
                        wrote it: do that for what your orchestrator should read.
  --json                Print the record as JSON.`,
  },
  pin: {
    usage: 'agent-board pin <path|url> [--label <text>] [--for orchestrator] | pin --note <text> --label <text>',
    text: `Pins something you want the user to see on your sidebar, beside your terminal in your session
window, as a Pinned block of your page or in the Full sidebar's Pins: the preview you started,
a screenshot, a log, a login to try.

  pin <path>            A file. A Markdown or HTML one opens in a Doc tab; any other is shown
                        in its folder. A relative path is from where you are.
  pin <url>             An http or https link, which opens in a web tab.
  pin --note <text>     A short note (at most ${MAX_PIN_NOTE} characters), shown on the sidebar
                        under its label.

Pinning the same file, link or note label again replaces it. The user may delete a pin, not
edit it. \`agent-board unpin <path|url>\`, or \`unpin --label <text>\` for a note, takes one off.

  --label <text>        What the sidebar calls it (at most ${MAX_PIN_LABEL} characters); a note's
                        names it.
  --for orchestrator    Pin it on the orchestrator that started you instead, saying you pinned
                        it.
  --json                Print the pin as JSON.`,
  },
  unpin: {
    usage: 'agent-board unpin <path|url> [--for orchestrator] | unpin --label <text> [--for orchestrator]',
    text: `Takes a pin off your sidebar: a file by its path (even once it is gone), a link by its URL,
or a note by its label. It is gone at once; the user gets no Undo for it.

  --label <text>        The note's label.
  --for orchestrator    Take it off the orchestrator's sidebar, where you pinned it for it.
  --json                Print the pin it was as JSON.`,
  },
  page: {
    usage: 'agent-board page --file <path|-> [--name <text>] [--icon <icon>] | agent-board page --clear',
    text: `Writes your page: the shelf your sidebar opens on, beside your terminal in your session
window. It is yours to fill. You name its tab, pick its icon, and give it blocks; each block may
have a title, an icon and a tone. Under your blocks, the board adds only what needs the user or
is failing. Until you write a page, the shelf shows the board's Now: what you are doing and your
last message.

Writing it again replaces the whole page, so give every block each time, and keep it current as
your work moves on. \`agent-board page --clear\` takes it off.

--file holds the page as JSON (- reads it from stdin): an object of name, icon and blocks, or
the list of blocks alone, with --name and --icon. --name and --icon win over the file's.

  {
    "name": "Export",
    "icon": "route",
    "blocks": [
      { "kind": "heading", "title": "Where I'm up to", "text": "Writing the CSV export.", "progress": 60 },
      { "kind": "figures", "figures": [
        { "value": "214", "label": "tests passing", "icon": "flask-conical", "tone": "green" },
        { "value": "18k", "label": "rows a second", "icon": "gauge" } ] },
      { "kind": "checklist", "items": [ { "text": "Columns", "state": "done" },
        { "text": "Tests", "state": "doing" }, { "text": "Docs" } ] },
      { "kind": "callout", "icon": "lightbulb", "tone": "violet",
        "text": "Invoices from before 2024 have no tax column; the export leaves it blank." },
      { "kind": "links", "title": "Try it", "links": [
        { "url": "http://localhost:5173/exports", "label": "Preview" }, { "path": "sample.csv" } ] },
      { "kind": "note", "title": "Test logins", "text": "ann, bob and cy · password: demo" }
    ]
  }

BLOCKS (at most ${MAX_PAGE_BLOCKS}; each may have "title", "icon" and "tone")
  heading     "title" (required), "text" (a line or two), "progress" (0-100, a bar).
  figures     "figures": 1 or ${MAX_PAGE_FIGURES} of { "value" (at most ${MAX_FIGURE_VALUE} characters, drawn large),
              "label", "icon", "tone" }.
  checklist   "items": at most ${MAX_PAGE_ITEMS} of { "text", "state" }: todo (unless you say), doing
              (the one you are on now, at most one) or done.
  callout     "text": a thing to notice, set apart.
  links       "links": at most ${MAX_PAGE_ITEMS} of { "url" (http or https, opened in a web tab) or "path" (a
              file; relative to your working directory, or absolute), and "label" }.
  note        "title" (required) and "text", such as test logins.

A name is at most ${MAX_PAGE_NAME} characters, and a block's text at most ${MAX_PAGE_TEXT}. A field a block
doesn't take is refused, so a misspelt one never goes missing quietly.

ICONS (lucide's names)
${wrapWords(PAGE_ICONS.join(', '), '  ')}

TONES
  ${PAGE_TONES.join(', ')}; neutral unless you pick one.
  Orange and red are the board's alone: they mean the user is needed, or something failed.

  --file <path|->       The page, or its blocks, as JSON.
  --name <text>         The tab's name.
  --icon <icon>         The tab's icon.
  --clear               Take your page off.
  --json                Print the page as JSON.`,
  },
  'needs-you': {
    usage: "agent-board needs-you [--via <ref>] [--] <reason> | agent-board needs-you --clear",
    text: `Asks for a look, without a question: nothing waits, and your turn goes on. A turn ending tells
no one, so say so when you are blocked, your work is ready for review, or you need a decision.
<reason> is one line, at most ${MAX_FLAG_LENGTH} characters: "PR #12 is ready for review".

An agent the user started is listed in their Needs you with the reason (and gets an OS
notification), until they open your session or you run \`needs-you --clear\`. Flagging again
replaces the reason.

An agent an orchestrator started flags that orchestrator instead, never the user: the reason is
typed at its prompt once its turn ends, and \`agent-board send\` from it clears the flag. An
orchestrator that can't settle it passes it on to the user with --via, naming the crew member.

For a question with answers to pick from, use the MCP tool \`ask\`, which waits for the answer.

  --via <ref>      Orchestrators: the crew member whose flag you pass on.
  --clear          Drop your flag: you no longer need a look.
  --json           Print the agent as JSON.`,
  },
  mcp: {
    usage: 'agent-board mcp',
    text: `Serves the board as MCP tools on stdio: whoami, board, connections, handoff, ask, present_plan,
show_doc, set_status, needs_you, open_pr, record_pr, record_doc, pin, unpin and set_page, and for an agent that may orchestrate as it starts, new_agent, send, wait, read,
interrupt, set_effort, continue_on_credits, restart, pause, wake, close, handover, add_edge, remove_edge, move, arrange, map,
zone_layout, add_note, edit_note, remove_note, prefabs, roles, set_role and remove_role. The app adds it to the agents it starts; add it to another Claude
with:

  claude mcp add agent-board -- agent-board mcp`,
  },
  orchestrate: {
    usage: 'agent-board orchestrate on|off <ref> [--scope zone|repo|board]\n       agent-board orchestrate handover <from> <to>',
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
read and wait for another orchestrator, but not steer one (send, interrupt, effort, restart, pause, wake,
close, or wire an edge into it) whose scope is wider than its own (board > repo > zone): a message
runs under the permissions of the agent that gets it.

\`agent-board orchestrate handover <from> <to>\` hands one orchestrator's crew and what it made
(notes, lane labels, clocks, shapes, connectors, zones and edges) to another, which may then
arrange, edit, remove and close them as its own. An orchestrator hands over its own crew, or
takes over one in its scope, no wider than its own, whose session has ended; either way the one
that gets the crew must have every agent in it in its scope. From a shell, the user hands over any.

As an orchestrator, a loop of implementing and reviewing looks like this:
  agent-board new --name impl -- 'Fix the flaky login test. Commit on your branch, write
    .agent-board/handover.md, and end with STATUS: done.'
  agent-board wait impl                      until its turn ends
  agent-board wait impl --until finished     or until it says its work is finished
  agent-board read impl                      its final message
  agent-board read impl .agent-board/handover.md
  agent-board new --base agent:impl --role reviewer --name review -- 'Review the diff against main'
  agent-board wait review && agent-board read review     (wait exits 3 if it gave up first)
  agent-board send impl -- 'Fix the review points: ...'
  agent-board close review --remove

A crew prefab starts a saved crew shape in one command, its builder (or its lead) with your
prompt, as the prefab says: \`agent-board new --prefab 'Implementer + reviewer' -- 'Fix the flaky
login test'\`. \`agent-board prefab ls\` lists them.

A send says "Sent" once the agent's turn has started on it. If it fails because the message was
typed at its prompt but no turn started, \`agent-board send impl --submit\` presses Enter on it, and
\`agent-board send impl --clear\` clears it, so the next send can go.

Keep your crew's tile lines current: a tile shows one status line (or else its task), and the
agent's last message is only a hover away. Set a crew member's with \`agent-board status set
--agent impl 'Retry fix in; waiting on review round 1'\` as its work moves on; its tile says you
set it. Only for agents you started, and theirs; the agent's own \`status set\` replaces yours.

Your sidebar, and each crew member's, lists what was recorded on it: pull requests, hand-off docs,
and the agents you started (recorded as you start them). Record each pull request you open with
\`agent-board record pr <url>\`, and each doc you write for the user with \`agent-board record doc
<path>\`; ask your crew to record theirs, their handovers \`--for orchestrator\` so they land on
your sidebar:
  agent-board new --name impl -- '... Record your PR with agent-board record pr <url>, and
    your handover with agent-board record doc .agent-board/handover.md --for orchestrator.'

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

A reviewer you start from an agent's branch (--base agent:impl, or --base <its branch>) is joined to
nothing: the reviewer and its implementer talk through agent-board send, findings back and the next
round, and the user never presses a Send button. If you do want a line between them, ask for it with
new --edges auto (the reviewer hands its findings back by itself; the way back is manual) or --edges
manual (one each way, left for the user to send), or wire them later with edge add, but keep one of the
two manual: two auto edges in a loop re-trigger each other, and a loop of them is refused. Never join
them to your own tile: lines from you to every agent you start only clutter the board.

Keep the crew tidy as it grows: arrange lays out your zone, you, the shells and the clocks you
or your crew made on the top row (the user's clocks stay put), then a lane per issue (or unit
of work): its label, its implementer, its reviewer, its follow-up reviewer, then an agent note
saying where each agent stands, each slot a column that lines up down the lanes. Send fix rounds back
to the same implementer and reviewer, so each unit stays one pair. move, zone and note do the
rest:
  agent-board arrange                        or: --by role, --by state, --layout columns
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
      'agent-board new [--zone <ref>] [--name <name>] [--harness claude|codex] [--model <model>] [--effort <level>] [--role <role>] ' +
      '[--repo <path>] [--branch <branch>] [--base <branch or agent ref>] [--edges auto|manual] [--issue <id>] [--file <path>] [--] <prompt> | ' +
      'new --prefab <name> [--zone <ref>] [--repo <path>] [--issue <id>] [--file <path>] [--] <prompt>',
    text: `Starts an agent with <prompt> (or the text of --file) as its first message, in a new worktree and
branch of its zone's repo, as the user starts one. In a group (a zone with no repo), give it one
with --repo, else it works in the group's default repo; with neither, in the group's own folder,
outside git, with no worktree or branch. You must be an orchestrator, a shell, or outside
agent-board: see \`agent-board help orchestrate\`. It prints the new agent's ref.

  --zone <ref>       A zone in your scope; your own by default (needed outside agent-board).
  --name <name>      Its tile's name; made from the prompt without.
  --harness <h>      claude (the default) or codex.
  --model <model>    The harness's model (opus, sonnet, haiku; gpt-5-codex, gpt-5); its default
                     without.
  --effort <level>   Its reasoning effort: low, medium, high, xhigh or max (Codex takes no max).
                     Without, the Settings default for its role, else for new agents, else the
                     harness's own.
  --role <role>      implementer, reviewer, follow-up-reviewer, custom, or any other name
                     (designer, 'release prep': 24 characters at most) for a custom role of
                     that name, which its tile shows. It starts with its zone's template for
                     the role (for a name, else the app's default role of that name: see
                     \`agent-board roles\`), filled in, then <prompt>; a name with neither starts
                     with <prompt> alone. A reviewer works on a detached checkout of --base,
                     the branch it reviews, with no branch of its own.
  --repo <path>      In a group, the repo (or a folder in one) to cut its worktree from, for
                     this task. Refused in a zone bound to a repo, whose agents work in it.
  --no-template      Start it without its role's template: its first message is exactly <prompt>
                     (and the issue, if --issue). For when you write the whole prompt.
  --branch <name>    Its new branch; made from its name without. Not for a reviewer.
  --edges auto|manual  Join a reviewer started on an agent's branch to that agent, both ways. None
                     without: they talk through agent-board send. auto hands the reviewer's findings
                     back by itself (the way back is manual); manual leaves both for the user to send.
  --base <b>         The branch to cut it from, or an agent's ref (agent:9c1e, agent:impl) for
                     that agent's branch, as for a reviewer of its work; the repo's HEAD without.
                     In a group, an agent's ref takes its repo too, unless --repo names one.
                     Refused when its project config (.claude, .mcp.json, .codex) differs
                     from HEAD's.
  --issue <id>       An issue in the zone's tracker: it comes first in the prompt.
  --file <path>      Read the prompt from a file.
  --prefab <name>    Start a crew from a crew prefab (\`agent-board prefab ls\`) in place of one
                     agent: its member that starts on the prompt, its builder or its lead, gets
                     <prompt>, as the prefab says to start it (role, harness, model, effort).
                     Its reviewers start on the builder's branch each time the builder hands
                     off, a fresh one each round, and their reviews go back to it, until each
                     approves or the round limit: see \`agent-board crew\`. A lead starts its
                     own crew, whose members count toward crew depth. Takes --zone, --repo,
                     --issue and --file; the prefab sets the rest.
  --json             Print the agent as JSON.`,
  },
  prefab: {
    usage:
      'agent-board prefab [ls] [--json] | prefab show <name> [--json] | prefab export <name> [--out <path>] | ' +
      'prefab import <file> [--add [--replace]] | prefab remove <name>',
    text: `The app's crew prefabs: saved crew shapes, each its members (a role, harness, model and
reasoning each), when each starts, and a round limit. One library for every board: the
built-ins (Solo agent, Implementer + reviewer, Implementer + code + design reviewers, Spike +
reviewer, Lead and crew), then those added. \`agent-board new --prefab <name> -- <prompt>\`
starts a crew from one.

\`prefab\` (or \`prefab ls\`) lists them, and \`prefab show\` prints one: its members in words, then
its .crew.json file. \`prefab export\` writes that file, to share; \`prefab import\` reads one and shows it whole,
and adds it to the library only with --add. A file holds no prompt, issue, repo, branch, key or
token, and a field it doesn't know is refused. Only a named role's member carries a template of
its own, checked as a prompt is. \`prefab remove\` removes one that was added; a built-in stays.

Adding and removing reach every board, so they are for the user (in a shell or terminal) or an
orchestrator of the whole board, and are logged (\`agent-board activity\`).

  --out <path>    Where \`export\` writes the file: <name>.crew.json here without. Never over a file.
  --add           Add the imported prefab to the library.
  --replace       With --add, replace a prefab added before under the same name.
  --json          Print it as JSON.`,
  },
  crew: {
    usage: 'agent-board crew [ls] [--json] | crew show <crew> [--json] | crew stop <crew> | crew round <crew>',
    text: `A running crew, started with \`agent-board new --prefab\` from a prefab with reviewers that
start at its builder's hand-off. The board runs its loop:

  1. The builder hands off (\`agent-board handoff\`, or ends its turn with its handover written).
  2. The prefab's reviewers start, fresh, on detached checkouts of its branch: the next round's
     are given the last review. Each writes .agent-board/review.md.
  3. Once each has: if every one approves with no blocker open, the crew stops ready to merge.
     If not, the reviews go back to the builder, as a hand-off from a reviewer that asked for
     changes, and the round's reviewers close (the crew keeps their reviews). The builder's next
     hand-off starts the next round.
  4. At its round limit (the prefab's) it stops instead. \`crew round\` gives it one more round.
     A round whose reviewers failed to start (a harness not set up) is flagged: \`crew round\`
     starts the ones it lacks.

While its builder waits on you (a permission prompt, a question or a plan), the round doesn't
start; a reviewer paused, or stopped by a restart, is waited for. A stop flags its builder, so it reaches you, or the orchestrator that started the
crew, in Needs you. It passes on only what its agents wrote, and approves, merges and draws
nothing: merging is yours. Once its builder's pull request is merged, the crew closes its
agents and their worktrees, unless you stopped it to take it over. Its builder's crew events
(\`watch\`, \`wait --crew\`) include \`round\` and \`crew-stopped\`.

\`crew\` (or \`crew ls\`) lists the crews you reach, and \`crew show\` prints one: its round, whose turn it
is, and each round's reviewers with their verdicts. \`crew stop\` stops its loop and leaves its
agents as they are; \`agent-board wait <crew>\` waits until it stops.

  --json          Print it as JSON.`,
  },
  send: {
    usage: 'agent-board send <ref> [--file <path>] [--] <message> | send <ref> --submit | --clear',
    text: `Sends the agent <message> (or the text of --file) as its next message, as the user typing it
would. Only once its turn has ended: wait for it first, or interrupt it. To an agent still
starting it is queued until its session is up, after its first prompt. To an orchestrator
mid-turn it is queued until that turn ends, then sent as a turn of its own, after any sent
before it, or behind any still waiting (its tile counts them; a \`wait\` on it, if you may
wait on it, waits for that turn). Never to an agent
that needs the user's permission, and never a harness command (a message starting with ! or
a /command other than a plugin's /plugin:command). Only printable text, tabs and line
breaks: no control characters.

It says "Sent" only once the agent's turn has started on it. A message typed at its prompt
whose Enter starts no turn stays there, unsent (its tile says so), and send fails, saying
why: nothing more is typed at that prompt until it is sent or cleared. --submit presses
Enter on it, as the tile's Send does, and fails, leaving it unsent, if no turn starts;
--clear clears it. Both only for an agent you may steer, and never while the user is typing at its prompt.

Any agent may send back to an agent that messaged it, for an hour after its latest message,
even one outside its scope, and even if it may not orchestrate: a message it couldn't otherwise
answer ends with a line naming who sent it. That opens a reply and nothing more: no wait,
read, interrupt, restart or close, and the answer opens no way back.

Any orchestrator may send the Captain a message, whatever its scope: a message only, so
--submit, --clear, waking it and every other command on the Captain stay out of its scope.
The Captain is told who it is from.

What the agent reads starts with your sender mark, so it and its chat know the message is
yours, not the user's: \`⟨send from impl · agent:944e1234⟩ Fix the review points: ...\`
(\`reply\` instead of \`send\` when it answers the agent's message, flag or question). send
prints how it starts, as typed (with --json, all of it).

  --file <path>   Read the message from a file.
  --submit        Press Enter on the message left unsent at its prompt.
  --clear         Clear the message left unsent at its prompt.
  --json          Print the agent as JSON.`,
  },
  wait: {
    usage: 'agent-board wait [<ref>...] [--crew] [--until <state,...>] [--any] [--timeout <duration>]',
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

Exits 0 when they are there, and 3 (not 0) when it gave up first: wait again. So
\`agent-board wait impl && agent-board read impl\` reads only once it is there.

  --crew             Your crew too: the agents you started, and theirs. With no refs, it is.
  --until <states>   Wait for these instead, by comma: ${WAIT_STATES.join(', ')}.
  --any              Until one of them is there, not all.
  <crew>             A crew's ref (crew:<id>) waits until it stops instead: ready to merge, at
                     its round limit, or stopped (\`agent-board crew\`). Alone, with --timeout.
  --timeout <d>      Give up after this long: seconds, or with s, m or h (90s, 30m). ${DEFAULT_ORCHESTRATOR_WAIT_MS / 1000}s by
                     default, at most ${MAX_ORCHESTRATOR_WAIT_MS / 1000}s.
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
permission prompt, or a question or plan of its own; flagged is it asking you for a look
(\`needs-you\`, also typed at your prompt); not-sent a message typed at its prompt (a hand-off,
a run) that started no turn and waits for Send; pr-opened an open pull request new since the
daemon started; paused is someone pausing it (by whom): no end, as a message wakes it; ended is
its session ending: closed, exited <code>, or removed. A removed agent's last lines still come.

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
  effort: {
    usage: 'agent-board effort <ref> <level> [--json]',
    text: `Changes an agent's reasoning effort (low, medium, high, xhigh or max; Codex takes no max), as
its tile's Reasoning menu does, and says when it takes it. A Claude agent at its prompt takes it
at once: \`/effort <level>\` is typed there as you would. One mid-turn, waiting on a question or
a permission prompt, or with you typing at it, takes it once it is free, never typed into a turn.
A Codex agent, or an ended one, takes it when next started. A restart keeps it.

  --json   Print the agent as JSON, with when it applies.`,
  },
  continue: {
    usage: 'agent-board continue <ref> [--json]',
    text: `Continue on credits: resumes the turn of a Claude agent its usage limit stopped (rate-limited),
for its usage credits to pay for, as the user would in its terminal. It closes the menu Claude
opens there with Escape, picking no row (so never one that opens a billing page), then submits
\`continue\` at the prompt, as Claude does by itself at the reset; text already there is refused.
Only while it is rate-limited, and never by itself: an orchestrator or the user chooses it. Waits
until its turn starts. If the limit stops it again at once, its usage credits are spent too: tell
the user.

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
  pause: {
    usage: 'agent-board pause <ref> [--json]',
    text: `Pauses an idle agent to free what its harness holds (its memory, mostly): its session ends,
keeping its tile, worktree, branch and conversation, and its tile shows it paused, by you. Only
an agent between turns that waits on no one: refused mid-turn, while it waits on the user, while
a message sits unsent at its prompt, and while one is being sent to it. Any background command
it started ends with it. Nothing pauses an agent by itself. Its orchestrator's \`watch\` hears
paused, not ended; \`close\` leaves it a plain closed agent, without waking it.

\`agent-board wake\`, the user's Wake, a message (\`send\`), a hand-off or a scheduled run wakes it,
carrying on its conversation (Claude with --resume, Codex with codex resume). A message waits
for it to start, as its first message.

  --json   Print the agent as JSON.`,
  },
  wake: {
    usage: 'agent-board wake <ref> [--json]',
    text: `Wakes a paused agent: starts it again in its tile, worktree and branch, carrying on its
conversation, as its tile's Wake does. Refused for an agent that is not paused.

  --json   Print the agent as JSON.`,
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
  usage: {
    usage: 'agent-board usage [--json]',
    text: `The plan's 5-hour and weekly usage: each window's used and left, when it resets, and when it
was read. A Claude agent's status line posts it as the agent runs, so nothing is asked of anyone
and no tokens are spent; with no Claude agent running for a while it is stale.

${READ_FLAGS}`,
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
    usage: 'agent-board arrange [<zone ref>] [--by issue|role|state] [--layout rows|columns|cards|grid|wrap|masonry|treemap] [--auto on|off] [--json] | arrange board [--json]',
    text: `Lays out the tiles of your zone (or <zone ref>, in your scope) that you may move, for an
orchestrator: you first, then

  --by issue   a lane per issue (the default), a row each, below you, the shells and your
               crew's clocks: its
               label in the first column; then a column per slot, the same in every lane:
               the implementer (and the others doing the work), the reviewer (anything that
               reviews another), the follow-up reviewer, a second of one slot in a column
               of its own and no column for a slot no lane uses. Lanes go in the order their
               work started. Right after its last tile, an agent note by you saying where
               each of its agents stands (its status line, else its latest STATUS, else its
               state, and its PR; never its task). No card for its pull
               request, as each tile shows its own, and any an earlier arrange made go.
               Arranging again moves the label and note with it; a note anyone has edited
               keeps its text. One whose unit has gone is removed. An agent note you put
               beside one of its agents (note add --near) becomes its note.
               Without an issue, a unit is the agents joined by edges or sharing a ticket in
               their branch (acme-199-… is ACME-199), labelled by that ticket, else the words
               its agents' names start with, else its implementer's name.
  --by role    a row per role (implementers, then the others doing the work, then
               reviewers), each reviewer under the agent it reviews
  --by state   a row per state, the ones needing the user first

and, by role or state, shells and your crew's clocks last. --layout columns turns each row into
a column instead: you, the shells and your crew's clocks stacked first, then a column per lane,
its label with its note below it on top, then its tiles under them in slot order. --layout cards makes each lane a card instead,
two across (three past four lanes), a free column and row between them: its label and note,
implementer and reviewers on one row, its follow-up reviewers under them. --layout wrap stacks
the lanes as rows do, but each lane's label and note sit in its first column and its tiles, in
slot order, wrap onto a new row after four, each lane with its own columns; by role or state it
lays out as rows. --layout masonry packs each lane, as wrap lays it out, into the shortest of
as many columns of lanes as best fit the app's window (or the zone's width with no window open).
--layout treemap gives each lane a block sized by its tiles, packed to the window's shape (16:10
with none open). By role or state, masonry and treemap pack each row as a lane. --layout grid fills
the zone's width in the same order
instead of a row each, but only with the tiles no edge joins: a unit whose tiles an edge joins
(you too, if one joins you) is laid out exactly as rows lay it out, from the top, and the grid
fills round it, clear of its rails. By role or state, or as a grid, an arrange by issue's
labels and notes line up beside the crew until you arrange by issue again. Agents joined by an edge get a grid
column's room (or a row's) past every tile and row the rail between them runs by, so the rail
has room for its document and label at either end.
Every tile lands on the zone's grid, so rows and columns line up across clusters. What it may
not move (the user's notes and cards, tiles outside your scope) stays put, and the rows keep
clear of it. The zone then fits what it holds, growing or shrinking to it (and what stays put)
plus its margin, never over another zone. A tile expanded in place counts at its expanded size,
so its lane is taller and its column wider. The same board always arranges the
same way, so arranging again moves nothing. A reviewer you start on a clustered agent's branch
(--base agent:<ref> --role reviewer) joins its cluster, after it. After it arranges, it prints
the zone's map (\`zone map\`), so you can check the layout at once.

--by, --layout and --auto are kept as your settings: a bare arrange arranges as you last asked
(by issue, in rows, until you ask otherwise). With --auto on, your zone is arranged by itself
after every agent you start, note you add and agent you close, the new one in its lane, so you
need not call arrange; --auto off stops it.

\`arrange board\`, for an orchestrator of the whole board (the Captain), lays out the board
itself, never what is in a zone: whole zones, at their sizes and with all they hold, in rows in
reading order a roomy gap apart, from the top-left of where they are, and the agents and shells
loose on the board in rows below them. The notes, shapes and text loose on the board stay put,
and what moves keeps clear of them. It is never run by itself. It takes no --by, --layout or
--auto.

  --by <b>         ${ARRANGE_BYS.join(', ')}.
  --layout <l>     ${ARRANGE_LAYOUTS.join(', ')}.
  --auto on|off    Arrange by itself as the crew changes, or not (off at first).
  --json           Print what moved, and the map, as JSON.`,
  },
  zone: {
    usage:
      'agent-board zone add --group --name <name> [--color <#rrggbb>] [--at <x>,<y>] [--size <w>,<h>] | ' +
      'zone rename <ref> <name> [--color <c>] | zone resize <ref> --size <w>,<h> [--at <x>,<y>] | zone remove <ref> | ' +
      'zone map [<ref>] [--boxes] [--sections] | zone screenshot [<ref>] [--out <file.png>] [--style board|lofi] | ' +
      'zone layout free|shelves|clusters [<ref>]',
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

\`zone map\` reads your zone (or <ref>, in your scope) as \`arrange\` sees it, moving nothing: a
line per lane with a cell per slot (implementer, reviewer, follow-up, notes), each tile's ref,
name and state, a free slot as ·, and you, the shells, your crew's clocks and what is in no
lane on the top line; then where the next lane goes, which lanes are all done, and a lint line:
things on top of each other, the widest gap in a lane (in slots), the space between lanes, a
label far from its tiles, a zone mostly empty (a band of empty columns or rows across it), and
the tiles not where an arrange would put them, or out of their lane's row (a tile dragged by hand), all of which the next arrange puts right. \`arrange\`
prints it after every arrange. --boxes draws the zone in characters instead, about one to
40 px, a key on each tile and note and a legend below: overlaps (#) and gaps show where they
really are, whatever the layout, at about three times the length. A zone with a diagram ends
with it in short: each shape's kind, text and how many attributes and methods it has, and each
connector's ends, relation and labels, at most 40 lines; --sections lists a class's members
too, a few of each and cut short. \`agent-board show <ref>\` prints one shape whole.

\`zone screenshot\` writes a PNG of your zone (or <ref>, in your scope) and prints where, the
zone's size, the scale it is drawn at and the map's lint line. The app takes it in a hidden
window, as the board draws it, with every terminal's text hidden; it never moves the user's
view, and fails when the app isn't open. A zone over ${MAX_CAPTURE_SIDE} px a side is drawn smaller
to fit. --style lofi draws the zone plainly instead, from what the board knows: each tile and
note as a labelled box, and its edges and connectors as straight lines. Check with \`zone map\`
first: a picture costs a model far more to read.

\`zone layout\` sets how your zone (or <ref>, in your scope) draws what it holds, as the zone's
Layout menu does in the app. free: each tile where it was put (every zone starts free).
shelves: its work as one stack per ticket on To do, Doing, Waiting and Done shelves, under a
head row of the zone's leads and shells; a click on a stack fans its tiles out below the shelves.
clusters: each ticket's tiles drawn together under its label, what needs the user first, under
the same head row. No tile's own place changes, so going back to free shows the zone as it was.
A zone is never laid out so by itself: choose shelves when its work is easier to follow by
status, clusters when by ticket.

  --group          Make a group (an orchestrator makes no other zone).
  --name <name>    Its name.
  --color <c>      #rrggbb.
  --at <x>,<y>     Where its top-left goes on the board.
  --size <w>,<h>   Its size: 720,480 by default.
  --boxes          zone map: draw the zone as boxes.
  --sections       zone map: list a diagram's class members, not only their counts.
  --out <file>     zone screenshot: where to write the PNG (by default a temp file per zone and style).
  --style <s>      zone screenshot: board (as the app draws it) or lofi (a plain drawing).
  --json           Print the zone (or map, or screenshot's details) as JSON.`,
  },
  note: {
    usage:
      'agent-board note add [--text <text> | [--] <text>] [--kind sticky|text] [--color <c>] [--to <zone ref>] [--at <x>,<y>] ' +
      '[--near <ref> [--side <s>]] | note edit <ref> [--text <text>] [--color <c>] [--size <w>x<h>] | note remove <ref>',
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

\`note edit --size\` resizes an agent note, as dragging its corner does: it keeps that size when
you arrange (the lane is laid out round it) and when the app restarts, and text that doesn't
fit scrolls, with a \`more\` cue. It is at least 200x96 and at most 1200x1440.

  --text <text>    Its text (or give it after --).
  --size <w>x<h>   An agent note's width and height, for \`note edit\`, such as 360x240.
  --kind <k>       sticky or text. From an agent, a note with no --kind is an agent note and
                   --kind sticky makes a signed sticky; elsewhere sticky is the default.
  --color <c>      A sticky note's yellow, orange, pink, violet, blue, green, grey or white;
                   text's accent, ink, grey, red, orange, yellow, green, teal, cyan, blue,
                   violet or pink, which follow the theme; or #rrggbb, which doesn't.
  --to, --at, --near, --side
                   Where, as for \`agent-board move\`.
  --json           Print the note as JSON.`,
  },
  shape: {
    usage:
      'agent-board shape add <kind> [--text <text> | [--] <text>] [--attribute <line>]... [--method <line>]... [--fill <f>] [--to <zone ref>] ' +
      '[--at <x>,<y>] [--near <ref> [--side <s>]] | shape edit <ref> [--kind <kind>] [--text <text>] [--attribute <line>]... [--method <line>]... ' +
      '[--fill <f>] | shape remove <ref>',
    text: `Shapes for an orchestrator (\`agent-board help orchestrate\`) to draw a diagram with, marked as made
by you. Draw only when the user asks for a diagram. \`shape add\` puts a shape of <kind> with <text> in it
in your zone (or --to's), at its first free spot, or exactly at --at or beside --near (another
shape, to lay the diagram out), what is there moving aside as for \`agent-board move\`. It is
sized for its text, and the board grows it taller if it needs more.

A class or interface-box has sections under its name: give each attribute with --attribute and
each method with --method, in order, one line each (\`+ id: UUID\`, \`+ total(): Money\`). They are
set in the mono font. Another kind has no sections, and refuses them.

\`shape edit\` changes only what it is given: --attribute or --method replaces that whole section.
It and \`shape remove\` change only a shape you, or an agent you started, drew; in a shell, or
outside agent-board, any shape. Removing a shape removes every connector on it. \`agent-board show\`
prints a shape's text, sections and connectors; \`agent-board zone map\` sums up a zone's diagram.

  <kind>           rectangle, rounded, ellipse, diamond, terminator, database, queue, cloud,
                   server, service, user, note, class, interface-box, component, package,
                   actor, use-case, state, ... (\`shape edit\` takes it as --kind)
  --text <text>    Its text: a class's name (or give it after --).
  --attribute <line>, --method <line>
                   A line of a class's (or interface-box's) attributes or methods; repeat it.
  --fill <f>       tile (the default), accent, yellow, green, teal, cyan, blue, violet, pink,
                   red or orange, which follow the theme; #rrggbb, which doesn't; or none.
  --to, --at, --near, --side
                   Where, as for \`agent-board move\`.
  --json           Print the shape as JSON.`,
  },
  connect: {
    usage: 'agent-board connect <from ref> <to ref> [--relation <r>] [--style straight|elbow|curved] [--label <t>] [--from-label <t>] [--to-label <t>]',
    text: `Joins two items on the board (shapes, notes, cards) with a connector, marked as made by you:
for an orchestrator (\`agent-board help orchestrate\`) drawing a diagram, only when the user asks for
one. The line goes from <from ref> to <to ref> as the relation reads, and its sides face each
other. Both items must be in zones you may lay out.

  --relation <r>   Its ends and dash, from → to:
${RELATIONS.map((relation) => `                     ${relation.id.padEnd(12)} ${relation.reads ?? (relation.id === 'directed' ? 'an arrow at to (the default)' : 'a plain line')}`).join('\n')}
  --style <s>      straight, elbow or curved (the default).
  --label <t>      The text on its middle.
  --from-label <t>, --to-label <t>
                   The text by its from or to end: a multiplicity (1, 0..*) or a role.
  --json           Print the connector as JSON.

\`connector edit\` and \`connector remove\` change it.`,
  },
  diagram: {
    usage:
      'agent-board diagram add [--file <path> | -] [--to <zone ref>] [--at <x>,<y>] [--near <ref> [--side <s>]] [--] [<mermaid>] | ' +
      'diagram export [<zone or shape ref>...]',
    text: `Mermaid in and out of the board, for an orchestrator (\`agent-board help orchestrate\`) drawing a
diagram, only when the user asks for one.

\`diagram add\` draws a Mermaid flowchart (\`flowchart TD\`, or LR) or class diagram (\`classDiagram\`)
as shapes and connectors marked as made by you, laid out in ranks as Mermaid draws it, and placed
as one block in your zone (or --to's), at its first free spot, or exactly at --at or beside --near.
Give the text after --, or in a file with --file (- reads it from stdin). A flowchart's brackets
pick each shape ([box], (rounded), {decision}, [(database)], @{ shape: doc } ...), and its links
their ends, dash and label; a class diagram's classes take their attributes and methods, an
<<interface>> is a box interface, and each relation (<|--, *--, o--, ..>, ..|>) its ends and the
multiplicities by them. \`style <id> fill:#rrggbb\` sets a fill. It prints the lines it passed over:
subgraphs are drawn without their box, and clicks, classDefs and notes are left out.

\`diagram export\` prints the shapes named (a zone's, or each shape ref; your zone with none) and the
connectors between them as Mermaid: a class diagram when a class is among them, else a flowchart.
\`shape edit\` and \`connector edit\` change what was drawn.

  --file <path>    Read the Mermaid text from a file, or - for stdin.
  --to, --at, --near, --side
                   Where the diagram goes, as for \`agent-board move\`.
  --json           Print what was drawn, or the text, as JSON.`,
  },
  connector: {
    usage:
      'agent-board connector edit <ref> [--relation <r>] [--style straight|elbow|curved] [--label <t>] [--from-label <t>] [--to-label <t>] | connector remove <ref>',
    text: `Changes a connector you, or an agent you started, made with \`agent-board connect\`; in a shell, or
outside agent-board, any connector. \`connector edit\` changes only what it is given, with the
options of \`connect\` (an empty label clears it). \`connector remove\` deletes it. \`agent-board show
<ref>\` prints its ends, relation and labels.`,
  },
  steps: {
    usage:
      'agent-board steps new [--title <text>] [--file <path>|-] [--] <line>... | steps ls [--mine] | steps read <card> | ' +
      'steps done <card> <n>... [--undo] | steps wait <card> <n> | steps add <card> [--file <path>|-] [--] <line>... | ' +
      'steps answer <card> [<n> <answer>] [--send] | steps close <card>',
    text: `A steps card is an ordered list on the board: questions for the user to step through, and
to-dos, each ticked by whoever it names. Put one up when you have more to ask than one question,
or a list of things to get done in order; one quick question is the MCP tool \`ask\`.

Write it one step a line, as people type them too:
  # Title                                 The card's name (or --title).
  ## Section                              Starts a section of the steps that follow.
  - [ ] Merge the fix @impl -> <link>     A to-do, for the agent named (@user for the user;
                                          you, without one), with a link. [x] is done.
  ? Which database? [Postgres | SQLite]   Pick one.
  ? Which checks? [any: lint | unit]      Pick any.
  ? Ship on Friday? [yes/no]              Yes or no.
  ? Rank the risks [order: loss | cost]   Put in order.
  ? Anything else?                        In their own words.
Add (required) to a step the set can't be sent, or the list finished, without. " -> " in a to-do
starts its link, so keep it out of the text, and "|" and "]" out of choices. A card holds at most
50 steps and 12 questions; a question offers 2 to 9 choices (6 to put in order).

Nothing waits: \`steps new\` returns at once. End your turn. Once the user has answered and pressed
Send, the answers are typed at your prompt, led by [agent-board]; if they change an answer and
send again, you are told what changed. If an orchestrator started you, it answers your questions
instead, and is told. Naming an agent on a to-do sends it nothing: it finds its to-dos with
\`steps ls --mine\`.

  steps ls [--mine]         The cards you can read: in your zone, in zones your orchestrator
                            scope reaches, loose ones, and any you are part of. --mine: those
                            with a to-do of yours not yet done.
  steps read <card>         One card in full, each step numbered, with its answer or tick.
  steps done <card> <n>...  Tick your to-dos (--undo unticks them).
  steps wait <card> <n>     Be told at your prompt once someone else ticks to-do <n>, or the
                            card is closed.
  steps add <card> ...      Add steps to the end of a card you made.
  steps answer <card> <n> <answer> [--send]
                            For an orchestrator, answer a crew member's question: a choice by
                            its number or text, several split by commas, yes or no, or words.
                            --send sends the answers, as the user's Send does.
  steps close <card>        You are done with a card you made: nothing on it changes now.

  --json                    Print the card as JSON.`,
  },
  memory: {
    usage:
      'agent-board memory ls | memory read <memory> [<entry>] [--search <text>] | memory add <memory> [--key <key>|--no-key] [--file <path>|--doc <title>] [--] <text>... | ' +
      'memory edit <memory> <entry> [--key <key>|--no-key] [--pin|--unpin] [--] [<text>...] | memory rm <memory> <entry> | ' +
      'memory history <memory> <entry> | memory restore <memory> <entry> <version> | memory confirm <memory> <entry> | memory new <title>...',
    text: `A memory is shared context on the board: what agents and people want kept, read and changed
by anyone in its scope. In a zone, its scope is that zone's agents (and orchestrators whose scope
reaches it); loose on the board, every agent's; set to No agents, only the user's. Read the
memories you can at the start of work, and keep what the next agent needs in one.

It holds facts and documents:
  key: value       A fact under a key (one word). Setting a key again replaces its value.
  a note           A fact with no key, kept as written.
  a document       Text kept whole (up to 1 MB) under its title: listed by its title and size,
                   read only when named.

  memory ls                     The memories you can read.
  memory read <memory>          Its facts in full, pinned first, then newest first, then its
                                documents by title; --search <text> only those holding it. With
                                <entry> (a key, a document's title, or its #id), that one in full.
  memory add <memory> <text>    Remember something: "key: value", or a note. --key <key> names it
                                (spaces and all), --no-key keeps "a: b" as a note. --doc <title>
                                keeps the text as a document; --file <path> keeps that file as
                                one, under its name (or --key).
  memory edit <memory> <entry> [<text>]
                                Change its text, key (--key, or --no-key), or pin (--pin keeps
                                it in the top rows, --unpin).
  memory rm <memory> <entry>    Remove it.
  memory history <memory> <entry>
                                Its versions, newest first: every change anyone made, removes too.
  memory restore <memory> <entry> <version>
                                Put a version back, undoing the changes after it.
  memory confirm <memory> <entry>
                                Say it is still true: it no longer reads as stale.
  memory new <title>            Put a new memory beside your tile.

<memory> is its ref (item:3f2a) or its title. An entry left 30 days reads as stale. Reading a fact,
or a document by name, counts you among its readers. Anyone in scope
may change any entry, the user's too: history takes a change back. At most 500 entries and 8 MB a
memory, and 4,000 characters a value (keep longer text as a document).

  --json                        Print it as JSON.`,
  },
  remind: {
    usage: 'agent-board remind [add] [--] <text>... | remind ls [--mine] | remind done <n> | remind undo <n> | remind rm <n>',
    text: `A to-do list holds reminders for the user: things only they can do, such as sending a pull
request for approval, answering a question on it, or restarting the app. Each agent has one
list, under its tile, made by its first to-do; the user keeps lists of their own too. The user
ticks, edits, moves and takes off any line. Nothing is done for them, and nothing tells you when
they tick one: read your list when you need to know.

  remind <text>...              Add each <text> as a to-do (a line break in one makes two). Start
                                with \`remind add\` when the to-do's first word is ls, done, undo
                                or rm.
  remind ls                     The to-do lists you can read, each line numbered, with who ticked
                                it and when: \`[x] Send the PR for approval · you, 14:06\`.
  remind ls --mine              Only your own list.
  remind done <n>               Tick line <n> of your list, one you wrote: it is done after all.
  remind undo <n>               Untick it.
  remind rm <n>                 Take it off: the user need not do it now.

<n> is the line's number in \`remind ls --mine\` as the list is now: the user may have moved
lines since you read it, and the answer names the line it changed. A line the user wrote is
theirs to tick or take off. At most 100 lines a list, and 500 characters a line. For questions the user answers
together, use a steps card (\`steps --help\`).

  --json                        Print it as JSON.`,
  },
  queue: {
    usage:
      'agent-board queue ls | queue read <queue> | queue add <queue> [--kind job|note] [--front] [--link <url>] [--file <path>|-] [--] <line>... | ' +
      'queue take <queue> [<job>] | queue drop <queue> <job> | queue done <queue> <job> | queue edit <queue> <job> [--link <url>] [--] [<text>...] | ' +
      'queue move <queue> <job> <before>|top|last | queue drain <queue> on|off [--most 1-3] | queue rm <queue> <job> | queue history <queue> <job> | queue restore <queue> <job> <version> | queue new [--for-user] <title>...',
    text: `A queue holds jobs in order, for agents to take one at a time, and plain notes. Its scope is
a memory's: where it sits. What goes in and comes out is for agents in scope and the user to
decide. A queue for the user (--for-user) holds what is ready for them to look at: agents add to
it, and only the user takes from it.

  queue ls                      The queues you can read.
  queue read <queue>            Its jobs and notes in order (the next job first), then those done.
  queue add <queue> <line>...   Queue a job a line, at the end (--front: at the front, in the
                                order given). " -> <link>" at a line's end is its link (or
                                --link for one). --kind note adds notes instead.
  queue take <queue> [<job>]    Take the next job, or that one: it is yours until you finish or
                                drop it. If your session ends first, it goes back to the front.
  queue done <queue> <job>      It is done.
  queue drop <queue> <job>      Put it back at the front, for someone else. Each drop is counted.
  queue edit <queue> <job> [<text>]
                                Change its text, or --link ("" clears it).
  queue move <queue> <job> <before>|top|last
                                Put it just before another open job, at the top, or last:
                                the next \`take\` takes them in this order.
  queue rm <queue> <job>        Remove a job or note.
  queue history <queue> <job>   Its versions, newest first.
  queue restore <queue> <job> <version>
                                Put a version's text and link back (or the job, once removed).
  queue drain <queue> on|off    For a queue you made: the board starts a fresh agent (your
                                harness) for each waiting job, its job taken for it and closed
                                once it is done, at most --most (1 to 3, 2 at first) at once.
  queue new <title>             Put a new queue beside your tile; --for-user, one for the user.

<queue> is its ref or its title; <job> is its #id (the start of it will do). A job another agent
holds is its, or the user's, to change. At most 200 open jobs a queue.

  --json                        Print it as JSON.`,
  },
  schedule: {
    usage:
      "agent-board schedule add '<cron>' (--to <ref> | --fresh [--zone <ref>] [--harness claude|codex] [--model <m>] [--role <r>] [--keep] " +
      '[--result history|note|handoff [--handoff-to <ref>]] | --self [--after hibernate|idle]) [--file <path> | [--] <prompt>] | schedule list | schedule remove <ref> | ' +
      'schedule set [--self | <ref>] --after hibernate|close|idle --why "…" | schedule stop [--self | <ref>] --why "…" | ' +
      "schedule add --template <name> [<cron> [<prompt>]] [--to <ref> | --self | --fresh …] | schedule template save <name> (--from <ref> | '<cron>' [--after <mode>] [--harness, --model, --role, --keep, --result] [--] <prompt>) | " +
      'schedule template list | schedule template remove <name>',
    text: `Schedules, each a clock on the board that fires on a five-field cron expression (minute
hour day month weekday, or @daily, @hourly…) in the machine's local time. Quote the expression.

Any agent has a clock of its own: one that messages it, or whose run started it.
\`schedule add --self\` adds one beside your tile, for a long watch, hibernating you after each
run (--after hibernate: you are paused, and the next run wakes you in the same conversation)
or leaving you idle (the default). \`schedule set --after hibernate|close|idle\` changes what it
does with you after each run: close starts a fresh agent each run instead, and closes you once
this run is over. \`schedule stop\` turns it off; only the user turns it on again. Both need
--why, which the user sees on the clock, and act on your own clock: name it with <ref> if you
have more than one.

An orchestrator (\`agent-board help orchestrate\`) also adds clocks for its crew, marked as
made by it. With --to, it sends <prompt> to that agent at each fire time, as its next message
(relaunching it if its session has ended; a time at which it is busy is skipped, and three
skipped in a row while it was still working flag it: its turn looks stuck). The clock goes on
the agent's tile's left. With --fresh, it starts a fresh agent each time, in --zone (your zone
by default) with <prompt> as its task, waits for its turn to end, keeps its final message in
the clock's run history, and closes it (--keep leaves it open); a time at which the last run
is still going is skipped. --result note also leaves the result as a note where its tile was;
--result handoff hands it to --handoff-to's agent.

\`schedule list\` prints each clock's ref, its schedule, what it does, when it next runs and how
its last run went: for a run of skips, how many, since when and why. \`schedule remove\` removes only a clock you, or an agent you started, made;
in a shell, or outside agent-board, any.

A template is a clock saved under a name, for any zone, to start new ones from: its schedule,
prompt and mode, and a fresh agent's settings, never the agent it messages. \`schedule template
save <name> --from <clock>\` saves a clock, or give its cron, prompt and --after (with --after
close, a fresh agent's options); saving under a name you saved replaces it. \`schedule add
--template <name>\` starts a clock from it: a cron, a prompt, --to, --self or --fresh given
override its own. \`schedule template remove\` removes only a template you saved; in a shell, or
outside agent-board, any.

  --to <ref>         The agent it messages, in your scope.
  --self             Message you: a clock of your own.
  --after <mode>     What your own clock does with you after each run: hibernate, close or idle.
  --why <text>       Why you are changing your own clock.
  --template <name>  Start from a saved template.
  --from <ref>       The clock \`schedule template save\` saves.
  --fresh            Start a fresh agent each run instead.
  --zone <ref>       A fresh agent's zone, in your scope.
  --harness, --model, --role
                     A fresh agent's, as for \`agent-board new\`.
  --keep             Leave a fresh agent open once its run is over.
  --result <r>       history (the default), note or handoff.
  --handoff-to <ref> The agent a fresh agent's result is handed to, in your scope.
  --file <path>      Read the prompt from a file.
  --json             Print the clock and its status as JSON.`,
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

/** `words`, a comma-separated list, wrapped to lines of at most 96 characters, each starting with `indent`. */
function wrapWords(words: string, indent: string): string {
  const lines: string[] = [];
  for (const word of words.split(' ')) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last]!.length + word.length + 1 <= 96) lines[last] += ` ${word}`;
    else lines.push(`${indent}${word}`);
  }
  return lines.join('\n');
}

/** `page --file`'s JSON as `board.setPage`'s page: an object of name, icon and blocks, or the blocks alone; `name` and `icon` win. */
function pageOfJson(json: string, name: string | undefined, icon: string | undefined): PageParams {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new UsageError(`the page is not JSON: ${(error as Error).message}`);
  }
  const fields: Record<string, unknown> = Array.isArray(parsed) ? { blocks: parsed } : typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const named = name ?? fields.name;
  const iconed = icon ?? fields.icon;
  if (typeof named !== 'string') throw new UsageError('give the page a name, with --name or "name" in the file');
  if (typeof iconed !== 'string') throw new UsageError('give the page an icon, with --icon or "icon" in the file');
  if (!Array.isArray(fields.blocks)) throw new UsageError('give the page "blocks", a list of blocks, or the list alone');
  return { name: named, icon: iconed, blocks: fields.blocks };
}

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

/**
 * `status set --category`, as `board.setStatus` takes it: `--on "who · ref"` names who it waits on, and their reference
 * after a " · " if it has one. Refuses what the daemon would, naming the options.
 */
function categoryOption(category: string, label: string | undefined, on: string | undefined): WorkCategoryParams {
  const split = on?.indexOf(' · ') ?? -1;
  const waitingOn = on === undefined ? undefined : split < 0 ? { who: on } : { who: on.slice(0, split), ref: on.slice(split + 3) };
  try {
    parseWorkCategorySet({ category, label, waitingOn });
  } catch (error) {
    throw new UsageError((error as Error).message.replace(/\bwaitingOn\b/g, '--on').replace(/\bthe (who|ref)\b/, 'the --on $1'));
  }
  return { category: category as WorkCategoryParams['category'], ...(label === undefined ? {} : { label }), ...(waitingOn === undefined ? {} : { waitingOn }) };
}

/** Exit code of a `wait` that gave up before the agents were there. */
const WAIT_TIMED_OUT = 3;

const OPTIONS = {
  json: { type: 'boolean' },
  progress: { type: 'string' },
  pose: { type: 'string' },
  face: { type: 'string' },
  category: { type: 'string' },
  on: { type: 'string' },
  prop: { type: 'string' },
  title: { type: 'string' },
  for: { type: 'string' },
  agent: { type: 'string' },
  zone: { type: 'string' },
  name: { type: 'string' },
  harness: { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  role: { type: 'string' },
  'no-template': { type: 'boolean' },
  repo: { type: 'string' },
  branch: { type: 'string' },
  base: { type: 'string' },
  edges: { type: 'string' },
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
  auto: { type: 'string' },
  boxes: { type: 'boolean' },
  sections: { type: 'boolean' },
  group: { type: 'boolean' },
  color: { type: 'string' },
  size: { type: 'string' },
  text: { type: 'string' },
  note: { type: 'string' },
  board: { type: 'boolean' },
  plan: { type: 'boolean' },
  kind: { type: 'string' },
  via: { type: 'string' },
  clear: { type: 'boolean' },
  submit: { type: 'boolean' },
  keep: { type: 'boolean' },
  result: { type: 'string' },
  'handoff-to': { type: 'string' },
  self: { type: 'boolean' },
  after: { type: 'string' },
  why: { type: 'string' },
  template: { type: 'string' },
  from: { type: 'string' },
  attribute: { type: 'string', multiple: true },
  method: { type: 'string', multiple: true },
  fill: { type: 'string' },
  relation: { type: 'string' },
  style: { type: 'string' },
  out: { type: 'string' },
  label: { type: 'string' },
  icon: { type: 'string' },
  'from-label': { type: 'string' },
  'to-label': { type: 'string' },
  mine: { type: 'boolean' },
  undo: { type: 'boolean' },
  send: { type: 'boolean' },
  key: { type: 'string' },
  'no-key': { type: 'boolean' },
  doc: { type: 'string' },
  search: { type: 'string' },
  pin: { type: 'boolean' },
  unpin: { type: 'boolean' },
  link: { type: 'string' },
  front: { type: 'boolean' },
  'for-user': { type: 'boolean' },
  most: { type: 'string' },
  prefab: { type: 'string' },
  add: { type: 'boolean' },
  replace: { type: 'boolean' },
} as const;

type Option = keyof typeof OPTIONS;

/** The options only `status set` takes, which other commands refuse by naming it. */
const STATUS_ONLY: ReadonlySet<Option> = new Set<Option>(['progress', 'done', 'agent', 'pose', 'face', 'prop', 'category', 'on']);

/** The options each command takes beyond `--json` (which every one but `status`'s set, `rpc` and `mcp` takes too). */
export const COMMAND_OPTIONS: Record<string, readonly Option[]> = {
  status: ['progress', 'done', 'agent', 'pose', 'face', 'prop', 'category', 'label', 'on'],
  record: ['title', 'for'],
  pin: ['note', 'label', 'for'],
  unpin: ['label', 'for'],
  page: ['file', 'name', 'icon', 'clear'],
  'needs-you': ['via', 'clear'],
  doc: ['title', 'board', 'plan'],
  new: ['zone', 'name', 'harness', 'model', 'effort', 'role', 'no-template', 'repo', 'branch', 'base', 'edges', 'issue', 'file', 'prefab'],
  roles: ['file', 'zone'],
  prefab: ['out', 'add', 'replace'],
  crew: [],
  send: ['file', 'submit', 'clear'],
  wait: ['until', 'any', 'timeout', 'crew'],
  watch: ['crew', 'only', 'since', 'count', 'timeout'],
  restart: ['fresh', 'file'],
  close: ['remove'],
  orchestrate: ['scope'],
  activity: ['of', 'limit'],
  handoff: ['to', 'message', 'handover', 'data'],
  edge: ['carries', 'path', 'trigger', 'condition'],
  move: ['to', 'at', 'near', 'side'],
  arrange: ['by', 'layout', 'auto'],
  zone: ['group', 'name', 'color', 'at', 'size', 'boxes', 'sections', 'style', 'out'],
  note: ['text', 'kind', 'color', 'size', 'to', 'at', 'near', 'side'],
  shape: ['text', 'attribute', 'method', 'fill', 'kind', 'to', 'at', 'near', 'side'],
  connect: ['relation', 'style', 'label', 'from-label', 'to-label'],
  connector: ['relation', 'style', 'label', 'from-label', 'to-label'],
  diagram: ['file', 'to', 'at', 'near', 'side'],
  schedule: ['to', 'fresh', 'self', 'after', 'why', 'template', 'from', 'zone', 'harness', 'model', 'role', 'keep', 'result', 'handoff-to', 'file'],
  steps: ['title', 'file', 'mine', 'undo', 'send'],
  memory: ['key', 'no-key', 'file', 'doc', 'search', 'pin', 'unpin'],
  remind: ['mine'],
  queue: ['kind', 'front', 'link', 'file', 'for-user', 'most'],
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
        STATUS_ONLY.has(option) ? `--${option} is only for \`status set\`` : `--${option} is not an option of ${command}`,
      );
    }
  }
  const string = (option: Option) => values[option] as string | undefined;
  const edgesOption = (value: string | undefined): 'auto' | 'manual' | undefined => {
    if (value !== undefined && value !== 'auto' && value !== 'manual') throw new UsageError('--edges is auto or manual');
    return value;
  };
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
  /** `connect`'s and `connector edit`'s options, checked. */
  const connectorOptions = () => {
    const options = { relation: string('relation'), style: string('style'), label: string('label'), fromLabel: string('from-label'), toLabel: string('to-label') };
    checked(() => checkConnector(options));
    return options;
  };
  const wholeNumber = (option: Option, max: number) => {
    const raw = string(option);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new UsageError(`--${option} must be a whole number from 0 to ${max}`);
    return value;
  };

  /** A duration option in whole seconds: `90`, `90s`, `30m` or `1h`. */
  const duration = (option: Option, max: number) => {
    const raw = string(option);
    if (raw === undefined) return undefined;
    const match = /^(\d+)([smh]?)$/.exec(raw.trim());
    const value = match === null ? NaN : Number(match[1]) * { '': 1, s: 1, m: 60, h: 3600 }[match[2] as '' | 's' | 'm' | 'h'];
    if (!Number.isSafeInteger(value) || value > max) throw new UsageError(`--${option} must be a duration such as 90, 90s or 30m, up to ${max} seconds`);
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
    case 'record': {
      const [kind, target, ...rest] = positionals;
      if (kind !== 'pr' && kind !== 'doc') throw new UsageError('record what: `record pr <url>` or `record doc <path>`');
      if (target === undefined || rest.length > 0) throw new UsageError(kind === 'pr' ? 'give one pull request URL' : 'give one file');
      if (kind === 'pr' && string('for') !== undefined) throw new UsageError('--for is only for `record doc`');
      if (kind === 'doc' && string('title') !== undefined) throw new UsageError('--title is only for `record pr`');
      const forWhom = string('for');
      if (forWhom !== undefined && forWhom !== 'orchestrator') throw new UsageError('--for takes only orchestrator');
      const title = string('title');
      const params: RecordParams =
        kind === 'pr' ? { kind, url: target, ...(title === undefined ? {} : { title }) } : { kind, path: target, forOrchestrator: forWhom === 'orchestrator' };
      return async (session) => print(await recordEntry(session, params, process.cwd()));
    }
    case 'pin':
    case 'unpin': {
      const [target, ...rest] = positionals;
      const note = string('note');
      const label = string('label');
      const forWhom = string('for');
      if (forWhom !== undefined && forWhom !== 'orchestrator') throw new UsageError('--for takes only orchestrator');
      const forOrchestrator = forWhom === 'orchestrator';
      const named = target === undefined ? {} : /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? { url: target } : { path: target };
      if (command === 'unpin') {
        if (rest.length > 0 || (target === undefined) === (label === undefined)) throw new UsageError('unpin a file, a link or --label <note label>');
        return async (session) => print(await unpinEntry(session, { ...named, ...(label === undefined ? {} : { label }), forOrchestrator }, process.cwd()));
      }
      if (rest.length > 0 || (target === undefined) === (note === undefined)) throw new UsageError('pin a file, a link or --note <text>');
      if (note !== undefined && label === undefined) throw new UsageError('a note needs --label, which names it on the sidebar');
      const params = { kind: 'pin' as const, ...named, ...(note === undefined ? {} : { note }), ...(label === undefined ? {} : { label }), forOrchestrator };
      return async (session) => print(await pinEntry(session, params, process.cwd()));
    }
    case 'status': {
      if (positionals[0] === 'poses') {
        if (positionals.length > 1 || Object.keys(values).some((option) => option !== 'json')) throw new UsageError('`status poses` takes nothing');
        return async () => (values.json ? JSON.stringify({ poses: [...AGENT_POSES, NO_POSE], faces: AGENT_FACES, props: AGENT_PROPS }, null, 2) : characterChoices());
      }
      if (positionals[0] !== 'set') throw new UsageError('the status commands are `status set` and `status poses`');
      const words = positionals.slice(1).join(' ');
      const summary = words.trim() === '' ? undefined : words;
      const pose = string('pose');
      if (pose === undefined && (string('face') !== undefined || string('prop') !== undefined)) throw new UsageError('--face and --prop go with a --pose');
      const kind = string('category');
      if (kind === undefined && (string('label') !== undefined || string('on') !== undefined)) throw new UsageError('--label and --on go with a --category');
      if (summary === undefined && pose === undefined && kind === undefined) throw new UsageError('give a summary, a --pose, a --category, or more');
      const progress = string('progress') === undefined ? undefined : Number(string('progress'));
      if (progress !== undefined && !isStatusProgress(progress)) {
        throw new UsageError('--progress must be a whole number from 0 to 100');
      }
      if (progress !== undefined && summary === undefined) throw new UsageError('--progress goes with a summary');
      let character: CharacterSet | undefined;
      try {
        character = pose === undefined ? undefined : parseCharacter({ pose, face: string('face'), prop: string('prop') });
      } catch (error) {
        throw new UsageError((error as Error).message);
      }
      const category = kind === undefined ? undefined : categoryOption(kind, string('label'), string('on'));
      const crewMember = string('agent');
      if (crewMember !== undefined && values.done === true) throw new UsageError('--done is for your own status: a crew member says it is finished itself');
      return async (session) => {
        if (crewMember !== undefined) {
          const view = await setCrewStatus(session, crewMember, summary, progress, character, category);
          return values.json ? JSON.stringify(view.json, null, 2) : view.text;
        }
        const agent = await setOwnStatus(session, summary, progress, values.done === true, character, category);
        if (values.json) return JSON.stringify(agent, null, 2);
        const lines = summary === undefined ? [] : [`status set: ${statusLine(agent.status!)}${agent.workFinishedAt === null ? '' : ' (finished)'}`];
        if (character !== undefined) lines.push(characterAnswer(agent));
        if (category !== undefined || values.done === true) lines.push(categoryAnswer(agent));
        return lines.join('\n');
      };
    }
    case 'page': {
      noPositionals();
      if (values.clear === true) {
        if (string('file') !== undefined || string('name') !== undefined || string('icon') !== undefined) throw new UsageError('--clear takes no --file, --name or --icon');
        return async (session) => print(await setOwnPage(session, null, process.cwd()));
      }
      if (string('file') === undefined) throw new UsageError('give the page with --file <path|->, or --clear');
      const page = pageOfJson(string('file') === '-' ? readFileSync(0, 'utf8') : text(0), string('name'), string('icon'));
      return async (session) => print(await setOwnPage(session, page, process.cwd()));
    }
    case 'needs-you': {
      const reason = positionals.join(' ');
      if (values.clear === true) {
        if (reason.trim() !== '' || string('via') !== undefined) throw new UsageError('--clear takes no reason and no --via');
      } else if (reason.trim() === '') throw new UsageError('give a reason, or --clear');
      return async (session) => {
        const agent = await flagOwn(session, values.clear === true ? undefined : reason, string('via'));
        return values.json ? JSON.stringify(agent, null, 2) : flagLine(agent, values.clear === true);
      };
    }
    case 'new': {
      const prompt = text(0);
      const repo = string('repo');
      const prefab = string('prefab');
      if (prefab !== undefined) {
        const set = (['name', 'harness', 'model', 'effort', 'role', 'no-template', 'branch', 'base', 'edges'] as const).find((option) => values[option] !== undefined);
        if (set !== undefined) throw new UsageError(`--${set} is the prefab's to set: --prefab takes --zone, --repo, --issue and --file`);
        return async (session) =>
          print(
            await startPrefab(session, {
              name: prefab,
              prompt,
              zone: string('zone'),
              repo: repo === undefined ? undefined : resolve(process.cwd(), repo),
              issue: string('issue'),
            }),
          );
      }
      return async (session) =>
        print(
          await newAgent(session, {
            prompt,
            zone: string('zone'),
            name: string('name'),
            harness: string('harness'),
            model: string('model'),
            effort: string('effort'),
            role: string('role'),
            noTemplate: values['no-template'] === true,
            repo: repo === undefined ? undefined : resolve(process.cwd(), repo),
            branch: string('branch'),
            base: string('base'),
            edges: edgesOption(string('edges')),
            issue: string('issue'),
          }),
        );
    }
    case 'send': {
      const ref = positionals[0];
      if (ref === undefined) throw new UsageError('give an agent ref and a message');
      if (values.submit === true || values.clear === true) {
        if (values.submit === true && values.clear === true) throw new UsageError('give --submit or --clear, not both');
        if (positionals.length > 1 || string('file') !== undefined) throw new UsageError('--submit and --clear take no message');
        const draft = values.submit === true ? { submit: true as const } : { clear: true as const };
        return async (session) => print(await sendToAgent(session, ref, draft));
      }
      const message = text(1);
      if (message.trim() === '') throw new UsageError('give a message');
      return async (session) => print(await sendToAgent(session, ref, { text: message }));
    }
    case 'wait': {
      const until = string('until')?.split(',').map((state) => state.trim()) as WaitState[] | undefined;
      const unknown = until?.find((state) => !isWaitState(state));
      if (unknown !== undefined) throw new UsageError(`${unknown} is not a state: ${WAIT_STATES.join(', ')}`);
      const seconds = duration('timeout', MAX_ORCHESTRATOR_WAIT_MS / 1000);
      if (positionals.some((ref) => ref.startsWith('crew:'))) {
        if (positionals.length !== 1 || until !== undefined || values.any === true || values.crew === true) {
          throw new UsageError('wait <crew> takes the one crew alone, with --timeout: it waits until the crew stops');
        }
        return async (session) => {
          const view = await waitForCrew(session, positionals[0]!, (seconds ?? DEFAULT_ORCHESTRATOR_WAIT_MS / 1000) * 1000);
          return { text: print(view), code: view.timedOut ? WAIT_TIMED_OUT : 0 };
        };
      }
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
    case 'effort': {
      if (positionals.length !== 2) throw new UsageError('give an agent ref and a level: agent-board effort <ref> <level>');
      const [ref, level] = positionals as [string, string];
      return async (session) => print(await setAgentEffort(session, ref, level));
    }
    case 'continue': {
      const ref = oneRef();
      return async (session) => print(await continueAgent(session, ref));
    }
    case 'restart': {
      const ref = positionals[0];
      if (ref === undefined) throw new UsageError('give one agent ref');
      const prompt = text(1);
      if (prompt.trim() !== '' && values.fresh !== true) throw new UsageError('a prompt needs --fresh: a restart that carries on its conversation takes none');
      return async (session) =>
        print(await restartAgent(session, ref, values.fresh === true ? { prompt: prompt.trim() === '' ? undefined : prompt } : undefined));
    }
    case 'pause': {
      const ref = oneRef();
      return async (session) => print(await pauseAgent(session, ref));
    }
    case 'wake': {
      const ref = oneRef();
      return async (session) => print(await wakeAgent(session, ref));
    }
    case 'close': {
      const ref = oneRef();
      return async (session) => print(await closeAgent(session, ref, values.remove === true));
    }
    case 'orchestrate': {
      if (positionals[0] === 'handover') {
        const [, from, to, ...extra] = positionals;
        if (from === undefined || to === undefined || extra.length > 0) throw new UsageError('give the orchestrator to hand over from, and the one to hand over to');
        return async (session) => print(await handOver(session, from, to));
      }
      const [onOff, ref, ...rest] = positionals;
      if ((onOff !== 'on' && onOff !== 'off') || ref === undefined || rest.length > 0) throw new UsageError('give on or off, and one agent ref');
      const scope = string('scope') ?? 'zone';
      if (!ORCHESTRATE_SCOPES.includes(scope as OrchestrateScope)) throw new UsageError(`--scope must be ${ORCHESTRATE_SCOPES.join(', ')}`);
      if (onOff === 'off' && string('scope') !== undefined) throw new UsageError('--scope is only for `orchestrate on`');
      return async (session) => print(await setOrchestrate(session, ref, onOff === 'on' ? (scope as OrchestrateScope) : null));
    }
    case 'doc': {
      if (positionals.length !== 1) throw new UsageError('give the path of one .md or .html file');
      if (values.plan === true) {
        return async (session) => {
          const source = readPlanSource({ path: positionals[0]! }, process.cwd());
          const title = string('title') ?? documentTitle(positionals[0]!, source.format, source.body);
          return print(await leavePlan(session, { title, ...source, onBoard: values.board === true }));
        };
      }
      return async (session) => print(await showDoc(session, { path: positionals[0]!, title: string('title'), onBoard: values.board === true }, process.cwd()));
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
      const options = { by: string('by'), layout: string('layout'), auto: string('auto') };
      checked(() => checkArrange(options));
      return async (session) => print(await arrangeZone(session, positionals[0], options));
    }
    case 'zone': {
      const [sub, ref, ...rest] = positionals;
      const given = (['group', 'name', 'color', 'at', 'size', 'boxes', 'sections', 'style', 'out'] as const).filter((option) => values[option] !== undefined);
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
      if (sub === 'map') {
        only(['boxes', 'sections']);
        if (rest.length > 0) throw new UsageError('give at most one zone ref');
        return async (session) => print(await zoneMap(session, ref, { boxes: values.boxes === true, sections: values.sections === true }));
      }
      if (sub === 'screenshot') {
        only(['style', 'out']);
        if (rest.length > 0) throw new UsageError('give at most one zone ref');
        const out = string('out');
        return async (session) => print(await writeZoneScreenshot(session, ref, { style: string('style'), out: out === undefined ? undefined : resolve(process.cwd(), out) }));
      }
      if (sub === 'layout') {
        only([]);
        // `zone layout <mode> [<zone ref>]`: the mode comes first.
        const [mode, zoneRef, ...more] = positionals.slice(1);
        if (mode === undefined || more.length > 0) throw new UsageError('give the layout (free, shelves or clusters), and at most one zone ref');
        return async (session) => print(await setZoneLayout(session, mode, zoneRef));
      }
      throw new UsageError('the zone commands are `zone add --group`, `zone rename`, `zone resize`, `zone remove`, `zone map`, `zone screenshot` and `zone layout`');
    }
    case 'note': {
      const [sub, ...rest] = positionals;
      const place = { to: string('to'), at: string('at'), near: string('near'), side: string('side') };
      const color = string('color');
      if (sub !== 'edit' && string('size') !== undefined) throw new UsageError('--size is only for `note edit`');
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
        const size = string('size');
        if (string('text') === undefined && color === undefined && size === undefined) throw new UsageError('give its new --text, --color or --size');
        if (size !== undefined) checked(() => noteSizeOf(size));
        return async (session) => print(await editNote(session, rest[0]!, { text: string('text'), color, size }));
      }
      if (sub === 'remove') {
        if (rest.length !== 1) throw new UsageError('give one note ref');
        if (string('text') !== undefined || color !== undefined) throw new UsageError('`note remove` takes no options');
        return async (session) => print(await removeNote(session, rest[0]!));
      }
      throw new UsageError('the note commands are `note add`, `note edit` and `note remove`');
    }
    case 'shape': {
      const [sub, ...rest] = positionals;
      const shapeOptions = {
        text: string('text'),
        attributes: values.attribute as string[] | undefined,
        methods: values.method as string[] | undefined,
        fill: string('fill'),
      };
      if (sub === 'add') {
        if (string('kind') !== undefined) throw new UsageError('give the kind as the first word: `shape add class Order`');
        const [kind, ...words] = rest;
        if (kind === undefined) throw new UsageError('give the kind of shape, then its text');
        if (words.length > 0 && shapeOptions.text !== undefined) throw new UsageError('give the text or --text, not both');
        const options = { ...shapeOptions, shape: kind, text: shapeOptions.text ?? words.join(' '), to: string('to'), at: string('at'), near: string('near'), side: string('side') };
        checked(() => {
          checkShape(options);
          checkPlace(options);
        });
        return async (session) => print(await addShape(session, options));
      }
      const placed = (['to', 'at', 'near', 'side'] as const).find((option) => values[option] !== undefined);
      if (placed !== undefined) throw new UsageError(`--${placed} is only for \`shape add\` (move a shape with \`agent-board move\`)`);
      if (sub === 'edit') {
        if (rest.length !== 1) throw new UsageError('give one shape ref');
        const options = { ...shapeOptions, shape: string('kind') };
        checked(() => checkShape(options));
        if (Object.values(options).every((value) => value === undefined)) throw new UsageError('give its new --kind, --text, --attribute, --method or --fill');
        return async (session) => print(await editShape(session, rest[0]!, options));
      }
      if (sub === 'remove') {
        if (rest.length !== 1) throw new UsageError('give one shape ref');
        if (Object.values(shapeOptions).some((value) => value !== undefined) || string('kind') !== undefined) throw new UsageError('`shape remove` takes no options');
        return async (session) => print(await removeShape(session, rest[0]!));
      }
      throw new UsageError('the shape commands are `shape add`, `shape edit` and `shape remove`');
    }
    case 'connect': {
      const options = connectorOptions();
      if (positionals.length !== 2) throw new UsageError('give the two items to join: <from ref> <to ref>');
      return async (session) => print(await connectItems(session, positionals[0]!, positionals[1]!, options));
    }
    case 'connector': {
      const [sub, ...rest] = positionals;
      const options = connectorOptions();
      if (rest.length !== 1) throw new UsageError('give one connector ref');
      if (sub === 'edit') {
        if (Object.values(options).every((value) => value === undefined)) throw new UsageError('give its new --relation, --style or a label');
        return async (session) => print(await editConnector(session, rest[0]!, options));
      }
      if (sub === 'remove') {
        if (Object.values(options).some((value) => value !== undefined)) throw new UsageError('`connector remove` takes no options');
        return async (session) => print(await removeConnector(session, rest[0]!));
      }
      throw new UsageError('the connector commands are `connector edit` and `connector remove`');
    }
    case 'diagram': {
      const [sub, ...rest] = positionals;
      if (sub === 'add') {
        const place = { to: string('to'), at: string('at'), near: string('near'), side: string('side') };
        checked(() => checkPlace(place));
        const mermaid = string('file') === '-' ? (positionals.length > 1 ? undefined : readFileSync(0, 'utf8').replace(/\r\n?/g, '\n')) : text(1);
        if (mermaid === undefined) throw new UsageError('give the text or --file, not both');
        if (mermaid.trim() === '') throw new UsageError('give the Mermaid text after --, or --file');
        return async (session) => print(await addDiagram(session, mermaid, place));
      }
      if (sub === 'export') {
        const stray = (['file', 'to', 'at', 'near', 'side'] as const).find((option) => values[option] !== undefined);
        if (stray !== undefined) throw new UsageError(`--${stray} is only for \`diagram add\``);
        return async (session) => print(await exportDiagram(session, rest));
      }
      throw new UsageError('the diagram commands are `diagram add` and `diagram export`');
    }
    case 'schedule': {
      const [sub, ...rest] = positionals;
      if (values.from !== undefined && !(sub === 'template' && rest[0] === 'save')) throw new UsageError('--from is only for `schedule template save`');
      if (sub === 'template') {
        const [action, name, ...words] = rest;
        const stray = (['to', 'fresh', 'self', 'why', 'template', 'zone', 'handoff-to'] as const).find((option) => values[option] !== undefined);
        if (stray !== undefined) throw new UsageError(`--${stray} is not for \`schedule template\``);
        if (action === 'save') {
          if (name === undefined) throw new UsageError('give the template a name');
          const [cron = '', ...prompt] = words;
          positionals = prompt;
          const options = {
            name,
            from: string('from'),
            cron,
            prompt: text(0),
            after: string('after'),
            harness: string('harness'),
            model: string('model'),
            role: string('role'),
            keep: values.keep === true ? true : undefined,
            result: string('result'),
          };
          checked(() => checkTemplate(options));
          return async (session) => print(await saveTemplate(session, options));
        }
        const option = (['after', 'harness', 'model', 'role', 'keep', 'result', 'file'] as const).find((each) => values[each] !== undefined);
        if (option !== undefined) throw new UsageError(`--${option} is only for \`schedule template save\``);
        if (action === 'list') {
          if (name !== undefined) throw new UsageError(`unexpected ${rest.slice(1).join(' ')}`);
          return async (session) => print(await listTemplates(session));
        }
        if (action === 'remove') {
          if (name === undefined || words.length > 0) throw new UsageError('give one template name');
          return async (session) => print(await removeTemplate(session, name));
        }
        throw new UsageError('the template commands are `schedule template save`, `schedule template list` and `schedule template remove`');
      }
      if (sub === 'add') {
        const [cron, ...words] = rest;
        const template = string('template');
        if (cron === undefined && template === undefined) throw new UsageError("give the schedule's cron expression, quoted: '0 9 * * 1-5'");
        positionals = words;
        const options = {
          cron: cron ?? '',
          template,
          prompt: text(0),
          to: string('to'),
          self: values.self === true ? true : undefined,
          after: string('after'),
          fresh: values.fresh === true ? true : undefined,
          zone: string('zone'),
          harness: string('harness'),
          model: string('model'),
          role: string('role'),
          keep: values.keep === true ? true : undefined,
          result: string('result'),
          handoffTo: string('handoff-to'),
        };
        checked(() => checkSchedule(options));
        return async (session) => print(await addSchedule(session, options));
      }
      if (values.why !== undefined && sub !== 'set' && sub !== 'stop') throw new UsageError('--why is only for `schedule set` and `schedule stop`');
      if (sub === 'set' || sub === 'stop') {
        const stray = (['to', 'fresh', 'template', 'zone', 'harness', 'model', 'role', 'keep', 'result', 'handoff-to', 'file'] as const).find((option) => values[option] !== undefined);
        if (stray !== undefined) throw new UsageError(`--${stray} is only for \`schedule add\``);
        if (rest.length > 1 || (rest.length === 1 && values.self === true)) throw new UsageError('give one schedule ref, or --self (the default) for your own');
        const options = { ref: rest[0], after: string('after'), stop: sub === 'stop' ? true : undefined, why: string('why') ?? '' };
        checked(() => checkOwnSchedule(options));
        return async (session) => print(await setOwnSchedule(session, options));
      }
      const added = (['to', 'fresh', 'self', 'after', 'template', 'zone', 'harness', 'model', 'role', 'keep', 'result', 'handoff-to', 'file'] as const).find((option) => values[option] !== undefined);
      if (added !== undefined) throw new UsageError(`--${added} is only for \`schedule add\``);
      if (sub === 'list') {
        if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
        return async (session) => print(await listSchedules(session));
      }
      if (sub === 'remove') {
        if (rest.length !== 1) throw new UsageError('give one schedule ref');
        return async (session) => print(await removeSchedule(session, rest[0]!));
      }
      throw new UsageError('the schedule commands are `schedule add`, `schedule list`, `schedule remove`, `schedule set`, `schedule stop` and `schedule template`');
    }
    case 'steps': {
      const [sub, ...rest] = positionals;
      const only = (option: Option, subs: string) => {
        if (values[option] !== undefined) throw new UsageError(`--${option} is only for ${subs}`);
      };
      /** The lines from `from` on, one a positional (or several to one, by line breaks), or the text of --file (- for stdin). */
      const lines = (from: number): string => {
        if (string('file') === '-') {
          if (rest.length > from) throw new UsageError('give the lines or --file, not both');
          return readFileSync(0, 'utf8').replace(/\r\n?/g, '\n');
        }
        return string('file') === undefined ? rest.slice(from).join('\n') : text(from + 1);
      };
      const place = (word: string | undefined) => {
        if (word === undefined || !/^\d+$/.test(word)) throw new UsageError(`give the step's number, from 1${word === undefined ? '' : `, not ${word}`}`);
        return Number(word);
      };
      if (sub !== 'new') only('title', '`steps new`');
      if (sub !== 'new' && sub !== 'add') only('file', '`steps new` and `steps add`');
      if (sub !== 'ls') only('mine', '`steps ls`');
      if (sub !== 'done' && sub !== 'tick') only('undo', '`steps done`');
      if (sub !== 'answer') only('send', '`steps answer`');
      const [card, ...after] = rest;
      const needCard = () => {
        if (card === undefined) throw new UsageError('give the steps card’s ref: `agent-board steps ls` lists them');
        return card;
      };
      switch (sub) {
        case 'new': {
          const body = lines(0);
          if (body.trim() === '') throw new UsageError('give the steps, one a line, after --, or --file');
          return async (session) => print(await newSteps(session, { title: string('title'), text: body }));
        }
        case 'ls':
          if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
          return async (session) => print(await listSteps(session, { mine: values.mine === true }));
        case 'read':
          if (rest.length !== 1) throw new UsageError('give one steps card’s ref');
          return async (session) => print(await readStepsCard(session, rest[0]!));
        case 'done':
        case 'tick': {
          const steps = after.map(place);
          if (steps.length === 0) throw new UsageError('give the number of each step to tick');
          return async (session) => print(await updateSteps(session, needCard(), { action: 'done', steps, undo: values.undo === true }));
        }
        case 'wait': {
          if (after.length !== 1) throw new UsageError('give the card and one step number');
          const step = place(after[0]);
          return async (session) => print(await updateSteps(session, needCard(), { action: 'wait', step }));
        }
        case 'add': {
          const body = lines(1);
          if (body.trim() === '') throw new UsageError('give the steps to add, one a line, after --, or --file');
          return async (session) => print(await updateSteps(session, needCard(), { action: 'add', text: body }));
        }
        case 'answer': {
          const [step, ...answer] = after;
          const update = step === undefined ? { action: 'answer' as const } : { action: 'answer' as const, step: place(step), answer: answer.join(' ') };
          return async (session) => print(await updateSteps(session, needCard(), { ...update, send: values.send === true }));
        }
        case 'close':
          if (rest.length !== 1) throw new UsageError('give one steps card’s ref');
          return async (session) => print(await updateSteps(session, rest[0]!, { action: 'close' }));
        default:
          throw new UsageError('the steps commands are `steps new`, `ls`, `read`, `done`, `wait`, `add`, `answer` and `close`');
      }
    }
    case 'memory': {
      const [sub, ref, ...after] = positionals;
      const allowed: Record<string, readonly Option[]> = { read: ['search'], add: ['key', 'no-key', 'file', 'doc'], edit: ['key', 'no-key', 'pin', 'unpin'] };
      for (const option of ['key', 'no-key', 'file', 'doc', 'search', 'pin', 'unpin'] as const) {
        if (values[option] !== undefined && !(allowed[sub ?? ''] ?? []).includes(option)) throw new UsageError(`--${option} is not for \`memory ${sub ?? ''}\``);
      }
      if (values.key !== undefined && values['no-key'] === true) throw new UsageError('give --key or --no-key, not both');
      if (values.pin === true && values.unpin === true) throw new UsageError('give --pin or --unpin, not both');
      const needRef = () => {
        if (ref === undefined) throw new UsageError('give the memory: its ref or title (`agent-board memory ls` lists them)');
        return ref;
      };
      const needEntry = () => {
        if (after[0] === undefined) throw new UsageError('give the entry: its key, or its #id');
        return after[0];
      };
      const versionAt = (word: string | undefined) => {
        const version = /^v?(\d+)$/.exec(word ?? '')?.[1];
        if (version === undefined) throw new UsageError('give the version to put back, as `memory history` lists it');
        return Number(version);
      };
      const cwd = process.cwd();
      switch (sub) {
        case 'ls':
          if (positionals.length > 1) throw new UsageError(`unexpected ${positionals.slice(1).join(' ')}`);
          return async (session) => print(await listMemories(session));
        case 'read': {
          if (after.length > 1) throw new UsageError('give the memory, and at most one entry');
          const memory = needRef();
          return async (session) => print(await readMemory(session, memory, { ...(after[0] === undefined ? {} : { entry: after[0] }), ...(string('search') === undefined ? {} : { search: string('search') }) }));
        }
        case 'add': {
          const memory = needRef();
          const path = string('file');
          const document = string('doc');
          const body = after.join(' ');
          if (path === undefined && body.trim() === '') throw new UsageError(document === undefined ? 'give the text to remember, after the memory, or --file' : 'give the document its text, after the memory');
          const update = {
            action: 'add' as const,
            ...(path === undefined ? { text: body } : { path, ...(body.trim() === '' ? {} : { text: body }) }),
            ...(document === undefined ? {} : { document }),
            ...(string('key') === undefined ? {} : { key: string('key') }),
            note: values['no-key'] === true,
          };
          return async (session) => print(await updateMemory(session, memory, update, cwd));
        }
        case 'edit': {
          const memory = needRef();
          const entry = needEntry();
          const body = after.slice(1).join(' ');
          const pinned = values.pin === true ? true : values.unpin === true ? false : undefined;
          const update = { action: 'edit' as const, entry, ...(body === '' ? {} : { text: body }), ...(string('key') === undefined ? {} : { key: string('key') }), note: values['no-key'] === true, ...(pinned === undefined ? {} : { pinned }) };
          return async (session) => print(await updateMemory(session, memory, update, cwd));
        }
        case 'rm':
        case 'remove': {
          if (after.length !== 1) throw new UsageError('give the memory and one entry');
          const memory = needRef();
          return async (session) => print(await updateMemory(session, memory, { action: 'remove', entry: needEntry() }, cwd));
        }
        case 'history': {
          if (after.length !== 1) throw new UsageError('give the memory and one entry');
          const memory = needRef();
          return async (session) => print(await memoryHistory(session, memory, needEntry()));
        }
        case 'restore': {
          if (after.length !== 2) throw new UsageError('give the memory, the entry and the version to put back');
          const memory = needRef();
          const version = versionAt(after[1]);
          return async (session) => print(await updateMemory(session, memory, { action: 'restore', entry: needEntry(), version }, cwd));
        }
        case 'confirm': {
          if (after.length !== 1) throw new UsageError('give the memory and one entry');
          const memory = needRef();
          return async (session) => print(await updateMemory(session, memory, { action: 'confirm', entry: needEntry() }, cwd));
        }
        case 'new': {
          const title = positionals.slice(1).join(' ');
          if (title.trim() === '') throw new UsageError('give the memory a title');
          return async (session) => print(await newMemory(session, title));
        }
        default:
          throw new UsageError('the memory commands are `memory ls`, `read`, `add`, `edit`, `rm`, `history`, `restore`, `confirm` and `new`');
      }
    }
    case 'remind': {
      const [sub, ...rest] = positionals;
      if (values.mine !== undefined && sub !== 'ls' && sub !== 'list') throw new UsageError('--mine is only for `remind ls`');
      const place = () => {
        if (rest.length !== 1 || !/^\d+$/.test(rest[0]!)) throw new UsageError(`give one line's number, as \`agent-board remind ls --mine\` numbers them`);
        return Number(rest[0]);
      };
      switch (sub) {
        case 'ls':
        case 'list':
          if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
          return async (session) => print(await readTodos(session, values.mine === true));
        case 'done':
        case 'undo':
        case 'rm': {
          const n = place();
          return async (session) => print(await changeTodo(session, sub, n));
        }
        default: {
          const texts = sub === 'add' ? rest : positionals;
          if (texts.join('').trim() === '') throw new UsageError('give the to-do: `agent-board remind "<what the user must do>"`');
          return async (session) => print(await remind(session, texts));
        }
      }
    }
    case 'queue': {
      const [sub, ref, ...after] = positionals;
      const allowed: Record<string, readonly Option[]> = { add: ['kind', 'front', 'link', 'file'], edit: ['link'], new: ['for-user'], drain: ['most'] };
      for (const option of ['kind', 'front', 'link', 'file', 'for-user', 'most'] as const) {
        if (values[option] !== undefined && !(allowed[sub ?? ''] ?? []).includes(option)) throw new UsageError(`--${option} is not for \`queue ${sub ?? ''}\``);
      }
      const needRef = () => {
        if (ref === undefined) throw new UsageError('give the queue: its ref or title (`agent-board queue ls` lists them)');
        return ref;
      };
      const oneJob = (verb: string) => {
        if (after.length !== 1) throw new UsageError(`give the queue and the job to ${verb}: its #id`);
        return after[0]!;
      };
      const run = (update: QueueUpdate) => {
        const queue = needRef();
        return async (session: BoardSession) => print(await updateQueue(session, queue, update));
      };
      switch (sub) {
        case 'ls':
          if (positionals.length > 1) throw new UsageError(`unexpected ${positionals.slice(1).join(' ')}`);
          return async (session) => print(await listQueues(session));
        case 'read': {
          if (after.length > 0) throw new UsageError('give one queue');
          const queue = needRef();
          return async (session) => print(await readQueue(session, queue));
        }
        case 'add': {
          const kind = string('kind') ?? 'job';
          if (kind !== 'job' && kind !== 'note') throw new UsageError('--kind is job or note');
          let body: string;
          if (string('file') === '-') {
            if (after.length > 0) throw new UsageError('give the lines or --file, not both');
            body = readFileSync(0, 'utf8').replace(/\r\n?/g, '\n');
          } else body = string('file') === undefined ? after.join('\n') : text(2);
          if (body.trim() === '') throw new UsageError('give the jobs to queue, one a line, after the queue, or --file');
          return run({ action: 'add', text: body, kind, front: values.front === true, ...(string('link') === undefined ? {} : { link: string('link') }) });
        }
        case 'take':
          if (after.length > 1) throw new UsageError('give the queue, and at most one job');
          return run({ action: 'take', ...(after[0] === undefined ? {} : { job: after[0] }) });
        case 'drop':
          return run({ action: 'drop', job: oneJob('drop') });
        case 'done':
          return run({ action: 'done', job: oneJob('finish') });
        case 'rm':
        case 'remove':
          return run({ action: 'remove', job: oneJob('remove') });
        case 'edit': {
          const [job, ...words] = after;
          if (job === undefined) throw new UsageError('give the queue and the job to change: its #id');
          const body = words.join(' ');
          if (body === '' && string('link') === undefined) throw new UsageError('give the new text, or --link');
          return run({ action: 'edit', job, ...(body === '' ? {} : { text: body }), ...(string('link') === undefined ? {} : { link: string('link') }) });
        }
        case 'history': {
          const queue = needRef();
          const job = oneJob('read the history of');
          return async (session) => print(await queueHistory(session, queue, job));
        }
        case 'drain': {
          if (after.length !== 1 || (after[0] !== 'on' && after[0] !== 'off')) throw new UsageError('give the queue, then on or off');
          const most = string('most');
          if (most !== undefined && !/^[1-3]$/.test(most)) throw new UsageError('--most is 1, 2 or 3');
          return run({ action: 'drain', on: after[0] === 'on', ...(most === undefined ? {} : { most: Number(most) }) });
        }
        case 'move': {
          if (after.length !== 2) throw new UsageError('give the queue, the job, and where: the #id of the job to put it before, top or last');
          return run({ action: 'move', job: after[0]!, to: after[1]! });
        }
        case 'restore': {
          if (after.length !== 2) throw new UsageError('give the queue, the job and the version to put back');
          const version = /^v?(\d+)$/.exec(after[1]!)?.[1];
          if (version === undefined) throw new UsageError('give the version to put back, as `queue history` lists it');
          return run({ action: 'restore', job: after[0]!, version: Number(version) });
        }
        case 'new': {
          const title = positionals.slice(1).join(' ');
          if (title.trim() === '') throw new UsageError('give the queue a title');
          return async (session) => print(await newQueue(session, title, values['for-user'] === true));
        }
        default:
          throw new UsageError('the queue commands are `queue ls`, `read`, `add`, `take`, `drop`, `done`, `edit`, `move`, `rm`, `history`, `restore`, `drain` and `new`');
      }
    }
    case 'usage': {
      if (positionals.length > 0) throw new UsageError(`unexpected ${positionals.join(' ')}`);
      return async (session) => print(await usageView(session));
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
    case 'prefab': {
      const [sub = 'ls', ...rest] = positionals;
      if (sub !== 'export' && string('out') !== undefined) throw new UsageError('--out is only for `prefab export`');
      if (sub !== 'import' && (values.add !== undefined || values.replace !== undefined)) throw new UsageError('--add and --replace are only for `prefab import`');
      const one = (what: string) => {
        if (rest.length === 0) throw new UsageError(`give ${what}`);
        return rest.join(' ');
      };
      if (sub === 'ls' || sub === 'list') {
        if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
        return async (session) => print(await prefabsView(session));
      }
      if (sub === 'show') {
        const name = one('a prefab name');
        return async (session) => print(await prefabView(session, name));
      }
      if (sub === 'export') {
        const name = one('a prefab name');
        const out = string('out');
        return async (session) => print(await exportPrefab(session, name, out === undefined ? undefined : resolve(process.cwd(), out)));
      }
      if (sub === 'import') {
        if (rest.length !== 1) throw new UsageError('give one .crew.json file');
        if (values.replace === true && values.add !== true) throw new UsageError('--replace goes with --add');
        const path = resolve(process.cwd(), rest[0]!);
        return async (session) => print(await importPrefab(session, path, { add: values.add === true, replace: values.replace === true }));
      }
      if (sub === 'remove') {
        const name = one('a prefab name');
        return async (session) => print(await removePrefab(session, name));
      }
      throw new UsageError('the prefab commands are `prefab ls`, `prefab show`, `prefab export`, `prefab import` and `prefab remove`');
    }
    case 'crew': {
      const [sub = 'ls', ...rest] = positionals;
      if (sub === 'ls' || sub === 'list') {
        if (rest.length > 0) throw new UsageError(`unexpected ${rest.join(' ')}`);
        return async (session) => print(await crewsView(session));
      }
      if (rest.length !== 1) throw new UsageError('give one crew (crew:<id>): agent-board crew lists them');
      const crew = rest[0]!;
      if (sub === 'show') return async (session) => print(await crewsView(session, crew));
      if (sub === 'stop') return async (session) => print(await stopCrew(session, crew));
      if (sub === 'round') return async (session) => print(await crewRound(session, crew));
      throw new UsageError('the crew commands are `crew ls`, `crew show`, `crew stop` and `crew round`');
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
