import { useState, type MouseEvent } from 'react';
import { Chip, Popover } from '../ui';

/** One line of what a tile's footer folded: its words, and what clicking it does (open its plan, its pull request…), when anything. */
export interface PlusItem {
  line: string;
  open?(): void;
}

/**
 * The "+N" chip of a tile's footer: clicking it lists what didn't fit, one row each. A row with something to open (a plan,
 * a document, a gate, a pull request) opens it and closes the list; the rest only say what they are. Always drawn, so the
 * footer can measure it: `useFooterFold` hides it while nothing is folded.
 */
export function PlusChip({ items, name }: { items: readonly PlusItem[]; name: string }) {
  const [open, setOpen] = useState(false);
  const list = (
    // The list sits in a portal, but React events bubble through the tile it is drawn from: a double-click here would open its session window.
    <div className="tile-folded-list" data-testid="tile-folded-list" onClick={stopPropagation} onDoubleClick={stopPropagation}>
      {items.map((item, index) =>
        item.open === undefined ? (
          <span key={index} className="tile-folded-row" data-testid="tile-folded-row" title={item.line}>
            <span className="tile-folded-text">{item.line}</span>
          </span>
        ) : (
          <button
            key={index}
            type="button"
            className="tile-folded-row"
            data-testid="tile-folded-row"
            title={item.line}
            onClick={() => {
              setOpen(false);
              item.open?.();
            }}
          >
            <span className="tile-folded-text">{item.line}</span>
          </button>
        ),
      )}
    </div>
  );
  return (
    <Popover open={open} onOpenChange={setOpen} content={list} aria-label={`${name}: what else is on its tile`} side="bottom" align="end" className="tile-folded-popover">
      <Chip
        className="hybrid-tile-folded nodrag"
        data-testid="tile-folded"
        data-folded-chip=""
        title={`${items.length} more: click to list them`}
        aria-label={`${items.length} more: ${items.map((item) => item.line).join('; ')}`}
        onDoubleClick={stopPropagation}
      >
        +{items.length}
      </Chip>
    </Popover>
  );
}

const stopPropagation = (event: MouseEvent) => event.stopPropagation();
