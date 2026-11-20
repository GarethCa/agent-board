import type { RefObject } from 'react';
import { Minus } from 'lucide-react';
import { leaveToTile } from '../keys/escape-hatch';
import { IconButton } from '../ui';
import { useBoardCommands } from './commands';

/** What – says, on every view bigger than a tile. */
const BACK_TO_TILE_TIP = 'Back to its tile; the session keeps running';

/**
 * The – of a view bigger than a tile (an expanded tile, a session window): back to the tile, which is left the board's
 * one selection, with the focus on it so the board's keys reach it after. It means that one thing everywhere, sits last
 * in its view's header, and no tile has one. `leave` collapses or closes the view; `label` keeps each view's own
 * accessible name.
 */
export function BackToTileButton({ from, leave, label, tooltip = BACK_TO_TILE_TIP }: { from: RefObject<HTMLElement | null>; leave: () => void; label: string; tooltip?: string }) {
  const board = useBoardCommands();
  return (
    <IconButton
      icon={<Minus />}
      size="sm"
      variant="secondary"
      className="back-to-tile"
      data-testid="back-to-tile"
      aria-label={label}
      tooltip={tooltip}
      onClick={() => leaveToTile(from.current, leave, board.selectNode)}
    />
  );
}
