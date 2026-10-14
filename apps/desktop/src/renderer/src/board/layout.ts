import type { ZoneLayout } from '@agent-board/daemon/protocol';
import { clamp, overlaps, type Rect } from '../geometry';

/** Space kept between a new zone and the zone it was stepped past. */
const ZONE_GAP = 40;

/**
 * Where to put a new zone of `size` that the user wants at `wanted`: there if it overlaps no existing zone, otherwise
 * stepped right past whatever it overlaps until it is clear, so two zones never land on top of each other.
 */
export function freeSpotFor(
  wanted: { x: number; y: number },
  size: { width: number; height: number },
  existing: readonly ZoneLayout[],
): { x: number; y: number } {
  let spot = { ...wanted };
  for (;;) {
    const hit = existing.find((zone) => overlaps({ ...spot, ...size }, zone));
    if (hit === undefined) return spot;
    spot = { x: hit.x + hit.width + ZONE_GAP, y: spot.y };
  }
}

/** A new agent's terminal size until its session window opens and resizes it. */
export const NEW_AGENT_SIZE = { cols: 120, rows: 32 };

/** An agent's tile on the board. */
export const AGENT_TILE_SIZE = { width: 256, height: 136 };

/** Space between a zone's edge and its tiles, and between tiles. */
export const ZONE_PADDING = 20;
export const TILE_GAP = 16;

/** Room above each row of tiles for the subagent characters perched on their top edges. */
export const PERCH_ROOM = 24;

/** How far apart the rows of tiles `tileSlot` lays out are. */
export const ROW_STEP = PERCH_ROOM + AGENT_TILE_SIZE.height + TILE_GAP;

/**
 * Where the `index`th tile of a zone `zoneWidth` wide goes, relative to the zone: in rows from the top-left, as many
 * to a row as fit, and at least one, each row below room for its characters.
 */
export function tileSlot(index: number, zoneWidth: number): { x: number; y: number } {
  const perRow = Math.max(1, Math.floor((zoneWidth - 2 * ZONE_PADDING + TILE_GAP) / (AGENT_TILE_SIZE.width + TILE_GAP)));
  return {
    x: ZONE_PADDING + (index % perRow) * (AGENT_TILE_SIZE.width + TILE_GAP),
    y: ZONE_PADDING + PERCH_ROOM + Math.floor(index / perRow) * ROW_STEP,
  };
}

/** How tall a zone `zoneWidth` wide must be to hold `tileCount` tiles laid out by `tileSlot`, at least one row. */
export function zoneHeightFor(tileCount: number, zoneWidth: number): number {
  const lastSlot = tileSlot(Math.max(tileCount, 1) - 1, zoneWidth);
  return lastSlot.y + AGENT_TILE_SIZE.height + TILE_GAP + ZONE_PADDING;
}

/**
 * Where a new tile goes in a zone `zoneWidth` wide: the first `tileSlot` no tile in `taken` (relative to the zone)
 * covers, even partly, so it never lands on top of another.
 */
export function freeTileSlot(zoneWidth: number, taken: readonly ZoneLayout[]): { x: number; y: number } {
  for (let index = 0; ; index++) {
    const slot = tileSlot(index, zoneWidth);
    if (!taken.some((tile) => overlaps({ ...slot, ...AGENT_TILE_SIZE }, tile))) return slot;
  }
}

/** How far a board item put in a zone for the user sits from its edge, and the gap between such items. */
export const ITEM_INSET = 40;
export const ITEM_GAP = 16;

/**
 * Where a new board item of `size` goes in a zone `zoneWidth` wide: the first spot in rows from the top-left, as many
 * to a row as fit, and at least one, that nothing in `taken` (relative to the zone) covers, even partly.
 */
export function freeItemSpot(zoneWidth: number, size: { width: number; height: number }, taken: readonly ZoneLayout[]): { x: number; y: number } {
  const perRow = Math.max(1, Math.floor((zoneWidth - 2 * ITEM_INSET + ITEM_GAP) / (size.width + ITEM_GAP)));
  for (let index = 0; ; index++) {
    const spot = {
      x: ITEM_INSET + (index % perRow) * (size.width + ITEM_GAP),
      y: ITEM_INSET + Math.floor(index / perRow) * (size.height + ITEM_GAP),
    };
    if (!taken.some((other) => overlaps({ ...spot, ...size }, other))) return spot;
  }
}

/**
 * The least size a zone needs to hold `tiles` (relative to it) with its padding round them, as `zoneHeightFor` does
 * for tiles laid out by `tileSlot`: at least a row tall.
 */
