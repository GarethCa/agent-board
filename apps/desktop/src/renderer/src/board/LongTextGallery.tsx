import {
  crewCardSize,
  LIST_CARD_FOLDED_SIZE,
  MEMORY_CARD_SIZE,
  QUEUE_CARD_SIZE,
  TODO_CARD_SIZE,
  TODO_PILL_SIZE,
  ZONE_COLORS,
  type Agent,
  type CrewCardData,
  type MemoryEntry,
  type QueueJob,
  type Step,
  type StepsData,
  type StepsWho,
  type TodoData,
  CLOCK_SIZE,
  DOCUMENT_CARD_SIZE,
  STICKY_SIZE,
  type BoardItemKind,
} from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { HybridTile } from './HybridTile';
import { galleryAgent, SHELL } from './TileGallery';
import { TileShowsOverride } from './view-settings';
import { EMOJI, LONG_PATH, LONG_SENTENCE, LONG_URL, NO_SPACES, OTHER_SCRIPTS } from './long-text';
import { TodoCardView, TodoPillView, type TodoCardActions } from './items/TodoCard';
import { MemoryCardView, MemoryIconView } from './items/MemoryCard';
import { QueueCardView, QueueIconView } from './items/QueueCard';
import { nextJob } from './items/queue-card';
import { StepsCard, type StepsCardActions } from './items/StepsCard';
import { CrewCardView } from './items/CrewCard';
import { crewCardModel } from './items/crew-card';
import type { ItemNodeType } from './items/items';
import { ISSUE_CARD_SIZE, IssueNode } from './items/IssueNode';
import { StickyNode } from './items/StickyNode';
import { TextNode } from './items/TextNode';
import { SHAPE_SIZE, ShapeNode } from './items/ShapeNode';
import { DocumentNode } from './items/DocumentNode';
import { ClockBoardContext, ClockNode } from './items/ClockNode';
import { LINK_CARD_SIZE, LinkNode } from './items/LinkNode';

const AT = '2026-01-01T00:00:00.000Z';
const noop = () => {};
const ZONE = ZONE_COLORS[0];

/** Every tile line at once, so a long string in any of them shows. */
const CHIPS_SHOWN = { chips: true } as const;

/** An agent whose every field is `text`. */
export const longAgent = (key: string, text: string): Agent => ({
  ...galleryAgent('running'),
  sessionId: `long-${key}`,
  name: text,
  description: text,
  purpose: text,
  branch: text,
  ownedBranch: text,
  worktree: LONG_PATH,
  cwd: LONG_PATH,
  roleName: text,
  model: text,
  status: { summary: text, progress: 40, updatedAt: AT, setBy: text },
  issue: {
    provider: 'linear',
    id: text.slice(0, 40),
    title: text,
    url: LONG_URL,
  },
  pullRequests: [
    {
      number: 123456,
      title: text,
      url: LONG_URL,
      state: 'open',
      checks: 'passing',
    },
    {
      number: 123457,
      title: text,
      url: LONG_URL,
      state: 'draft',
      checks: 'pending',
    },
  ],
  subagents: [
    {
      id: 'sub',
      type: text,
      state: 'running',
      startedAt: AT,
      endedAt: null,
      result: null,
    },
  ],
  commands: [{ command: text, startedAt: AT }],
  lastMessage: text,
});

/** One agent per kind of long string, waiting on the user so its last message shows as well. */
const AGENTS: Agent[] = [
  longAgent('no-spaces', NO_SPACES),
  longAgent('path', LONG_PATH),
  longAgent('url', LONG_URL),
  longAgent('scripts', OTHER_SCRIPTS),
  longAgent('emoji', EMOJI),
  {
    ...longAgent('waiting', LONG_SENTENCE),
    state: 'waiting',
    notice: LONG_SENTENCE,
  },
  { ...longAgent('failed', NO_SPACES), state: 'failed', notice: NO_SPACES },
];

const LONG_SHELL = {
  ...SHELL,
  id: 'long-shell',
  name: NO_SPACES,
  cwd: LONG_PATH,
};

