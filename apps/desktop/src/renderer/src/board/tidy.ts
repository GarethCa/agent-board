// Tidy: a zone's tiles, or the loose ones on the board, laid out in neat rows in board reading order. Unlike
// the room made round an expanded tile, a tidy is saved, and can be undone. Pure, so every case is unit-tested.
import { MIN_ZONE_SIZE } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';
import { AGENT_TILE_SIZE, clearOf, footprint, ROW_STEP, TILE_GAP, tileSlot, ZONE_PADDING, zoneHeightFor, type ZoneTile } from './layout';

/**
 * `tiles` in board reading order: by rows a row of tiles apart from the topmost, so ones a little out of line read as
 * one row, then left to right, then by id, so the same tiles, however listed, tidy the same way.
 */
function inReadingOrder(tiles: readonly ZoneTile[]): ZoneTile[] {
  const top = Math.min(...tiles.map((tile) => tile.y));
  const row = (tile: ZoneTile) => Math.round((tile.y - top) / ROW_STEP);
  return tiles.toSorted((a, b) => row(a) - row(b) || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Each of `tiles`, in reading order, at the next of `slot(0)`, `slot(1)`, … that is a gap clear of `obstacles`. */
function intoSlots(tiles: readonly ZoneTile[], obstacles: readonly Rect[], slot: (index: number) => { x: number; y: number }) {
  const positions = new Map<string, { x: number; y: number }>();
  let index = 0;
  for (const tile of inReadingOrder(tiles)) {
    while (!clearOf(footprint(slot(index)), obstacles)) index++;
    positions.set(tile.id, slot(index++));
  }
  return positions;
}

/**
 * Where a zone `size`'s `tiles` (relative to it) go when it is tidied, and its size then: in the rows `tileSlot` lays
 * out at its width, in reading order, round its notes and cards (`items`, which stay where they are). It keeps its
 * width, at least one tile wide, and its height fits what it holds. A zone with no tiles stays as it is.
 */
export function tidyZone(
  size: { width: number; height: number },
  tiles: readonly ZoneTile[],
  items: readonly Rect[] = [],
): { positions: Map<string, { x: number; y: number }>; size: { width: number; height: number } } {
  if (tiles.length === 0) return { positions: new Map(), size };
  const width = Math.max(size.width, 2 * ZONE_PADDING + AGENT_TILE_SIZE.width);
  const positions = intoSlots(tiles, items, (index) => tileSlot(index, width));
  const height = Math.max(
    MIN_ZONE_SIZE.height,
    zoneHeightFor(0, width),
    ...[...positions.values()].map((spot) => spot.y + AGENT_TILE_SIZE.height + TILE_GAP + ZONE_PADDING),
    ...items.map((item) => item.y + item.height + ZONE_PADDING),
  );
  return { positions, size: { width, height } };
}

/**
 * Where the loose `tiles` go when the board is tidied: in reading order, in rows of as many as make the grid about
 * square, from the top-left of where they are now, skipping any spot within a gap of `obstacles` (zones, items).
 */
export function tidyLoose(tiles: readonly ZoneTile[], obstacles: readonly Rect[] = []): Map<string, { x: number; y: number }> {
  if (tiles.length === 0) return new Map();
  const origin = { x: Math.min(...tiles.map((tile) => tile.x)), y: Math.min(...tiles.map((tile) => tile.y)) };
  const perRow = Math.ceil(Math.sqrt(tiles.length));
  return intoSlots(tiles, obstacles, (index) => ({
    x: origin.x + (index % perRow) * (AGENT_TILE_SIZE.width + TILE_GAP),
    y: origin.y + Math.floor(index / perRow) * ROW_STEP,
  }));
}
