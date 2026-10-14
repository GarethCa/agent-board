// A tile's move is saved by asking the daemon, which answers with the session as it saved it, and also tells every
// window of the change. The answer can reach the board after a later change it has heard of: the app hands
// the daemon's events on as they come, but its answers a step later. Taken whole, the answer would put the tile back.
import type { TilePosition } from '@agent-board/daemon/protocol';

/** Where a tile is: in a zone, or loose on the board for null; at `position`, or slotted in by the board for null. */
export interface Place {
  zoneId: string | null;
  position: TilePosition | null;
}

const samePlace = (a: Place, b: Place) =>
  a.zoneId === b.zoneId &&
  (a.position === null || b.position === null
    ? a.position === b.position
    : a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z);

/**
 * `known`, as the board has it, at the place `saved` a move of it was saved at: unless it has moved from `asked`, the
 * place it had when the move was asked for, since. Then the board has heard of this move or a later one, which stands.
 * Only the place is taken: the rest of the answer may be older than what the board has heard.
 */
export function withSavedPlace<T extends Place>(known: T, asked: Place, saved: Place): T {
  return samePlace(known, asked) ? { ...known, zoneId: saved.zoneId, position: saved.position } : known;
}
