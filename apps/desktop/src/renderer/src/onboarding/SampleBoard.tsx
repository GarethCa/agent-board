import { useEffect, type CSSProperties } from 'react';
import { Eye, X } from 'lucide-react';
import type { AgentState } from '@agent-board/daemon/protocol';
import { HybridTile } from '../board/HybridTile';
import { AGENT_TILE_SIZE } from '../board/layout';
import { galleryAgent } from '../board/TileGallery';
import { Button, Island } from '../ui';

/** The sample board's zones, and the states of the agents in each. */
const ZONES: { name: string; color: string; states: AgentState[] }[] = [
  { name: 'sample-repo', color: 'var(--accent)', states: ['running', 'waiting', 'thinking', 'needs-permission', 'done', 'scheduled'] },
  { name: 'docs', color: 'var(--state-running)', states: ['rate-limited', 'idle', 'failed', 'stopped-by-restart'] },
];

/**
 * The sample board onboarding offers (mock AA): zones of made-up agents, one in each state, drawn as the board draws
 * them. Nothing behind it runs, nothing is saved, and no tokens are spent; leaving it (or Esc) shows the real board.
 */
export function SampleBoard({ onLeave }: { onLeave(): void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onLeave();
      // The real board's keys stay off under it.
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onLeave]);

  return (
    <div className="sample-board" data-testid="sample-board" role="region" aria-label="Sample board">
      <div className="sample-board-zones">
        {ZONES.map((zone) => (
          <section key={zone.name} className="sample-zone" style={{ '--zone-color': zone.color } as CSSProperties} aria-label={zone.name}>
            <span className="sample-zone-tab">{zone.name}</span>
            <div className="sample-zone-tiles">
              {zone.states.map((state) => {
                const agent = galleryAgent(state);
                return (
                  <div key={state} className="sample-tile" style={AGENT_TILE_SIZE}>
                    <HybridTile id={agent.sessionId} tile={{ label: agent.name, harness: agent.harness, agent }} />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <Island className="sample-board-bar island-top-centre">
        <span className="sample-board-label">
          <Eye />
          Sample board
        </span>
        <span className="sample-board-note">demo · nothing runs, no tokens spent</span>
        <Button size="sm" icon={<X />} onClick={onLeave}>
          Leave sample board
        </Button>
      </Island>
    </div>
  );
}
