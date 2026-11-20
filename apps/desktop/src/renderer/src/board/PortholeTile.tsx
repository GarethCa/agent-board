import { Expand } from 'lucide-react';
import { useCharacterStyle } from './characters';
import { GlanceLine } from './GlanceLine';
import { glanceLine } from './glance-tile';
import { GlanceTileFrame, type GlanceParts, type GlanceTileProps } from './GlanceTileFrame';
import { portholeRing, portholeWordTone } from './porthole';
import { StatusGlyph } from './StatusMark';
import { TileButton } from './tile-parts';
import { TileCharacter } from './TileCharacter';

/** The height of an agent's character in its porthole, in px: about 78% of `--porthole-size` (32px), standing on its rim. Change them together. */
const PORTHOLE_CHARACTER_HEIGHT = 25;

/**
 * An agent's tile in the Porthole design: its name on a row of its own, then its robot in a round window whose ring
 * carries its state beside the whole of what it is doing or asks, and its state, ticket, pull request and age along the
 * foot. At rest it has
 * no buttons; hover or focus shows Expand and More in its corner and its one action in the age's place. It looks the
 * same at every zoom.
 */
export function PortholeTile(props: GlanceTileProps) {
  return (
    <GlanceTileFrame {...props} design="porthole">
      {(parts) => <PortholeFace {...parts} />}
    </GlanceTileFrame>
  );
}

function PortholeFace({ face, status, ask, look, name, reviewer, menu, expand, prompt, action, times, repo, tags, extras }: GlanceParts) {
  const style = useCharacterStyle();
  const tone = portholeWordTone(face);
  const line = glanceLine(face.line, face.state);
  const word = (
    <>
      <StatusGlyph status={status} className="porthole-word-glyph" />
      {face.word}
    </>
  );
  return (
    <>
      {/* Its name, on a row of its own: the tray its buttons take on hover lies over the row's end only. */}
      <div className="porthole-name">{name}</div>
      {/* Its robot beside the line it speaks, like a chat's avatar: the line's box keeps its size with no line yet. What
          waits on the user's click to reach the agent takes the whole row, with its own buttons. */}
      {prompt ?? (
        <div className="porthole-body">
          <span className="porthole-port" data-testid="porthole" data-ring={portholeRing(face)} data-look={style === 'off' ? 'icons' : style}>
            {style === 'off' ? <StatusGlyph status={status} className="porthole-glyph" /> : <TileCharacter {...look} style={style} height={PORTHOLE_CHARACTER_HEIGHT} />}
          </span>
          <GlanceLine line={line} className="porthole-line" />
        </div>
      )}
      <span className="porthole-meta" data-testid="tile-meta">
        {/* Its state word, then a reviewer's mark. */}
        <span className="porthole-state">
          <span className="porthole-word" data-testid="tile-state" data-tone={tone} data-ask={ask}>
            {word}
          </span>
          {reviewer}
        </span>
        {tags}
        {extras}
        {repo}
        {/* Its age, and its one action in the age's place: shown, the action takes the cell's room, so the chips give way
            before they reach it. */}
        {(times !== undefined || action !== null) && (
          <span className="porthole-corner">
            {times !== undefined && (
              <span className="porthole-age" data-testid="tile-times">
                {times}
              </span>
            )}
            {action !== null && (
              <span className="porthole-action" data-level={face.level}>
                {action}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="porthole-tools" data-testid="tile-controls">
        <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its terminal" onClick={expand} />
        {menu}
      </span>
    </>
  );
}
