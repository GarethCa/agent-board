// Where tiles, items and zones go on the board: the pure geometry the board and the daemon's layout
// commands share, so a tile an orchestrator moves lands where a drop would. Pure, so every case is unit-tested.
import type { Agent, TileSide, ZoneLayout } from './protocol.ts';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A rectangle from its top-left. */
export interface Rect extends Point, Size {}

/** Whether two rects share any area: touching along an edge isn't overlapping. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** `value`, kept between `low` and `high`. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

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
  // Each step goes right past a zone it hit, so it hits each at most once.
  for (let step = 0; step <= existing.length; step++) {
    const hit = existing.find((zone) => overlaps({ ...spot, width: size.width, height: size.height }, zone));
    if (hit === undefined) return spot;
    spot = { x: hit.x + hit.width + ZONE_GAP, y: spot.y };
  }
  return { x: Math.max(spot.x, ...existing.map((zone) => zone.x + zone.width + ZONE_GAP)), y: spot.y };
}

/**
 * Most spots any search here tries before it gives up and takes one past everything in its way: a hard stop, so a
 * crowded zone (or a bad size) can never hang the board or the daemon.
 */
export const MAX_SEARCH_STEPS = 10_000;

/** The lowest bottom of `rects`, or `top` with none. */
const lowestOf = (rects: readonly Rect[], top: number) => Math.max(top, ...rects.map((rect) => rect.y + rect.height));

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
 * The zone's grid, which automated layout keeps tiles on so they line up across clusters: a column a default
 * tile and a gap wide, a row `ROW_STEP` tall, counted from a zone's first tile slot.
 */
export const GRID_COLUMN = AGENT_TILE_SIZE.width + TILE_GAP;
export const GRID_ORIGIN = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };

/**
 * The shortest rail a linked pair's token lies along in full, with its name and the line under it: the renderer's
 * `--rail-token-room`, which a test keeps the same.
 */
export const RAIL_TOKEN_ROOM = 160;
/** The least gap between two tiles a rail joins, so its token and label clear both: its room, and a tile gap each side. */
export const RAIL_GAP = RAIL_TOKEN_ROOM + 2 * TILE_GAP;

/** The top-left of the grid cell `column` along and `row` down, relative to its zone. */
export const gridPoint = (column: number, row: number): Point => ({ x: GRID_ORIGIN.x + column * GRID_COLUMN, y: GRID_ORIGIN.y + row * ROW_STEP });

/** The grid cell nearest `point`, relative to its zone: never left of or above the first. */
export function snapToGrid(point: Point): Point {
  return gridPoint(Math.max(0, Math.round((point.x - GRID_ORIGIN.x) / GRID_COLUMN)), Math.max(0, Math.round((point.y - GRID_ORIGIN.y) / ROW_STEP)));
}

/** The first grid row whose tiles start at or below `y`. */
export const gridRowAtOrBelow = (y: number): number => Math.max(0, Math.ceil((y - GRID_ORIGIN.y - EPSILON) / ROW_STEP));

/** The first grid column whose tiles start at or right of `x`. */
export const gridColumnAtOrRight = (x: number): number => Math.max(0, Math.ceil((x - GRID_ORIGIN.x - EPSILON) / GRID_COLUMN));

/** How many grid columns and rows a tile of `size` takes, with its gaps and the room above it for its characters. */
export function gridSpan(size: Size): { columns: number; rows: number } {
  return {
    columns: Math.max(1, Math.ceil((size.width + TILE_GAP - EPSILON) / GRID_COLUMN)),
    rows: Math.max(1, Math.ceil((size.height + PERCH_ROOM + TILE_GAP - EPSILON) / ROW_STEP)),
  };
}

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
 * Where a new tile of `size` goes in a zone `zoneWidth` wide: the first `tileSlot` where no tile in `taken` (relative to
 * the zone) covers it, even partly, so it never lands on top of another. A resized tile takes only a slot it fits in
 * the zone's width from, or the first of a row.
 */
export function freeTileSlot(zoneWidth: number, taken: readonly ZoneLayout[], size: Size = AGENT_TILE_SIZE): { x: number; y: number } {
  for (let index = 0; index < MAX_SEARCH_STEPS; index++) {
    const slot = tileSlot(index, zoneWidth);
    const fits = slot.x === ZONE_PADDING || slot.x + size.width + ZONE_PADDING <= zoneWidth;
    if (fits && !taken.some((tile) => overlaps({ ...slot, width: size.width, height: size.height }, tile))) return slot;
  }
  return { x: ZONE_PADDING, y: lowestOf(taken, 0) + TILE_GAP + PERCH_ROOM };
}

