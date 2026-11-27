// Arranging the board: whole zones laid out in tidy rows a gap apart, and the tiles loose on the board gathered in rows
// below them. What is in a zone moves with it and is never laid out afresh (that is the zone's own arrange), and the
// notes, shapes and text loose on the board stay where they are. Pure, so every case is unit-tested.
import { MAX_SEARCH_STEPS, overlaps, PERCH_ROOM, rotatedBounds, sizedFootprint, sizeOfZoneTile, TILE_GAP, type Point, type Rect, type ZoneTile } from './board-layout.ts';
import { looseGrid } from './board-tidy.ts';
import { drawnZoneSize, type Zone } from './protocol.ts';

/** The gap between zones, and between the zones and the loose tiles, as the board's Roomy spacing has it. */
export const BOARD_ARRANGE_GAP = 80;

/** A zone to arrange, by its top-left on the board and its size, which it keeps. */
export interface BoardZone extends Rect {
  id: string;
}

/**
 * Where `arrangeBoard` puts the zones and the loose tiles that move, by id: only those that go elsewhere. `freed` are
 * the tiles it moved, whose overlaps end: a tile let overlap an expanded one, or put down beside one so it isn't pushed
 * with its row, is laid out clear of the rest now, and is pushed aside again as any tile is.
 */
export interface BoardArrangement {
  zones: Map<string, Point>;
  tiles: Map<string, Point>;
  freed: string[];
}

/** A zone as arranging the board reads it: where it is, its saved size, and whether it is folded to a chip. */
export type ArrangedZone = Pick<Zone, 'id' | 'x' | 'y' | 'width' | 'height' | 'folded'>;

/** A session's tile as arranging the board reads it, at the size it takes (an expanded one its expanded size). */
export interface ArrangedTile extends Rect {
  /** Its key on the board (`tileSizeKey`): the app's node id for it too. */
  id: string;
  kind: 'agent' | 'shell' | 'external';
  zoneId: string | null;
  /** Pinned expanded: it stays where it is, and so does its zone. */
  pinned: boolean;
}

/** A note, shape, text or card as arranging the board reads it: its box, its turn, and its zone. */
export interface ArrangedItem extends Rect {
  zoneId: string | null;
  rotation: number;
}

/** What is on the board, as the app and the daemon both hand it to `arrangeBoard`. */
export interface BoardToArrange {
  zones: readonly ArrangedZone[];
  tiles: readonly ArrangedTile[];
  items: readonly ArrangedItem[];
}

/** The room a zone takes on the board: its own, or folded, its chip's, so its neighbours close up round it. */
export const zoneRoom = (zone: ArrangedZone): BoardZone => ({ id: zone.id, x: zone.x, y: zone.y, ...drawnZoneSize(zone) });

/**
 * The one way the board is read for an arrange: the zones that move (every one but a zone holding a tile pinned
 * expanded) by the room each takes, the agents and shells loose on the board (not pinned), and what stays where it is
 * for the rest to keep clear of: the notes, shapes and text loose on it (a turned one by its upright box), the other
 * loose tiles (external sessions', pinned ones) with the room above them for their characters, and the pinned tiles'
 * zones.
 */
export function arrangeInput(board: BoardToArrange): { zones: BoardZone[]; tiles: ZoneTile[]; fixed: Rect[] } {
  const pinnedZones = new Set(board.tiles.flatMap((tile) => (tile.pinned && tile.zoneId !== null ? [tile.zoneId] : [])));
  const loose = board.tiles.filter((tile) => tile.zoneId === null);
  const moving = loose.filter((tile) => tile.kind !== 'external' && !tile.pinned);
  const rooms = board.zones.map(zoneRoom);
  return {
    zones: rooms.filter((room) => !pinnedZones.has(room.id)),
    tiles: moving.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
    fixed: [
      ...board.items.filter((item) => item.zoneId === null).map(({ x, y, width, height, rotation }) => rotatedBounds({ x, y, width, height }, rotation)),
      ...loose.filter((tile) => !moving.includes(tile)).map((tile) => sizedFootprint(tile, tile)),
      ...rooms.filter((room) => pinnedZones.has(room.id)),
    ],
  };
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

/** Where the zones and the loose tiles go when `board` is arranged (`arrangeInput`, `laidOut`), and the tiles it frees. */
export function arrangeBoard(board: BoardToArrange): BoardArrangement {
  const { zones, tiles, fixed } = arrangeInput(board);
  const laid = laidOut(zones, tiles, fixed);
  return { ...laid, freed: [...laid.tiles.keys()] };
}

/**
 * Where the zones and the loose tiles go when the board is arranged. Zones, at their own sizes, in reading order, in
 * rows of about one and a half times as many as there are rows, top-aligned and `BOARD_ARRANGE_GAP` apart, from the
 * top-left of where the zones are now (of where the tiles are, with no zones). The loose `tiles` (their tops, below
 * the room for their characters) in rows a gap below the zones, in reading order. Each keeps the gap from `fixed`, what
 * stays where it is (the notes, shapes, text and other sessions' tiles loose on the board): a zone that would cover one
 * goes right past it, or its whole row goes down below it, whichever is nearer, so every row stays top-aligned.
 */
export function laidOut(zones: readonly BoardZone[], tiles: readonly ZoneTile[], fixed: readonly Rect[] = []): Omit<BoardArrangement, 'freed'> {
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
  const tileSpots = looseGrid(
    tiles,
    [...placedZones, ...fixed].map((rect) => grown(rect, BOARD_ARRANGE_GAP - TILE_GAP)),
    tilesFrom,
  );

  const movedOnly = (spots: Map<string, Point>, from: readonly { id: string; x: number; y: number }[]) =>
    new Map([...spots].filter(([id, spot]) => from.some((each) => each.id === id && (each.x !== spot.x || each.y !== spot.y))));
  return { zones: movedOnly(zoneSpots, zones), tiles: movedOnly(tileSpots, tiles) };
}
