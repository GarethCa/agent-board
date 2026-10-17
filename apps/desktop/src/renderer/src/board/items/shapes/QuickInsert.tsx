import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ShapeType } from '@agent-board/daemon/protocol';
import { AnchoredPopover, Kbd } from '../../../ui';
import { SHAPE_GROUPS, SHAPES } from './catalogue';
import { recentShapes } from './recents';
import { searchShapes, type ShapeMatch, type ShapeResult } from './search';
import { ShapeIcon } from './ShapeArt';
import { keyText } from '../../../keys/registry';

const groupName = (shape: ShapeType) => SHAPE_GROUPS.find(({ id }) => id === SHAPES[shape].group)!.name;

/** `text` with the letters `match` found marked. */
function marked(text: string, match: ShapeMatch | undefined): ReactNode {
  if (match === undefined || match.from === match.to) return text;
  return (
    <>
      {text.slice(0, match.from)}
      <mark>{text.slice(match.from, match.to)}</mark>
      {text.slice(match.to)}
    </>
  );
}

/**
 * The quick-insert palette: `/` on the board opens it at the pointer (`at`, on the screen). Typing finds shapes by
 * name or another word for them; ↑ and ↓ pick one, and Enter or a click puts it where the pointer was. Empty, it lists
 * the recent shapes (every shape before any is used). Esc or a click elsewhere closes it.
 */
export function QuickInsert({ at, onPlace, onClose }: { at: { x: number; y: number }; onPlace(shape: ShapeType): void; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const recents = recentShapes();
  const results: ShapeResult[] = query.trim() === '' && recents.length > 0 ? recents.map((shape) => ({ shape })) : searchShapes(query);
  const chosen = Math.min(active, results.length - 1);
  return createPortal(
    <AnchoredPopover
      anchor={<div className="quick-insert-anchor" style={{ left: at.x, top: at.y }} />}
      open
      onOpenChange={(open) => open || onClose()}
      side="bottom"
      align="start"
      sideOffset={12}
      aria-label="Insert a shape"
      className="quick-insert"
    >
      <div className="quick-insert-field">
        <span className="quick-insert-slash" aria-hidden="true">
          /
        </span>
        <input
          className="quick-insert-input"
          aria-label="Shape to insert"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-insert-results"
          aria-activedescendant={results.length > 0 ? `quick-insert-${results[chosen]!.shape}` : undefined}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((chosen + step + results.length) % Math.max(1, results.length));
            } else if (event.key === 'Enter' && results.length > 0) {
              event.preventDefault();
              onPlace(results[chosen]!.shape);
            }
          }}
        />
        <Kbd>{keyText('dialog.close')}</Kbd>
      </div>
      {results.length === 0 ? (
        <p className="quick-insert-none">No shape matches “{query.trim()}”</p>
      ) : (
        <ul className="quick-insert-results" id="quick-insert-results" role="listbox" aria-label="Shapes">
          {results.map(({ shape, match }, index) => (
            <li
              key={shape}
              id={`quick-insert-${shape}`}
              role="option"
              aria-selected={index === chosen}
              className="quick-insert-result"
              onPointerMove={() => index !== chosen && setActive(index)}
              onClick={() => onPlace(shape)}
            >
              <span className="quick-insert-icon">
                <ShapeIcon shape={shape} room={{ width: 24, height: 18 }} />
              </span>
              <b>{marked(SHAPES[shape].name, match?.in === 'name' ? match : undefined)}</b>
              <i>
                {match?.in === 'synonym' && <>“{marked(match.text, match)}” · </>}
                {groupName(shape)}
              </i>
            </li>
          ))}
        </ul>
      )}
      <p className="quick-insert-foot">
        <span>↑↓ pick</span>·<span>↵ places it at the pointer</span>·<span>empty: recents</span>
      </p>
    </AnchoredPopover>,
    document.body,
  );
}