export function zoneMinSize(tiles: readonly ZoneLayout[]): { width: number; height: number } {
  const right = Math.max(0, ...tiles.map((tile) => tile.x + tile.width));
  const bottom = Math.max(...tiles.map((tile) => tile.y + tile.height + TILE_GAP + ZONE_PADDING));
  return { width: right + ZONE_PADDING, height: Math.max(zoneHeightFor(0, 0), bottom) };
}

/** A tile in a zone, by its top-left relative to the zone. */
export interface ZoneTile {
  id: string;
  x: number;
  y: number;
  /** Its size if it was resized; `AGENT_TILE_SIZE` when left out. */
  width?: number;
  height?: number;
}

/** The size of `tile`: what it was resized to, or the default. */
export const sizeOfZoneTile = (tile: ZoneTile) => ({ width: tile.width ?? AGENT_TILE_SIZE.width, height: tile.height ?? AGENT_TILE_SIZE.height });

/** Slack for positions worked out from fractional ones, px. */
const EPSILON = 1e-6;

/**
 * Where a zone's `tiles` go when it is resized to `size`. Each tile that still fits inside the zone's padding stays
 * exactly where it is. Each that doesn't (the edge cut through it) moves the least distance to a spot inside that is
 * clear, by the gaps `tileSlot` leaves, of the other tiles and of `obstacles` (the zone's notes, text and shapes). If
 * the cut tiles can't all be put near where they were, they take free slots of the rows `tileSlot` lays out, round
 * the tiles that stay. Undefined when even that fails: the tiles that fit are never moved to make room, so the zone
 * can shrink no further.
 */
export function packTiles(
  size: { width: number; height: number },
  tiles: readonly ZoneTile[],
  obstacles: readonly Rect[] = [],
): Map<string, { x: number; y: number }> | undefined {
  const { width, height } = AGENT_TILE_SIZE;
  const region = {
    left: ZONE_PADDING,
    top: ZONE_PADDING + PERCH_ROOM,
    right: size.width - ZONE_PADDING - width,
    bottom: size.height - TILE_GAP - ZONE_PADDING - height,
  };
  const inside = (spot: { x: number; y: number }) =>
    spot.x >= region.left - EPSILON &&
    spot.x <= region.right + EPSILON &&
    spot.y >= region.top - EPSILON &&
    spot.y <= region.bottom + EPSILON;
  // A resized tile is never moved to make room: it stays where it is, and the zone can shrink no further than its edge.
  const resized = (tile: ZoneTile) => tile.width !== undefined || tile.height !== undefined;
  const holds = (tile: ZoneTile) => {
    const own = sizeOfZoneTile(tile);
    return (
      tile.x >= region.left - EPSILON &&
      tile.y >= region.top - EPSILON &&
      tile.x + own.width <= size.width - ZONE_PADDING + EPSILON &&
      tile.y + own.height <= size.height - TILE_GAP - ZONE_PADDING + EPSILON
    );
  };
  if (tiles.some((tile) => resized(tile) && !holds(tile))) return undefined;
  const kept = tiles.filter((tile) => (resized(tile) ? true : inside(tile)));
  const cut = tiles.filter((tile) => !resized(tile) && !inside(tile));
  const packed = new Map(kept.map((tile) => [tile.id, { x: tile.x, y: tile.y }]));
  if (cut.length === 0) return packed;
  if (region.right < region.left || region.bottom < region.top) return undefined;
  const taken = [...kept.map((tile) => sizedFootprint(tile, sizeOfZoneTile(tile))), ...obstacles];

  // The nearest to fitting first, so a tile just over the edge gets the spot nearest it.
  const overhang = (tile: ZoneTile) =>
    Math.hypot(tile.x - clamp(tile.x, region.left, region.right), tile.y - clamp(tile.y, region.top, region.bottom));
  const nearFirst = cut.toSorted((a, b) => overhang(a) - overhang(b));
  const near = placeEach(nearFirst, taken, (tile, blocking) => nearestFreeSpot(tile, blocking, region));
  if (near !== undefined) return new Map([...packed, ...near]);

  // In reading order, into the free slots of rows round the tiles that stay.
  const slots = freeSlots(size, region.bottom);
  const inRows = placeEach(
    cut.toSorted((a, b) => a.y - b.y || a.x - b.x),
    taken,
    (_tile, blocking) => slots.find((slot) => clearOf(footprint(slot), blocking)),
  );
  return inRows === undefined ? undefined : new Map([...packed, ...inRows]);
}

