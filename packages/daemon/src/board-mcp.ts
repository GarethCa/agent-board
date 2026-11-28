// The board as an MCP server (ADR-0010): a few tools over the same board-ops the CLI uses, and instructions that say
// once where the agent is and to read `agent-board help <command>` for the rest. One set of handlers, two transports: stdio
// here (`agent-board mcp`), and Streamable HTTP in the daemon (`board-mcp-http.ts`).
import { isAbsolute } from 'node:path';
import { addSchedule, listSchedules, listTemplates, removeSchedule, removeTemplate, saveTemplate, setOwnSchedule } from './clock-ops.ts';
import { listSteps, newSteps, readStepsCard, stepsUpdate, stepWords, updateSteps, type StepsUpdate } from './steps-ops.ts';
import { listQueues, newQueue, queueHistory, queueUpdate, readQueue, updateQueue, type QueueUpdate } from './queue-ops.ts';
import { changeTodo, readTodos, remind } from './todo-ops.ts';
import {
  addEdge,
  BoardError,
  askUser,
  BoardRefs,
  askToRemove,
  closeAgent,
  handOver,
  pauseAgent,
  wakeAgent,
  defaultRolesView,
  prefabsView,
  draftPrefab,
  prefabView,
  startPrefab,
  usageView,
  presentPlan,
  readPlanSource,
  showDoc,
  EDGE_CARRIES,
  edgesView,
  handOff,
  removeDefaultRole,
  removeEdge,
  connectionsView,
  identifyView,
  interruptAgent,
  setAgentEffort,
  renameAgent,
  pinAgentExpanded,
  ticketWatches,
  giveAgentRole,
  continueAgent,
  restartAgent,
  newAgent,
  openBoardSession,
  readAgent,
  readBoard,
  readCards,
  sendToAgent,
  setDefaultRole,
  checkPrefabStart,
  PREFAB_SETS,
  setStatus,
  flagLine,
  flagOwn,
  alertLine,
  alertUser,
  restOwn,
  openOwnPullRequest,
  recordEntry,
  pinEntry,
  setOwnPage,
  unpinEntry,
  treeView,
  waitForAgents,
  waitForCrew,
  watchCrew,
  type BoardSession,
} from './board-ops.ts';
import { AGENT_FACES, AGENT_POSES, AGENT_PROPS, NO_POSE, parseCharacter, type CharacterSet } from './character.ts';
import { DaemonRpcError } from './client.ts';
import { documentTitle } from './document-names.ts';
import {
  addDiagram,
  addNote,
  addShape,
  arrangeZone,
  placeOption,
  setZoneLayout,
  connectItems,
  editConnector,
  editNote,
  editShape,
  exportDiagram,
  moveTile,
  removeConnector,
  removeNote,
  deleteItem,
  passNote,
  removeShape,
  zoneMap,
  zoneScreenshot,
  type ConnectorOptions,
  type PlaceOptions,
  type ShapeOptions,
} from './layout-ops.ts';
import {
  MAX_FIGURE_VALUE,
  MAX_JOB_HEADLINE,
  QUEUE_ADD_KINDS,
  MAX_PAGE_BLOCKS,
  MAX_PAGE_FIGURES,
  MAX_PAGE_ITEM,
  MAX_PAGE_ITEMS,
  MAX_PAGE_NAME,
  MAX_PAGE_TEXT,
  MAX_PAGE_TITLE,
  PAGE_BLOCK_KINDS,
  PAGE_CHECK_STATES,
  PAGE_ICONS,
  PAGE_TONES,
  AGENT_ROLES,
  ARRANGE_BYS,
  ARRANGE_ITEM_KINDS,
  ARRANGE_PLACEMENTS,
  CAPTURE_STYLES,
  CREW_EVENT_KINDS,
  ARRANGE_LAYOUTS,
  ZONE_LAYOUT_CHOICES,
  NOTE_KINDS,
  CONNECTOR_STYLES,
  RELATIONS,
  SHAPE_TYPES,
  TILE_SIDES,
  DAEMON_VERSION,
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_PLAN_WAIT_MS,
  MAX_ASK_OPTIONS,
  MAX_ASK_QUESTIONS,
  MAX_PIN_LABEL,
  MAX_PIN_NOTE,
  MAX_AGENT_NOTE_LINES,
  MAX_ASK_WAIT_MS,
  MAX_REMOVE_ASK_TILES,
  MAX_OPTION_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_STEPS,
  MAX_STEPS_QUESTIONS,
  MAX_ROLE_NAME_LENGTH,
  MAX_QUESTION_LENGTH,
  FLOW_CONDITION_KINDS,
  FLOW_EDGE_TRIGGERS,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  MAX_ORCHESTRATOR_WAIT_MS,
  CLOCK_MODES,
  CLOCK_RESULTS,
  EFFORTS,
  TICKET_WATCH_EVERY_MINUTES,
  TICKET_WATCH_KINDS,
  TICKET_WATCH_MODES,
  type TicketWatchChange,
  type TicketWatchEvery,
  HARNESSES,
  isCrewSince,
  isWaitState,
  lineSplitter,
  MAX_FLAG_LENGTH,
  MAX_ALERT_LENGTH,
  ALERT_INTERVAL_MS,
  MAX_REST_LENGTH,
  MAX_PURPOSE_LENGTH,
  MAX_STATUS_LENGTH,
  RPC_ERROR,
  type BoardCaller,
  type CrewEventKind,
  type WaitState,
  type WorkCategoryParams,
  WAIT_STATES,
  MAX_WAITING_ON_LENGTH,
  MAX_WORK_LABEL_LENGTH,
  WORK_CATEGORIES,
  type LaunchSettings,
} from './protocol.ts';
import { NO_CATEGORY, parseWorkCategorySet } from './work-category.ts';
import { handleRpcLine, RpcMethodError, type RpcHandlers } from './rpc.ts';

/** The MCP revisions it speaks, newest first; it answers a client asking for another with the newest. */
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What the server tells the model once, as it connects: the "tell it once" rule. */
export const BOARD_MCP_INSTRUCTIONS =
  'You are running on agent-board, a desktop app that shows coding agents and shells as tiles in zones on one board, ' +
  'joined by edges that hand work from one agent to the next. These tools are the few you need most; for anything else, ' +
  '`agent-board help <command>` in your shell prints that one command (the whole `agent-board --help` is long: read it only if you must). ' +
  'Most tools are a CLI command too: `agent-board help <tool name>` has the detail their descriptions leave out. A turn ending tells no one: when you are blocked, ' +
  'your work is ready for review, or you need a decision, call `needs_you` with the reason in a line. When a task the user asked for is done, or something comes up they would ' +
  'want to know now, you may `alert` them with a line (never for routine progress). ' +
  'Something only the user can do, later (send a pull request for approval, restart the app), goes on their to-do list with `remind`. ' +
  "When you're waiting on someone else for longer than a few minutes, and have nothing to do, call `rest` with what you're waiting for: the board pauses you as your turn ends, and a message wakes you. " +
  'For a long watch, `clock_add` adds a clock of your own that messages you on a schedule; `clock_set` changes what your ' +
  'clock does with you after each run, or turns it off, with your reason; `save_clock_template` saves a clock to start new ones from.';