/** Lines by an agent with a long name too. */
const WRITER: StepsWho = {
  kind: 'agent',
  sessionId: 'long-writer',
  name: NO_SPACES,
};
const LINES = [NO_SPACES, LONG_PATH, LONG_URL, OTHER_SCRIPTS, EMOJI, LONG_SENTENCE];

const TODO: TodoData = {
  owner: WRITER,
  lines: LINES.map((text, at) => ({
    id: `t${at}`,
    text,
    by: WRITER,
    at: AT,
    done: at === 1 ? { by: WRITER, at: AT } : null,
  })),
};
const TODO_LOOKUP = { name: () => NO_SPACES, harness: () => 'claude' as const };
const TODO_ACTIONS: TodoCardActions = {
  add: async () => undefined,
  edit: noop,
  tick: noop,
  remove: noop,
  clear: noop,
  move: noop,
  showAgent: noop,
  copy: noop,
  fold: noop,
  deleteList: noop,
  leave: noop,
};

const NOW = new Date(2026, 10, 5, 15, 0);
const memo = (id: string, key: string | null, text: string): MemoryEntry => ({
  id,
  memoryId: 'long',
  key,
  file: false,
  text,
  pinned: id === 'm0',
  madeBy: WRITER,
  changedBy: WRITER,
  createdAt: AT,
  updatedAt: AT,
});
const MEMORY: MemoryEntry[] = LINES.map((text, at) => memo(`m${at}`, at % 2 === 0 ? text : null, text));

const job = (id: string, text: string, more: Partial<QueueJob> = {}): QueueJob => ({
  id,
  queueId: 'long',
  kind: 'task',
  text,
  link: null,
  state: 'queued',
  takenBy: null,
  takenAt: null,
  drops: 0,
  doneBy: null,
  doneAt: null,
  result: null,
  hiddenUntil: null,
  madeBy: WRITER,
  changedBy: WRITER,
  lastChange: 'add',
  createdAt: AT,
  updatedAt: AT,
  ...more,
});
const JOBS: QueueJob[] = LINES.map((text, at) =>
  job(`j${at}`, text, at === 0 ? { state: 'taken', takenBy: WRITER, takenAt: AT, link: LONG_URL } : { link: at % 2 ? LONG_PATH : null }),
);

let nextStep = 0;
const step = (text: string, part: Partial<Step> = {}): Step => ({
  id: `s${nextStep++}`,
  kind: 'todo',
  section: null,
  required: false,
  choices: [],
  who: WRITER,
  link: null,
  done: null,
  answer: null,
  text,
  ...part,
});
const STEPS: StepsData = {
  title: NO_SPACES,
  madeBy: WRITER,
  answeredBy: { kind: 'user' },
  steps: [
    step(NO_SPACES, { section: LONG_SENTENCE, link: LONG_URL }),
    step(LONG_PATH, { section: LONG_SENTENCE, done: { by: WRITER, at: AT } }),
    step(OTHER_SCRIPTS, {
      kind: 'one',
      who: null,
      choices: [NO_SPACES, EMOJI],
    }),
    step(EMOJI),
  ],
  sent: null,
  waits: [],
  closedAt: null,
};
const STEPS_LOOKUP = { live: () => true, name: () => NO_SPACES };
const STEPS_ACTIONS: StepsCardActions = {
  answer: noop,
  tick: noop,
  send: noop,
  stepIn: noop,
  leave: noop,
};

const CREW: CrewCardData = {
  crewId: 'long',
  title: NO_SPACES,
  icon: 'crew',
  tiles: false,
  members: [
    {
      id: 'builder',
      name: NO_SPACES,
      role: LONG_SENTENCE,
      harness: 'claude',
      model: null,
      starts: 'prompt',
    },
    {
      id: 'review',
      name: OTHER_SCRIPTS,
      role: NO_SPACES,
      harness: 'claude',
      model: null,
      starts: 'handoff',
    },
  ],
  crew: {
    id: 'long',
    prefab: NO_SPACES,
    zoneId: 'long',
    startedBy: null,
    builder: 'long-builder',
    round: 1,
    roundLimit: 3,
    phase: 'building',
    needsYou: false,
    stopped: null,
    startedAt: AT,
    stoppedAt: null,
    reviewers: [],
  },
  phaseAt: AT,
  startFailed: true,
  startError: NO_SPACES,
};
const CREW_AGENTS: Agent[] = [{ ...longAgent('builder', NO_SPACES), sessionId: 'long-builder' }];

