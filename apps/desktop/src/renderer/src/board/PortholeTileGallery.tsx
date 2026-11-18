import type { Agent } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { GLANCE_STATES, type GlanceState } from './glance-tile';
import { PortholeTile } from './PortholeTile';
import type { TileData } from './tile';
import { galleryAgent } from './TileGallery';

const AT = '2026-01-01T00:00:00.000Z';

const line = (summary: string, progress: number | null = null): Agent['status'] => ({ summary, progress, updatedAt: AT, setBy: null });
const ISSUE: Agent['issue'] = { provider: 'linear', id: 'ACME-18', title: 'Workbench light theme and brand assets', url: '' };
const PR = (state: 'open' | 'merged', checks: 'passing' | 'pending'): Agent['pullRequests'][number] => ({ number: 43, title: 'Fix the login redirect', url: '', state, checks });

/** An agent in each glance state, with the ticket, pull request and line that state's tile would carry. */
export const PORTHOLE_TILES: Record<GlanceState, { agent: Agent; implementer?: TileData['implementer'] }> = {
  working: { agent: { ...galleryAgent('running'), name: 'Fix login redirect', issue: ISSUE, pullRequests: [PR('open', 'pending')], status: line('Running checks: 2 of 3 suites passed') } },
  thinking: { agent: { ...galleryAgent('thinking'), name: 'Plan the cache layer', status: null } },
  needs: { agent: { ...galleryAgent('waiting'), name: 'Pick a database', issue: ISSUE, lastMessage: 'Postgres or SQLite for the local store?' } },
  permission: {
    agent: {
      ...galleryAgent('needs-permission'),
      name: 'Clean the build',
      permissions: [{ id: 'ask', toolName: 'Bash', toolInput: { command: 'rm -rf apps/desktop/out && pnpm --filter desktop build && pnpm --filter daemon build' }, subagent: null, requestedAt: AT, heldUntil: null, asksInTerminal: false, sessionGrant: null, dialog: null, plan: null, questions: null }],
    },
  },
  failed: { agent: { ...galleryAgent('failed'), name: 'Migrate the schema', notice: 'Stopped while running the migration.' } },
  idle: { agent: { ...galleryAgent('idle'), name: 'Write the README', pullRequests: [], status: line('Docs in; ready for another task') } },
  done: { agent: { ...galleryAgent('done'), name: 'Write onboarding docs', endedAt: AT, exitCode: 0, shellSessionId: 'porthole-done-shell', pullRequests: [PR('merged', 'passing')], status: line('Added a Getting started page') } },
  paused: { agent: { ...galleryAgent('hibernated'), name: 'Mutation rate sweep', status: null, hibernated: { at: AT, by: null, byId: null } } },
  limit: { agent: { ...galleryAgent('rate-limited'), name: 'Refactor the parser', status: line('Halfway through the tokenizer') } },
  review: {
    agent: { ...galleryAgent('idle'), name: 'Review login redirect', reviewOf: 'gallery-running', issue: ISSUE, pullRequests: [] },
    implementer: { ...galleryAgent('running'), name: 'Fix login redirect' },
  },
  scheduled: { agent: { ...galleryAgent('scheduled'), name: 'Nightly fitness report' } },
};

/** A reviewer at work: the state word says Working, so its mark beside its name is what says it reviews. */
export const WORKING_REVIEWER: { agent: Agent; implementer: Agent } = {
  agent: { ...galleryAgent('running'), sessionId: 'porthole-reviewer-working', name: 'Review login redirect', reviewOf: 'gallery-running', issue: ISSUE, pullRequests: [PR('open', 'pending')], status: line('Reading the redirect handler and its tests') },
  implementer: PORTHOLE_TILES.review.implementer!,
};

/** A reviewer at work whose name is cut short: its eye still follows its word, clear of the corner its buttons take. */
export const REVIEWER_LONG: Agent = { ...WORKING_REVIEWER.agent, sessionId: 'porthole-reviewer-long', name: 'Review the dev server restart under launchd' };

// Each shot takes in the subagents perched on the tile's top edge.
const PERCH_ROOM = { paddingTop: 'var(--space-4-5)' };

/** A line as long as an agent can set, every character of which its tile shows. */
export const AT_THE_CAP = 'Running checks: two of three suites passed, and the third waits on the macOS runner to come back before the merge lands.';

/** A tile with the most to fit: a name cut short, a line at the cap with its progress after it, a long ticket and pull request, and a repo outside its zones. */
const LONG: Agent = {
  ...PORTHOLE_TILES.working.agent,
  sessionId: 'porthole-long',
  name: 'Restart the dev server under launchd once its config moves',
  issue: { provider: 'linear', id: 'ACME-1824', title: 'Move the dev server config', url: '' },
  pullRequests: [{ number: 12_345, title: 'Restart the dev server under launchd', url: '', state: 'open', checks: 'pending' }],
  status: line(AT_THE_CAP, 40),
};
const LONG_REPO = 'desktop-companion-workbench';

/** An agent's tile in the Porthole design in each glance state, then two reviewers at work (one with a long name) and one with the most to fit: the gallery shows them, at rest and on hover. */
export function PortholeTileGallery() {
  return (
    <div className="tile-gallery" data-testid="porthole-tile-gallery">
      {GLANCE_STATES.map((state) => {
        const { agent, implementer } = PORTHOLE_TILES[state];
        return (
          <div key={state} style={PERCH_ROOM} data-testid={`porthole-tile-${state}`}>
            <div style={AGENT_TILE_SIZE}>
              <PortholeTile id={`porthole-${state}`} selected={false} agent={{ ...agent, sessionId: `porthole-${state}` }} implementer={implementer} />
            </div>
          </div>
        );
      })}
      <div style={PERCH_ROOM} data-testid="porthole-tile-reviewer-working">
        <div style={AGENT_TILE_SIZE}>
          <PortholeTile id="porthole-reviewer-working" selected={false} agent={WORKING_REVIEWER.agent} implementer={WORKING_REVIEWER.implementer} />
        </div>
      </div>
      <div style={PERCH_ROOM} data-testid="porthole-tile-reviewer-long">
        <div style={AGENT_TILE_SIZE}>
          <PortholeTile id="porthole-reviewer-long" selected={false} agent={REVIEWER_LONG} implementer={WORKING_REVIEWER.implementer} />
        </div>
      </div>
      <div style={PERCH_ROOM} data-testid="porthole-tile-long">
        <div style={AGENT_TILE_SIZE}>
          <PortholeTile id="porthole-long" selected={false} agent={LONG} repo={LONG_REPO} />
        </div>
      </div>
    </div>
  );
}