/** What the server adds to its instructions for an agent's own live session, which may act on other agents. */
export const ORCHESTRATOR_INSTRUCTIONS =
  'You may start, message, watch and close other agents, join them with edges, and keep the board tidy (move tiles, ' +
  'arrange a crew, notes), with the tools below or the same commands in `agent-board help orchestrate`. You reach ' +
  "every agent anywhere on the board, the ones the user started by hand too; to remove a tile you didn't start, `ask_to_remove` it, and the user decides. " +
  'A reviewer started from an agent\'s branch gets no edge to that agent: it and its implementer talk through `send` (findings back, next round), and the user presses no Send ' +
  'button. Ask for a line between them only with `new` `edges` (`auto` hands the findings back by itself, the way ' +
  'back manual; `manual` leaves both for the user), never an edge to your own tile, and keep one of a pair manual, ' +
  'as two auto edges in a loop re-trigger each other. Keep your crew\'s tile lines current ' +
  'with `set_status` and `agent`: what each agent is doing now, as its work moves on. A crew member\'s `needs_you` comes ' +
  'to you, typed at your prompt, and so do its `ask` questions and plans (`show_doc` with `plan`, written in its ' +
  'worktree, for `read`). It wakes you at once if you are at your prompt, between check-ins too, or comes as your turn ' +
  'ends; flags raised together come as one message. Answer it with `send`, which clears its flag, or pass it on to the user with `needs_you` ' +
  'and `via`. Only its permission prompts reach the user directly. When your crew has room, `queue_update` take the next ' +
  "item from your zone's queue, and mark it done when it is.";

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
    description: 'Who and where you are on the board: your tile, its zone, your state and status.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'board',
    description:
      "Your zone with its tiles (agents and shells, with state and status), items (a shape's text and sections) and " +
      'connectors (their ends, relation and labels), its hibernated, finished and ended agents folded into one count line. ' +
      '`zone: "all"` shows every zone and what is loose on the board, nothing folded.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: 'A zone, by ref, or `all` for the whole board. Yours by default; the whole board if you are in no zone.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'usage',
    description:
      "The plan's 5-hour and weekly usage (used, left, when each resets, when it was read, and whether it is stale), " +
      "read from Claude agents' status lines, so no tokens are spent.",
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
      'Call it once the work is ready; your turn\'s end then hands off along your other edges alone.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'One agent, by ref or name: along your edge to it, or, with none, a one-off edge; every edge out of you without.',
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
      `Ask one question, or up to ${MAX_ASK_QUESTIONS} with questions, which the user steps through and sends together. ` +
      'More than that, or to-dos, is a steps card: use steps_new. One ask at a time. If an orchestrator started you, ' +
      'the question goes to it instead and nothing waits: end your turn, and its answer comes as your next message.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: MAX_QUESTION_LENGTH, description: 'The question, in a sentence or two. Or give questions.' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ASK_QUESTIONS,
          description: 'Several questions instead of question, stepped through one at a time and sent together.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', maxLength: MAX_QUESTION_LENGTH },
              options: { type: 'array', items: { type: 'string', maxLength: MAX_OPTION_LENGTH }, maxItems: MAX_ASK_OPTIONS },
              free_text: { type: 'boolean' },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
        options: {
          type: 'array',
          items: { type: 'string', maxLength: MAX_OPTION_LENGTH },
          maxItems: MAX_ASK_OPTIONS,
          description: 'Short answers to pick from, one click each. Without, the user replies in their own words.',
        },
        free_text: { type: 'boolean', description: 'Let the user reply in their own words besides the options.' },
        on_board: {
          type: 'boolean',
          description: 'Put it on the board at once, as a steps card beside your tile: you still wait, and its Send answers you.',
        },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'How long to wait.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'show_doc',
    description:
      'Show the user a Markdown (.md) or HTML (.html) file of yours as a document, nicer to read than your terminal: a ' +
      'Document tab in your window, and with on_board a card beside your tile. Returns at once. It stays live: write the ' +
      'file again and they see the new version; their edits to a Markdown document are written to the file, and you are ' +
      'told what changed. With plan, it is your plan, which they approve, send back with changes or reject, and it waits ' +
      `for their decision (${DEFAULT_PLAN_WAIT_MS / 60_000} minutes by default); after changes are asked for, write the ` +
      'revised plan and show it again. If an orchestrator started you, the plan goes to it instead and nothing waits: end ' +
      'your turn, and its answer comes as your next message.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, relative to your working directory.' },
        title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What it is, in a line; else its first heading.' },
        on_board: { type: 'boolean', description: 'Also put it on the board, as a card beside your tile (a plan card, with plan), if the user puts docs on the board: off by default.' },
        plan: { type: 'boolean', description: 'It is your plan, to approve, send back with changes, or reject: waits for their decision.' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'With plan, how long to wait.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_status',
    description:
      'Set the one line your tile shows: the change you are making now, not the task you were given. Call it once you ' +
      'understand the work, and again when its direction changes. With done, your work is finished, not only this turn. ' +
      'With agent, you set the line of an agent in your crew instead; keep your crew\'s lines current. character is a ' +
      'pose for your tile\'s character; category is what kind of wait your work is in, for the overview the user reads; ' +
      'description is what you are for (\'\' clears it). When a pose goes, and how a category is set and cleared: ' +
      '`agent-board help status`.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          maxLength: MAX_STATUS_LENGTH,
          description: `What you are doing now, for your tile. Up to ${MAX_STATUS_LENGTH} characters, all shown: a longer line shrinks its text to fit, and a line over ${MAX_STATUS_LENGTH} is refused. Lead with what matters at a glance (the change you are making, then where it stands).`,
        },
        description: { type: 'string', maxLength: MAX_PURPOSE_LENGTH, description: 'What you are for, kept until you change it ("Builds the morning overview window").' },
        character: {
          type: 'object',
          description: 'Your character\'s pose, with a face and a prop of its own if you like.',
          properties: {
            pose: { type: 'string', enum: [...AGENT_POSES, NO_POSE] },
            face: { type: 'string', enum: [...AGENT_FACES] },
            prop: { type: 'string', enum: [...AGENT_PROPS] },
          },
          required: ['pose'],
          additionalProperties: false,
        },
        category: {
          type: 'string',
          enum: [...WORK_CATEGORIES, NO_CATEGORY],
          description: 'What kind of wait your work is in: on the user (needs-help, ready-for-review), blocked, on others (waiting-on-others, in-review), or on its own (working, done).',
        },
        label: { type: 'string', maxLength: MAX_WORK_LABEL_LENGTH, description: 'Your own word for the category ("With Legal"), with category.' },
        waiting_on: {
          type: 'object',
          description: 'Who your work waits on, and their reference if it has one (a ticket, a PR): only with waiting-on-others or in-review.',
          properties: {
            who: { type: 'string', maxLength: MAX_WAITING_ON_LENGTH },
            ref: { type: 'string', maxLength: MAX_WAITING_ON_LENGTH },
          },
          required: ['who'],
          additionalProperties: false,
        },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: 'How far through you are, if you know.' },
        done: { type: 'boolean', description: 'Your work is finished (handoff says so too). Your next prompt clears it.' },
        agent: { type: 'string', description: 'An agent in your crew to set the line or pose of, by ref or unique name; yours without. Not with done.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rest',
    description:
      "Say you're done for now: when you wait on someone else for longer than a few minutes (a review, a merge, a GO) " +
      'and have nothing to do. Your tile says "Resting" with your line, and as your turn ends the board pauses you, ' +
      'freeing what your session holds and keeping your tile, worktree, branch and conversation. A message (send), a ' +
      "hand-off, your clock or the user's Wake wakes you. Refused while the user's answer is pending (a permission " +
      'prompt, a question, a plan or your needs_you flag), while a command you started in the background runs, or while ' +
      'a message waits at your prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string', maxLength: MAX_REST_LENGTH, description: 'What you wait for, in a line: "waiting for the Playwright GO".' },
      },
      required: ['line'],
      additionalProperties: false,
    },
  },
  {
    name: 'needs_you',
    description:
      'Ask for a look, without a question: when you are blocked, your work is ready for review, or you need a decision. ' +
      'It lists you in the user\'s Needs you with your reason (or, if an orchestrator started you, tells that one, ' +
      'waking it at once if it is at its prompt, else as its turn ends), and nothing waits. A turn ending alone tells no one. Opening your session clears it; so does clear.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', maxLength: MAX_FLAG_LENGTH, description: 'Why, in a line: "PR #12 is ready for review".' },
        via: { type: 'string', description: 'Orchestrators: the crew member whose flag you pass on to the user, by ref (agent:9c1e) or name.' },
        clear: { type: 'boolean', description: 'Drop your flag instead: you no longer need a look.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'alert',
    description:
      'Tell the user something is done, with a banner and a row in their inbox\'s Done list, apart from Needs you: it ' +
      'asks nothing of them. Use it when a task the user asked for is done, or for something they would want to know now; ' +
      'not for routine progress, and not for a hand-off to another agent. It is your choice: the board never alerts for you. ' +
      `One banner every ${ALERT_INTERVAL_MS / 60_000} minutes: alerts sooner fold into your Done row.`,
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string', maxLength: MAX_ALERT_LENGTH, description: 'What is done, in a line: "PR #12 is merged".' },
        link: { type: 'string', description: 'An https link to go with it, such as the pull request.' },
      },
      required: ['line'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_pr',
    description:
      'Open a pull request of your branch, always as a draft, filled from .agent-board/handover.md. Commit first; in a ' +
      'zone with a gate, the gate must have passed on that commit. Marking it ready and merging stay the user\'s.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'record_pr',
    description:
      'Put a pull request you opened on your sidebar\'s PR section, as soon as you open it: any branch\'s, not only ' +
      'yours (open_pr records its own). What you record wins over what the board guesses from gh.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The pull request\'s GitHub URL, https://github.com/owner/repo/pull/n.' },
        title: { type: 'string', description: 'Its title, shown until gh is asked.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_doc',
    description:
      'Put a hand-off doc you wrote (a handover, findings, a plan) on your sidebar\'s Hand-off docs, where the user opens ' +
      'it in a Doc tab. With for_orchestrator, it goes on the sidebar of the orchestrator that started you instead, ' +
      'saying you wrote it: do that for what your orchestrator should read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, relative to your working directory, or absolute.' },
        for_orchestrator: { type: 'boolean', description: 'Record it for the orchestrator that started you.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'pin',
    description:
      'Pin something you want the user to see on your sidebar, as a Pinned block of your page: a file (a Markdown or HTML one opens in a Doc tab, ' +
      'any other is shown in its folder), an http(s) link (opens in a web tab), or a short note with a label. Give one of ' +
      'path, url or note. Pinning the same file, link or note label again replaces it; the user may delete a pin, not ' +
      'edit it. With for_orchestrator, it goes on the orchestrator that started you instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A file, relative to your working directory, or absolute.' },
        url: { type: 'string', description: 'An http or https link, such as a preview server.' },
        note: { type: 'string', description: `A short note, at most ${MAX_PIN_NOTE} characters; needs a label.` },
        label: { type: 'string', description: `What the sidebar calls it, at most ${MAX_PIN_LABEL} characters; a note's names it.` },
        for_orchestrator: { type: 'boolean', description: 'Pin it for the orchestrator that started you.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'unpin',
    description: 'Take a pin off your sidebar (or with for_orchestrator, off your orchestrator\'s): a file by its path, a link by its URL, or a note by its label.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The pinned file, as you named it to pin it.' },
        url: { type: 'string', description: 'The pinned link.' },
        label: { type: 'string', description: 'The pinned note\'s label.' },
        for_orchestrator: { type: 'boolean', description: 'Unpin it from the orchestrator that started you.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'steps_new',
    description:
      'Put a steps card beside your tile: questions for the user to step through and to-dos, in order, each ticked by ' +
      'whoever it names. For more than one question, or a list to get done in order; one quick question is `ask`. ' +
      'Returns at once: end your turn, and once the user presses Send the answers are typed at your prompt (if an ' +
      'orchestrator started you, it answers). One step a line: `- [ ] text @who` a to-do (@user for the user; yours ' +
      'without one), `? text [a | b]` pick one (a choice can\'t hold `|` or `]`), `? text [yes/no]`, `? text` in words; ' +
      '`# title` names it. The whole grammar ' +
      '(pick any, order, required, sections, links): `agent-board help steps`. ' +
      `At most ${MAX_STEPS} steps and ${MAX_STEPS_QUESTIONS} questions.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What it is, in a line; else its "# title" line.' },
        steps: { type: 'string', description: 'The steps, one a line, in the format above.' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'steps_read',
    description:
      'Read a steps card in full, each step numbered with its answer or tick; without card, list the cards you can read ' +
      '(in your zone, loose ones, and any you are part of), with mine only ' +
      'those with a to-do of yours not yet done.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', description: 'The card, by ref (item:3f2a).' },
        mine: { type: 'boolean', description: 'Without card: only cards with a to-do of yours not yet done.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'steps_update',
    description:
      'Change a steps card: done ticks a to-do that names you (with undo, unticks it); wait tells you at your prompt ' +
      'once someone else ticks a to-do, or the card is closed; add adds steps to the end of a card you made; answer, for an orchestrator, ' +
      "answers a crew member's question (send sends the answers, as the user's Send does); close says you are done " +
      'with a card you made.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', description: 'The card, by ref (item:3f2a).' },
        action: { type: 'string', enum: ['done', 'wait', 'add', 'answer', 'close'], description: 'What to do.' },
        step: { type: 'integer', minimum: 1, description: 'For done, wait and answer: the step, by its number.' },
        steps: { type: 'string', description: 'For add: the steps, one a line. For done, in place of step: the numbers of several to tick at once, as "2 3 5".' },
        answer: { type: 'string', description: 'For answer: a choice by its number or text, several split by commas, yes or no, or words.' },
        undo: { type: 'boolean', description: 'For done: untick it instead.' },
        send: { type: 'boolean', description: 'For answer: send the answers once this one is in (step and answer may be left out).' },
      },
      required: ['card', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'queue_new',
    description: 'Put a new queue beside your tile: jobs for the agents of its zone (every agent, if it is loose) to take one at a time, and info to read; with for_user, a queue of things for the user to look at, which no agent takes from.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What it queues, in a line.' },
        for_user: { type: 'boolean', description: "The user's queue: agents add to it, the user goes through it." },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'queue_read',
    description:
      'Without queue, list the queues you can read; with queue, its open rows in order, each its headline and link, and how many are done; ' +
      "with job and whole, that job whole (its body and result); with job alone, that job's versions, newest first; with done, the done " +
      'jobs and their results, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'The queue, by ref (item:3f2a) or title.' },
        job: { type: 'string', description: "A job's #id (its start will do): its history, or with whole, the job itself." },
        whole: { type: 'boolean', description: 'With job: the job whole, not its history.' },
        done: { type: 'boolean', description: 'The done jobs and their results, newest first, not the open rows.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'queue_update',
    description:
      'Change a queue: add queues jobs, one a line (" -> link" at its end; front puts them at the front; kind sets their ' +
      'kind; or one job as a headline and a body); take takes the next job, or job: it is yours until done or drop, and goes back to the front if your session ' +
      'ends first; drop puts a job you took back at the front, counted; done finishes it (result: what was done); edit, remove and restore (a ' +
      'version from queue_read) change a row; move puts one before another open job (to: its #id), at the top or last; later marks a waiting job Later, which no ' +
      'take without a job, nor the drain, starts until up moves it up. ' +
      'drain (on a queue you made) has the board start fresh agents for its waiting jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'The queue, by ref (item:3f2a) or title.' },
        action: { type: 'string', enum: ['add', 'take', 'drop', 'done', 'edit', 'move', 'later', 'up', 'remove', 'restore', 'drain'], description: 'What to do.' },
        job: { type: 'string', description: "The row, by #id (its start will do). For take, leave it out for the next one." },
        text: { type: 'string', description: 'For add: the jobs, one a line; for edit, the new text.' },
        headline: { type: 'string', description: `For add, instead of text: one job's headline, a line of at most ${MAX_JOB_HEADLINE} characters. Its detail goes in body.` },
        body: { type: 'string', description: 'For add, with headline: the detail, in Markdown.' },
        kind: {
          type: 'string',
          enum: [...QUEUE_ADD_KINDS],
          description:
            "For add. An agents' queue: task (the default), request, prompt, or info (read, never taken). The user's queue: backlog (the default), review, questions or read. job is the default kind, note is info.",
        },
        result: { type: 'string', description: 'For done: what was done, for whoever reads the queue next.' },
        front: { type: 'boolean', description: 'For add: at the front, in the order given.' },
        link: { type: 'string', description: 'For add (one job) and edit: its link; "" clears it.' },
        version: { type: 'integer', minimum: 1, description: 'For restore: the version to put back.' },
        to: { type: 'string', description: 'For move: the #id of the open job to put it before, top, or last.' },
        on: { type: 'boolean', description: 'For drain, on a queue you made: whether the board starts fresh agents for its waiting jobs.' },
        most: { type: 'integer', minimum: 1, maximum: 3, description: 'For drain: the most agents at once.' },
      },
      required: ['queue', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'remind',
    description:
      'Add to-dos for the user to your to-do list, under your tile (made by your first): things only they can do, such as ' +
      'sending a pull request for approval. Nothing is done for them, and nothing tells you when they tick one: ' +
      'remind_read with mine shows which are done. For questions they answer together, use steps_new.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The to-do, in a line: one a line for several (at most 500 characters each).' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'remind_read',
    description:
      'The to-do lists you can read (in your zone, loose ones, and any you are part of), each line numbered, with who ' +
      'ticked it and when; with mine, only your own.',
    inputSchema: {
      type: 'object',
      properties: { mine: { type: 'boolean', description: 'Only your own list.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'remind_update',
    description:
      'Change a line you wrote on your own to-do list, by its number in remind_read with mine, as the list is now (the user may ' +
      'have moved lines since you read it): done ticks it, undo unticks it, remove takes it off (the user need not do it ' +
      'now). The answer names the line it changed. A line the user wrote is theirs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['done', 'undo', 'remove'] },
        line: { type: 'integer', minimum: 1, description: "The line's number in your list." },
      },
      required: ['action', 'line'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_page',
    description:
      'Write your page: the shelf your sidebar opens on, which is yours to fill. Name its tab, pick its icon, and give ' +
      'it blocks: a heading with your progress, key figures, a checklist, a callout, links, a note. Each block may have ' +
      'a title, an icon and a tone. Writing it again replaces the whole page, so send every block each time; keep it ' +
      'current as your work moves on. With clear, the sidebar shows the board\'s Now instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: MAX_PAGE_NAME, description: `The tab's name, at most ${MAX_PAGE_NAME} characters: "Export".` },
        icon: { type: 'string', enum: [...PAGE_ICONS], description: "The tab's icon." },
        blocks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PAGE_BLOCKS,
          description: 'The page, top to bottom.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [...PAGE_BLOCK_KINDS],
                description:
                  'heading (title, text, progress 0-100), figures (figures), checklist (items), callout (text), links (links), note (title, text).',
              },
              title: { type: 'string', maxLength: MAX_PAGE_TITLE, description: "The block's title; a heading and a note need one." },
              icon: { type: 'string', description: "One of the tab's icons." },
              tone: { type: 'string', enum: [...PAGE_TONES], description: 'neutral unless you pick one.' },
              text: { type: 'string', maxLength: MAX_PAGE_TEXT, description: "A heading's line or two, a callout's or a note's text." },
              progress: { type: 'integer', minimum: 0, maximum: 100, description: "A heading's progress bar." },
              figures: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_PAGE_FIGURES,
                items: {
                  type: 'object',
                  properties: {
                    value: { type: 'string', maxLength: MAX_FIGURE_VALUE, description: 'Drawn large: "214", "18k".' },
                    label: { type: 'string', maxLength: MAX_PAGE_ITEM, description: 'What it counts: "tests passing".' },
                    icon: { type: 'string', description: "One of the tab's icons." },
                    tone: { type: 'string', enum: [...PAGE_TONES] },
                  },
                  required: ['value', 'label'],
                  additionalProperties: false,
                },
              },
              items: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_PAGE_ITEMS,
                description: "A checklist's lines, in order.",
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', maxLength: MAX_PAGE_ITEM },
                    state: { type: 'string', enum: [...PAGE_CHECK_STATES], description: 'todo unless you say; at most one line is doing, the one you are on now.' },
                  },
                  required: ['text'],
                  additionalProperties: false,
                },
              },
              links: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_PAGE_ITEMS,
                items: {
                  type: 'object',
                  description: 'One of url (an http or https link, opened in a web tab) and path (a file).',
                  properties: {
                    url: { type: 'string' },
                    path: { type: 'string', description: 'Relative to your working directory, or absolute.' },
                    label: { type: 'string', maxLength: MAX_PAGE_ITEM },
                  },
                  additionalProperties: false,
                },
              },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        clear: { type: 'boolean', description: 'Clear your page instead.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'clock_add',
    description:
      'Add a clock of your own, beside your tile: at each fire time of cron (five fields, local time) it messages you with ' +
      'prompt, and keeps your final message in its run history. after says what it does with you once each run is over: ' +
      'hibernate pauses you until the next run, which wakes you in the same conversation; idle (the default) leaves you at ' +
      'your prompt. With template it starts from a saved clock template, whose cron and prompt stand unless given.',
    inputSchema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: 'Five fields (minute hour day month weekday) or @daily, @hourly…: 0 9 * * 1-5.' },
        prompt: { type: 'string', description: 'What it sends you at each run.' },
        after: { type: 'string', enum: ['hibernate', 'idle'], description: "What it does with you after each run: the template's, else idle." },
        template: { type: 'string', description: 'A saved clock template to start from, by name.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'clock_set',
    description:
      'Change your own clock (the one that messages you, or whose run started you): what it does with you after each run ' +
      '(hibernate pauses you until the next run, which wakes you in the same conversation; close starts a fresh agent each ' +
      'run instead, and closes you once this run is over; idle leaves you at your prompt), or stop to turn it off. The user ' +
      'sees why on the clock, and only they turn it on again.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'string', enum: [...CLOCK_MODES], description: 'What it does with you after each run.' },
        stop: { type: 'boolean', description: 'Turn it off instead.' },
        why: { type: 'string', description: 'Why, in a line: the user sees it on the clock.' },
        schedule: { type: 'string', description: 'The clock, by ref, if you have more than one.' },
      },
      required: ['why'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_clock_template',
    description:
      'Save a clock as a template, by name, for clock_add (or add_schedule) to start new clocks from in any zone: from a clock on the board, or ' +
      "from cron, prompt and after (with close, a fresh agent's settings). Never the agent it messages. Saving under a name you " +
      'saved replaces it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What it is called: Slack watch.' },
        from: { type: 'string', description: 'The clock to save, by ref (item:31f0).' },
        cron: { type: 'string', description: 'Five fields (minute hour day month weekday) or @daily, @hourly…' },
        prompt: { type: 'string', description: 'What it sends, or a fresh agent its task.' },
        after: { type: 'string', enum: [...CLOCK_MODES], description: 'What it does with its agent after each run: idle by default.' },
        harness: { type: 'string', enum: [...HARNESSES] },
        model: { type: 'string' },
        role: { type: 'string' },
        keep: { type: 'boolean', description: 'Leave a fresh agent open once its run is over.' },
        result: { type: 'string', enum: ['history', 'note'], description: "Where a fresh agent's result goes besides the history." },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_clock_templates',
    description: 'Every saved clock template: its name, schedule, what it does, who saved it and its prompt.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'remove_clock_template',
    description: 'Remove a clock template you saved; only the user removes one another agent saved.',
    inputSchema: {
      type: 'object',
      properties: { template: { type: 'string', description: 'The template, by name.' } },
      required: ['template'],
      additionalProperties: false,
    },
  },
];

const AGENT_REF = { type: 'string', description: 'By ref (agent:9c1e) or unique name.' };

/** An agent's env vars of its own, as `--env`. */
const LAUNCH_ENV_ARG = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description:
    'Env vars of its own, by name ({"CLAUDE_CODE_EXPERIMENTAL_CODE_MODE": "0"}), kept for its restarts. A Claude agent gets them in ' +
    'its --settings env block too, which beats the user\'s settings files. Only plain knobs: that one, MAX_THINKING_TOKENS, ' +
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS, the BASH_ and MCP_ timeouts and limits, and DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, ' +
    'DISABLE_AUTOUPDATER, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and CLAUDE_CODE_DISABLE_TERMINAL_TITLE; the user sets others in the app. ' +
    'Only the names are shown, never the values.',
};

/** An agent's Claude settings of its own, as `--settings`. */
const LAUNCH_SETTINGS_ARG = {
  type: 'object',
  description: "Claude settings of its own, added to the board's --settings ({\"outputStyle\": \"Explanatory\"}). Only alwaysThinkingEnabled, outputStyle, includeCoAuthoredBy, includeGitInstructions, spinnerTipsEnabled, language and env; model and effort are new_agent's own. Claude only.",
};

/** Where the layout tools put something, as `agent-board move` takes it. */
const PLACE_PROPERTIES = {
  to: { type: 'string', description: "The zone or group, by ref; `board` for loose on the main board; a ticket's chat ref, or `ticket` for yours, for that ticket's own board. Without, its own place." },
  at: { type: 'string', description: "x,y relative to the zone (or on a ticket's board), such as 40,120. Moving a note to another board takes at or near." },
  near: { type: 'string', description: 'A tile or note to put it a gap beside, by ref.' },
  side: { type: 'string', enum: [...TILE_SIDES], description: 'Which side of near: below by default.' },
};

/** A shape's fields, as `add_shape` and `edit_shape` take them. */
const SHAPE_PROPERTIES = {
  shape: { type: 'string', enum: [...SHAPE_TYPES], description: 'Its kind: rectangle, rounded, diamond, database, class, interface-box, …' },
  text: { type: 'string', description: "Its text: a class's name." },
  attributes: { type: 'array', items: { type: 'string' }, description: 'class and interface-box only: its attributes, a line each, such as "+ id: UUID".' },
  methods: { type: 'array', items: { type: 'string' }, description: 'class and interface-box only: its methods, a line each, such as "+ total(): Money".' },
  fill: { type: 'string', description: 'tile (the default), accent, yellow, green, teal, cyan, blue, violet, pink, red or orange, which follow the theme; #rrggbb, which doesn\'t; or none.' },
};

/** A connector's fields, as `connect` and `edit_connector` take them. */
const CONNECTOR_PROPERTIES = {
  relation: { type: 'string', enum: RELATIONS.map((relation) => relation.id), description: 'Its ends and dash; directed (an arrow at to) by default.' },
  style: { type: 'string', enum: [...CONNECTOR_STYLES], description: 'Its line: curved by default.' },
  label: { type: 'string', description: 'The text on its middle.' },
  from_label: { type: 'string', description: 'The text by its from end: a multiplicity (1, 0..*) or a role.' },
  to_label: { type: 'string', description: 'The text by its to end.' },
};

/** The orchestrator's tools (ADR-0011), listed to every agent's own live session and to a shell. As the CLI's commands. */
export const ORCHESTRATOR_MCP_TOOLS: Tool[] = [
  {
    name: 'new_agent',
    description:
      'Start an agent with a prompt as its first message, in its own worktree and branch, in any zone (yours by default) ' +
      'and any repo. Returns its ref. A prompt may not start with ! or a /command (a plugin\'s /plugin:command is ' +
      'fine), nor hold a control character.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Its first message: the task.' },
        name: { type: 'string', description: "Its tile's name." },
        zone: { type: 'string', description: 'A zone ref; yours by default.' },
        harness: { type: 'string', enum: [...HARNESSES] },
        model: { type: 'string', description: "The harness's model (opus, sonnet, haiku; gpt-5-codex, gpt-5); its default without." },
        effort: {
          type: 'string',
          enum: [...EFFORTS],
          description: "Its reasoning effort (Codex takes no max). Without, the Settings default for its role, else for new agents, else the harness's own.",
        },
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
            "false starts it without its role's template: its first message is exactly your prompt (and the issue). For when you write the whole prompt. The result says which template was applied.",
        },
        repo: {
          type: 'string',
          description:
            "The absolute path of the repo, or a folder in one, to cut its worktree from, whatever repo its zone has. Without, the zone's repo; in a group (a zone with no repo), its default repo, else the group's own folder, outside git.",
        },
        branch: { type: 'string', description: 'Its new branch; made from its name by default. Not for a reviewer.' },
        base: { type: 'string', description: "The branch to cut it from (a reviewer's to review; a remote's, origin/<branch>, is fetched and made local), or an agent ref for that agent's branch (and its repo, unless repo names one)." },
        edges: {
          type: 'string',
          enum: ['auto', 'manual'],
          description:
            "Join a reviewer started on an agent's branch to that agent. None without: they talk through send. auto hands the reviewer's findings back by itself (the way back is manual); manual leaves both for the user to send.",
        },
        issue: { type: 'string', description: "An issue, which comes first in its prompt: read from the zone's tracker, else from the tracker its key names, yours, or the one on the board." },
        description: {
          type: 'string',
          description: `What it is for, kept as its description from the start ("Builds the morning overview window"): one line, cut to ${MAX_PURPOSE_LENGTH} characters.`,
        },
        prefab: {
          type: 'string',
          description:
            'Start a crew from this crew prefab (as `agent-board prefab ls` lists them) in place of one agent: its member ' +
            'that starts on the prompt, its builder or its lead, gets the prompt, started as the prefab says. Its reviewers ' +
            'start on the builder\'s branch each time the builder hands off, and their reviews go back to it, until each approves ' +
            'or the round limit (`agent-board crew`); a lead starts its own crew. Takes zone, repo, issue, description, chat, and name and branch for that member; the prefab sets the rest.',
        },
        env: LAUNCH_ENV_ARG,
        settings: LAUNCH_SETTINGS_ARG,
        chat: {
          type: 'string',
          enum: ['implementer', 'lead'],
          description:
            "With a prefab that starts inside a ticket tile: who builds the ticket. implementer: its chat builds it (one session fewer); lead: its chat leads a builder helper. The prefab's own choice without.",
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    description:
      "Send an agent its next message once its turn has ended (wait first): any agent but yourself. Never to one that " +
      "needs the user's permission, and never a harness command. To one still starting or mid-turn it is queued until " +
      "its turn ends. If it was typed but no turn started, it fails saying so: then submit or clear, instead of text. " +
      'The agent reads it headed with your sender mark, `⟨send from <your name> · <your ref>⟩`; the result says how it starts.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_REF,
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Instead of text: press Enter on the message left unsent at its prompt.' },
        clear: { type: 'boolean', description: 'Instead of text: clear the message left unsent at its prompt.' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      'Wait until each agent\'s turn has ended (at its prompt, needing the user, failed or stopped), and say where each ' +
      'is; with no agents, your crew. A turn you started counts once it began, so call it straight after new_agent or ' +
      'send. until finished waits until it says its work is finished. A crew ref (crew:<id>) alone waits until that ' +
      'crew stops. With since, it waits instead for what happens to them next, each as a line, and answers with a ' +
      `cursor to pass as since next time ("now" the first time). Gives up after ${MCP_WAIT_SECONDS} s by default ` +
      "(the result's timedOut is true): then call it again.",
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: AGENT_REF },
        crew: { type: 'boolean', description: 'Your crew too, besides the agents named: the agents you started, and theirs.' },
        until: { type: 'array', items: { type: 'string', enum: [...WAIT_STATES] }, description: 'Wait for these states instead.' },
        any: { type: 'boolean', description: 'Until one of them is there, not all.' },
        since: { type: 'string', description: 'Wait for what happens after this cursor instead: "now", a cursor it answered with, or "all".' },
        kinds: { type: 'array', items: { type: 'string', enum: [...CREW_EVENT_KINDS] }, description: 'With since, only these.' },
        timeout_seconds: { type: 'integer', minimum: 0, description: `How long to wait; ${MCP_WAIT_SECONDS} by default. The result's timedOut says whether it gave up.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      "An agent's final message from its last finished turn, or a text file in its worktree (such as " +
      '.agent-board/handover.md).',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, path: { type: 'string', description: 'A file, relative to its worktree.' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'interrupt',
    description: "Interrupt an agent's turn, as Ctrl-C would: it waits at its prompt.",
    inputSchema: { type: 'object', properties: { agent: AGENT_REF }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'set_effort',
    description:
      "Change an agent's reasoning effort, as its tile's Reasoning menu does. A Claude agent takes it at once if it is at its " +
      'prompt, or when its turn ends if it is mid-turn (never typed into a turn); a Codex agent (no max) takes it when next ' +
      'started. The reply says which.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, effort: { type: 'string', enum: [...EFFORTS], description: 'The new level.' } },
      required: ['agent', 'effort'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename',
    description:
      "Rename any agent's tile, your own too (agent me), and set what it is for (description): either or both. Any agent " +
      'may rename any agent, one the user named or started by hand too; the last rename wins. The tile shows the new name ' +
      'at once, and its hover card who renamed it and when. A name another agent, a shell or a zone already has is ' +
      'refused, naming what has it, and so are `me`, ref-shaped names (agent:…) and names holding ⟨ ⟩ or starting ' +
      '[agent-board].',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The agent, by ref (agent:9c1e), unique name, or me for your own tile.' },
        name: { type: 'string', description: 'Its new name, at most 60 characters.' },
        description: { type: 'string', description: 'What it is for, in up to 80 characters; "" clears it.' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'pin_expanded',
    description:
      "Pin an agent's tile expanded, or unpin it with pinned false, as its tile's Pin expanded does. Pinned, it stays " +
      'expanded where it is and at its size, opens again by itself after a restart, and nothing collapses, moves or ' +
      'resizes it: other tiles and arrange go round it. A closed agent drops its pin.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, pinned: { type: 'boolean', description: 'false to unpin it; true unless given.' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'ticket_watches',
    description:
      "Show a ticket's watches on its pull request, or change them, as its tile's Watches menu does: agent is the ticket's " +
      'chat or a helper (`me` for your own ticket). Each kind is off, tile (its tile shows the news), chat (the chat is told, ' +
      'as its next message) or both; none is on until turned on, and kinds left out stay as they are. They read the pull ' +
      "request with the user's own gh, every_minutes apart (5 unless set) and once straight after the ticket pushes, and " +
      'only read: none approves or merges.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_REF,
        watches: {
          type: 'object',
          description: 'The kinds to change: reviews (a person reviews or comments), approvals (approved, or the decision changes), merge (merged, closed, conflicting, behind), checks (failing, or passing again).',
          properties: Object.fromEntries(TICKET_WATCH_KINDS.map((kind) => [kind, { type: 'string', enum: [...TICKET_WATCH_MODES] }])),
          additionalProperties: false,
        },
        every_minutes: { type: 'number', enum: [...TICKET_WATCH_EVERY_MINUTES], description: 'How often to read the pull request.' },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_role',
    description:
      "Give a running agent a role, as its tile's Role menu does, or take it away with clear: a built-in one (implementer, " +
      'reviewer, follow-up-reviewer) or any other by its name, orchestrator among them. Give `me` to name yourself: ' +
      "`orchestrator` makes you your zone's. Only the role changes: the agent isn't restarted, and no template is sent " +
      "to it unless send_template asks, when the role's template goes to it as a message from you (a role with none " +
      'sends nothing).',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_REF,
        role: { type: 'string', maxLength: MAX_ROLE_NAME_LENGTH, description: 'The role: implementer, reviewer, orchestrator, designer.' },
        clear: { type: 'boolean', description: 'Take its role away instead.' },
        send_template: { type: 'boolean', description: "Also send it the role's template as a message. Not with clear, nor to yourself." },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'continue_on_credits',
    description:
      'Continue on credits: resume the turn of a Claude agent its usage limit stopped (rate-limited), for its usage ' +
      "credits to pay for, by the step Claude Code offers for it; never a billing page. Only while it is rate-limited. " +
      'Returns once its turn starts. If the limit stops it again at once, its usage credits are spent too: tell the user.',
    inputSchema: { type: 'object', properties: { agent: AGENT_REF }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'restart',
    description:
      "Start an ended agent again in its tile, worktree and branch, carrying on its conversation, as its tile's Restart " +
      'does. With `fresh` it starts a new conversation instead, under a new session id (the old one is kept in the ' +
      "agent's earlierConversations), on `prompt` as its first message.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_REF,
        fresh: { type: 'boolean', description: 'Start a new conversation instead of carrying on the old one.' },
        prompt: { type: 'string', description: 'With fresh: its first message.' },
        env: { ...LAUNCH_ENV_ARG, description: "Its env vars of its own in place of the ones it had ({} for none), as new_agent's env. A running agent is stopped first, then carries on its conversation." },
        settings: { ...LAUNCH_SETTINGS_ARG, description: "Its Claude settings of its own in place of the ones it had ({} for none). Each of env and settings left out stays as it was." },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'pause',
    description:
      "Pause an idle agent to free the memory its harness holds: its session ends, keeping its tile, worktree, branch " +
      'and conversation, and its tile shows it hibernated. Only an agent between turns that waits on no one. `wake`, ' +
      'a message (send) or a hand-off wakes it, carrying on its conversation.',
    inputSchema: { type: 'object', properties: { agent: AGENT_REF }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'wake',
    description: 'Wake a paused agent, or one a restart stopped, carrying on its conversation.',
    inputSchema: { type: 'object', properties: { agent: AGENT_REF }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'add_edge',
    description:
      'Join two agents (or you) with an edge: when `from` hands off, what it carries goes to `to` as its ' +
      'next message. Marked as made by you. A gate or script condition runs nothing until the user approves it.',
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
            additionalProperties: false,
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
    description: 'Every edge on the board: its two agents, what it carries, when, how it stands, and who made it.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'remove_edge',
    description: 'Remove an edge you, or an agent you started, made.',
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
      'Move a tile (an agent, a shell, or you) or a note, as dragging it would: into a zone ' +
      "or a group you made, exactly at a place (on the zone's grid) or beside another, what is in the way moving aside. " +
      "A note, shape or card also goes onto a ticket's own board (to its chat's ref, with at or near) and back off it (to a zone or board, with at or near); a tile stays on the main board.",
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
      "Lay out your zone's tiles that you may move, on its grid: you and the shells and clocks you or your crew made " +
      'first, then a lane per issue or branch ticket (its implementer, reviewer and follow-up reviewer in columns, then ' +
      'a note saying what each agent is doing), or a row per role or state. It places the zone\'s items too, each kind ' +
      'as placements says, and fits the zone to what it holds. It answers with the zone\'s map (see map). by, layout ' +
      'and auto are kept for the next arrange. Each layout and placement: `agent-board help arrange`.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: {
          type: 'string',
          description:
            "The zone, by ref; yours by default. `board`: the board's zones, and its loose agents and shells below them. `ticket` (yours) or a ticket's chat ref: that ticket's own board. Neither takes by, layout or auto.",
        },
        by: { type: 'string', enum: [...ARRANGE_BYS], description: 'What a row holds: issue at first, then as you last asked.' },
        layout: {
          type: 'string',
          enum: [...ARRANGE_LAYOUTS],
          description: 'rows at first: a lane per group, a column per slot. Each layout: `agent-board help arrange`.',
        },
        auto: { type: 'boolean', description: 'Arrange by itself after every agent you start, note you add and agent you close (true), or stop (false). Off at first.' },
        placements: {
          type: 'object',
          description: "Where to place each kind of the zone's items, as { notes: 'sidebar' }: kept as the zone's for its next arrange, unless once.",
          properties: Object.fromEntries(ARRANGE_ITEM_KINDS.map((kind) => [kind, { type: 'string', enum: [...ARRANGE_PLACEMENTS] }])),
          additionalProperties: false,
        },
        once: { type: 'boolean', description: 'The placements given for this arrange only, not kept as the zone\'s.' },
        all: { type: 'boolean', description: 'Tidy the items the user dragged or turned too, which an arrange otherwise leaves where they are.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'zone_layout',
    description:
      'Set how a zone (yours by default) draws what it holds, as its Layout menu does: free, each tile where it was put ' +
      '(every zone starts free); spine or lanes, a rule by ticket the zone keeps, moving its tiles; shelves, a stack per ' +
      'ticket on To do, Doing, Waiting and Done shelves; clusters, each ticket\'s tiles together, what needs the user ' +
      'first. Shelves and clusters move no tile\'s own place. Choose shelves to follow its work by status; spine, ' +
      'clusters or lanes by ticket. Each in full: `agent-board help zone`.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: [...ZONE_LAYOUT_CHOICES], description: 'free, spine, lanes, shelves or clusters.' },
        zone: { type: 'string', description: 'The zone, by ref; yours by default.' },
      },
      required: ['layout'],
      additionalProperties: false,
    },
  },
  {
    name: 'map',
    description:
      'Your zone as arrange sees it, to check a layout without a screenshot: a line per lane with a cell per slot ' +
      '(implementer, reviewer, follow-up, notes), each tile\'s ref, name and state, and a lint line naming overlaps, the ' +
      'widest gap in a lane, the space between lanes, a label far from its tiles, a zone mostly empty, and tiles not where an arrange would put them or out of their lane. ' +
      "For a ticket's own board (yours by default if you are a helper beside your ticket), what is on it, where, its size, and what overlaps. Moves nothing.",
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: "The zone, by ref; a ticket's chat, by ref, for its ticket's own board, or `ticket` for yours. Yours by default: your ticket's board if you are a helper beside your ticket." },
        boxes: { type: 'boolean', description: 'Draw the zone in characters instead, overlaps and gaps where they really are (about three times as long).' },
        sections: { type: 'boolean', description: "List a diagram's class members under each shape (cut short), not only their counts." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'zone_screenshot',
    description:
      'A picture of your zone (PNG), to see its layout as the user does: as the board draws it, every terminal\'s text ' +
      'hidden, or with style lofi a plain drawing of its tiles, notes and lines. A bigger zone is drawn smaller, and the ' +
      'caption says by how much, with the map\'s lint line. Costs about 2–3k tokens: check with map first. Needs the ' +
      'app open; never moves the user\'s view.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: 'The zone, by ref; yours by default.' },
        style: { type: 'string', enum: [...CAPTURE_STYLES], description: 'board (the default): as the app draws it; lofi: a plain drawing from what the board knows.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_note',
    description:
      'Put a note of short markdown on the board, marked as made by you, in your zone or beside a tile, what is there moving ' +
      'aside: an agent note (a speech bubble from your face, with your name, role and the time, never a sticky) by default, or a signed sticky or text with kind. Near an agent with no ' +
      "side, it is added to its cluster's note, else goes in the slot before it.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: [...NOTE_KINDS], description: 'Left out, an agent note from you; sticky makes a signed sticky; or text.' },
        color: { type: 'string', description: 'Text only (an agent note has none, and ignores one): yellow, orange, pink, violet, blue, green, grey or white (text: accent, ink, grey, red, orange, yellow, green, teal, cyan, blue, violet or pink, which follow the theme), or #rrggbb.' },
        lines: { type: 'integer', minimum: 1, maximum: MAX_AGENT_NOTE_LINES, description: 'An agent note\'s line budget: it starts as tall as this many lines, and past them its text fades into a "more lines" chip the user can click.' },
        ...PLACE_PROPERTIES,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_note',
    description:
      'Change the text (or text item\'s colour, or an agent note\'s size or line budget) of a note you, or an agent you started, made.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The note, by ref (item:31f0).' },
        text: { type: 'string' },
        color: { type: 'string' },
        size: { type: 'string', description: 'An agent note\'s size, <width>x<height> such as 360x240 (238x96 to 1200x1440). An arrange keeps it, and text that does not fit scrolls. Not with lines.' },
        lines: { type: 'integer', minimum: 0, maximum: MAX_AGENT_NOTE_LINES, description: 'An agent note\'s line budget, as add_note takes it; 0 takes it away. Rewritten, a note keeps its budget. Not with size.' },
      },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_note',
    description: 'Remove a note or link card you, or an agent you started, made.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The note, by ref (item:31f0).' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_item',
    description:
      'Delete a board item of any kind (a queue, to-do list, steps card, note, shape…; not a running crew\'s card) as ' +
      'one step an open board can undo (not on a ticket\'s board), its connectors with it. One you, or an agent you started, made goes at once; ' +
      'one made by the user or another agent only with ask, which asks the user in an Allow/Deny prompt and waits for the answer ' +
      `(${DEFAULT_ASK_WAIT_MS / 60_000} minutes by default). A queue with open jobs, a to-do list with open lines or a steps card ` +
      'with open steps stays, saying how many, unless force.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item, by ref (item:31f0).' },
        force: { type: 'boolean', description: 'Delete it even with open jobs, lines or steps.' },
        ask: { type: 'boolean', description: 'Ask the user to delete one you did not make.' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'With ask: how long to wait for the answer. No answer by then deletes nothing.' },
      },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'pass_note',
    description:
      'Pass an agent note or document card you or any other agent holds to any agent, one the user started by hand ' +
      'included, which holds it from then on and is told: it stays when you are removed, and goes with that agent. Never the user\'s own ' +
      'notes.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The agent note or document card, by ref (item:31f0).' }, to: AGENT_REF },
      required: ['note', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_shape',
    description:
      'Draw a shape with text in it, marked as made by you, placed as add_note places a note (near another shape, with a ' +
      'side, to lay a diagram out). A class or interface-box takes attributes and methods, a line each, under its name. ' +
      'It is sized for its text. Draw only when the user asks for a diagram.',
    inputSchema: {
      type: 'object',
      properties: { ...SHAPE_PROPERTIES, ...PLACE_PROPERTIES },
      required: ['shape'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_diagram',
    description:
      'Draw a Mermaid flowchart (`flowchart TD`, or LR) or class diagram (`classDiagram`) as shapes and connectors, marked ' +
      'as made by you: laid out in ranks as Mermaid draws it, and placed as one block as add_note places a note. A ' +
      "flowchart's brackets pick each shape and its links their ends and labels; a class diagram's classes take their " +
      'members and its relations (<|--, *--, o--, ..>, ..|>) their ends and multiplicities. It says which lines it passed ' +
      'over. Draw only when the user asks for a diagram.',
    inputSchema: {
      type: 'object',
      properties: { mermaid: { type: 'string', description: 'The Mermaid text, its header line first.' }, ...PLACE_PROPERTIES },
      required: ['mermaid'],
      additionalProperties: false,
    },
  },
  {
    name: 'export_diagram',
    description:
      'Shapes on the board and the connectors between them as Mermaid: a class diagram when a class is among them, else a ' +
      'flowchart.',
    inputSchema: {
      type: 'object',
      properties: { refs: { type: 'array', items: { type: 'string' }, description: "Zones (every shape in each) or shapes, by ref. Left out: your ticket's board if you are a helper beside your ticket, else your zone." } },
      additionalProperties: false,
    },
  },
  {
    name: 'edit_shape',
    description: "Change a shape's kind, text, sections or fill: one you, or an agent you started, drew. Only what is given changes.",
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', description: 'The shape, by ref (item:31f0).' }, ...SHAPE_PROPERTIES },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_shape',
    description: 'Remove a shape you, or an agent you started, drew, and every connector joined to it.',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', description: 'The shape, by ref (item:31f0).' } },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'connect',
    description:
      'Join two board items (shapes, notes) with a connector, marked as made by you, from → to as the relation reads: a ' +
      'child to its parent (inheritance), a class to its interface (realisation), a user to what it uses (dependency), a ' +
      'whole to its parts (aggregation, composition). Its sides face each other. Draw only when the user asks for a ' +
      'diagram.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The item it starts at, by ref (item:31f0).' },
        to: { type: 'string', description: 'The item it ends at, by ref.' },
        ...CONNECTOR_PROPERTIES,
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_connector',
    description: "Change a connector's relation, style or labels: one you, or an agent you started, made. Only what is given changes.",
    inputSchema: {
      type: 'object',
      properties: { connector: { type: 'string', description: 'The connector, by ref (connector:8a2c).' }, ...CONNECTOR_PROPERTIES },
      required: ['connector'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_connector',
    description: 'Remove a connector you, or an agent you started, made.',
    inputSchema: {
      type: 'object',
      properties: { connector: { type: 'string', description: 'The connector, by ref (connector:8a2c).' } },
      required: ['connector'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_schedule',
    description:
      'Put a schedule on the board as a clock, marked as made by you: at each fire time of cron (five fields, local time) it either ' +
      'messages the agent `to` with prompt, or with fresh starts a fresh agent in your zone (or zone) with prompt as its task, waits ' +
      'for its turn to end, keeps its final message in the clock\'s run history and closes it. With template it starts from a ' +
      'saved clock template, whose cron, prompt and mode stand unless given. A clock of your own is `clock_add`.',
    inputSchema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: 'Five fields (minute hour day month weekday) or @daily, @hourly…: 0 9 * * 1-5.' },
        prompt: { type: 'string', description: 'What it sends the agent, or a fresh agent its task.' },
        to: { type: 'string', description: 'The agent it messages, by ref.' },
        fresh: { type: 'boolean', description: 'Start a fresh agent each run instead.' },
        zone: { type: 'string', description: "A fresh agent's zone, by ref: yours by default." },
        harness: { type: 'string', enum: [...HARNESSES] },
        model: { type: 'string' },
        role: { type: 'string' },
        keep: { type: 'boolean', description: 'Leave a fresh agent open once its run is over.' },
        result: { type: 'string', enum: [...CLOCK_RESULTS], description: "Where a fresh agent's result goes besides the history: a note where its tile was, or a hand-off." },
        handoff_to: { type: 'string', description: 'The agent a fresh agent hands its result to (result handoff), by ref.' },
        template: { type: 'string', description: 'A saved clock template to start from, by name (list_clock_templates).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'list_schedules',
    description: "Every schedule (clock) on the board: its ref, its cron, what it does, its next run and its last run's outcome. Each prompt is cut to 80 characters; full gives all of it.",
    inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'Show each schedule\'s whole prompt.' } }, additionalProperties: false },
  },
  {
    name: 'remove_schedule',
    description: 'Remove a schedule you, or an agent you started, made.',
    inputSchema: {
      type: 'object',
      properties: { schedule: { type: 'string', description: 'The clock, by ref (item:31f0).' } },
      required: ['schedule'],
      additionalProperties: false,
    },
  },
  {
    name: 'prefabs',
    description:
      "The app's crew prefabs, one library for every board: each a saved crew shape (its members, when each starts, " +
      'its round limit), built-ins first. With name, that one whole, as its .crew.json file. Start a crew from one with ' +
      'new_agent and prefab.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A prefab to show whole; every prefab in a line each without.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'prefab_draft',
    description:
      'Draft a crew prefab for the user from a .crew.json file (version 2) you wrote, checked as an imported file is, ' +
      "with a line for each thing you assumed that they didn't say. The user opens it on the prefab's board and saves " +
      'it or deletes it; nothing is saved, started or changed until then. Read prefabs and roles first for what they ' +
      'have.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The absolute path of the .crew.json file.' },
        assumed: {
          type: 'array',
          items: { type: 'string' },
          description: "What you assumed, a line each. Start one with a member's, input's or loop gate's id in brackets ('[reviewer] Stops at 3 rounds') when it is about that one.",
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'roles',
    description:
      "The app's default roles: a custom role's name and the template an agent started in it begins with, in any zone " +
      'with no template of its own for the name.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'set_role',
    description:
      "Add one of the app's default roles, or replace the one of the same name, logged for the user. With zone, that " +
      "zone's own template for the name instead. Not for a built-in role. The " +
      'template may not start with ! or a /command, nor hold a control character.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: MAX_ROLE_NAME_LENGTH, description: 'The role\'s name: designer, release prep.' },
        zone: { type: 'string', description: "A zone ref: set its own template for the name, not the app's." },
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
    description: "Remove one of the app's default roles, or with zone that zone's template for the name, logged for the user.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, zone: { type: 'string', description: 'A zone ref.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'close',
    description:
      "End an agent's session and take its tile off the board, with the notes and documents it holds; its worktree and " +
      'branch go too, unless they hold unsaved work, which stays (the answer says where). One the user started by hand ' +
      "only by asking them (ask_to_remove). A ticket's chat closes with its helpers: as an agent, only when you " +
      'started each helper yourself. With remove, delete it with ' +
      'its worktree and branch, keeping nothing: only an agent you started, with nothing unsaved; to remove others, ' +
      'use ask_to_remove.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, remove: { type: 'boolean' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_to_remove',
    description:
      'Ask the user to remove agents you may close but did not start, each with its tile, worktree and branch: ' +
      'they get one Allow/Deny prompt for the whole list, and nothing goes unless they press Allow. One still running, ' +
      'or with an agent it started still running, stays unless they tick it. Returns at once: the ask stays up until ' +
      `they answer or the wait runs out (${DEFAULT_ASK_WAIT_MS / 60_000} minutes by default), and their answer comes ` +
      'to your prompt as a message, with what was removed and what stayed, and why. One ask at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: AGENT_REF, minItems: 1, maxItems: MAX_REMOVE_ASK_TILES },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'How long the ask stays up for the answer. No answer by then removes nothing.' },
      },
      required: ['agents'],
      additionalProperties: false,
    },
  },
  {
    name: 'handover',
    description:
      "Hand one orchestrator's crew, and what it made on the board, to another, which may then arrange, edit, remove and " +
      "close them: your own crew to another agent, or take over one whose session has ended or that was removed. " +
      "`from` may be a removed orchestrator whose crew is still on the board (the crew's `orphanedFrom`).",
    inputSchema: {
      type: 'object',
      properties: { from: AGENT_REF, to: AGENT_REF },
      required: ['from', 'to'],
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

/** A tool's answer is text, and for `zone_screenshot` a picture before it. */
type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };

interface ToolResult {
  content: ToolContent[];
  /** What a tool says in fields as well as text: `wait`'s `timedOut`. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A tool's answer: its text, its content, or content with fields. */
type ToolAnswer = string | ToolContent[] | { content: ToolContent[]; structuredContent: Record<string, unknown> };

/** The env and settings args as launch settings, undefined with neither: the daemon checks what they hold. */
function launchSettingsArgs(args: Record<string, unknown>): LaunchSettings | undefined {
  if (args.env === undefined && args.settings === undefined) return undefined;
  return {
    ...(args.env === undefined ? {} : { env: args.env as Record<string, string> }),
    ...(args.settings === undefined ? {} : { settings: args.settings as Record<string, unknown> }),
  };
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

/** An agent note's line budget, from `args.lines`, if given: checked as a number by the note ops. */
function linesArgOf(args: Record<string, unknown>): { lines?: number } {
  if (args.lines === undefined) return {};
  if (typeof args.lines !== 'number') throw new BoardError('lines must be a whole number');
  return { lines: args.lines };
}

/** A boolean argument, if given. */
function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  if (args[name] !== undefined && typeof args[name] !== 'boolean') throw new BoardError(`${name} must be true or false`);
  return args[name] as boolean | undefined;
}

/** `queue_update`'s arguments, read by the parser `queue add|take|…` uses too. */
function queueUpdateArg(args: Record<string, unknown>): QueueUpdate {
  const { headline, text, ...given } = givenStrings(args, ['job', 'text', 'headline', 'body', 'kind', 'link', 'result', 'to'] as const);
  if (headline === undefined && given.body !== undefined) throw new BoardError('body goes with headline');
  if (headline !== undefined && text !== undefined) throw new BoardError('give text, or headline and body: not both');
  const front = booleanArg(args, 'front');
  const on = booleanArg(args, 'on');
  const body = headline === undefined ? {} : { body: given.body ?? '' };
  const line = headline ?? text;
  return queueUpdate({
    action: typeof args.action === 'string' ? args.action : undefined,
    ...given,
    ...body,
    ...(line === undefined ? {} : { text: line }),
    ...(front === undefined ? {} : { front }),
    ...(on === undefined ? {} : { on }),
    ...(args.version === undefined ? {} : { version: args.version }),
    ...(args.most === undefined ? {} : { most: args.most }),
  });
}

/** `steps_update`'s arguments as the update `steps done|wait|add|answer|close` makes. */
function stepsUpdateArg(args: Record<string, unknown>): StepsUpdate {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const text = stringArg(args, 'steps', true);
  const answer = stringArg(args, 'answer', true);
  const undo = booleanArg(args, 'undo');
  const send = booleanArg(args, 'send');
  // For done, steps names the steps to tick, as the CLI's words do; for add, it is the steps to add.
  const listed = action === 'done' && text !== undefined;
  if (listed && args.step !== undefined) throw new BoardError('give step or steps, not both');
  return stepsUpdate({
    action,
    steps: listed ? stepWords(text) : args.step === undefined ? [] : [args.step],
    ...(text === undefined || listed ? {} : { text }),
    ...(answer === undefined ? {} : { answer }),
    ...(undo === undefined ? {} : { undo }),
    ...(send === undefined ? {} : { send }),
  });
}

/** `new`'s `edges`: auto or manual, or undefined. */
function edgesArg(args: Record<string, unknown>): 'auto' | 'manual' | undefined {
  const value = stringArg(args, 'edges', true);
  if (value !== undefined && value !== 'auto' && value !== 'manual') throw new BoardError('edges must be auto or manual');
  return value;
}

/** The string arguments of `names` that were given, each checked, as an object of only those. */
function givenStrings<Name extends string>(args: Record<string, unknown>, names: readonly Name[]): Partial<Record<Name, string>> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = stringArg(args, name, true);
      return value === undefined ? [] : [[name, value]];
    }),
  ) as Partial<Record<Name, string>>;
}

/**
 * `arrange`'s `auto` as the CLI's `--auto`: true or false, or as a model may send it, `"true"`, `"on"`, `"false"` or
 * `"off"`; anything else is refused rather than read as off.
 */
function autoArg(args: Record<string, unknown>): { auto?: string } {
  const value = args.auto;
  if (value === undefined) return {};
  if (value === true || value === 'true' || value === 'on') return { auto: 'on' };
  if (value === false || value === 'false' || value === 'off') return { auto: 'off' };
  throw new BoardError('auto must be true or false');
}

/** A yes-or-no option of `arrange` (`once`, `all`): true or false, or as a model may send it, `"true"` or `"false"`. */
function flagArg<Name extends 'once' | 'all'>(args: Record<string, unknown>, name: Name): Partial<Record<Name, true>> {
  const value = args[name];
  if (value === undefined || value === false || value === 'false') return {};
  if (value === true || value === 'true') return { [name]: true } as Record<Name, true>;
  throw new BoardError(`${name} must be true or false`);
}

/** `placements` as `arrange` takes it: each kind's placement, by kind; or a string of `kind=placement` pairs. */
function placementsArg(args: Record<string, unknown>): { place?: Record<string, string> } {
  const value = args.placements;
  if (value === undefined) return {};
  if (typeof value === 'string') return { place: placeOption(value) };
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every((each) => typeof each === 'string')) {
    throw new BoardError('placements must say each kind\'s placement, as { "notes": "sidebar" }');
  }
  return { place: value as Record<string, string> };
}

/** `on_board` as a plan takes it: true or false, or not given. */
function onBoardArg(args: Record<string, unknown>): { onBoard?: boolean } {
  if (args.on_board === undefined) return {};
  if (typeof args.on_board !== 'boolean') throw new BoardError('on_board must be true or false');
  return { onBoard: args.on_board };
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

/** Every tool's input schema, by name, to check a call's arguments against. */
const TOOL_SCHEMAS = new Map([...BOARD_MCP_TOOLS, ...ORCHESTRATOR_MCP_TOOLS].map((tool) => [tool.name, tool.inputSchema]));

interface ObjectSchema {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  items?: unknown;
}

/** An object in a call with keys its schema closes out: where it is, those keys, and the keys it allows. */
interface UnknownKeys {
  path: string;
  keys: string[];
  allowed: string[];
}

/**
 * Every object in `value` with keys that `schema` closes out (additionalProperties false), at every level, through
 * its properties and array items: each with its unknown keys and the keys it allows. `path` names `value` in the call.
 */
function unknownKeys(schema: unknown, value: unknown, path: string): UnknownKeys[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const { properties = {}, additionalProperties, items } = schema as ObjectSchema;
  if (Array.isArray(value)) return value.flatMap((each, index) => unknownKeys(items, each, `${path}[${index}]`));
  if (typeof value !== 'object' || value === null) return [];
  const keys = Object.keys(value);
  const unknown = additionalProperties === false ? keys.filter((key) => !Object.hasOwn(properties, key)) : [];
  const here = unknown.length > 0 ? [{ path, keys: unknown, allowed: Object.keys(properties) }] : [];
  const inside = keys
    .filter((key) => Object.hasOwn(properties, key))
    .flatMap((key) => unknownKeys(properties[key], (value as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`));
  return [...here, ...inside];
}

/** One line of a refusal: what `found` lacks, and what it takes. */
function unknownKeysLine(name: string, found: UnknownKeys): string {
  const keys = found.keys.join(', ');
  if (found.path === '') {
    if (found.allowed.length === 0) return `${name} takes no arguments, not ${keys}.`;
    return `${name} has no argument${found.keys.length > 1 ? 's' : ''} ${keys}. Its arguments are: ${found.allowed.join(', ')}.`;
  }
  if (found.allowed.length === 0) return `${name}: ${found.path} takes no keys, not ${keys}.`;
  return `${name}: ${found.path} has no ${keys}. Its keys are: ${found.allowed.join(', ')}.`;
}

/** Why `args` don't fit tool `name`'s schema, a line for each object with unknown keys, or undefined when they fit. */
function argumentRefusal(name: string, args: Record<string, unknown>): string | undefined {
  const found = unknownKeys(TOOL_SCHEMAS.get(name), args, '');
  return found.length === 0 ? undefined : found.map((each) => unknownKeysLine(name, each)).join('\n');
}

/** What each tool does with a board session, its arguments and the caller's folder: the text the model reads, or what it sees. */
const TOOL_CALLS: Record<string, (session: BoardSession, args: Record<string, unknown>, cwd: string) => Promise<ToolAnswer>> = {
  whoami: async (session) => identifyView(new BoardRefs(await readBoard(session.client)), session.caller, session.socketPath, 'mcp').text,
  board: async (session, args) => treeView(new BoardRefs(await readCards(session)), session.caller, { zone: stringArg(args, 'zone', true), face: 'mcp' }).text,
  usage: async (session) => (await usageView(session)).text,
  connections: async (session) => connectionsView(new BoardRefs(await readBoard(session.client)), session.caller, 'mcp').text,
  open_pr: async (session) => (await openOwnPullRequest(session)).text,
  record_pr: async (session, args, cwd) => {
    const title = stringArg(args, 'title', true);
    return (await recordEntry(session, { kind: 'pr', url: stringArg(args, 'url'), ...(title === undefined ? {} : { title }) }, cwd)).text;
  },
  record_doc: async (session, args, cwd) =>
    (await recordEntry(session, { kind: 'doc', path: stringArg(args, 'path'), forOrchestrator: args.for_orchestrator === true }, cwd)).text,
  pin: async (session, args, cwd) => {
    const given = givenStrings(args, ['path', 'url', 'note', 'label']);
    if (given.note !== undefined && given.label === undefined) throw new BoardError('a note needs a label, which names it on the sidebar');
    return (await pinEntry(session, { kind: 'pin', ...given, forOrchestrator: args.for_orchestrator === true }, cwd)).text;
  },
  unpin: async (session, args, cwd) => {
    return (await unpinEntry(session, { ...givenStrings(args, ['path', 'url', 'label']), forOrchestrator: args.for_orchestrator === true }, cwd)).text;
  },
  set_page: async (session, args, cwd) => {
    if (args.clear === true) {
      if (args.name !== undefined || args.icon !== undefined || args.blocks !== undefined) throw new BoardError('clear takes no name, icon or blocks');
      return (await setOwnPage(session, null, cwd)).text;
    }
    const name = stringArg(args, 'name');
    const icon = stringArg(args, 'icon');
    if (!Array.isArray(args.blocks)) throw new BoardError('give blocks, a list of at least one block, or clear');
    return (await setOwnPage(session, { name, icon, blocks: args.blocks }, cwd)).text;
  },
  alert: async (session, { line, link }) => {
    if (typeof line !== 'string') throw new BoardError('give a line: what is done');
    if (link !== undefined && typeof link !== 'string') throw new BoardError('link must be a string');
    return alertLine(await alertUser(session, line, link));
  },
  rest: async (session, args) => (await restOwn(session, stringArg(args, 'line'))).text,
  needs_you: async (session, { reason, via, clear }) => {
    if (clear === true) return flagLine(await flagOwn(session, undefined), true, 'mcp');
    if (typeof reason !== 'string') throw new BoardError('give a reason, or clear');
    if (via !== undefined && typeof via !== 'string') throw new BoardError('via must be a string');
    return flagLine(await flagOwn(session, reason, via), false, 'mcp');
  },
  set_status: async (session, { summary, progress, done, agent: crewMember, character: given, category: kind, label, waiting_on: waitingOn, description }) => {
    if (summary !== undefined && typeof summary !== 'string') throw new BoardError('summary must be a string');
    if (description !== undefined && typeof description !== 'string') throw new BoardError('description must be a string');
    if (progress !== undefined && typeof progress !== 'number') throw new BoardError('progress must be a number');
    let character: CharacterSet | undefined;
    try {
      character = given === undefined ? undefined : parseCharacter(given);
    } catch (error) {
      throw new BoardError((error as Error).message);
    }
    let category: WorkCategoryParams | undefined;
    try {
      category = parseWorkCategorySet({ category: kind, label, waitingOn }) === undefined ? undefined : ({ category: kind, label, waitingOn } as WorkCategoryParams);
    } catch (error) {
      throw new BoardError((error as Error).message.replace(/\bwaitingOn\b/g, 'waiting_on'));
    }
    if (crewMember !== undefined && typeof crewMember !== 'string') throw new BoardError('agent must be a ref or name');
    if (done !== undefined && typeof done !== 'boolean') throw new BoardError('done must be true or false');
    const answer = await setStatus(session, {
        ...(summary === undefined ? {} : { summary }),
        ...(progress === undefined ? {} : { progress }),
        ...(done === undefined ? {} : { done }),
        ...(character === undefined ? {} : { character }),
        ...(category === undefined ? {} : { category }),
        ...(description === undefined ? {} : { description }),
        ...(crewMember === undefined ? {} : { agent: crewMember }),
    });
    return answer.text;
  },
  new_agent: async (session, args) => {
    const prefab = stringArg(args, 'prefab', true);
    const chat = checkPrefabStart(
      prefab,
      stringArg(args, 'chat', true),
      PREFAB_SETS.find((key) => args[key] !== undefined),
    );
    if (prefab !== undefined) {
      return (
        await startPrefab(session, {
          name: prefab,
          prompt: stringArg(args, 'prompt'),
          zone: stringArg(args, 'zone', true),
          repo: stringArg(args, 'repo', true),
          issue: stringArg(args, 'issue', true),
          description: stringArg(args, 'description', true),
          agentName: stringArg(args, 'name', true),
          branch: stringArg(args, 'branch', true),
          ...(chat === undefined ? {} : { chat }),
        })
      ).text;
    }
    return (
      await newAgent(session, {
        prompt: stringArg(args, 'prompt'),
        name: stringArg(args, 'name', true),
        zone: stringArg(args, 'zone', true),
        harness: stringArg(args, 'harness', true),
        model: stringArg(args, 'model', true),
        effort: stringArg(args, 'effort', true),
        role: stringArg(args, 'role', true),
        noTemplate: args.template === false,
        repo: stringArg(args, 'repo', true),
        branch: stringArg(args, 'branch', true),
        base: stringArg(args, 'base', true),
        edges: edgesArg(args),
        issue: stringArg(args, 'issue', true),
        description: stringArg(args, 'description', true),
        launchSettings: launchSettingsArgs(args),
      })
    ).text;
  },
  send: async (session, args) => {
    const draft = args.submit === true ? { submit: true as const } : args.clear === true ? { clear: true as const } : undefined;
    if ((args.submit === true && args.clear === true) || (draft !== undefined && args.text !== undefined)) {
      throw new BoardError('give one of text, submit and clear');
    }
    return (await sendToAgent(session, stringArg(args, 'agent'), draft ?? { text: stringArg(args, 'text') })).text;
  },
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
    // As `agent-board wait crew:<id>`: a crew is waited on alone, until it stops.
    if (agents.some((ref) => (ref as string).startsWith('crew:'))) {
      if (agents.length !== 1 || crew === true || until !== undefined || any === true || since !== undefined || kinds !== undefined) {
        throw new BoardError('wait with a crew takes the one crew alone, with timeout_seconds: it waits until the crew stops');
      }
      const view = await waitForCrew(session, agents[0] as string, Math.min(timeoutMs, MAX_ORCHESTRATOR_WAIT_MS));
      return { content: [{ type: 'text', text: view.text }], structuredContent: { timedOut: view.timedOut } };
    }
    if (since === undefined) {
      const view = await waitForAgents(session, agents as string[], { until: until as WaitState[] | undefined, any: any === true, crew: wholeCrew, timeoutMs });
      return { content: [{ type: 'text', text: view.text }], structuredContent: { timedOut: view.timedOut } };
    }
    const news = await watchCrew(session, agents as string[], { crew: wholeCrew, since, kinds: kinds as CrewEventKind[] | undefined, timeoutMs });
    const text = [
      ...(news.missed ? ['Some were missed: the daemon keeps only the latest, or it restarted.'] : []),
      ...(news.timedOut ? ['Nothing yet.'] : news.lines),
      `Cursor ${news.cursor}: pass it as since next time to hear only what comes after.`,
    ].join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { timedOut: news.timedOut } };
  },
  read: async (session, args) => (await readAgent(session, stringArg(args, 'agent'), stringArg(args, 'path', true))).text,
  interrupt: async (session, args) => (await interruptAgent(session, stringArg(args, 'agent'))).text,
  pin_expanded: async (session, args) => (await pinAgentExpanded(session, stringArg(args, 'agent'), booleanArg(args, 'pinned') !== false)).text,
  rename: async (session, args) => {
    return (await renameAgent(session, stringArg(args, 'agent'), { name: stringArg(args, 'name', true), description: stringArg(args, 'description', true) })).text;
  },
  set_effort: async (session, args) => (await setAgentEffort(session, stringArg(args, 'agent'), stringArg(args, 'effort'))).text,
  ticket_watches: async (session, args) =>
    (
      await ticketWatches(session, stringArg(args, 'agent'), {
        ...(args.watches === undefined ? {} : { watches: args.watches as TicketWatchChange['watches'] }),
        ...(args.every_minutes === undefined ? {} : { everyMinutes: args.every_minutes as TicketWatchEvery }),
      })
    ).text,
  give_role: async (session, args) => {
    const role = stringArg(args, 'role', true);
    const clear = booleanArg(args, 'clear') === true;
    if ((role === undefined) === !clear) throw new BoardError('give a role, or clear: true, not both');
    const sendTemplate = booleanArg(args, 'send_template') === true;
    return (await giveAgentRole(session, stringArg(args, 'agent'), clear ? null : role!, sendTemplate)).text;
  },
  continue_on_credits: async (session, args) => (await continueAgent(session, stringArg(args, 'agent'))).text,
  restart: async (session, args) => {
    const prompt = stringArg(args, 'prompt', true);
    if (args.fresh !== true && prompt !== undefined && prompt.trim() !== '') throw new BoardError('prompt needs fresh');
    const anew = args.fresh === true ? { prompt: prompt === undefined || prompt.trim() === '' ? undefined : prompt } : undefined;
    return (await restartAgent(session, stringArg(args, 'agent'), anew, launchSettingsArgs(args))).text;
  },
  pause: async (session, args) => (await pauseAgent(session, stringArg(args, 'agent'))).text,
  wake: async (session, args) => (await wakeAgent(session, stringArg(args, 'agent'))).text,
  handover: async (session, args) => (await handOver(session, stringArg(args, 'from'), stringArg(args, 'to'))).text,
  close: async (session, args) => (await closeAgent(session, stringArg(args, 'agent'), args.remove === true)).text,
  ask_to_remove: async (session, { agents, timeout_minutes: minutes }) => {
    if (!Array.isArray(agents) || agents.length === 0 || !agents.every((ref) => typeof ref === 'string')) throw new BoardError('agents must be a list of agent refs');
    if (minutes !== undefined && (!Number.isInteger(minutes) || (minutes as number) < 1)) throw new BoardError('timeout_minutes must be a whole number of minutes');
    // Returns at once, so the client's own time limit on a call never ends it: the answer comes as a message.
    return (await askToRemove(session, agents as string[], minutes === undefined ? undefined : (minutes as number) * 60_000, true)).text;
  },
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
    const { options, free_text: freeText, on_board: onBoard, questions } = args;
    const strings = (value: unknown, name: string) => {
      if (value !== undefined && (!Array.isArray(value) || !value.every((option) => typeof option === 'string'))) throw new BoardError(`${name} must be a list of strings`);
      return value as string[] | undefined;
    };
    const flag = (value: unknown, name: string) => {
      if (value !== undefined && typeof value !== 'boolean') throw new BoardError(`${name} must be true or false`);
      return value as boolean | undefined;
    };
    flag(onBoard, 'on_board');
    if (questions !== undefined && !Array.isArray(questions)) throw new BoardError('questions must be a list of { question, options?, free_text? }');
    const asked =
      questions === undefined
        ? {
            question: stringArg(args, 'question'),
            ...(options === undefined ? {} : { options: strings(options, 'options') }),
            ...(freeText === undefined ? {} : { freeText: flag(freeText, 'free_text') }),
          }
        : {
            questions: questions.map((each: unknown, at) => {
              if (each === null || typeof each !== 'object') throw new BoardError(`question ${at + 1} must be { question, options?, free_text? }`);
              const q = each as Record<string, unknown>;
              return {
                question: stringArg(q, 'question'),
                ...(q.options === undefined ? {} : { options: strings(q.options, `question ${at + 1}'s options`) }),
                ...(q.free_text === undefined ? {} : { freeText: flag(q.free_text, `question ${at + 1}'s free_text`) }),
              };
            }),
          };
    if (questions !== undefined && (args.question !== undefined || options !== undefined || freeText !== undefined)) {
      throw new BoardError('give question (with options and free_text) or questions (each with its own), not both');
    }
    return (await askUser(session, { ...asked, ...(onBoard === undefined ? {} : { onBoard: onBoard as boolean }), ...timeoutArg(args) })).text;
  },
  show_doc: async (session, args, cwd) => {
    const path = stringArg(args, 'path');
    const title = stringArg(args, 'title', true);
    if (args.on_board !== undefined && typeof args.on_board !== 'boolean') throw new BoardError('on_board must be true or false');
    if (args.plan === true) {
      const source = readPlanSource({ path }, cwd);
      return (await presentPlan(session, { title: title ?? documentTitle(path, source.format, source.body), ...source, ...onBoardArg(args), ...timeoutArg(args) })).text;
    }
    if (args.timeout_minutes !== undefined) throw new BoardError('timeout_minutes is for a plan: give plan too');
    return (await showDoc(session, { path, title, onBoard: args.on_board === true }, cwd)).text;
  },
  list_edges: async (session) => edgesView(new BoardRefs(await readBoard(session.client))).text,
  remove_edge: async (session, args) => (await removeEdge(session, stringArg(args, 'edge'))).text,
  move: async (session, args) => (await moveTile(session, stringArg(args, 'tile'), placeArgs(args))).text,
  arrange: async (session, args) =>
    (
      await arrangeZone(session, stringArg(args, 'zone', true), {
        by: stringArg(args, 'by', true),
        layout: stringArg(args, 'layout', true),
        ...autoArg(args),
        ...placementsArg(args),
        ...flagArg(args, 'once'),
        ...flagArg(args, 'all'),
      })
    ).text,
  zone_screenshot: async (session, args) => {
    const { shot, caption } = await zoneScreenshot(session, stringArg(args, 'zone', true), givenStrings(args, ['style']));
    return [
      { type: 'image', data: shot.png, mimeType: 'image/png' },
      { type: 'text', text: caption },
    ];
  },
  zone_layout: async (session, args) => (await setZoneLayout(session, stringArg(args, 'layout'), stringArg(args, 'zone', true))).text,
  map: async (session, args) => (await zoneMap(session, stringArg(args, 'zone', true), { boxes: args.boxes === true, sections: args.sections === true, face: 'mcp' })).text,
  add_note: async (session, args) =>
    (
      await addNote(session, {
        text: stringArg(args, 'text'),
        kind: stringArg(args, 'kind', true),
        color: stringArg(args, 'color', true),
        ...linesArgOf(args),
        ...placeArgs(args),
      })
    ).text,
  edit_note: async (session, args) => {
    const text = stringArg(args, 'text', true);
    const color = stringArg(args, 'color', true);
    const size = stringArg(args, 'size', true);
    const lines = linesArgOf(args);
    if (text === undefined && color === undefined && size === undefined && lines.lines === undefined) throw new BoardError('give the text, the color, the size or the lines');
    return (await editNote(session, stringArg(args, 'note'), { text, color, size, ...lines })).text;
  },
  remove_note: async (session, args) => (await removeNote(session, stringArg(args, 'note'))).text,
  delete_item: async (session, args) => {
    const minutes = args.timeout_minutes;
    if (minutes !== undefined && (!Number.isInteger(minutes) || (minutes as number) < 1)) throw new BoardError('timeout_minutes must be a whole number of minutes');
    if (minutes !== undefined && args.ask !== true) throw new BoardError('timeout_minutes is for ask: it says how long to wait for the user');
    return (await deleteItem(session, stringArg(args, 'item'), { force: args.force === true, ask: args.ask === true, ...(minutes === undefined ? {} : { timeoutMs: (minutes as number) * 60_000 }) })).text;
  },
  pass_note: async (session, args) => (await passNote(session, stringArg(args, 'note'), stringArg(args, 'to'))).text,
  add_shape: async (session, args) => (await addShape(session, { ...shapeArgs(args), shape: stringArg(args, 'shape'), ...placeArgs(args) })).text,
  add_diagram: async (session, args) => (await addDiagram(session, stringArg(args, 'mermaid'), placeArgs(args))).text,
  export_diagram: async (session, args) => (await exportDiagram(session, linesArg(args, 'refs') ?? [])).text,
  edit_shape: async (session, args) => (await editShape(session, stringArg(args, 'item'), shapeArgs(args))).text,
  remove_shape: async (session, args) => (await removeShape(session, stringArg(args, 'item'))).text,
  connect: async (session, args) => (await connectItems(session, stringArg(args, 'from'), stringArg(args, 'to'), connectorArgs(args))).text,
  edit_connector: async (session, args) => (await editConnector(session, stringArg(args, 'connector'), connectorArgs(args))).text,
  remove_connector: async (session, args) => (await removeConnector(session, stringArg(args, 'connector'))).text,
  add_schedule: async (session, args) =>
    (
      await addSchedule(session, {
        cron: stringArg(args, 'cron', true) ?? '',
        prompt: stringArg(args, 'prompt', true) ?? '',
        template: stringArg(args, 'template', true),
        to: stringArg(args, 'to', true),
        fresh: args.fresh === true ? true : undefined,
        zone: stringArg(args, 'zone', true),
        harness: stringArg(args, 'harness', true),
        model: stringArg(args, 'model', true),
        role: stringArg(args, 'role', true),
        keep: args.keep === true ? true : undefined,
        result: stringArg(args, 'result', true),
        handoffTo: stringArg(args, 'handoff_to', true),
      })
    ).text,
  list_schedules: async (session, { full }) => (await listSchedules(session, full === true)).text,
  save_clock_template: async (session, args) =>
    (
      await saveTemplate(session, {
        name: stringArg(args, 'name'),
        from: stringArg(args, 'from', true),
        cron: stringArg(args, 'cron', true) ?? '',
        prompt: stringArg(args, 'prompt', true) ?? '',
        after: stringArg(args, 'after', true),
        harness: stringArg(args, 'harness', true),
        model: stringArg(args, 'model', true),
        role: stringArg(args, 'role', true),
        keep: args.keep === true ? true : undefined,
        result: stringArg(args, 'result', true),
      })
    ).text,
  list_clock_templates: async (session) => (await listTemplates(session)).text,
  remove_clock_template: async (session, args) => (await removeTemplate(session, stringArg(args, 'template'))).text,
  clock_add: async (session, args) =>
    (
      await addSchedule(session, {
        cron: stringArg(args, 'cron', true) ?? '',
        prompt: stringArg(args, 'prompt', true) ?? '',
        template: stringArg(args, 'template', true),
        self: true,
        after: stringArg(args, 'after', true),
      })
    ).text,
  clock_set: async (session, args) => {
    if (args.stop !== undefined && typeof args.stop !== 'boolean') throw new BoardError('stop must be true or false');
    const after = stringArg(args, 'after', true);
    if ((after === undefined) === (args.stop !== true)) throw new BoardError('give after, or stop: true');
    return (await setOwnSchedule(session, { ref: stringArg(args, 'schedule', true), after, stop: args.stop === true ? true : undefined, why: stringArg(args, 'why') })).text;
  },
  steps_new: async (session, args) => (await newSteps(session, { title: stringArg(args, 'title', true), text: stringArg(args, 'steps') })).text,
  steps_read: async (session, args) => {
    const card = stringArg(args, 'card', true);
    if (args.mine !== undefined && typeof args.mine !== 'boolean') throw new BoardError('mine must be true or false');
    if (card === undefined) return (await listSteps(session, { mine: args.mine === true })).text;
    if (args.mine !== undefined) throw new BoardError('mine is for listing: leave out card');
    return (await readStepsCard(session, card)).text;
  },
  steps_update: async (session, args) => (await updateSteps(session, stringArg(args, 'card'), stepsUpdateArg(args))).text,
  queue_new: async (session, args) => {
    if (args.for_user !== undefined && typeof args.for_user !== 'boolean') throw new BoardError('for_user must be true or false');
    return (await newQueue(session, stringArg(args, 'title'), args.for_user === true)).text;
  },
  queue_read: async (session, args) => {
    const queue = stringArg(args, 'queue', true);
    const job = stringArg(args, 'job', true);
    for (const flag of ['whole', 'done']) {
      if (args[flag] !== undefined && typeof args[flag] !== 'boolean') throw new BoardError(flag + ' must be true or false');
    }
    if (queue === undefined) {
      if (job !== undefined || args.done === true || args.whole === true) throw new BoardError('give `queue`: job, done and whole read one queue');
      return (await listQueues(session)).text;
    }
    if (args.done === true) {
      if (job !== undefined || args.whole === true) throw new BoardError('give a job or done, not both');
      return (await readQueue(session, queue, { done: true })).text;
    }
    if (job === undefined) {
      if (args.whole === true) throw new BoardError('whole goes with a job: its #id');
      return (await readQueue(session, queue)).text;
    }
    return args.whole === true ? (await readQueue(session, queue, { job })).text : (await queueHistory(session, queue, job)).text;
  },
  queue_update: async (session, args) => (await updateQueue(session, stringArg(args, 'queue'), queueUpdateArg(args))).text,
  remind: async (session, args) => (await remind(session, [stringArg(args, 'text')])).text,
  remind_read: async (session, args) => {
    if (args.mine !== undefined && typeof args.mine !== 'boolean') throw new BoardError('mine must be true or false');
    return (await readTodos(session, args.mine === true)).text;
  },
  remind_update: async (session, args) => {
    const action = stringArg(args, 'action');
    if (action !== 'done' && action !== 'undo' && action !== 'remove') throw new BoardError('action must be done, undo or remove');
    if (typeof args.line !== 'number' || !Number.isInteger(args.line)) throw new BoardError("line must be the line's number");
    return (await changeTodo(session, action === 'remove' ? 'rm' : action, args.line)).text;
  },
  remove_schedule: async (session, args) => (await removeSchedule(session, stringArg(args, 'schedule'))).text,
  prefab_draft: async (session, args) => {
    const file = stringArg(args, 'file');
    if (!isAbsolute(file)) throw new BoardError('file must be an absolute path');
    return (await draftPrefab(session, file, linesArg(args, 'assumed') ?? [])).text;
  },
  prefabs: async (session, args) => {
    const name = stringArg(args, 'name', true);
    return (name === undefined ? await prefabsView(session) : await prefabView(session, name)).text;
  },
  roles: async (session) => (await defaultRolesView(session)).text,
  set_role: async (session, args) =>
    (await setDefaultRole(session, stringArg(args, 'name'), stringArg(args, 'template'), stringArg(args, 'zone', true))).text,
  remove_role: async (session, args) => (await removeDefaultRole(session, stringArg(args, 'name'), stringArg(args, 'zone', true))).text,
};