/**
 * Where a tile of `size` goes to sit a gap beside `of` (a tile's or item's rect) on `side`: level with it to its right or
 * left, lined up on its left below or above it, with room for the characters perched on the tile's top edge.
 */
export function besideSpot(of: Rect, side: TileSide, size: Size): Point {
  switch (side) {
    case 'right':
      return { x: of.x + of.width + TILE_GAP, y: of.y };
    case 'left':
      return { x: of.x - TILE_GAP - size.width, y: of.y };
    case 'below':
      return { x: of.x, y: of.y + of.height + TILE_GAP + PERCH_ROOM };
    case 'above':
      return { x: of.x, y: of.y - PERCH_ROOM - TILE_GAP - size.height };
  }
}

/**
 * The name the board gives a session tile's node, which its resized size is kept under in the view state
 * (`TILE_SIZES_VIEW_KEY`): `agent:<session id>`, `shell:<id>`, `external:<id>`.
 */
export const tileSizeKey = (kind: 'agent' | 'shell' | 'external', id: string): string => `${kind}:${id}`;

/** The view state key the board keeps each resized tile's size under, by `tileSizeKey`. */
export const TILE_SIZES_VIEW_KEY = 'tileSizes';

/** The view state key the board keeps the closed agents the user unfolded under, as a list of `tileSizeKey`s. */
export const UNFOLDED_VIEW_KEY = 'unfoldedTiles';

/** A folded chip: a closed agent's tile once it has shrunk to its mark, name and final state. */
export const CHIP_SIZE = { width: 196, height: 34 };

/**
 * Whether the agent's session is closed: it ended, and nothing of it is left running. Not one a restart stopped (that
 * is resumed), nor one paused (that is woken: its tile keeps what it was doing, and Wake), nor one whose pane dropped
 * into a shell that still runs: that tile keeps its Restart, and the user may be running the harness by hand there.
 */
export const isClosed = (agent: Pick<Agent, 'endedAt' | 'state' | 'shellSessionId' | 'shellHarness'>): boolean =>
  agent.endedAt !== null &&
  agent.state !== 'stopped-by-restart' &&
  agent.state !== 'hibernated' &&
  agent.shellSessionId === null &&
  agent.shellHarness === null;

/** The view state key the board keeps the tiles expanded in place under, as a list of `{ id, width, height }` by `tileSizeKey`. */
export const EXPANDED_VIEW_KEY = 'expandedTiles';

/** The size of each expanded tile saved in the view state (`EXPANDED_VIEW_KEY`), by `tileSizeKey`: only the well-formed ones. */
export function expandedSizesFrom(saved: unknown): Record<string, Size> {
  const sizes: Record<string, Size> = {};
  if (!Array.isArray(saved)) return sizes;
  for (const entry of saved as unknown[]) {
    const { id, width, height } = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof id === 'string' && typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) sizes[id] = { width, height };
  }
  return sizes;
}

/** Whether the board draws the agent as a chip: closed, and not unfolded by the user. */
export const isFolded = (agent: Pick<Agent, 'endedAt' | 'state' | 'sessionId' | 'shellSessionId' | 'shellHarness'>, unfolded: ReadonlySet<string>): boolean =>
  isClosed(agent) && !unfolded.has(tileSizeKey('agent', agent.sessionId));

/** The unfolded node ids saved in the view state (`UNFOLDED_VIEW_KEY`), taking only the strings, once each. */
export const unfoldedFrom = (saved: unknown): string[] => (Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))] : []);

/** How far a board item put in a zone for the user sits from its edge, and the gap between such items. */
export const ITEM_INSET = 40;
export const ITEM_GAP = 16;

/**
 * Where a new board item of `size` goes in a zone `zoneWidth` wide: the first spot in rows from the top-left, as many
 * to a row as fit, and at least one, that nothing in `taken` (relative to the zone) covers, even partly.
 */
export function freeItemSpot(zoneWidth: number, size: { width: number; height: number }, taken: readonly ZoneLayout[]): { x: number; y: number } {
  const perRow = Math.max(1, Math.floor((zoneWidth - 2 * ITEM_INSET + ITEM_GAP) / (size.width + ITEM_GAP)));
  for (let index = 0; index < MAX_SEARCH_STEPS; index++) {
    const spot = {
      x: ITEM_INSET + (index % perRow) * (size.width + ITEM_GAP),
      y: ITEM_INSET + Math.floor(index / perRow) * (size.height + ITEM_GAP),
    };
    if (!taken.some((other) => overlaps({ ...spot, width: size.width, height: size.height }, other))) return spot;
  }
  return { x: ITEM_INSET, y: lowestOf(taken, 0) + ITEM_GAP };
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
 * The spot inside `region` nearest `tile` whose footprint, at `size`, is clear of `blocking`. The nearest is always against the
 * region's edges, against some blocking rectangle's edges, or straight in line with where the tile was, so those are
 * the only spots tried.
 */
export function nearestFreeSpot(
  tile: Point,
  blocking: readonly Rect[],
  region: { left: number; top: number; right: number; bottom: number },
  size: Size = AGENT_TILE_SIZE,
): { x: number; y: number } | undefined {
  const { width, height } = size;
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
      if (better && clearOf(sizedFootprint({ x, y }, size), blocking)) best = { x, y, distance };
    }
  }
  return best && { x: best.x, y: best.y };
}

