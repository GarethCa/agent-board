import type { Agent } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { HybridTile } from './HybridTile';
import { galleryAgent } from './TileGallery';

const AT = '2026-01-01T00:00:00.000Z';

const line = (summary: string): Agent['status'] => ({ summary, progress: null, updatedAt: AT, setBy: null });

/**
 * An agent's calm tile in each of the six statuses, by the name its screenshot takes, one a restart stopped (Needs you,
 * with Resume), and one to show the technical layer.
 */
const TILES: Record<string, Agent> = {
  working: { ...galleryAgent('running'), name: 'Fix login redirect', subagents: [], pullRequests: [], status: line('Running checks: 2 of 3 suites passed') },
  waiting: { ...galleryAgent('needs-permission'), name: 'Clean the build', muted: false },
  done: { ...galleryAgent('idle'), name: 'Write onboarding docs', pullRequests: [], status: line('Added a Getting started page') },
  paused: {
    ...galleryAgent('hibernated'),
    name: 'Mutation rate sweep',
    status: null,
    hibernated: { at: AT, by: null, byId: null },
  },
  scheduled: { ...galleryAgent('scheduled'), name: 'Nightly fitness report' },
  problem: { ...galleryAgent('failed'), name: 'Migrate the schema', notice: 'Stopped while running the migration.' },
  stopped: { ...galleryAgent('stopped-by-restart'), name: 'Kobo shelf sync' },
  technical: {
    ...galleryAgent('done'),
    name: 'Write onboarding docs',
    model: 'opus',
    branch: 'docs/onboarding',
    endedAt: AT,
    exitCode: 0,
    shellSessionId: 'gallery-technical-shell',
    status: line('Added a Getting started page'),
    pullRequests: [{ number: 43, title: 'Docs', url: '', state: 'merged', checks: 'passing' }],
  },
};

/** Every status's calm tile under the Simplified design, and one with its technical line: the gallery shows it. */
export function CalmTileGallery() {
  return (
    <div className="tile-gallery" data-testid="calm-tile-gallery">
      {Object.entries(TILES).map(([name, agent]) => (
        <div key={name} style={AGENT_TILE_SIZE} data-testid={`simplified-tile-${name}`}>
          <HybridTile id={`calm-${name}`} tile={{ label: agent.name, harness: agent.harness, agent }} />
        </div>
      ))}
    </div>
  );
}
