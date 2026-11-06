import type { Agent } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE, CHIP_SIZE } from '@agent-board/daemon/board-layout';
import { FoldedChip } from './FoldedChip';
import { HybridTile } from './HybridTile';
import { galleryAgent, SHELL, START, START_FAILED } from './TileGallery';

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
    effort: 'high',
    branch: 'docs/onboarding',
    endedAt: AT,
    exitCode: 0,
    shellSessionId: 'gallery-technical-shell',
    status: line('Added a Getting started page'),
    pullRequests: [{ number: 43, title: 'Docs', url: '', state: 'merged', checks: 'passing' }],
  },
};

/** A shell's calm tile: running, stopped by a restart, every pane ended, and with its panes counted by the technical layer. */
const SHELLS = {
  running: { ...SHELL, endedPanes: [], exitCodes: {} },
  stopped: { ...SHELL, name: 'Watch the logs', endedPanes: [], exitCodes: {}, stoppedPanes: ['left'] },
  ended: { ...SHELL, name: 'Seed the database', endedPanes: ['left', 'right'], exitCodes: { left: 0, right: 0 } },
};

/** Closed agents folded to chips: finished, merged and one that failed. */
const CHIPS: Record<string, Agent> = {
  done: { ...galleryAgent('done'), name: 'Write onboarding docs', endedAt: AT, exitCode: 0, shellSessionId: 'chip-done-shell', pullRequests: [] },
  merged: { ...galleryAgent('done'), name: 'Fix login redirect', endedAt: AT, exitCode: 0, shellSessionId: 'chip-merged-shell', pullRequests: [{ number: 43, title: 'Fix', url: '', state: 'merged', checks: 'passing' }] },
  problem: { ...galleryAgent('failed'), name: 'Migrate the schema', endedAt: AT, exitCode: 1, shellSessionId: 'chip-problem-shell' },
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
      {Object.entries(SHELLS).map(([name, shell]) => (
        <div key={name} style={AGENT_TILE_SIZE} data-testid={`simplified-shell-tile-${name}`}>
          <HybridTile id={`calm-shell-${name}`} tile={{ label: shell.name, harness: null, shell }} />
        </div>
      ))}
      {[START, START_FAILED].map((start) => (
        <div key={start.sessionId} style={AGENT_TILE_SIZE} data-testid={`simplified-start-tile-${start.error === null ? 'starting' : 'failed'}`}>
          <HybridTile id={`start:${start.sessionId}`} tile={{ label: start.name, harness: start.harness, start }} />
        </div>
      ))}
      <div className="calm-chip-gallery" data-testid="simplified-folded-chips">
        {Object.entries(CHIPS).map(([name, agent]) => (
          <div key={name} style={CHIP_SIZE}>
            <FoldedChip id={`chip-${name}`} agent={agent} />
          </div>
        ))}
      </div>
    </div>
  );
}