/** A board item of `kind` as the canvas hands it to its node, at `size`, not picked; `key` tells two of a kind apart. */
const itemProps = (kind: BoardItemKind, data: Record<string, unknown>, size: { width: number; height: number }, key: string = kind): NodeProps<ItemNodeType> =>
  ({
    id: `long-${key}`,
    type: kind,
    data: { item: { id: `long-${key}`, kind, zoneId: null, ticket: null, x: 0, y: 0, ...size, z: 0, rotation: 0, data, createdAt: AT } },
    selected: false,
    dragging: false,
    ...size,
  }) as unknown as NodeProps<ItemNodeType>;

const SHAPE_BOX = { width: SHAPE_SIZE.width, height: SHAPE_SIZE.height };
const TEXT_BOX = { width: 240, height: 120 };
/** Cards the user has made taller: their titles show as many lines as they have room for. */
const TALL_ISSUE = { width: ISSUE_CARD_SIZE.width, height: 240 };
const TALL_LINK = { width: LINK_CARD_SIZE.width, height: 200 };
const NODES = [
  { Node: IssueNode, props: itemProps('issue', { provider: 'linear', id: NO_SPACES, title: LONG_SENTENCE, url: LONG_URL, state: OTHER_SCRIPTS }, ISSUE_CARD_SIZE) },
  { Node: IssueNode, props: itemProps('issue', { provider: 'linear', id: NO_SPACES, title: NO_SPACES, url: LONG_URL, state: OTHER_SCRIPTS }, TALL_ISSUE, 'issue-tall') },
  { Node: StickyNode, props: itemProps('sticky', { text: `${NO_SPACES} ${LONG_PATH}` }, STICKY_SIZE) },
  { Node: TextNode, props: itemProps('text', { text: `${NO_SPACES}\n${LONG_URL}`, wrap: true }, TEXT_BOX) },
  { Node: ShapeNode, props: itemProps('shape', { shape: 'rectangle', text: `${NO_SPACES} ${EMOJI}` }, SHAPE_BOX) },
  {
    Node: DocumentNode,
    props: itemProps('document', { documentId: 'long-doc', agent: { sessionId: 'long-doc-agent', name: NO_SPACES, harness: 'claude', role: null }, title: NO_SPACES, format: 'markdown', collapsed: false }, DOCUMENT_CARD_SIZE),
  },
  { Node: ClockNode, props: itemProps('clock', { agent: 'long-clock-agent', prompt: NO_SPACES }, CLOCK_SIZE) },
  { Node: LinkNode, props: itemProps('link', { url: LONG_URL, title: NO_SPACES, domain: OTHER_SCRIPTS }, LINK_CARD_SIZE) },
  { Node: LinkNode, props: itemProps('link', { url: LONG_URL, title: NO_SPACES, domain: OTHER_SCRIPTS }, TALL_LINK, 'link-tall') },
];
const CLOCK_BOARD = { statuses: new Map(), agentName: () => NO_SPACES, edit: noop };

/**
 * Every board item with long text in every field it shows: agent and shell tiles, a to-do list, a memory, a queue, a
 * steps card and a crew card, open and folded; and the canvas's own nodes: an issue, a sticky note, text, a shape, a
 * document, a clock and a link. Nothing in it may run past its box. The app shows it at `#gallery-long-text`.
 */
