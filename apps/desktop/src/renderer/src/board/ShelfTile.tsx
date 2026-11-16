import { Expand } from 'lucide-react';
import { useCharacterStyle } from './characters';
import { GlanceGlyph } from './GlanceGlyph';
import { glanceLine } from './glance-tile';
import { GlanceTileFrame, type GlanceParts, type GlanceTileProps } from './GlanceTileFrame';
import { TileButton } from './tile-parts';
import { TileCharacter } from './TileCharacter';

/** How tall its character stands, peeking over the tile's top edge with only its head showing, in px. */
const SHELF_PEEK_HEIGHT = 36;

/**
 * An agent's tile drawn as a Shelf: its character peeks over the top edge, its name and one line of what it is doing or
 * asks sit on a plain card, its ticket and pull request under them, and a band along the bottom carries its state's
 * glyph and word and how long it has been in it. Only the states that want the user colour the band. Its controls
 * (Expand, ⋯) and its one action, at the band's end in the time's place, show on hover or focus. It looks the same at
 * every zoom.
 */
export function ShelfTile(props: GlanceTileProps) {
  return (
    <GlanceTileFrame {...props} design="shelf">
      {(parts) => <ShelfFace {...parts} />}
    </GlanceTileFrame>
  );
}

function ShelfFace({ face, look, name, menu, expand, prompt, action, times, tags, repo, extras, fitted }: GlanceParts) {
  const style = useCharacterStyle();
  // A command it asks to run is shown as the command, the same way under either glance design.
  const line = glanceLine(face.line, face.state);
  return (
    <>
      {style !== 'off' && (
        <span className="shelf-tile-peek" data-testid="tile-peek" data-style={style} data-pose={look.pose}>
          <TileCharacter {...look} style={style} height={SHELF_PEEK_HEIGHT} />
        </span>
      )}
      <div className="shelf-tile-body">
        <div className="shelf-tile-head">{name}</div>
        {/* What waits on the user's click to reach the agent comes first, with its own buttons, in the line's place. */}
        {prompt ?? (
          <span ref={fitted} className="shelf-tile-line" data-testid="tile-line" data-command={line?.command || undefined} title={line?.text}>
            {line?.text}
          </span>
        )}
        <div className="shelf-tile-meta" data-testid="tile-meta">
          {tags}
          {extras}
          {repo}
        </div>
      </div>
      <span className="shelf-tile-tools" data-testid="tile-controls">
        <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its terminal" onClick={expand} />
        {menu}
      </span>
      <div className="shelf-tile-band" data-testid="tile-band" data-level={face.level} data-glance={face.state}>
        <GlanceGlyph state={face.state} className="shelf-tile-glyph" />
        <span className="shelf-tile-word" data-testid="tile-state">
          {face.word}
        </span>
        {times !== undefined && (
          <span className="shelf-tile-age" data-testid="tile-times" data-hides={action !== null || undefined} title={times}>
            {times}
          </span>
        )}
      </div>
      {action !== null && (
        <span className="shelf-tile-act" data-level={face.level}>
          {action}
        </span>
      )}
    </>
  );
}