/** Places each of `tiles` in turn where `spotFor` says, clear of `taken` and of those placed before it; undefined if one has none. */
function placeEach(
  tiles: readonly ZoneTile[],
  taken: readonly Rect[],
  spotFor: (tile: ZoneTile, blocking: readonly Rect[]) => { x: number; y: number } | undefined,
): Map<string, { x: number; y: number }> | undefined {
  const blocking = [...taken];
  const placed = new Map<string, { x: number; y: number }>();
  for (const tile of tiles) {
    const spot = spotFor(tile, blocking);
    if (spot === undefined) return undefined;
    placed.set(tile.id, spot);
    blocking.push(footprint(spot));
  }
  return placed;
}

/**
 * The spot inside `region` nearest `tile` whose footprint is clear of `blocking`. The nearest is always against the
 * region's edges, against some blocking rectangle's edges, or straight in line with where the tile was, so those are
 * the only spots tried.
 */
function nearestFreeSpot(
  tile: ZoneTile,
  blocking: readonly Rect[],
  region: { left: number; top: number; right: number; bottom: number },
): { x: number; y: number } | undefined {
  const { width, height } = AGENT_TILE_SIZE;
  const xs = [tile.x, region.left, region.right, ...blocking.flatMap((rect) => [rect.x - TILE_GAP - width, rect.x + rect.width + TILE_GAP])];
  const ys = [
    tile.y,
    region.top,
    region.bottom,
    ...blocking.flatMap((rect) => [rect.y - TILE_GAP - height, rect.y + rect.height + TILE_GAP + PERCH_ROOM]),
  ];
  let best: { x: number; y: number; distance: number } | undefined;
  for (const x of new Set(xs.map((x) => clamp(x, region.left, region.right)))) {
    for (const y of new Set(ys.map((y) => clamp(y, region.top, region.bottom)))) {
      const distance = Math.hypot(x - tile.x, y - tile.y);
      // Ties go to the higher spot, then the one further left, so the same layout always packs the same way.
      const better = best === undefined || distance < best.distance - EPSILON || (Math.abs(distance - best.distance) <= EPSILON && (y < best.y || (y === best.y && x < best.x)));
      if (better && clearOf(footprint({ x, y }), blocking)) best = { x, y, distance };
    }
  }
  return best && { x: best.x, y: best.y };
}

/** The part of a zone a tile at `spot` takes: itself and the room above it for its subagents. */
export const footprint = (spot: { x: number; y: number }): Rect => sizedFootprint(spot, AGENT_TILE_SIZE);

/** The part of a zone a tile of `size` at `spot` takes. */
export function sizedFootprint(spot: { x: number; y: number }, size: { width: number; height: number }): Rect {
  return { x: spot.x, y: spot.y - PERCH_ROOM, width: size.width, height: size.height + PERCH_ROOM };
}

/** Whether `rect` keeps `TILE_GAP` from every one of `others`. */
export function clearOf(rect: Rect, others: readonly Rect[]): boolean {
  return others.every(
    (other) =>
      rect.x + rect.width + TILE_GAP <= other.x + EPSILON ||
      other.x + other.width + TILE_GAP <= rect.x + EPSILON ||
      rect.y + rect.height + TILE_GAP <= other.y + EPSILON ||
      other.y + other.height + TILE_GAP <= rect.y + EPSILON,
  );
}

/** The `tileSlot` slots of a zone `size` that are inside it, a tile's top-left no lower than `bottom`. */
function freeSlots(size: { width: number; height: number }, bottom: number): { x: number; y: number }[] {
  const slots: { x: number; y: number }[] = [];
  for (let index = 0; ; index++) {
    const slot = tileSlot(index, size.width);
    if (slot.y > bottom + EPSILON) return slots;
    if (slot.x + AGENT_TILE_SIZE.width + ZONE_PADDING <= size.width + EPSILON) slots.push(slot);
  }
}

/**
 * The least a zone `size` can shrink to and still hold `tileCount` tiles laid out by `tileSlot`: its least width at its
 * height, and its least height at its width. `packTiles` can always pack them into that.
 */
export function leastZoneSize(tileCount: number, size: { width: number; height: number }): { width: number; height: number } {
  if (tileCount === 0) return { width: 0, height: 0 };
  const { width, height } = AGENT_TILE_SIZE;
  const rowsRoom = size.height - 2 * ZONE_PADDING - PERCH_ROOM - height - TILE_GAP;
  const rows = Math.max(1, Math.floor(rowsRoom / (PERCH_ROOM + height + TILE_GAP)) + 1);
  const perRow = Math.ceil(tileCount / rows);
  return { width: 2 * ZONE_PADDING + perRow * width + (perRow - 1) * TILE_GAP, height: zoneHeightFor(tileCount, size.width) };
}