/** A layout tool's place, as `agent-board move` takes it. */
/** A shape's section as a model may send it: a line each, or one string of lines. */
function linesArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.split('\n');
  if (!Array.isArray(value) || !value.every((line) => typeof line === 'string')) throw new BoardError(`${name} must be an array of strings, a line each`);
  return value as string[];
}

function shapeArgs(args: Record<string, unknown>): ShapeOptions {
  return {
    shape: stringArg(args, 'shape', true),
    text: stringArg(args, 'text', true),
    attributes: linesArg(args, 'attributes'),
    methods: linesArg(args, 'methods'),
    fill: stringArg(args, 'fill', true),
  };
}

function connectorArgs(args: Record<string, unknown>): ConnectorOptions {
  return {
    relation: stringArg(args, 'relation', true),
    style: stringArg(args, 'style', true),
    label: stringArg(args, 'label', true),
    fromLabel: stringArg(args, 'from_label', true),
    toLabel: stringArg(args, 'to_label', true),
  };
}

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
): Promise<ToolAnswer> {
  const session: BoardSession = { ...(await context.openSession()), face: 'mcp' };
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
      const orchestrating = (await whoIs(context))?.orchestrates === true;
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
      tools: (await whoIs(context))?.orchestrates === true ? [...BOARD_MCP_TOOLS, ...ORCHESTRATOR_MCP_TOOLS] : BOARD_MCP_TOOLS,
    }),
    'tools/call': async (params, { signal }) => {
      const { name, arguments: args = {} } = (params ?? {}) as McpMethods['tools/call']['params'];
      const call = typeof name === 'string' && Object.hasOwn(TOOL_CALLS, name) ? TOOL_CALLS[name]! : undefined;
      if (call === undefined) throw new RpcMethodError(RPC_ERROR.invalidParams, `no tool ${String(name)}`);
      // A misspelt or unsupported argument is refused, not ignored: the model reads which ones the tool takes.
      const refusal = argumentRefusal(name!, args);
      if (refusal !== undefined) return { content: [{ type: 'text', text: refusal }], isError: true };
      try {
        const answer = await callTool(call, args, context, signal);
        if (typeof answer === 'string') return { content: [{ type: 'text', text: answer }] };
        return Array.isArray(answer) ? { content: answer } : answer;
      } catch (error) {
        // A refusal is the tool's answer, for the model to read; anything else is the server's failure.
        if (error instanceof BoardError || error instanceof DaemonRpcError) {
          return { content: [{ type: 'text', text: BoardError.text(error, 'mcp') }], isError: true };
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