export function LongTextGallery() {
  return (
    <TileShowsOverride value={CHIPS_SHOWN}>
      <section className="long-text-gallery" data-testid="long-text-gallery" aria-label="Long text">
        <div className="long-text-gallery-row">
          {AGENTS.map((agent) => (
            <div key={agent.sessionId} className="long-text-box" style={AGENT_TILE_SIZE} data-testid="long-text-box">
              <HybridTile id={agent.sessionId} tile={{ label: agent.name, harness: agent.harness, agent }} />
            </div>
          ))}
          <div className="long-text-box" style={AGENT_TILE_SIZE} data-testid="long-text-box">
            <HybridTile
              id={LONG_SHELL.id}
              tile={{
                label: LONG_SHELL.name,
                harness: null,
                shell: LONG_SHELL,
              }}
            />
          </div>
        </div>
        <div className="long-text-gallery-row">
          <div className="long-text-box" style={TODO_CARD_SIZE} data-testid="long-text-box">
            <TodoCardView data={TODO} lookup={TODO_LOOKUP} zoneName={NO_SPACES} steppedIn={false} actions={TODO_ACTIONS} />
          </div>
          <div className="long-text-box" style={TODO_PILL_SIZE} data-testid="long-text-box">
            <TodoPillView data={TODO} lookup={TODO_LOOKUP} onOpen={noop} onClear={noop} />
          </div>
          <div className="long-text-box" style={MEMORY_CARD_SIZE} data-testid="long-text-box">
            <MemoryCardView title={NO_SPACES} scope={LONG_SENTENCE} zoneColor={ZONE} entries={MEMORY} now={NOW} onAdd={noop} onOpen={noop} />
          </div>
          <div className="long-text-box" style={LIST_CARD_FOLDED_SIZE} data-testid="long-text-box">
            <MemoryIconView title={NO_SPACES} scope={LONG_SENTENCE} zoneColor={ZONE} count={MEMORY.length} sub={LONG_URL} onOpen={noop} />
          </div>
          <div className="long-text-box" style={QUEUE_CARD_SIZE} data-testid="long-text-box">
            <QueueCardView
              title={NO_SPACES}
              scope={LONG_SENTENCE}
              zoneColor={ZONE}
              zoneName={NO_SPACES}
              audience="agents"
              jobs={JOBS}
              onAdd={noop}
              onOpen={noop}
              onMoveUp={noop}
            />
          </div>
          <div className="long-text-box" style={LIST_CARD_FOLDED_SIZE} data-testid="long-text-box">
            <QueueIconView
              audience="agents"
              title={NO_SPACES}
              scope={LONG_SENTENCE}
              zoneColor={ZONE}
              count={JOBS.length}
              next={nextJob(JOBS)}
              sub={EMOJI}
              onOpen={noop}
            />
          </div>
          <div className="long-text-box long-text-steps" data-testid="long-text-box">
            <StepsCard
              data={STEPS}
              lookup={STEPS_LOOKUP}
              look="full"
              selected
              sized={false}
              steppedIn={false}
              writing={false}
              actions={STEPS_ACTIONS}
            />
          </div>
          <div className="long-text-box" style={crewCardSize(CREW.members.length)} data-testid="long-text-box">
            <CrewCardView
              title={CREW.title}
              icon={CREW.icon}
              model={crewCardModel(CREW, CREW_AGENTS, 'explicit', true)}
              onAction={noop}
              onOpenAgent={noop}
              onOpenPullRequest={noop}
            />
          </div>
        </div>
        <ReactFlowProvider>
          <ClockBoardContext value={CLOCK_BOARD}>
            <div className="long-text-gallery-row">
              {NODES.map(({ Node, props }) => (
                // A text item resized to a width wraps at it and grows as tall as its text. One never resized is as wide as its
                // lines, on the board too (it can't be made narrower without wrapping), so it has no box to run past.
                <div key={props.id} className="long-text-box" style={{ width: props.width, height: props.data.item.kind === 'text' ? undefined : props.height }} data-testid="long-text-box">
                  <Node {...props} />
                </div>
              ))}
            </div>
          </ClockBoardContext>
        </ReactFlowProvider>
      </section>
    </TileShowsOverride>
  );
}
