// The user's own moves of a tile, which take it out of its zone's layout rule (placed by hand), and how a rule is undone
// and redone: picking or leaving one, and a tile the user moved out of one.

import type { TileMove, ZoneLayoutChoice } from '@agent-board/daemon/protocol';
import { historyKey, type BoardState, type Change } from './editing/use-history';

/** A nudge of a tile with the arrow keys, to `at` in `zoneId`: the user's own move, as a drag is. */
export const nudgeMove = (zoneId: string | null, at: { x: number; y: number }): TileMove => ({ zoneId, x: at.x, y: at.y, byHand: true });

/**
 * The move a resize of a tile saved at `saved` made, let go at `place` in `zoneId`: none if its place is as saved. A
 * resize from its left or top edge moves its top-left, and is the user's own move, as a drag is.
 */
export function resizeMove(saved: { x: number; y: number } | null, zoneId: string | null, place: { x: number; y: number } | undefined): TileMove | undefined {
  if (place === undefined || (saved !== null && saved.x === place.x && saved.y === place.y)) return undefined;
  return { zoneId, x: place.x, y: place.y, byHand: true };
}

/**
 * A tile's place as the history keeps it: never marked by hand (`byHand`), which a drag still in flight can carry. Put
 * back, a place says where the tile goes; whether it goes back as placed by hand is the step's own `handPlaced`.
 */
export function historyPlace(move: TileMove): TileMove {
  if (move.byHand === undefined) return move;
  const place = { ...move };
  delete place.byHand;
  return place;
}

/**
 * The step of picking `choice` for a zone laid out as `was`, whose tiles were at `places` (by node id): one step that
 * puts the choice back, and each tile's place, when a rule was picked or left (a rule moves the tiles, and a view only
 * draws them elsewhere). None for a view picked over a view, or the same choice again.
 */
export function layoutChoiceStep(zoneId: string, was: ZoneLayoutChoice, choice: ZoneLayoutChoice, ruledBefore: boolean, places: readonly [string, TileMove][]): Change[] {
  if (was === choice || (choice !== 'lanes' && !ruledBefore)) return [];
  return [
    [historyKey.zoneLayoutChoice(zoneId), { type: 'zoneLayoutChoice', choice: was }, { type: 'zoneLayoutChoice', choice }],
    // Redone, the rule lays them out again: no place of theirs to put back.
    ...places.map(([nodeId, move]): Change => [historyKey.tile(nodeId), { type: 'tile', move: historyPlace(move) }, null]),
  ];
}

/**
 * The step of the user moving the tile `nodeId` from `before` to `move`. A move by hand records whether the tile was
 * placed by hand before it (`markedIn`, the zone it is marked in, if any), so that an undo puts the mark back as it was.
 */
export function tileMoveStep(nodeId: string, before: TileMove, move: TileMove, markedIn: string | undefined): Change {
  const marked = move.byHand === true ? { handPlaced: markedIn !== undefined } : {};
  return [historyKey.tile(nodeId), { type: 'tile', move: historyPlace(before), ...marked }, { type: 'tile', move }];
}

/** What putting back a tile's step does: move it there, or have its zone's rule take it back (to where its lane is now). */
export type TileStepAction = { kind: 'move'; move: TileMove } | { kind: 'followRule'; zoneId: string };

/**
 * What putting the tile back to `state` does, the tile now marked placed by hand in `markedIn` (if any). A tile that
 * was not placed by hand, back in the zone it is marked in, is put back under the rule; one that was is moved there
 * by hand again, so it is marked as it was even if the move it undoes took it out of that zone.
 */
export function tileStepAction(state: Extract<BoardState, { type: 'tile' }>, markedIn: string | undefined): TileStepAction {
  if (state.handPlaced === false && markedIn !== undefined && markedIn === state.move.zoneId) return { kind: 'followRule', zoneId: markedIn };
  return { kind: 'move', move: state.handPlaced === true ? { ...state.move, byHand: true } : state.move };
}
