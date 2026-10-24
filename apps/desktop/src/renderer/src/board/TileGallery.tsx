import { AGENT_STATES, type Agent, type AgentStart, type AgentState, type Harness, type Shell } from '@agent-board/daemon/protocol';
import { HandoffsContext } from './flow-edges';
import { GitBranch } from 'lucide-react';
import { HarnessMark } from './HarnessMark';
import { HybridTile } from './HybridTile';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { StatusPill } from '../ui';

const AT = '2026-01-01T00:00:00.000Z';
/** Far enough ahead that the clock badge reads the same date whenever the gallery is shown. */
const NEXT_RUN = new Date(2099, 0, 1, 9, 0).toISOString();
/** Half a minute into "22 min", so the command's time reads the same while the gallery is looked at. */
const GATE_STARTED = new Date(Date.now() - 22.5 * 60_000).toISOString();

/** The states the gallery shows in its first rows: `starting` has its own, with a start's tiles (`STARTS`). */
type GalleryState = Exclude<AgentState, 'starting'>;
const GALLERY_STATES = AGENT_STATES.filter((state): state is GalleryState => state !== 'starting');

/** What each state's tile carries besides its state, so the gallery also shows PRs, an issue, schedules and more. */
const EXTRAS: Record<GalleryState, { harness: Harness; name: string } & Partial<Agent>> = {
  running: {
    harness: 'claude',
    name: 'Add the dock',
    subagents: [
      { id: 'explore', type: 'Explore', state: 'running', startedAt: AT, endedAt: null, result: null },
      { id: 'plan', type: 'Plan', state: 'thinking', startedAt: AT, endedAt: null, result: null },
    ],
    pullRequests: [{ number: 41, title: 'Add the dock', url: '', state: 'open', checks: 'passing' }],
  },
  thinking: {
    harness: 'codex',
    name: 'Tidy the tokens',
    pullRequests: [{ number: 42, title: 'Tidy the tokens', url: '', state: 'draft', checks: 'pending' }],
  },
  waiting: {
    harness: 'claude',
    name: 'Pick a database',
    issue: { provider: 'linear', id: 'ACME-18', title: 'Workbench light theme and brand assets', url: '' },
    lastMessage: 'Which database should I use, Postgres or SQLite?',
  },
  'needs-permission': {
    harness: 'claude',
    name: 'Clean the build',
    muted: true,
    permissions: [{ id: 'ask', toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, subagent: null, requestedAt: AT, heldUntil: null }],
  },
  idle: {
    harness: 'codex',
    name: 'Write the README',
    // A line its orchestrator set for it: the tile says who.
    status: { summary: 'Docs in; awaiting review', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' },
    pullRequests: [
      { number: 43, title: 'README', url: '', state: 'merged', checks: 'passing' },
      { number: 44, title: 'README again', url: '', state: 'closed', checks: 'failing' },
      { number: 45, title: 'README, third go', url: '', state: 'open', checks: 'none' },
    ],
  },
  'rate-limited': {
    harness: 'claude',
    name: 'Review the diff',
    schedule: { clockId: 'clock-1', cron: '@daily', prompt: 'Review the diff', enabled: false, nextRunAt: null, lastRun: null },
  },
  failed: { harness: 'codex', name: 'Migrate the schema', notice: 'Its process crashed (exit code 1).' },
  scheduled: {
    harness: 'claude',
    name: 'Triage new issues',
    schedule: { clockId: 'clock-1', cron: '0 9 * * *', prompt: 'Triage new issues', enabled: true, nextRunAt: NEXT_RUN, lastRun: null },
  },
  'stopped-by-restart': { harness: 'codex', name: 'Port the scheduler', endedAt: AT },
  'handing-off': { harness: 'claude', name: 'Write the review', lastMessage: 'The diff looks good: two nits inline.' },
  hibernated: {
    harness: 'claude',
    name: 'Pick a cache',
    endedAt: AT,
    status: { summary: 'Picked SQLite, wrote the note', progress: null, updatedAt: AT, setBy: null },
    // Paused a while before now, so its line reads the same whenever the gallery is shown.
    hibernated: { at: new Date(Date.now() - 14 * 60_000).toISOString(), by: 'Release orchestrator', byId: 'gallery-orchestrator' },
  },
  'on-command': {
    harness: 'claude',
    name: 'Fix checkout flake',
    status: { summary: 'Retry fix in; running the gate', progress: null, updatedAt: AT, setBy: null },
    commands: [
      { command: 'pnpm check:pr', startedAt: GATE_STARTED },
      { command: 'pnpm dev --port 5173', startedAt: new Date(Date.now() - 60_000).toISOString() },
    ],
    pullRequests: [{ number: 241, title: 'Fix checkout flake', url: '', state: 'open', checks: 'pending' }],
  },
  done: {
    harness: 'claude',
    name: 'Fix the flaky test',
    pullRequests: [{ number: 46, title: 'Fix the flaky test', url: '', state: 'open', checks: 'failing' }],
  },
};

/** An agent in `state`, with what that state's gallery tile carries besides it: for the gallery and the sample board. */
export const galleryAgent = (state: AgentState): Agent => ({
  sessionId: `gallery-${state}`,
  zoneId: 'gallery',
  repoRoot: '/code/gallery',
  position: null,
  model: null,
  role: null,
  roleName: null,
  reviews: null,
  description: 'A task as the agent was given it, long enough to need a second line on the tile.',
  branch: `acme-18-${state}`,
  ownedBranch: `acme-18-${state}`,
  detached: false,
  worktree: '/worktrees/gallery',
  cwd: '/worktrees/gallery',
  state,
  notice: null,
  earlierConversations: [],
  hibernated: null,
  issue: null,
  muted: false,
  seen: false,
  pullRequests: [],
  pushedPullRequests: [],
  records: [],
  recordedPullRequests: [],
  guessedDoc: null,
  createdAt: AT,
  endedAt: null,
  exitCode: null,
  shellSessionId: null,
  shellHarness: null,
  subagents: [],
  commands: [],
  lastMessage: null,
  finishedAt: null,
  permissions: [],
  ask: null,
  plan: null,
  docs: [],
  schedule: null,
  reviewOf: null,
  reviewCap: 3,
  ownsWorktree: true,
  master: false,
  plainFolder: false,
  orchestrate: null,
  spawnedBy: null,
  unsent: null,
  status: null,
  workFinishedAt: null,
  startup: null,
  flag: null,
  ...EXTRAS[state === 'starting' ? 'running' : state],
});

/** A crowded tile: a long name, every badge, and more than fits, which folds into its "+N". */
const CROWDED: Agent = {
  ...galleryAgent('waiting'),
  sessionId: 'gallery-crowded',
  name: 'Movable sessions follow-up for the dock',
  lastMessage: null,
  muted: true,
  pullRequests: [
    { number: 214, title: 'Movable sessions', url: '', state: 'open', checks: 'passing' },
    { number: 215, title: 'Movable sessions, part two', url: '', state: 'open', checks: 'failing' },
    { number: 216, title: 'Movable sessions, part three', url: '', state: 'draft', checks: 'pending' },
  ],
  schedule: { clockId: 'clock-1', cron: '0 9 * * 2', prompt: 'Follow up', enabled: true, nextRunAt: NEXT_RUN, lastRun: null },
};

/** Names of 10, 30 and 60 characters, on tiles that are not crowded, and a reviewer's: none is cut off before its second line. */
const NAMES: Agent[] = [
  { ...galleryAgent('running'), sessionId: 'gallery-name-10', name: 'Fix a bug!' },
  { ...galleryAgent('waiting'), sessionId: 'gallery-name-30', name: 'Move the dock into the island' },
  { ...galleryAgent('done'), sessionId: 'gallery-name-60', name: 'Rework the movable sessions follow-up so the dock keeps up!' },
  { ...galleryAgent('thinking'), sessionId: 'gallery-reviewer', name: 'Write the code · review r1', reviewOf: 'gallery-running' },
];

/**
 * Agents that ended: one that exited cleanly into a shell, one that exited with 1. Each says so in its state
 * pill, with no Restart row on the tile.
 */
const ENDED: Agent[] = [
  { ...galleryAgent('done'), sessionId: 'gallery-ended-0', name: 'Fix the flaky test', endedAt: AT, exitCode: 0, shellSessionId: 'gallery-ended-0-shell' },
  { ...galleryAgent('failed'), sessionId: 'gallery-ended-1', name: 'Migrate the schema', notice: null, endedAt: AT, exitCode: 1, pullRequests: [{ number: 47, title: 'Migrate the schema', url: '', state: 'open', checks: 'failing' }] },
];

/** An agent receiving a hand-off along a flow edge (FlowRules): its tile reads "receiving…". */
const RECEIVING: Agent = { ...galleryAgent('idle'), sessionId: 'gallery-receiving', name: 'Review the diff', pullRequests: [] };

/** The handing-off tile hands off along an edge, its robot over it, to the receiving one. */
const HANDOFFS = { sending: new Set(['gallery-handing-off']), receiving: new Set([RECEIVING.sessionId]) };

/** A tile whose description runs to several paragraphs and one long unbroken path: it clamps inside the tile. */
const LONG_DESCRIPTION: Agent = {
  ...galleryAgent('running'),
  sessionId: 'gallery-long-description',
  name: 'Long description',
  description: `${'A task described at great length, over several sentences. '.repeat(4)}\n\nSecond paragraph.\n\n/code/gallery/${'a-very-long-unbroken-path-segment/'.repeat(5)}file.ts`,
};

/**
 * An agent starting: its start's tile making its worktree, the agent's tile with its harness's last line once its
 * session runs, and a start that failed, both before its agent was made and as its harness started.
 */
const START: AgentStart = {
  sessionId: 'gallery-start',
  zoneId: 'gallery',
  position: null,
  name: 'Pick a cache',
  harness: 'claude',
  model: 'opus',
  spawnedBy: null,
  steps: [{ kind: 'worktree', state: 'now', detail: null }],
  error: null,
  confirm: false,
};
const START_FAILED: AgentStart = {
  ...START,
  sessionId: 'gallery-start-failed',
  name: 'Prune old jobs',
  steps: [{ kind: 'worktree', state: 'failed', detail: null }],
  error: 'fatal: invalid reference: release-2',
};
const STARTING: Agent = {
  ...galleryAgent('starting'),
  sessionId: 'gallery-starting',
  name: 'Pick a cache',
  model: 'opus',
  branch: 'pick-a-cache-80c2e9',
  subagents: [],
  pullRequests: [],
  startup: { output: '✻ Welcome to Claude Code · loading MCP…', failed: false },
};
/**
 * A start an orchestrator made: a long name, an issue, a role, its orchestrator's status line, a repo outside its zone's
 * and a model. It still fits its tile, the extra badges in the "+N"; the status line, "from" chip and repo tag stay hidden
 * until its first hook.
 */
const STARTING_BY_ORCHESTRATOR: Agent = {
  ...STARTING,
  sessionId: 'gallery-starting-orchestrated',
  name: 'Rework the movable sessions follow-up so the dock keeps up',
  role: 'implementer',
  roleName: 'implementer',
  issue: { provider: 'linear', id: 'ACME-184', title: 'Movable sessions follow-up', url: '' },
  spawnedBy: 'gallery-orchestrator',
  status: { summary: 'Starting up', progress: null, updatedAt: AT, setBy: 'web-app orchestrator' },
  startup: { output: '✻ Welcome to Claude Code · loading MCP servers and the project’s settings…', failed: false },
};
/** A reviewer an orchestrator started: while it starts its "Review · r1" leads its long name, in place of a subtitle row. */
const STARTING_REVIEWER: Agent = {
  ...STARTING_BY_ORCHESTRATOR,
  sessionId: 'gallery-starting-reviewer',
  name: 'Rework the movable sessions follow-up so the dock keeps up · review r1',
  role: 'reviewer',
  roleName: 'reviewer',
  reviewOf: 'gallery-starting-orchestrated',
};
/** A start an orchestrator made whose harness exited: with its long name and status line it still shows its error, Retry and Delete inside the tile. */
const START_EXITED_BY_ORCHESTRATOR: Agent = {
  ...STARTING_BY_ORCHESTRATOR,
  sessionId: 'gallery-start-exited-orchestrated',
  state: 'failed',
  notice: null,
  endedAt: AT,
  exitCode: 1,
  startup: { output: 'ANTHROPIC_API_KEY not set: export it, or log in with claude login, then retry the start', failed: true },
};
const START_EXITED: Agent = {
  ...galleryAgent('failed'),
  sessionId: 'gallery-start-exited',
  name: 'Pick a cache',
  branch: 'pick-a-cache-80c2e9',
  notice: null,
  endedAt: AT,
  exitCode: 1,
  startup: { output: 'ANTHROPIC_API_KEY not set', failed: true },
};

/** A shell tile split in two, one of its panes ended. */
const SHELL: Shell = {
  id: 'gallery-shell',
  zoneId: 'gallery',
  position: null,
  name: 'Run the dev server',
  cwd: '/worktrees/gallery',
  paneFolders: {},
  layout: {
    type: 'split',
    id: 'split',
    direction: 'horizontal',
    ratio: 0.5,
    first: { type: 'pane', sessionId: 'left' },
    second: { type: 'pane', sessionId: 'right' },
  },
  endedPanes: ['right'],
  stoppedPanes: [],
  exitCodes: { right: 0 },
  busyPanes: [],
  panePorts: {},
  failedCommands: {},
  owner: null,
  tabOrder: null,
  createdAt: AT,
};

/**
 * A session window's header at three widths, with a 60-character name: the branch and "N of M" chips shrink
 * and ellipsise first, the title only after them.
 */
function HeaderCases() {
  const name = 'Rework the movable sessions follow-up so the dock keeps up!';
  return (
    <div className="tile-gallery-headers" data-testid="header-gallery">
      {[640, 480, 360].map((width) => (
        <header key={width} className="session-window-head" style={{ width }}>
          <HarnessMark className="session-window-mark" harness="claude" />
          <h2 className="session-window-name" title={name}>
            {name}
          </h2>
          <StatusPill state="waiting" />
          <span className="session-nav-count">
            <b>3</b> of 7 ·<span className="session-nav-dot" aria-hidden />
            Frontend
          </span>
          <span className="session-window-where">
            <GitBranch aria-hidden />
            acme-110-session-names-are-almost-always-cut-off
          </span>
        </header>
      ))}
    </div>
  );
}

/** An agent tile in every agent state, a crowded one, two ended ones, one with a long description, one receiving a hand-off, a shell tile, and an agent starting, for checking how they look. The app shows it at `#gallery`. */
export function TileGallery() {
  return (
    <HandoffsContext value={HANDOFFS}>
      <div className="tile-gallery" data-testid="tile-gallery">
        {GALLERY_STATES.map((state) => {
          const agent = galleryAgent(state);
          return (
            <div key={state} style={AGENT_TILE_SIZE}>
              <HybridTile id={agent.sessionId} tile={{ label: agent.name, harness: agent.harness, agent }} />
            </div>
          );
        })}
        <div style={AGENT_TILE_SIZE}>
          <HybridTile id={CROWDED.sessionId} tile={{ label: CROWDED.name, harness: CROWDED.harness, agent: CROWDED }} />
        </div>
        <div style={AGENT_TILE_SIZE}>
          <HybridTile
            id={LONG_DESCRIPTION.sessionId}
            tile={{ label: LONG_DESCRIPTION.name, harness: LONG_DESCRIPTION.harness, agent: LONG_DESCRIPTION }}
          />
        </div>
        <div style={AGENT_TILE_SIZE}>
          <HybridTile id={RECEIVING.sessionId} tile={{ label: RECEIVING.name, harness: RECEIVING.harness, agent: RECEIVING }} />
        </div>
        {NAMES.map((agent) => (
          <div key={agent.sessionId} style={AGENT_TILE_SIZE}>
            <HybridTile id={agent.sessionId} tile={{ label: agent.name, harness: agent.harness, agent }} />
          </div>
        ))}
        {ENDED.map((agent) => (
          <div key={agent.sessionId} style={AGENT_TILE_SIZE}>
            <HybridTile id={agent.sessionId} tile={{ label: agent.name, harness: agent.harness, agent }} />
          </div>
        ))}
        <div style={AGENT_TILE_SIZE}>
          <HybridTile id={SHELL.id} tile={{ label: SHELL.name, harness: null, shell: SHELL }} />
        </div>
        {[START, START_FAILED].map((start) => (
          <div key={start.sessionId} style={AGENT_TILE_SIZE}>
            <HybridTile id={`start:${start.sessionId}`} tile={{ label: start.name, harness: start.harness, start }} />
          </div>
        ))}
        <div style={AGENT_TILE_SIZE}>
          <HybridTile
            id={STARTING_BY_ORCHESTRATOR.sessionId}
            tile={{
              label: STARTING_BY_ORCHESTRATOR.name,
              harness: STARTING_BY_ORCHESTRATOR.harness,
              agent: STARTING_BY_ORCHESTRATOR,
              repo: 'monorepo-with-a-long-name',
              from: { sessionId: 'gallery-orchestrator', name: 'web-app orchestrator' },
            }}
          />
        </div>
        <div style={AGENT_TILE_SIZE}>
          <HybridTile id={STARTING_REVIEWER.sessionId} tile={{ label: STARTING_REVIEWER.name, harness: STARTING_REVIEWER.harness, agent: STARTING_REVIEWER }} />
        </div>
        <div style={AGENT_TILE_SIZE}>
          <HybridTile id={START_EXITED_BY_ORCHESTRATOR.sessionId} tile={{ label: START_EXITED_BY_ORCHESTRATOR.name, harness: START_EXITED_BY_ORCHESTRATOR.harness, agent: START_EXITED_BY_ORCHESTRATOR }} />
        </div>
        {[STARTING, START_EXITED].map((agent) => (
          <div key={agent.sessionId} style={AGENT_TILE_SIZE}>
            <HybridTile id={agent.sessionId} tile={{ label: agent.name, harness: agent.harness, agent }} />
          </div>
        ))}
        <HeaderCases />
      </div>
    </HandoffsContext>
  );
}
