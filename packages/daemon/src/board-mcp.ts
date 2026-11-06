// The board as an MCP server (ADR-0010): a few tools over the same board-ops the CLI uses, and instructions that say
// once where the agent is and to read `agent-board --help` for the rest. One set of handlers, two transports: stdio
// here (`agent-board mcp`), and Streamable HTTP in the daemon (`board-mcp-http.ts`).
import { addSchedule, listSchedules, removeSchedule } from './clock-ops.ts';
import { listSteps, newSteps, readStepsCard, updateSteps, type StepsUpdate } from './steps-ops.ts';
import { listMemories, listQueues, memoryHistory, newMemory, newQueue, queueHistory, readMemory, readQueue, updateMemory, updateQueue, type MemoryUpdate, type QueueUpdate } from './memory-ops.ts';
import {
  addEdge,
  BoardError,
  askUser,
  BoardRefs,
  closeAgent,
  pauseAgent,
  wakeAgent,
  defaultRolesView,
  prefabsView,
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
  continueAgent,
  restartAgent,
  newAgent,
  openBoardSession,
  readAgent,
  readBoard,
  sendToAgent,
  setDefaultRole,
  setCrewStatus,
  setOwnStatus,
  flagLine,
  flagOwn,
  openOwnPullRequest,
  recordEntry,
  pinEntry,
  setOwnPage,
  unpinEntry,
  treeView,
  waitForAgents,
  watchCrew,
  type BoardSession,
} from './board-ops.ts';
import { DaemonRpcError } from './client.ts';
import { documentTitle } from './document-names.ts';
import {
  addDiagram,
  addNote,
  addShape,
  arrangeZone,
  setZoneLayout,
  connectItems,
  editConnector,
  editNote,
  editShape,
  exportDiagram,
  moveTile,
  removeConnector,
  removeNote,
  removeShape,
  zoneMap,
  zoneScreenshot,
  type ConnectorOptions,
  type PlaceOptions,
  type ShapeOptions,
} from './layout-ops.ts';
import {
  MAX_FIGURE_VALUE,
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
  CAPTURE_STYLES,
  CREW_EVENT_KINDS,
  ARRANGE_LAYOUTS,
  ZONE_LAYOUT_MODES,
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
  MAX_ASK_WAIT_MS,
  MAX_OPTION_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_STEPS,
  MAX_STEPS_QUESTIONS,
  MAX_ROLE_NAME_LENGTH,
  MAX_QUESTION_LENGTH,
  FLOW_CONDITION_KINDS,
  FLOW_EDGE_TRIGGERS,
  DEFAULT_ORCHESTRATOR_WAIT_MS,
  CLOCK_RESULTS,
  EFFORTS,
  HARNESSES,
  isCrewSince,
  isWaitState,
  lineSplitter,
  MAX_FLAG_LENGTH,
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
  'board and its commands; these tools are the few you need most. A turn ending tells no one: when you are blocked, ' +
  'your work is ready for review, or you need a decision, call `needs_you` with the reason in a line.';

/** What the server adds to its instructions for an agent that may orchestrate as it starts. */
export const ORCHESTRATOR_INSTRUCTIONS =
  'The user lets you orchestrate: you may start, message, watch and close other agents, join them with edges, and keep ' +
  'your zone tidy (move tiles, arrange your crew, notes), with the tools below or the same commands in ' +
  '`agent-board help orchestrate`. A reviewer started from an agent\'s branch gets no edge to that agent: it and its implementer talk through `send` (findings back, next round), and the user presses no Send ' +
  'button. Ask for a line between them only with `new` `edges` (`auto` hands the findings back by itself, the way ' +
  'back manual; `manual` leaves both for the user), never an edge to your own tile, and keep one of a pair manual, ' +
  'as two auto edges in a loop re-trigger each other. Keep your crew\'s tile lines current ' +
  'with `set_status` and `agent`: what each agent is doing now, as its work moves on. A crew member\'s `needs_you` comes ' +
  'to you, typed at your prompt, and so do its `ask` questions and plans (`show_doc` with `plan`, written in its ' +
  'worktree, for `read`): answer it with `send`, which clears its flag, or pass it on to the user with `needs_you` ' +
  'and `via`. Only its permission prompts reach the user directly.';

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
    description:
      "Every zone with its tiles (agents and shells, with state and status), items (a shape's text and sections) and " +
      'connectors (their ends, relation and labels). As `agent-board tree`.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'usage',
    description:
      "The plan's 5-hour and weekly usage (used, left, when each resets, when it was read, and whether it is stale), " +
      "read from Claude agents' status lines, so no tokens are spent. As `agent-board usage`.",
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
    name: 'present_plan',
    description:
      'Kept for agents that already call it: write your plan to a file and use show_doc with plan instead. Shows the ' +
      'user your plan before you carry it out, and waits for their decision, as show_doc with plan does. Give it as ' +
      'Markdown, as HTML (shown sandboxed, offline: no network, no navigation), or as the path of a .md or .html ' +
      `file. Waits ${DEFAULT_PLAN_WAIT_MS / 60_000} minutes by default.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What the plan is for, in a line.' },
        markdown: { type: 'string', description: 'The plan as Markdown.' },
        html: { type: 'string', description: 'The plan as a self-contained HTML page.' },
        path: { type: 'string', description: 'A .md or .html file holding the plan, relative to your working directory.' },
        on_board: { type: 'boolean', description: 'Also put its plan card on the board, beside your tile.' },
        timeout_minutes: { type: 'integer', minimum: 1, maximum: MAX_ASK_WAIT_MS / 60_000, description: 'How long to wait.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_doc',
    description:
      'Show the user a longer Markdown (.md) or HTML (.html) file of yours as a document, nicer to read than your ' +
      'terminal: a Document tab in your window, and with on_board a card beside your tile too. Returns at once. It stays ' +
      'live: write the file again and they see the new version. They may edit a Markdown document there: their edit is ' +
      'written to the file, and you are told what changed at your prompt. An HTML document is view-only, sandboxed and ' +
      'offline. With plan, it is your plan, for them to decide on before you carry it out, and waits for their ' +
      'decision: it waits in their Needs you inbox (and, with on_board, on a plan card beside your tile), kept as v1, ' +
      'v2… in your history; they approve it, ask for changes (with comments) or reject it. They may edit a Markdown ' +
      'plan before deciding: you are then told what they changed, and an approved edit is written to the file. ' +
      `Waits ${DEFAULT_PLAN_WAIT_MS / 60_000} minutes by default. After changes are asked for, write the revised plan ` +
      'and show it again. If an orchestrator started you, the plan goes to it instead, written in your worktree, and ' +
      'nothing waits: end your turn, and its answer comes as your next message.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, relative to your working directory.' },
        title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What it is, in a line; else its first heading.' },
        on_board: { type: 'boolean', description: 'Also put it on the board, as a card beside your tile (a plan card, with plan).' },
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
      'understand the work, and again when its direction changes. With done, your work is finished, not only this ' +
      'turn: the agent that started you hears it once. As an orchestrator, pass agent to set the line of an agent in your ' +
      'crew instead (its tile says you set it); keep your crew\'s lines current. As `agent-board status set`.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', maxLength: MAX_STATUS_LENGTH, description: 'What you are doing now, in a line.' },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: 'How far through you are, if you know.' },
        done: { type: 'boolean', description: 'Your work is finished (handoff says so too). Your next prompt clears it.' },
        agent: { type: 'string', description: 'An agent in your crew to set the line of, by ref or unique name; yours without. Not with done.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'needs_you',
    description:
      'Ask for a look, without a question: when you are blocked, your work is ready for review, or you need a decision. ' +
      'It lists you in the user\'s Needs you with your reason (or, if an orchestrator started you, tells that one), and ' +
      'nothing waits. A turn ending alone tells no one. Opening your session clears it; so does clear. As ' +
      '`agent-board needs-you`.',
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
    name: 'open_pr',
    description:
      'Open a pull request of your branch, always as a draft, filled from .agent-board/handover.md. Commit first; in a ' +
      'zone with a gate, the gate must have passed on that commit. Marking it ready and merging stay the user\'s. As ' +
      '`agent-board open-pr`.',
    inputSchema: NO_INPUT,
  },
  {
    name: 'record_pr',
    description:
      'Put a pull request you opened on your sidebar\'s PR section, as soon as you open it: any branch\'s, not only ' +
      'yours (open_pr records its own). What you record wins over what the board guesses from gh. As `agent-board record pr`.',
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
      'saying you wrote it: do that for what your orchestrator should read. As `agent-board record doc`.',
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
      'Pin something you want the user to see on your sidebar, as a Pinned block of your page or in the Full sidebar\'s Pins: a file (a Markdown or HTML one opens in a Doc tab, ' +
      'any other is shown in its folder), an http(s) link (opens in a web tab), or a short note with a label. Give one of ' +
      'path, url or note. Pinning the same file, link or note label again replaces it; the user may delete a pin, not ' +
      'edit it. With for_orchestrator, it goes on the orchestrator that started you instead. As `agent-board pin`.',
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
    description: 'Take a pin off your sidebar (or with for_orchestrator, off your orchestrator\'s): a file by its path, a link by its URL, or a note by its label. As `agent-board unpin`.',
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
      'Put a steps card beside your tile: an ordered list of questions for the user to step through and to-dos, each ' +
      'ticked by whoever it names. For more than one question, or a list of things to get done in order; one quick ' +
      'question is `ask`. Returns at once: nothing waits. End your turn. Once the user has answered and pressed Send, ' +
      'the answers are typed at your prompt, led by [agent-board] (later, only what they changed). If an orchestrator ' +
      'started you, it answers instead. Naming an agent on a to-do sends it nothing. One step a line: `- [ ] text ' +
      '@who -> link` a to-do (@user for the user; you, without one; [x] done), `? text [a | b]` pick one, ' +
      '`? text [any: a | b]` pick any, `? text [yes/no]`, `? text [order: a | b]` put in order, `? text` in words; ' +
      '`(required)` on a step it can\'t be sent without; `## heading` starts a section; `# title` names it. ' +
      '` -> ` in a to-do starts its link, and a choice can\'t hold `|` or `]`. At most ' +
      `${MAX_STEPS} steps and ${MAX_STEPS_QUESTIONS} questions. As \`agent-board steps new\`.`,
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
      '(in your zone, in zones your orchestrator scope reaches, loose ones, and any you are part of), with mine only ' +
      'those with a to-do of yours not yet done. As `agent-board steps read` and `steps ls`.',
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
      'with a card you made. As `agent-board steps done|wait|add|answer|close`.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', description: 'The card, by ref (item:3f2a).' },
        action: { type: 'string', enum: ['done', 'wait', 'add', 'answer', 'close'], description: 'What to do.' },
        step: { type: 'integer', minimum: 1, description: 'For done, wait and answer: the step, by its number.' },
        steps: { type: 'string', description: 'For add: the steps, one a line.' },
        answer: { type: 'string', description: 'For answer: a choice by its number or text, several split by commas, yes or no, or words.' },
        undo: { type: 'boolean', description: 'For done: untick it instead.' },
        send: { type: 'boolean', description: 'For answer: send the answers once this one is in (step and answer may be left out).' },
      },
      required: ['card', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_new',
    description: 'Put a new memory beside your tile: shared context that agents in its scope and the user read and write. As `agent-board memory new`.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: MAX_PLAN_TITLE_LENGTH, description: 'What it remembers, in a line.' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_read',
    description:
      'Without memory, list the memories you can read (in your zone, zones your orchestrator scope reaches, and loose ones). ' +
      'With memory, its entries, pinned first, then newest first (search: only those holding it); with entry, that one in full ' +
      '(a file whole), or with history its versions, newest first. As `agent-board memory ls|read|history`.',
    inputSchema: {
      type: 'object',
      properties: {
        memory: { type: 'string', description: 'The memory, by ref (item:3f2a) or title.' },
        entry: { type: 'string', description: 'An entry, by its key or #id.' },
        search: { type: 'string', description: 'Only entries whose key or text holds this (any case).' },
        history: { type: 'boolean', description: "With entry: its versions, every change anyone made, to put one back with memory_update's restore." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_update',
    description:
      'Change a memory: add remembers text ("key: value" with a one-word key replaces that key\'s value; else a note) or, ' +
      'with file, a whole file (up to 1 MB) under its name; edit changes an entry\'s text, key or pin; remove removes one; ' +
      'restore puts a version back (memory_read with history lists them). Anyone in scope may change any entry, the ' +
      "user's too. As `agent-board memory add|edit|rm|restore`.",
    inputSchema: {
      type: 'object',
      properties: {
        memory: { type: 'string', description: 'The memory, by ref (item:3f2a) or title.' },
        action: { type: 'string', enum: ['add', 'edit', 'remove', 'restore'], description: 'What to do.' },
        entry: { type: 'string', description: 'For edit, remove and restore: the entry, by its key or #id.' },
        text: { type: 'string', description: 'For add and edit: the text.' },
        key: { type: 'string', description: 'For add and edit: the key to keep it under (spaces and all).' },
        no_key: { type: 'boolean', description: 'For add: keep the text as a note, "a: b" and all; for edit, take its key off.' },
        file: { type: 'string', description: 'For add: a file to keep whole, by path (relative to where you started).' },
        pinned: { type: 'boolean', description: 'For edit: pin it to the top rows, or unpin it.' },
        version: { type: 'integer', minimum: 1, description: 'For restore: the version to put back.' },
      },
      required: ['memory', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'queue_new',
    description: 'Put a new queue beside your tile: jobs for agents in its scope to take one at a time, and notes; with for_user, a queue of things for the user to look at, which no agent takes from. As `agent-board queue new`.',
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
    description: 'Without queue, list the queues you can read; with queue, its jobs and notes in order, then those done; with job, that job\'s versions, newest first. As `agent-board queue ls|read|history`.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'The queue, by ref (item:3f2a) or title.' },
        job: { type: 'string', description: "A job's #id (its start will do): its history." },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'queue_update',
    description:
      'Change a queue: add queues jobs, one a line (" -> link" at its end; front puts them at the front; kind note adds ' +
      'notes); take takes the next job, or job: it is yours until done or drop, and goes back to the front if your session ' +
      'ends first; drop puts a job you took back at the front, counted; done finishes it; edit, remove and restore (a ' +
      'version from queue_read) change a job or note; move puts one before another open job (to: its #id), at the top or last. ' +
      'drain (on a queue you made) has the board start fresh agents for its waiting jobs. ' +
      'As `agent-board queue add|take|drop|done|edit|move|rm|restore|drain`.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: { type: 'string', description: 'The queue, by ref (item:3f2a) or title.' },
        action: { type: 'string', enum: ['add', 'take', 'drop', 'done', 'edit', 'move', 'remove', 'restore', 'drain'], description: 'What to do.' },
        job: { type: 'string', description: "The job or note, by #id (its start will do). For take, leave it out for the next one." },
        text: { type: 'string', description: 'For add: the jobs, one a line; for edit, the new text.' },
        kind: { type: 'string', enum: ['job', 'note'], description: 'For add: jobs (the default) or notes.' },
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
    name: 'set_page',
    description:
      'Write your page: the shelf your sidebar opens on, which is yours to fill. Name its tab, pick its icon, and give ' +
      'it blocks: a heading with your progress, key figures, a checklist, a callout, links, a note. Each block may have ' +
      'a title, an icon and a tone. Writing it again replaces the whole page, so send every block each time; keep it ' +
      'current as your work moves on. With clear, the sidebar shows the board\'s Now instead. As `agent-board page`.',
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
              icon: { type: 'string', enum: [...PAGE_ICONS] },
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
                    icon: { type: 'string', enum: [...PAGE_ICONS] },
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
];

const AGENT_REF = { type: 'string', description: 'The agent, by ref (agent:9c1e) or unique name.' };

/** Where the layout tools put something, as `agent-board move` takes it. */
const PLACE_PROPERTIES = {
  to: { type: 'string', description: 'The zone or group to put it in, by ref; `board` for loose on the board. Its own zone without.' },
  at: { type: 'string', description: 'x,y relative to the zone, such as 40,120.' },
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
            "false starts it without its role's template: its first message is exactly your prompt (and the issue). For when you write the whole prompt. The result says which template was applied. As --no-template.",
        },
        repo: {
          type: 'string',
          description:
            "In a group (a zone with no repo), the absolute path of the repo, or a folder in one, to cut its worktree from: the group's default repo without, else the group's own folder, outside git. Refused in a zone bound to a repo.",
        },
        branch: { type: 'string', description: 'Its new branch; made from its name by default. Not for a reviewer.' },
        base: { type: 'string', description: "The branch to cut it from (a reviewer's to review), or an agent ref for that agent's branch (and, in a group, its repo, unless repo names one)." },
        edges: {
          type: 'string',
          enum: ['auto', 'manual'],
          description:
            "Join a reviewer started on an agent's branch to that agent. None without: they talk through send. auto hands the reviewer's findings back by itself (the way back is manual); manual leaves both for the user to send.",
        },
        issue: { type: 'string', description: "An issue in the zone's tracker, which comes first in its prompt." },
        prefab: {
          type: 'string',
          description:
            'Start a crew from this crew prefab (as `agent-board prefab ls` lists them) in place of one agent: its member ' +
            'that starts on the prompt, its builder or its lead, gets the prompt, started as the prefab says. Its reviewers ' +
            'start on the builder\'s branch each time the builder hands off, and their reviews go back to it, until each approves ' +
            'or the round limit (`agent-board crew`); a lead starts its own crew. Takes zone, repo and issue; the prefab sets the rest.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    description:
      "Send an agent its next message, once its turn has ended (wait first). Never to one that needs the user's " +
      "permission, and never a harness command. To one still starting it is queued until it's up, after its first " +
      'prompt; to an orchestrator mid-turn, until its turn ends, then sent as a turn of its own. You may also reply to an agent that messaged you, even outside your scope, and message the Captain whatever your scope. It fails, saying why, when ' +
      'the message was typed at its prompt but no turn started on it: then submit presses Enter on what is typed ' +
      'there, or clear clears it, instead of text (for an agent you may steer). The agent reads your message headed with your ' +
      'sender mark, so it and its chat know it is yours, not the user\'s: `⟨send from <your name> · <your ref>⟩ <text>` ' +
      '(reply when it answers its message, flag or question); the result says how it starts. As `agent-board send`.',
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
      `is. A turn you started counts only once it began, so call it straight after new_agent or send. until finished ` +
      `waits until it says its work is finished (it handed off, or set its status done), which a turn ending while its ` +
      `background work runs is not. With no agents, it waits on your crew (the agents you started, and theirs). With ` +
      `since, it waits instead for what happens to them next, each once: ${CREW_EVENT_KINDS.join(', ')}; it answers ` +
      `with each as a line (at most 100) and a cursor to pass as since next time: "now" the first time. Gives up ` +
      `after ${MCP_WAIT_SECONDS} s by default, saying so (the result's timedOut is true): then call it again. As \`agent-board wait\` and ` +
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
        timeout_seconds: { type: 'integer', minimum: 0, description: `How long to wait; ${MCP_WAIT_SECONDS} by default. The result's timedOut says whether it gave up.` },
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
    name: 'set_effort',
    description:
      "Change an agent's reasoning effort, as its tile's Reasoning menu does. A Claude agent takes it at once if it is at its " +
      'prompt, or when its turn ends if it is mid-turn (never typed into a turn); a Codex agent (no max) takes it when next ' +
      'started. The reply says which. As `agent-board effort`.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_REF, effort: { type: 'string', enum: [...EFFORTS], description: 'The new level.' } },
      required: ['agent', 'effort'],
      additionalProperties: false,
    },
  },
  {
    name: 'continue_on_credits',
    description:
      'Continue on credits: resume the turn of a Claude agent its usage limit stopped (rate-limited), for its usage ' +
      "credits to pay for, by the step Claude Code offers for it; never a billing page. Only while it is rate-limited. " +
      'Returns once its turn starts. If the limit stops it again at once, its usage credits are spent too: tell the user. ' +
      'As `agent-board continue`.',
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
    name: 'pause',
    description:
      "Pause an idle agent to free the memory its harness holds: its session ends, keeping its tile, worktree, branch " +
      'and conversation, and its tile shows it hibernated. Only an agent between turns that waits on no one. `wake`, ' +
      'a message (send) or a hand-off wakes it, carrying on its conversation. As `agent-board pause`.',
    inputSchema: { type: 'object', properties: { agent: AGENT_REF }, required: ['agent'], additionalProperties: false },
  },
  {
    name: 'wake',
    description: 'Wake a paused agent, carrying on its conversation. As `agent-board wake`.',
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
      "Lay out your zone's tiles that you may move, on its grid: you, the shells and the clocks you or your crew made first " +
      "(the user's clocks stay put), then a lane per issue or branch " +
      'ticket (its label; its implementer, reviewer and follow-up reviewer, each slot a column lining up down the lanes, a ' +
      'rail apart where an edge joins them; then a note you sign saying what each agent is doing), or a row per role or ' +
      'state. Arranging again moves the notes with their lanes, keeping any edited text, and fits the zone to what it ' +
      'holds. It answers with the zone\'s map (see map). by, layout and auto are kept as your settings for the next ' +
      'arrange. As `agent-board arrange`.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: {
          type: 'string',
          description:
            "The zone, by ref; yours by default. `board`, at board scope: the whole board's zones in rows a gap apart and its loose agents and shells below them, never what is in a zone (no by, layout or auto).",
        },
        by: { type: 'string', enum: [...ARRANGE_BYS], description: 'What a row holds: issue at first, then as you last asked.' },
        layout: {
          type: 'string',
          enum: [...ARRANGE_LAYOUTS],
          description:
            'A row per group (rows, at first: by issue, lanes with a column per slot), a column per group (columns), a card per lane two or three across (cards), filling the zone (grid) with the tiles no edge joins, units joined by edges laid out as rows, or by issue each lane below the one before, its label and note in its first column and its tiles wrapping onto a new row after four (wrap; by role or state, as rows), each lane as wrap lays it out in the shortest of as many columns as fit the window (masonry), or each lane a block sized by its tiles in a treemap of the window\'s shape, 16:10 with none (treemap); masonry and treemap pack each role\'s or state\'s row as a lane.',
        },
        auto: { type: 'boolean', description: 'Arrange by itself after every agent you start, note you add and agent you close (true), or stop (false). Off at first.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'zone_layout',
    description:
      'Set how your zone (or one in your scope) draws what it holds, as its Layout menu does in the app: free, each tile ' +
      'where it was put (every zone starts free); shelves, one stack per ticket on To do, Doing, Waiting and Done shelves ' +
      "under a head row of the zone's leads and shells, a click on a stack fanning its tiles out below the shelves; clusters, " +
      "each ticket's tiles drawn together, what needs the user first. Moves no tile's own place, so free again shows the " +
      'zone as it was. A zone is never laid out so by itself: choose shelves when its work is easier to follow by status, ' +
      'clusters when by ticket. As ' +
      '`agent-board zone layout`.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: [...ZONE_LAYOUT_MODES], description: 'free, shelves or clusters.' },
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
      'widest gap in a lane, the space between lanes, a label far from its tiles, a zone mostly empty, and tiles not where an arrange would put them or out of their lane. Moves nothing. As `agent-board zone map`.',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', description: 'The zone, by ref; yours by default.' },
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
      'app open; never moves the user\'s view. As `agent-board zone screenshot`.',
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
      'aside: an agent note (a card with your badge and the time, never a sticky) by default, or a signed sticky or text with kind. Near an agent with no ' +
      "side, it is added to its cluster's note, else goes in the slot before it. As `agent-board note add`.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: [...NOTE_KINDS], description: 'Left out, an agent note from you; sticky makes a signed sticky; or text.' },
        color: { type: 'string', description: 'Text only (an agent note has none, and ignores one): yellow, orange, pink, violet, blue, green, grey or white (text: accent, ink, grey, red, orange, yellow, green, teal, cyan, blue, violet or pink, which follow the theme), or #rrggbb.' },
        ...PLACE_PROPERTIES,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_note',
    description:
      'Change the text (or text item\'s colour, or an agent note\'s size) of a note you, or an agent you started, made. As `agent-board note edit`.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The note, by ref (item:31f0).' },
        text: { type: 'string' },
        color: { type: 'string' },
        size: { type: 'string', description: 'An agent note\'s size, <width>x<height> such as 360x240 (200x96 to 1200x1440). An arrange keeps it, and text that does not fit scrolls.' },
      },
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
    name: 'add_shape',
    description:
      'Draw a shape with text in it, marked as made by you, placed as add_note places a note (near another shape, with a ' +
      'side, to lay a diagram out). A class or interface-box takes attributes and methods, a line each, under its name. ' +
      'It is sized for its text. Draw only when the user asks for a diagram. As `agent-board shape add`.',
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
      'over. Draw only when the user asks for a diagram. As `agent-board diagram add`.',
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
      'flowchart. As `agent-board diagram export`.',
    inputSchema: {
      type: 'object',
      properties: { refs: { type: 'array', items: { type: 'string' }, description: 'Zones (every shape in each) or shapes, by ref; your zone if left out.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'edit_shape',
    description: "Change a shape's kind, text, sections or fill: one you, or an agent you started, drew. Only what is given changes. As `agent-board shape edit`.",
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', description: 'The shape, by ref (item:31f0).' }, ...SHAPE_PROPERTIES },
      required: ['item'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_shape',
    description: 'Remove a shape you, or an agent you started, drew, and every connector joined to it. As `agent-board shape remove`.',
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
      'diagram. As `agent-board connect`.',
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
    description: "Change a connector's relation, style or labels: one you, or an agent you started, made. Only what is given changes. As `agent-board connector edit`.",
    inputSchema: {
      type: 'object',
      properties: { connector: { type: 'string', description: 'The connector, by ref (connector:8a2c).' }, ...CONNECTOR_PROPERTIES },
      required: ['connector'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_connector',
    description: 'Remove a connector you, or an agent you started, made. As `agent-board connector remove`.',
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
      'for its turn to end, keeps its final message in the clock\'s run history and closes it. As `agent-board schedule add`.',
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
      },
      required: ['cron', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_schedules',
    description: "Every schedule (clock) on the board: its ref, its cron, what it does, its next run and its last run's outcome. As `agent-board schedule list`.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'remove_schedule',
    description: 'Remove a schedule you, or an agent you started, made. As `agent-board schedule remove`.',
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
      'new_agent and prefab. As `agent-board prefab ls` and `prefab show`.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A prefab to show whole; every prefab in a line each without.' } },
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

/** A tool argument that must be a string, or undefined when optional and absent. */
function stringArg(args: Record<string, unknown>, name: string, optional: true): string | undefined;
function stringArg(args: Record<string, unknown>, name: string): string;
function stringArg(args: Record<string, unknown>, name: string, optional = false): string | undefined {
  const value = args[name];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new BoardError(`${name} must be a string`);
  return value;
}

/** A whole version number, from `args.version`. */
function versionArg(args: Record<string, unknown>): number {
  if (!Number.isInteger(args.version) || (args.version as number) < 1) throw new BoardError('restore needs version: a version number, as history lists them');
  return args.version as number;
}

/** A boolean argument, if given. */
function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  if (args[name] !== undefined && typeof args[name] !== 'boolean') throw new BoardError(`${name} must be true or false`);
  return args[name] as boolean | undefined;
}

/** `memory_update`'s arguments as the update `memory add|edit|rm|restore` makes. */
function memoryUpdateArg(args: Record<string, unknown>): MemoryUpdate {
  const key = stringArg(args, 'key', true);
  const note = booleanArg(args, 'no_key') === true;
  if (key !== undefined && note) throw new BoardError('give key or no_key, not both');
  const text = stringArg(args, 'text', true);
  const entry = () => stringArg(args, 'entry');
  switch (args.action) {
    case 'add': {
      const path = stringArg(args, 'file', true);
      return { action: 'add', ...(text === undefined ? {} : { text }), ...(path === undefined ? {} : { path }), ...(key === undefined ? {} : { key }), note };
    }
    case 'edit': {
      const pinned = booleanArg(args, 'pinned');
      return { action: 'edit', entry: entry(), ...(text === undefined ? {} : { text }), ...(key === undefined ? {} : { key }), note, ...(pinned === undefined ? {} : { pinned }) };
    }
    case 'remove':
      return { action: 'remove', entry: entry() };
    case 'restore':
      return { action: 'restore', entry: entry(), version: versionArg(args) };
    default:
      throw new BoardError('action must be add, edit, remove or restore');
  }
}

/** `queue_update`'s arguments as the update `queue add|take|…` makes. */
function queueUpdateArg(args: Record<string, unknown>): QueueUpdate {
  const job = () => stringArg(args, 'job');
  const text = stringArg(args, 'text', true);
  const link = stringArg(args, 'link', true);
  switch (args.action) {
    case 'add': {
      if (args.kind !== undefined && args.kind !== 'job' && args.kind !== 'note') throw new BoardError('kind must be job or note');
      return { action: 'add', text: stringArg(args, 'text'), kind: (args.kind as 'job' | 'note' | undefined) ?? 'job', front: booleanArg(args, 'front') === true, ...(link === undefined ? {} : { link }) };
    }
    case 'take': {
      const which = stringArg(args, 'job', true);
      return { action: 'take', ...(which === undefined ? {} : { job: which }) };
    }
    case 'edit':
      if (text === undefined && link === undefined) throw new BoardError('edit needs text or link');
      return { action: 'edit', job: job(), ...(text === undefined ? {} : { text }), ...(link === undefined ? {} : { link }) };
    case 'drop':
    case 'done':
    case 'remove':
      return { action: args.action, job: job() };
    case 'restore':
      return { action: 'restore', job: job(), version: versionArg(args) };
    case 'move':
      return { action: 'move', job: job(), to: stringArg(args, 'to') };
    case 'drain': {
      const on = booleanArg(args, 'on');
      if (on === undefined) throw new BoardError('drain needs on: true or false');
      const most = args.most;
      if (most !== undefined && (!Number.isInteger(most) || (most as number) < 1 || (most as number) > 3)) throw new BoardError('most is 1, 2 or 3');
      return { action: 'drain', on, ...(most === undefined ? {} : { most: most as number }) };
    }
    default:
      throw new BoardError('action must be add, take, drop, done, edit, move, remove, restore or drain');
  }
}

/** `steps_update`'s arguments as the update `steps done|wait|add|answer|close` makes. */
function stepsUpdateArg(args: Record<string, unknown>): StepsUpdate {
  const step = args.step;
  if (step !== undefined && (!Number.isInteger(step) || (step as number) < 1)) throw new BoardError('step must be a step number, from 1');
  for (const flag of ['undo', 'send']) {
    if (args[flag] !== undefined && typeof args[flag] !== 'boolean') throw new BoardError(`${flag} must be true or false`);
  }
  const needStep = () => {
    if (step === undefined) throw new BoardError(`${String(args.action)} needs step`);
    return step as number;
  };
  switch (args.action) {
    case 'done':
      return { action: 'done', steps: [needStep()], undo: args.undo === true };
    case 'wait':
      return { action: 'wait', step: needStep() };
    case 'add':
      return { action: 'add', text: stringArg(args, 'steps') };
    case 'answer':
      return { action: 'answer', ...(step === undefined ? {} : { step: step as number, answer: stringArg(args, 'answer') }), send: args.send === true };
    case 'close':
      return { action: 'close' };
    default:
      throw new BoardError('action must be done, wait, add, answer or close');
  }
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

/** What each tool does with a board session, its arguments and the caller's folder: the text the model reads, or what it sees. */
const TOOL_CALLS: Record<string, (session: BoardSession, args: Record<string, unknown>, cwd: string) => Promise<ToolAnswer>> = {
  whoami: async (session) => identifyView(new BoardRefs(await readBoard(session.client)), session.caller, session.socketPath).text,
  board: async (session) => treeView(new BoardRefs(await readBoard(session.client)), session.caller).text,
  usage: async (session) => (await usageView(session)).text,
  connections: async (session) => connectionsView(new BoardRefs(await readBoard(session.client)), session.caller).text,
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
  needs_you: async (session, { reason, via, clear }) => {
    if (clear === true) return flagLine(await flagOwn(session, undefined), true);
    if (typeof reason !== 'string') throw new BoardError('give a reason, or clear');
    if (via !== undefined && typeof via !== 'string') throw new BoardError('via must be a string');
    return flagLine(await flagOwn(session, reason, via));
  },
  set_status: async (session, { summary, progress, done, agent: crewMember }) => {
    if (typeof summary !== 'string') throw new BoardError('summary must be a string');
    if (progress !== undefined && typeof progress !== 'number') throw new BoardError('progress must be a number');
    if (crewMember !== undefined) {
      if (typeof crewMember !== 'string') throw new BoardError('agent must be a ref or name');
      if (done === true) throw new BoardError('done is for your own status: a crew member says it is finished itself');
      return (await setCrewStatus(session, crewMember, summary, progress)).text;
    }
    const agent = await setOwnStatus(session, summary, progress, done === true);
    return `Your tile now says: ${statusLine(agent.status!)}${agent.workFinishedAt === null ? '' : ', and that your work is finished'}`;
  },
  new_agent: async (session, args) => {
    const prefab = stringArg(args, 'prefab', true);
    if (prefab !== undefined) {
      const set = ['name', 'harness', 'model', 'effort', 'role', 'template', 'branch', 'base', 'edges'].find((key) => args[key] !== undefined);
      if (set !== undefined) throw new BoardError(`${set} is the prefab's to set: with prefab, give zone, repo and issue alone`);
      return (
        await startPrefab(session, {
          name: prefab,
          prompt: stringArg(args, 'prompt'),
          zone: stringArg(args, 'zone', true),
          repo: stringArg(args, 'repo', true),
          issue: stringArg(args, 'issue', true),
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
  set_effort: async (session, args) => (await setAgentEffort(session, stringArg(args, 'agent'), stringArg(args, 'effort'))).text,
  continue_on_credits: async (session, args) => (await continueAgent(session, stringArg(args, 'agent'))).text,
  restart: async (session, args) => {
    const prompt = stringArg(args, 'prompt', true);
    if (args.fresh !== true && prompt !== undefined && prompt.trim() !== '') throw new BoardError('prompt needs fresh');
    const anew = args.fresh === true ? { prompt: prompt === undefined || prompt.trim() === '' ? undefined : prompt } : undefined;
    return (await restartAgent(session, stringArg(args, 'agent'), anew)).text;
  },
  pause: async (session, args) => (await pauseAgent(session, stringArg(args, 'agent'))).text,
  wake: async (session, args) => (await wakeAgent(session, stringArg(args, 'agent'))).text,
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
  present_plan: async (session, args, cwd) => {
    const source = { markdown: stringArg(args, 'markdown', true), html: stringArg(args, 'html', true), path: stringArg(args, 'path', true) };
    return (await presentPlan(session, { title: stringArg(args, 'title'), ...readPlanSource(source, cwd), ...onBoardArg(args), ...timeoutArg(args) })).text;
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
        ...placeArgs(args),
      })
    ).text,
  edit_note: async (session, args) => {
    const text = stringArg(args, 'text', true);
    const color = stringArg(args, 'color', true);
    const size = stringArg(args, 'size', true);
    if (text === undefined && color === undefined && size === undefined) throw new BoardError('give the text, the color or the size');
    return (await editNote(session, stringArg(args, 'note'), { text, color, size })).text;
  },
  remove_note: async (session, args) => (await removeNote(session, stringArg(args, 'note'))).text,
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
        cron: stringArg(args, 'cron'),
        prompt: stringArg(args, 'prompt'),
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
  list_schedules: async (session) => (await listSchedules(session)).text,
  steps_new: async (session, args) => (await newSteps(session, { title: stringArg(args, 'title', true), text: stringArg(args, 'steps') })).text,
  steps_read: async (session, args) => {
    const card = stringArg(args, 'card', true);
    if (args.mine !== undefined && typeof args.mine !== 'boolean') throw new BoardError('mine must be true or false');
    if (card === undefined) return (await listSteps(session, { mine: args.mine === true })).text;
    if (args.mine !== undefined) throw new BoardError('mine is for listing: leave out card');
    return (await readStepsCard(session, card)).text;
  },
  steps_update: async (session, args) => (await updateSteps(session, stringArg(args, 'card'), stepsUpdateArg(args))).text,
  memory_new: async (session, args) => (await newMemory(session, stringArg(args, 'title'))).text,
  memory_read: async (session, args) => {
    const memory = stringArg(args, 'memory', true);
    const entry = stringArg(args, 'entry', true);
    const search = stringArg(args, 'search', true);
    if (args.history !== undefined && typeof args.history !== 'boolean') throw new BoardError('history must be true or false');
    if (memory === undefined) {
      if (entry !== undefined || search !== undefined || args.history !== undefined) throw new BoardError('give the memory');
      return (await listMemories(session)).text;
    }
    if (args.history === true) {
      if (entry === undefined) throw new BoardError('history needs entry');
      return (await memoryHistory(session, memory, entry)).text;
    }
    return (await readMemory(session, memory, { ...(entry === undefined ? {} : { entry }), ...(search === undefined ? {} : { search }) })).text;
  },
  memory_update: async (session, args, cwd) => (await updateMemory(session, stringArg(args, 'memory'), memoryUpdateArg(args), cwd)).text,
  queue_new: async (session, args) => {
    if (args.for_user !== undefined && typeof args.for_user !== 'boolean') throw new BoardError('for_user must be true or false');
    return (await newQueue(session, stringArg(args, 'title'), args.for_user === true)).text;
  },
  queue_read: async (session, args) => {
    const queue = stringArg(args, 'queue', true);
    const job = stringArg(args, 'job', true);
    if (queue === undefined) {
      if (job !== undefined) throw new BoardError('give the queue');
      return (await listQueues(session)).text;
    }
    return job === undefined ? (await readQueue(session, queue)).text : (await queueHistory(session, queue, job)).text;
  },
  queue_update: async (session, args) => (await updateQueue(session, stringArg(args, 'queue'), queueUpdateArg(args))).text,
  remove_schedule: async (session, args) => (await removeSchedule(session, stringArg(args, 'schedule'))).text,
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
        const answer = await callTool(call, args, context, signal);
        if (typeof answer === 'string') return { content: [{ type: 'text', text: answer }] };
        return Array.isArray(answer) ? { content: answer } : answer;
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
