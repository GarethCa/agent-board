import { createContext, useContext } from 'react';
import { Pin } from 'lucide-react';

/** The tiles, by node id, the user placed by hand in a zone with a layout rule, which the rule skips. */
export const HandPlacedContext = createContext<ReadonlySet<string>>(new Set());

/**
 * The mark beside a tile's name when the user placed it by hand in a zone with a layout rule. It says something rather
 * than doing anything, so it shows at rest, not among the tile's buttons. Nothing for any other tile.
 */
export function HandPlacedMark({ nodeId }: { nodeId: string }) {
  const placed = useContext(HandPlacedContext);
  if (!placed.has(nodeId)) return null;
  return (
    <span className="tile-hand-placed" data-testid="tile-hand-placed" role="img" aria-label="Placed by hand" title="Placed by hand: this zone's rule skips it">
      <Pin aria-hidden />
    </span>
  );
}