/** Space between an orchestrator and its crew's first column: room for the frame between them. */
export const CREW_GAP = 40;
/** How many of a crew go to a row beside their orchestrator before the next row. */
export const CREW_PER_ROW = 3;
/** How many rows down a new crew member is looked for a spot before the zone slots it as any other. */
export const CREW_ROWS = 20;

/** The spot `col` along and `row` down of the crew of the orchestrator at `at`. */
const crewSlot = (at: { x: number; y: number }, col: number, row: number) => ({
  x: at.x + AGENT_TILE_SIZE.width + CREW_GAP + col * (AGENT_TILE_SIZE.width + TILE_GAP),
  y: at.y + row * ROW_STEP,
});

/** Where the next of a crew goes beside its orchestrator at `at`: the first spot in its rows clear of `taken`. */
export function crewSpot(at: { x: number; y: number }, taken: readonly Rect[]): { x: number; y: number } | undefined {
  for (let row = 0; row < CREW_ROWS; row++) {
    for (let col = 0; col < CREW_PER_ROW; col++) {
      const spot = crewSlot(at, col, row);
      if (clearOf(footprint(spot), taken)) return spot;
    }
  }
  return undefined;
}

/** How `slotUnplaced` reads and places the tiles it is given. */
export interface Slotting<T> {
  /** The zone it is in, or undefined for loose on the board. */
  zoneOf(tile: T): string | undefined;
  /** Its place, relative to its zone (a board position when loose), or undefined for none yet. */
  placeOf(tile: T): Point | undefined;
  place(tile: T, spot: Point): void;
  /** The agent it is (its session id), and the orchestrator that started it, if either. */
  agentOf(tile: T): string | undefined;
  orchestratorOf(tile: T): string | undefined;
  /** What it takes at its place: itself, and what it takes for a new crew member beside it. */
  rect(tile: T): Rect;
  footprint(tile: T): Rect;
  zoneWidth(zoneId: string): number;
  /** Every zone, on the board: a loose tile keeps clear of them. */
  zones: readonly Rect[];
  /** The board items in the zone (or loose, for undefined), which are in the way too. */
  items(zoneId: string | undefined): readonly Rect[];
}

/**
 * Gives each of `tiles` with no place yet the one the board draws it at, in order: an orchestrator's
 * new agent beside it, in its crew's rows, when it is in its orchestrator's zone; else the first free slot of its zone
 * (`freeTileSlot`); else, loose, a spot clear of the zones and loose tiles from the board's origin. The board slots
 * them so each time it draws, without saving it, so the daemon works out the same places to lay out round them.
 */
export function slotUnplaced<T>(tiles: readonly T[], slotting: Slotting<T>): void {
  const { zoneOf, placeOf } = slotting;
  for (const tile of tiles) {
    if (placeOf(tile) !== undefined) continue;
    const zoneId = zoneOf(tile);
    const siblings = tiles.filter((other) => zoneOf(other) === zoneId && placeOf(other) !== undefined);
    const inTheWay = slotting.items(zoneId);
    const from = slotting.orchestratorOf(tile);
    const orchestrator = from === undefined ? undefined : siblings.find((other) => slotting.agentOf(other) === from);
    const besideIt =
      orchestrator && crewSpot(placeOf(orchestrator)!, [...siblings.map(slotting.footprint), ...inTheWay, ...(zoneId === undefined ? slotting.zones : [])]);
    if (besideIt !== undefined) slotting.place(tile, besideIt);
    else if (zoneId === undefined) slotting.place(tile, freeSpotFor({ x: 0, y: 0 }, AGENT_TILE_SIZE, [...slotting.zones, ...siblings.map(slotting.rect)]));
    else slotting.place(tile, freeTileSlot(slotting.zoneWidth(zoneId), [...siblings.map(slotting.rect), ...inTheWay]));
  }
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
  for (let index = 0; index < MAX_SEARCH_STEPS; index++) {
    const slot = tileSlot(index, size.width);
    if (slot.y > bottom + EPSILON) return slots;
    if (slot.x + AGENT_TILE_SIZE.width + ZONE_PADDING <= size.width + EPSILON) slots.push(slot);
  }
  return slots;
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
