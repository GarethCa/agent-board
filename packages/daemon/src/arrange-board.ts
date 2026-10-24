// Arranging the board: whole zones laid out in tidy rows a gap apart, and the tiles loose on the board gathered in rows
// below them. What is in a zone moves with it and is never laid out afresh (that is the zone's own arrange), and the
// notes, shapes and text loose on the board stay where they are. Pure, so every case is unit-tested.
import { AGENT_TILE_SIZE, MAX_SEARCH_STEPS, overlaps, PERCH_ROOM, ROW_STEP, sizedFootprint, sizeOfZoneTile, TILE_GAP, type Point, type Rect, type ZoneTile } from './board-layout.ts';
import { inReadingOrder, settledSlots } from './board-tidy.ts';

/** The gap between zones, and between the zones and the loose tiles, as the board's Roomy spacing has it. */
export const BOARD_ARRANGE_GAP = 80;

/** A zone to arrange, by its top-left on the board and its size, which it keeps. */
export interface BoardZone extends Rect {
  id: string;
}

/** Where `arrangeBoard` puts the zones and the loose tiles that move, by id: only those that go elsewhere. */
export interface BoardArrangement {
  zones: Map<string, Point>;
  tiles: Map<string, Point>;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * `zones` in board reading order: in rows, a zone joining the row of the one above it while its top is above that
 * one's middle; then left to right, then by id, so the same zones, however listed, arrange the same way.
 */
function zonesInReadingOrder(zones: readonly BoardZone[]): BoardZone[] {
  const rows: BoardZone[][] = [];
  for (const zone of zones.toSorted((a, b) => a.y - b.y || a.x - b.x || byId(a, b))) {
    const row = rows.at(-1);
    if (row !== undefined && zone.y < row[0]!.y + row[0]!.height / 2) row.push(zone);
    else rows.push([zone]);
  }
  return rows.flatMap((row) => row.toSorted((a, b) => a.x - b.x || byId(a, b)));
}

/** `rect` grown by `by` on every side. */
const grown = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by });

/**
 * One row of `zones`, left to right from `x` a gap apart, top-aligned at `top` or lower: a zone that would come within
 * the gap of one of `keepClear` goes right past it, or, when that is nearer, the whole row goes down below it and is laid
 * out again. Its spots, and its top. Past the search's cap, below every one.
 */
function laidOutRow(zones: readonly BoardZone[], x: number, top: number, keepClear: readonly Rect[]): { spots: Point[]; top: number } {
  let rowTop = top;
  for (let step = 0; step < MAX_SEARCH_STEPS; ) {
    const spots: Point[] = [];
    let next = x;
    let down: number | undefined;
    for (const zone of zones) {
      let spot = { x: next, y: rowTop };
      for (; step < MAX_SEARCH_STEPS; step++) {
        const hit = keepClear.find((rect) => overlaps({ ...spot, width: zone.width, height: zone.height }, rect));
        if (hit === undefined) break;
        if (hit.x + hit.width - spot.x <= hit.y + hit.height - rowTop) spot = { x: hit.x + hit.width, y: rowTop };
        else {
          down = hit.y + hit.height;
          break;
        }
      }
      if (down !== undefined) break;
      spots.push(spot);
      next = spot.x + zone.width + BOARD_ARRANGE_GAP;
    }
    if (down === undefined) return { spots, top: rowTop };
    rowTop = down;
    step++;
  }
  rowTop = Math.max(top, ...keepClear.map((rect) => rect.y + rect.height));
  let next = x;
  return {
    spots: zones.map((zone) => {
      const spot = { x: next, y: rowTop };
      next += zone.width + BOARD_ARRANGE_GAP;
      return spot;
    }),
    top: rowTop,
  };
}

/**
 * Where the zones and the loose tiles go when the board is arranged. Zones, at their own sizes, in reading order, in
 * rows of about one and a half times as many as there are rows, top-aligned and `BOARD_ARRANGE_GAP` apart, from the
 * top-left of where the zones are now (of where the tiles are, with no zones). The loose `tiles` (their tops, below
 * the room for their characters) in rows a gap below the zones, in reading order. Each keeps the gap from `fixed`, what
 * stays where it is (the notes, shapes, text and other sessions' tiles loose on the board): a zone that would cover one
 * goes right past it, or its whole row goes down below it, whichever is nearer, so every row stays top-aligned.
 */
export function arrangeBoard(zones: readonly BoardZone[], tiles: readonly ZoneTile[], fixed: readonly Rect[] = []): BoardArrangement {
  const footprintOf = (tile: ZoneTile) => sizedFootprint(tile, sizeOfZoneTile(tile));
  // The zones' own top-left, whatever the strays; else the strays'.
  const moving = zones.length > 0 ? zones : tiles.map(footprintOf);
  if (moving.length === 0) return { zones: new Map(), tiles: new Map() };
  const origin = { x: Math.min(...moving.map((rect) => rect.x)), y: Math.min(...moving.map((rect) => rect.y)) };
  const keepClear = fixed.map((rect) => grown(rect, BOARD_ARRANGE_GAP));

  const zoneSpots = new Map<string, Point>();
  const placedZones: Rect[] = [];
  const perRow = Math.ceil(Math.sqrt(1.5 * zones.length));
  const ordered = zonesInReadingOrder(zones);
  let rowTop = origin.y;
  let rowHeight = 0;
  for (let first = 0; first < ordered.length; first += perRow) {
    if (first > 0) rowTop += rowHeight + BOARD_ARRANGE_GAP;
    const row = ordered.slice(first, first + perRow);
    const laid = laidOutRow(row, origin.x, rowTop, keepClear);
    rowTop = laid.top;
    rowHeight = Math.max(...row.map((zone) => zone.height));
    row.forEach((zone, index) => {
      zoneSpots.set(zone.id, laid.spots[index]!);
      placedZones.push({ ...laid.spots[index]!, width: zone.width, height: zone.height });
    });
  }

  // Below the zones, a gap clear of them, from the zones' left edge as they are now placed: the slots' tops are the tiles'
  // characters' room. With no zones, from the strays' own corner, settled where they land.
  const tilesFrom =
    placedZones.length === 0
      ? { x: origin.x, y: origin.y + PERCH_ROOM }
      : { x: Math.min(...placedZones.map((rect) => rect.x)), y: rowTop + rowHeight + BOARD_ARRANGE_GAP + PERCH_ROOM };
  const perTileRow = Math.ceil(Math.sqrt(tiles.length));
  const tileSpots = settledSlots(
    inReadingOrder(tiles),
    [...placedZones, ...fixed].map((rect) => grown(rect, BOARD_ARRANGE_GAP - TILE_GAP)),
    tilesFrom,
    (from, index) => ({ x: from.x + (index % perTileRow) * (AGENT_TILE_SIZE.width + TILE_GAP), y: from.y + Math.floor(index / perTileRow) * ROW_STEP }),
  );

  const movedOnly = (spots: Map<string, Point>, from: readonly { id: string; x: number; y: number }[]) =>
    new Map([...spots].filter(([id, spot]) => from.some((each) => each.id === id && (each.x !== spot.x || each.y !== spot.y))));
  return { zones: movedOnly(zoneSpots, zones), tiles: movedOnly(tileSpots, tiles) };
}
