// Which session tiles are expanded in place, how big each one is, and which is in front. Pure, so every
// change is unit-tested. The board holds the set in one state, saved in the daemon's view state so the tiles
// open again after a restart.
import { PERCH_ROOM, ZONE_PADDING } from '@agent-board/daemon/board-layout';

/** An expanded tile: its node id and its size on the board. */
export interface ExpandedTile {
  id: string;
  width: number;
  height: number;
}

/** The expanded tiles, back to front: the last one is drawn over the others. */
export type ExpandedTiles = readonly ExpandedTile[];

/** An expanded tile's size when it first opens: room for a terminal to read and its details strip. */
export const EXPANDED_SIZE = { width: 960, height: 600 };

/** The smallest an expanded tile can be resized to, with its details strip and a usable terminal. */
export const EXPANDED_MIN_SIZE = { width: 640, height: 360 };

/** The biggest an expanded tile can be resized to: about a large screen's worth at full zoom. */
export const EXPANDED_MAX_SIZE = { width: 3200, height: 2000 };

/** The size each tile was last let go at once resized, by node id: it opens at that size again, after a collapse too. */
export type ExpandedSizes = Readonly<Record<string, { width: number; height: number }>>;

/** `size` within the least and greatest an expanded tile can be. */
function clampSize(size: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.min(EXPANDED_MAX_SIZE.width, Math.max(EXPANDED_MIN_SIZE.width, size.width)),
    height: Math.min(EXPANDED_MAX_SIZE.height, Math.max(EXPANDED_MIN_SIZE.height, size.height)),
  };
}

/** How long after a tile expands the view waits to move to show it, so the tile has been laid out. */
export const VIEW_FOLLOW_DELAY_MS = 100;

/** Where an expanded tile is: loose on the board, or in a zone. */
export type ExpandedParent = 'board' | 'zone';

/** Where a tile whose node has the parent `parentId` is. */
export function parentKindOf(parentId: string | undefined): ExpandedParent {
  return parentId === undefined ? 'board' : 'zone';
}

/**
 * Whether a resize under way may take an expanded tile's top-left (relative to its parent) to `next` from `start`,
 * where it was as the resize began. Anywhere on the open board; in a zone, not past its padding, unless it was already
 * further out.
 */
export function resizeAllowed(next: { x: number; y: number }, start: { x: number; y: number }, parent: ExpandedParent): boolean {
  if (parent === 'board') return true;
  return next.x >= Math.min(start.x, ZONE_PADDING) && next.y >= Math.min(start.y, ZONE_PADDING + PERCH_ROOM);
}

/** What a tile takes up in a tidy: an expanded tile its expanded size, so the rest are laid out clear of it; else `compact`. */
export function tidySize(expanded: ExpandedTiles, id: string, compact: { width: number; height: number }): { width: number; height: number } {
  const open = expanded.find((entry) => entry.id === id);
  return open === undefined ? compact : { width: open.width, height: open.height };
}

/** Expands the tile, at the size it was last let go at if `sizes` has one, or brings it to the front if it already is. */
export function expandTile(expanded: ExpandedTiles, id: string, sizes: ExpandedSizes = {}): ExpandedTiles {
  if (expanded.some((entry) => entry.id === id)) return bringToFront(expanded, id);
  return [...expanded, { id, ...(sizes[id] ?? EXPANDED_SIZE) }];
}

/** Draws the expanded tile over the others. */
export function bringToFront(expanded: ExpandedTiles, id: string): ExpandedTiles {
  const entry = expanded.find((known) => known.id === id);
  if (entry === undefined || expanded.at(-1) === entry) return expanded;
  return [...expanded.filter((known) => known !== entry), entry];
}

/** Returns the tile to compact. */
export function collapseTile(expanded: ExpandedTiles, id: string): ExpandedTiles {
  return expanded.some((entry) => entry.id === id) ? expanded.filter((entry) => entry.id !== id) : expanded;
}

/** Returns the expanded tile in front to compact: Esc, one at a time. */
export function collapseFront(expanded: ExpandedTiles): ExpandedTiles {
  return expanded.length === 0 ? expanded : expanded.slice(0, -1);
}

/** Sets the expanded tile's size, within the least and greatest. */
export function resizeExpanded(expanded: ExpandedTiles, id: string, size: { width: number; height: number }): ExpandedTiles {
  if (!expanded.some((entry) => entry.id === id)) return expanded;
  return expanded.map((entry) => (entry.id === id ? { id, ...clampSize(size) } : entry));
}

/** Remembers the size the tile was let go at, within the least and greatest. */
export function rememberSize(sizes: ExpandedSizes, id: string, size: { width: number; height: number }): ExpandedSizes {
  return { ...sizes, [id]: clampSize(size) };
}

/** Only the remembered sizes of tiles still on the board, by node id. */
export function keepSizes(sizes: ExpandedSizes, present: ReadonlySet<string>): ExpandedSizes {
  const ids = Object.keys(sizes);
  return ids.every((id) => present.has(id)) ? sizes : Object.fromEntries(ids.filter((id) => present.has(id)).map((id) => [id, sizes[id]!]));
}

