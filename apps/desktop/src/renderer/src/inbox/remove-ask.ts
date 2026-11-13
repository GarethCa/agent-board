import type { RemoveAsk, RemoveAskTile } from '@agent-board/daemon/protocol';

/** How many of the tiles that will go the row names before "… N more". */
const REMOVE_ASK_SHOWN = 3;

/** Held-back tiles that stay for the same reason, which the row says once. */
export interface HeldGroup {
  why: string;
  /** The first few unless the held-back tiles are open. */
  tiles: RemoveAskTile[];
}

/** The remove ask's row, as data: the heading, the held-back tiles to tick, and the rest, cut to a few. */
export interface RemoveAskList {
  heading: string;
  /** Still running, with a live agent it started, or with a reviewer that stays: each stays unless the user ticks it. */
  held: HeldGroup[];
  /** How many tiles are held back, in all. */
  heldCount: number;
  /** How many held-back tiles are past the first few of their group, which a toggle shows and hides: 0 when all fit. */
  heldMore: number;
  /** The tiles that go on Allow, the first few unless `open`. */
  shown: RemoveAskTile[];
  /** How many go on Allow past the first few, which a toggle shows and hides: 0 when all fit. */
  more: number;
}

/** How many of `tiles` a cut list leaves out: one more than the cut is never worth a toggle, as "… 1 more" takes the room of the name. */
const pastCut = (tiles: readonly RemoveAskTile[]) => (tiles.length <= REMOVE_ASK_SHOWN + 1 ? 0 : tiles.length - REMOVE_ASK_SHOWN);

/** `tiles`, the first few unless `open`. */
const cut = (tiles: RemoveAskTile[], open: boolean) => (open || pastCut(tiles) === 0 ? tiles : tiles.slice(0, REMOVE_ASK_SHOWN));

export function removeAskList(ask: Pick<RemoveAsk, 'tiles'>, open: boolean, heldOpen = false): RemoveAskList {
  const going = ask.tiles.filter((tile) => tile.held === null);
  const byWhy = new Map<string, RemoveAskTile[]>();
  for (const tile of ask.tiles) if (tile.held !== null) byWhy.set(tile.held, [...(byWhy.get(tile.held) ?? []), tile]);
  const groups = [...byWhy];
  const count = ask.tiles.length;
  return {
    heading: `Wants to remove ${count === 1 ? 'a tile' : `${count} tiles`} it didn't start`,
    held: groups.map(([why, tiles]) => ({ why, tiles: cut(tiles, heldOpen) })),
    heldCount: count - going.length,
    heldMore: groups.reduce((sum, [, tiles]) => sum + pastCut(tiles), 0),
    shown: cut(going, open),
    more: pastCut(going),
  };
}

/** Every held-back tile of the ask, shown or not: what "Tick all" ticks. */
export const heldIds = (ask: Pick<RemoveAsk, 'tiles'>): string[] => ask.tiles.filter((tile) => tile.held !== null).map((tile) => tile.sessionId);

/** The Allow button's words: what pressing it removes, the ticked held-back tiles with the rest. */
export function allowWords(ask: Pick<RemoveAsk, 'tiles'>, ticked: ReadonlySet<string>): string {
  const going = ask.tiles.filter((tile) => tile.held === null || ticked.has(tile.sessionId)).length;
  return going === 0 ? 'Allow' : `Remove ${going}`;
}
