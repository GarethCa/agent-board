import { Expand } from 'lucide-react';
import { useCharacterStyle } from './characters';
import { glanceLine } from './glance-tile';
import { GlanceTileFrame, type GlanceParts, type GlanceTileProps } from './GlanceTileFrame';
import { portholeRing, portholeWordTone } from './porthole';
import { StatusGlyph } from './StatusMark';
import { TileButton } from './tile-parts';
import { TileCharacter } from './TileCharacter';

/** The height of an agent's character in its porthole, in px: about 78% of `--porthole-size` (32px), standing on its rim. Change them together. */
const PORTHOLE_CHARACTER_HEIGHT = 25;

/**
 * An agent's tile in the Porthole design: its robot in a round window whose ring carries its state, its name and state
 * beside it, one line of what it is doing or asks, and its ticket, pull request and age along the foot. At rest it has
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

function PortholeFace({ face, status, look, name, reviewer, menu, expand, prompt, action, times, repo, tags, extras, fitted }: GlanceParts) {
  const style = useCharacterStyle();
  const tone = portholeWordTone(face.state);
  const line = glanceLine(face.line, face.state);
  const word = (
    <>
      <StatusGlyph status={status} className="porthole-word-glyph" />
      {face.word}
    </>
  );
  return (
    <>
      <div className="porthole-head">
        <span className="porthole-port" data-testid="porthole" data-ring={portholeRing(face.state)} data-look={style === 'off' ? 'icons' : style}>
          {style === 'off' ? <StatusGlyph status={status} className="porthole-glyph" /> : <TileCharacter {...look} style={style} height={PORTHOLE_CHARACTER_HEIGHT} />}
        </span>
        <span className="porthole-about">
          <span className="porthole-name">{name}</span>
          {/* Its state word, then a reviewer's mark: one line, clear of the corner its buttons take on hover. */}
          <span className="porthole-state">
            <span className="porthole-word" data-testid="tile-state" data-tone={tone}>
              {word}
            </span>
            {reviewer}
          </span>
        </span>
      </div>
      {prompt ??
        (line === null ? (
          <span className="porthole-now" />
        ) : (
          <span ref={fitted} className="porthole-now" data-testid="tile-line" data-command={line.command || undefined} title={line.text}>
            {line.text}
          </span>
        ))}
      <span className="porthole-meta" data-testid="tile-meta">
        {tags}
        {extras}
        {repo}
        {times !== undefined && (
          <span className="porthole-age" data-testid="tile-times">
            {times}
          </span>
        )}
      </span>
      <span className="porthole-tools" data-testid="tile-controls">
        <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its terminal" onClick={expand} />
        {menu}
      </span>
      {action !== null && (
        <span className="porthole-action" data-level={face.level}>
          {action}
        </span>
      )}
    </>
  );
}