/** Only the expanded tiles still on the board, by node id. */
export function keepExpanded(expanded: ExpandedTiles, present: ReadonlySet<string>): ExpandedTiles {
  return expanded.every((entry) => present.has(entry.id)) ? expanded : expanded.filter((entry) => present.has(entry.id));
}

/** Where the session windows are, by the node id of the tile each one belongs to. */
export interface WindowedTiles {
  /** The tiles whose session is shown on the board or popped out: not also expanded, one terminal sizes it. */
  open: ReadonlySet<string>;
  /** Every tile with a window, docked ones too. */
  all: ReadonlySet<string>;
}

const sameEntries = (a: ExpandedTiles, b: ExpandedTiles) => a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Keeps an expanded tile out of the way while its session window is open, and gives it back, at its size, once the
 * window is closed. `hidden` holds the tiles a window took: a docked window leaves them compact, and one expanded by
 * hand meanwhile is the state to come back to. Tiles no longer `present` are forgotten rather than brought back.
 * Returns the same arrays when nothing changes.
 */
export function windowedExpanded(
  expanded: ExpandedTiles,
  hidden: ExpandedTiles,
  windowed: WindowedTiles,
  present: ReadonlySet<string>,
): { expanded: ExpandedTiles; hidden: ExpandedTiles } {
  let held = hidden.filter((entry) => present.has(entry.id));
  for (const entry of expanded) {
    if (windowed.open.has(entry.id)) held = [...held.filter((known) => known.id !== entry.id), entry];
    else if (windowed.all.has(entry.id)) held = held.filter((known) => known.id !== entry.id);
  }
  const back = held.filter((entry) => !windowed.all.has(entry.id) && !expanded.some((known) => known.id === entry.id));
  held = held.filter((entry) => windowed.all.has(entry.id));
  const kept = expanded.filter((entry) => !windowed.open.has(entry.id));
  const next = back.length === 0 ? kept : [...kept, ...back];
  return {
    expanded: sameEntries(expanded, next) ? expanded : next,
    hidden: sameEntries(hidden, held) ? hidden : held,
  };
}

/**
 * Which tile the user dragged onto which, one of the two expanded: the dropped tile's node id, to the node id of the
 * one it was dropped onto. The board lets each pair overlap, and nothing else: each is still kept clear of
 * every other tile. A pair lasts until either tile moves any other way, collapses or goes. Saved with the expanded tiles,
 * so the layout is the same after a restart.
 */
export type OverlapsAllowed = ReadonlyMap<string, string>;

/** `allowed` with the tile `id` dropped onto the tile `onto`, or onto none. Any pair it was in is gone. */
export function allowingOverlap(allowed: OverlapsAllowed, id: string, onto: string | undefined): OverlapsAllowed {
  const without = withoutOverlaps(allowed, [id]);
  if (onto === undefined) return without;
  return new Map([...without, [id, onto]]);
}

/** `allowed` without the pairs any of the tiles `ids` is in: moved otherwise, collapsed or gone. */
export function withoutOverlaps(allowed: OverlapsAllowed, ids: Iterable<string>): OverlapsAllowed {
  const gone = new Set(ids);
  const kept = [...allowed].filter(([dropped, onto]) => !gone.has(dropped) && !gone.has(onto));
  return kept.length === allowed.size ? allowed : new Map(kept);
}

/** Only the pairs of tiles both still on the board, by node id. */
export function keepOverlaps(allowed: OverlapsAllowed, present: ReadonlySet<string>): OverlapsAllowed {
  return withoutOverlaps(
    allowed,
    [...allowed].flat().filter((id) => !present.has(id)),
  );
}

/** The pairs saved from the last run (view state): each a dropped tile's node id and the one it was dropped onto. */
export function overlapsFrom(saved: unknown): OverlapsAllowed {
  if (!Array.isArray(saved)) return new Map();
  const pairs = saved.filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === 'string'));
  return new Map(pairs);
}

/** The tiles in `before` that are no longer expanded in `after`, by node id. */
export function collapsedBetween(before: ExpandedTiles, after: ExpandedTiles): string[] {
  return before.filter((entry) => !after.some((known) => known.id === entry.id)).map((entry) => entry.id);
}

/** Where the expanded tile is from the back (0), or undefined for a compact tile. */
export function expandedRank(expanded: ExpandedTiles, id: string): number | undefined {
  const index = expanded.findIndex((entry) => entry.id === id);
  return index === -1 ? undefined : index;
}

/** The expanded tiles saved from the last run (view state), taking only well-formed entries, each once. */
export function expandedFrom(saved: unknown): ExpandedTiles {
  if (!Array.isArray(saved)) return [];
  const taken: ExpandedTile[] = [];
  for (const entry of saved as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, width, height } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !isSize(width) || !isSize(height) || taken.some((known) => known.id === id)) continue;
    taken.push({ id, ...clampSize({ width, height }) });
  }
  return taken;
}

/** The remembered sizes saved from the last run (view state), taking only well-formed ones. */
export function sizesFrom(saved: unknown): ExpandedSizes {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [id, size] of Object.entries(saved)) {
    if (typeof size !== 'object' || size === null) continue;
    const { width, height } = size as Record<string, unknown>;
    if (isSize(width) && isSize(height)) sizes[id] = clampSize({ width, height });
  }
  return sizes;
}

const isSize = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
