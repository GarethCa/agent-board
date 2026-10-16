import { AGENT_STATES, type Agent, type AgentState, type Harness, type Shell } from '@agent-board/daemon/protocol';
import { HandoffsContext } from './flow-edges';
import { GitBranch } from 'lucide-react';
import { HarnessMark } from './HarnessMark';
import { HybridTile } from './HybridTile';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { StatusPill } from '../ui';

const AT = '2026-01-01T00:00:00.000Z';
/** Far enough ahead that the clock badge reads the same date whenever the gallery is shown. */
const NEXT_RUN = new Date(2099, 0, 1, 9, 0).toISOString();

/** The states the gallery shows: `starting` is drawn as `running`, so it has no tile of its own. */
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
    pullRequests: [
      { number: 43, title: 'README', url: '', state: 'merged', checks: 'passing' },
      { number: 44, title: 'README again', url: '', state: 'closed', checks: 'failing' },
      { number: 45, title: 'README, third go', url: '', state: 'open', checks: 'none' },
    ],
  },
  'rate-limited': {
    harness: 'claude',
    name: 'Review the diff',
    schedule: { cron: '@daily', prompt: 'Review the diff', enabled: false, nextRunAt: null, lastRun: null },
  },
  failed: { harness: 'codex', name: 'Migrate the schema', notice: 'Its process crashed (exit code 1).' },
  scheduled: {
    harness: 'claude',
    name: 'Triage new issues',
    schedule: { cron: '0 9 * * *', prompt: 'Triage new issues', enabled: true, nextRunAt: NEXT_RUN, lastRun: null },
  },
  'stopped-by-restart': { harness: 'codex', name: 'Port the scheduler', endedAt: AT },
  'handing-off': { harness: 'claude', name: 'Write the review', lastMessage: 'The diff looks good: two nits inline.' },
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
  issue: null,
  muted: false,
  seen: false,
  pullRequests: [],
  pushedPullRequests: [],
  createdAt: AT,
  endedAt: null,
  exitCode: null,
  shellSessionId: null,
  shellHarness: null,
  subagents: [],
  lastMessage: null,
  finishedAt: null,
  permissions: [],
  ask: null,
  plan: null,
  schedule: null,
  reviewOf: null,
  reviewCap: 3,
  ownsWorktree: true,
  orchestrate: null,
  spawnedBy: null,
  status: null,
  workFinishedAt: null,
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
  schedule: { cron: '0 9 * * 2', prompt: 'Follow up', enabled: true, nextRunAt: NEXT_RUN, lastRun: null },
};

/** Names of 10, 30 and 60 characters, on tiles that are not crowded, and a reviewer's: none is cut off before its second line. */
const NAMES: Agent[] = [
  { ...galleryAgent('running'), sessionId: 'gallery-name-10', name: 'Fix a bug!' },
  { ...galleryAgent('waiting'), sessionId: 'gallery-name-30', name: 'Move the dock into the island' },
  { ...galleryAgent('done'), sessionId: 'gallery-name-60', name: 'Rework the movable sessions follow-up so the dock keeps up!' },
  { ...galleryAgent('thinking'), sessionId: 'gallery-reviewer', name: 'Write the code · review r1', reviewOf: 'gallery-running' },
];

/**
 * Agents that ended (BW1): one that exited cleanly into a shell, one that exited with 1. Each says so in its state
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

/** An agent tile in every agent state, a crowded one, two ended ones, one with a long description, one receiving a hand-off, and a shell tile, for checking how they look. The app shows it at `#gallery`. */
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
        <HeaderCases />
      </div>
    </HandoffsContext>
  );
}
