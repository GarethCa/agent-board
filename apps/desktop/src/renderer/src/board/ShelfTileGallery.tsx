import { FIRST_PROMPT, type Agent } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { GLANCE_STATES } from './glance-tile';
import { PORTHOLE_TILES } from './PortholeTileGallery';
import { ShelfTile } from './ShelfTile';

const PEEK_ROOM = { paddingTop: 'var(--space-4-5)' };

/** A tile with the most to fit: a name on two lines, a long ticket and pull request, and a repo outside its zones. */
const LONG: Agent = {
  ...PORTHOLE_TILES.working.agent,
  sessionId: 'shelf-long',
  name: 'Restart the dev server under launchd once its config moves',
  issue: { provider: 'linear', id: 'ACME-1824', title: 'Move the dev server config', url: '' },
  pullRequests: [{ number: 12_345, title: 'Restart the dev server under launchd', url: '', state: 'open', checks: 'pending' }],
};
const LONG_REPO = 'desktop-companion-workbench';

/** A tile whose first prompt is typed and not sent: the prompt row, with its own buttons, in its line's place. */
const UNSENT: Agent = { ...PORTHOLE_TILES.idle.agent, sessionId: 'shelf-unsent', name: 'Tidy the release notes', unsent: FIRST_PROMPT };

/**
 * An agent's tile in the Shelf design in each glance state, at rest and on hover: the same agents the Porthole gallery
 * draws, so the two designs can be set side by side. Then one with the most to fit in the tile's fixed size, and one with a prompt row in its line's place.
 */
export function ShelfTileGallery() {
  return (
    <div className="tile-gallery" data-testid="shelf-tile-gallery">
      {GLANCE_STATES.map((state) => {
        const { agent, implementer } = PORTHOLE_TILES[state];
        return (
          // Each shot takes in the robot's head over the tile's top edge.
          <div key={state} style={PEEK_ROOM} data-testid={`shelf-tile-${state}`}>
            <div style={AGENT_TILE_SIZE}>
              <ShelfTile id={`shelf-${state}`} selected={false} agent={{ ...agent, sessionId: `shelf-${state}` }} implementer={implementer} />
            </div>
          </div>
        );
      })}
      <div style={PEEK_ROOM} data-testid="shelf-tile-long">
        <div style={AGENT_TILE_SIZE}>
          <ShelfTile id="shelf-long" selected={false} agent={LONG} repo={LONG_REPO} />
        </div>
      </div>
      <div style={PEEK_ROOM} data-testid="shelf-tile-unsent">
        <div style={AGENT_TILE_SIZE}>
          <ShelfTile id="shelf-unsent" selected={false} agent={UNSENT} />
        </div>
      </div>
    </div>
  );
}
