// The Spine layout rule: a zone's orchestrator stands at the left with its shells stacked under it, each ticket is one
// band (the agent, then its reviewers to the right), and the bands stack in columns to the right of the orchestrator.
// Clocks run along the top within the width the rest needs, and the zone hugs what it holds. Pure and deterministic:
// the only state is each band's place (its column and its place down it), kept from when the band arrived, so a band
// that leaves moves only the bands under it up, and nothing crosses the zone until a Tidy lays the bands out afresh.
// Nothing is laid over what stays put (a tile placed by hand, a note, a card): a band goes down clear of it.
import { lanesOf, LANE_SLOTS, type ArrangeLink, type ArrangeTile } from './board-arrange.ts';
import { AGENT_TILE_SIZE, clearOf, PERCH_ROOM, SPACING_GAPS, type Point, type Rect, type Size } from './board-layout.ts';
import { MIN_ZONE_SIZE, SPINE_MORE_CHIP_WIDTH, type ArrangeSpacing } from './protocol.ts';

/**
 * The gaps between bands, by spacing, in px: between two columns (`across`), between two bands in a column (`down`),
 * and the margin round a band's tiles that its band is drawn in (`band`), kept clear on its left.
 */
export const SPINE_GAPS: Readonly<Record<ArrangeSpacing, { across: number; down: number; band: number }>> = {
  compact: { across: 20, down: 12, band: 8 },
  normal: { across: 24, down: 20, band: 8 },
  roomy: { across: 48, down: 40, band: 8 },
};

/** The least number of bands a column holds before the next starts, however short the orchestrator's column is. */
const SPINE_LEAST_BANDS = 3;

export { SPINE_MORE_CHIP_WIDTH } from './protocol.ts';

/** Where a band was last laid: its column (`line`, counted from the one next to the head) and its place down it. */
export interface SpinePlace {
  line: number;
  rank: number;
}

/**
 * Each band's place, by its key (`issue:<id>`, or its first tile's id) and by each of its tiles' ids: the rule's only
 * state. Kept by its tiles too, a band keeps its place when its key changes (it gains a ticket, or its first tile goes).
 */
export type SpinePlaces = Record<string, SpinePlace>;

export interface SpineInput {
  /** The crew: its lead, its shells, its clocks and its agents. Hand-placed tiles are not among them. */
  tiles: readonly ArrangeTile[];
  links: readonly ArrangeLink[];
  spacing: ArrangeSpacing;
  /** Each band's place, kept from the last layout. Without, the bands are laid out afresh in start order (a Tidy). */
  places?: Readonly<SpinePlaces>;
  /**
   * What stays where it is (tiles placed by hand, notes, cards), relative to the zone, its characters' perches
   * included: nothing is laid over it, and the zone hugs it too.
   */
  fixed?: readonly Rect[];
  /**
   * The lead's tile where it stays (the user started it by hand, so the rule never moves it), its perch included and
   * among `fixed` too. The head column is its: the shells stack under it and the bands go right of it.
   */
  anchor?: Rect;
}

export interface SpineBand {
  key: string;
  /** Its tiles' ids, in the order they go: the agent, then its reviewers. */
  members: string[];
  /** Its column, counted from the one next to the orchestrator. */
  line: number;
  /** Where its tiles sit, relative to the zone, the room above them for their characters included. */
  rect: Rect;
}

export interface SpineLayout {
  /**
   * Where each of the crew's tiles goes (its top-left), relative to the zone. A clock set aside (`more.hidden`) goes
   * under the chip.
   */
  positions: Map<string, Point>;
  bands: SpineBand[];
  /** Each band's place, to keep for the next layout. */
  places: SpinePlaces;
  /** The chip that stands for the clocks that don't fit, relative to the zone, and those clocks, or null if all fit. */
  more: (Rect & { hidden: string[] }) | null;
  /** The zone's size: hugging what it holds, with its padding. */
  size: Size;
}

const sizeOf = (tile: ArrangeTile): Size => tile.size ?? AGENT_TILE_SIZE;
const byStart = (a: ArrangeTile, b: ArrangeTile) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

interface Band {
  key: string;
  tiles: ArrangeTile[];
  size: Size;
  /** Its place in start order, among the bands. */
  order: number;
}

/** The place `band` kept: under its key, else under the first of its tiles that kept one. */
const keptPlace = (band: Band, saved: Readonly<SpinePlaces>): SpinePlace | undefined =>
  saved[band.key] ?? band.tiles.map((tile) => saved[tile.id]).find((place) => place !== undefined);

/** Lays `input`'s crew out by the Spine rule. */
export function layOutSpine({ tiles, links, spacing, places: saved, fixed = [], anchor }: SpineInput): SpineLayout {
  const gaps = SPACING_GAPS[spacing];
  const spine = SPINE_GAPS[spacing];
  const { top, lanes } = lanesOf(tiles, links);
  const head = top.filter((tile) => tile.kind !== 'clock');
  const clocks = top.filter((tile) => tile.kind === 'clock').toSorted(byStart);
  const clockHeight = Math.max(0, ...clocks.map((tile) => sizeOf(tile).height));
  // The tiles' perches start a lane's gap below the clocks.
  const below = gaps.padding + (clocks.length > 0 ? clockHeight + gaps.lane - PERCH_ROOM : 0);

  /** `rect` moved down (`'down'`) or right clear of everything fixed, keeping a tile's gap from it. */
  const clear = (rect: Rect, way: 'down' | 'right'): Rect => {
    let at = rect;
    for (;;) {
      const inWay = fixed.filter((other) => !clearOf(at, [other], gaps.tile));
      if (inWay.length === 0) return at;
      at = way === 'down'
        ? { ...at, y: Math.max(...inWay.map((other) => other.y + other.height)) + gaps.tile }
        : { ...at, x: Math.max(...inWay.map((other) => other.x + other.width)) + gaps.tile };
    }
  };

  // The head column, from the top of its first tile's perch: the lead, then its shells, stacked. A lead that stays put
  // (`anchor`) heads it where it is.
  const positions = new Map<string, Point>();
  const headLeft = anchor?.x ?? gaps.padding;
  const headTop = anchor?.y ?? below;
  let headBottom = anchor === undefined ? headTop : anchor.y + anchor.height;
  // Under a lead that stays put, clear of it (it is fixed), perch and all.
  let down = (anchor === undefined ? below : headBottom + gaps.tile) + PERCH_ROOM;
  let headWidth = anchor?.width ?? 0;
  for (const tile of head) {
    const at = clear({ x: headLeft, y: down - PERCH_ROOM, width: sizeOf(tile).width, height: PERCH_ROOM + sizeOf(tile).height }, 'down');
    positions.set(tile.id, { x: at.x, y: at.y + PERCH_ROOM });
    headBottom = at.y + at.height;
    down = headBottom + gaps.tile;
    headWidth = Math.max(headWidth, sizeOf(tile).width);
  }
  const headHeight = headBottom - headTop;

  const bands: Band[] = lanes.map((lane, order) => {
    const members = LANE_SLOTS.flatMap((slot) => lane.slots[slot]);
    const width = members.reduce((sum, tile, index) => sum + (index === 0 ? 0 : gaps.tile) + sizeOf(tile).width, 0);
    const height = PERCH_ROOM + Math.max(...members.map((tile) => sizeOf(tile).height));
    return { key: lane.key, tiles: members, size: { width, height }, order };
  });

  // A column takes bands until it is as tall as the head column, and holds at least three.
  const least = SPINE_LEAST_BANDS * (PERCH_ROOM + AGENT_TILE_SIZE.height) + (SPINE_LEAST_BANDS - 1) * spine.down;
  const tall = Math.max(headHeight, least);
  const heightOf = (column: readonly Band[]) => column.reduce((sum, band, index) => sum + (index === 0 ? 0 : spine.down) + band.size.height, 0);
  let columns: Band[][];
  if (saved === undefined) {
    columns = [];
    let filling: Band[] = [];
    for (const band of bands) {
      filling.push(band);
      if (heightOf(filling) >= tall) {
        columns.push(filling);
        filling = [];
      }
    }
    if (filling.length > 0) columns.push(filling);
  } else {
    // Each band in the column it kept, in the order it kept there, the emptied columns dropped; then each new band at
    // the foot of the shortest column with room, or in a new column on the right.
    const kept: { band: Band; rank: number }[][] = [];
    const fresh: Band[] = [];
    for (const band of bands) {
      const place = keptPlace(band, saved);
      if (place === undefined) fresh.push(band);
      else (kept[place.line] ??= []).push({ band, rank: place.rank });
    }
    columns = kept
      .filter((column) => column !== undefined && column.length > 0)
      .map((column) => column.toSorted((a, b) => a.rank - b.rank || a.band.order - b.band.order).map(({ band }) => band));
    for (const band of fresh) {
      let shortest: Band[] | undefined;
      for (const column of columns) if (heightOf(column) < tall && (shortest === undefined || heightOf(column) < heightOf(shortest))) shortest = column;
      if (shortest === undefined) columns.push([band]);
      else shortest.push(band);
    }
  }

  // Each column's bands down from the top, each pushed down clear of what stays put.
  const laidBands: SpineBand[] = [];
  const places: SpinePlaces = {};
  let x = headLeft + (headWidth > 0 ? headWidth + spine.across : 0) + spine.band;
  for (const [line, column] of columns.entries()) {
    let y = below;
    for (const [rank, band] of column.entries()) {
      const rect = clear({ x, y, ...band.size }, 'down');
      let along = x;
      for (const tile of band.tiles) {
        positions.set(tile.id, { x: along, y: rect.y + PERCH_ROOM });
        along += sizeOf(tile).width + gaps.tile;
      }
      places[band.key] = { line, rank };
      for (const tile of band.tiles) places[tile.id] = { line, rank };
      laidBands.push({ key: band.key, members: band.tiles.map((tile) => tile.id), line, rect });
      y = rect.y + rect.height + spine.down;
    }
    x += Math.max(...column.map((band) => band.size.width)) + spine.across;
  }

  // The width the tiles take: the clocks run along the top within it, never wider, each clear of what stays put.
  const reach = Math.max(0, ...[...positions].map(([id, spot]) => spot.x + sizeOf(tiles.find((tile) => tile.id === id)!).width));
  let more: SpineLayout['more'] = null;
  if (clocks.length > 0) {
    // With no tiles to keep within, a clock still shows.
    const right = Math.max(reach, gaps.padding + sizeOf(clocks[0]!).width);
    const row = (chip: boolean) => {
      const spots: [string, Point][] = [];
      let along = gaps.padding;
      for (const tile of clocks) {
        const at = clear({ x: along, y: gaps.padding, ...sizeOf(tile) }, 'right');
        // The first always shows, the chip after it if need be.
        if (spots.length > 0 && at.x + at.width > (chip ? right - gaps.tile - SPINE_MORE_CHIP_WIDTH : right)) break;
        spots.push([tile.id, { x: at.x, y: at.y }]);
        along = at.x + at.width + gaps.tile;
      }
      return { spots, along };
    };
    let laid = row(false);
    if (laid.spots.length < clocks.length) {
      laid = row(true);
      const chip = clear({ x: laid.along, y: gaps.padding, width: SPINE_MORE_CHIP_WIDTH, height: clockHeight }, 'right');
      const hidden = clocks.slice(laid.spots.length).map((tile) => tile.id);
      // Set aside under the chip, hidden: never piled where they show.
      for (const id of hidden) positions.set(id, { x: chip.x, y: chip.y });
      more = { ...chip, hidden };
    }
    for (const [id, spot] of laid.spots) positions.set(id, spot);
  }

  const hiddenIds = new Set(more?.hidden ?? []);
  const shown = [...positions].filter(([id]) => !hiddenIds.has(id)).map(([id, spot]) => ({ ...spot, ...sizeOf(tiles.find((tile) => tile.id === id)!) }));
  const all = [...shown, ...(more === null ? [] : [more]), ...fixed];
  return {
    positions,
    bands: laidBands,
    places,
    more,
    size: {
      width: Math.max(MIN_ZONE_SIZE.width, ...all.map((rect) => rect.x + rect.width + gaps.padding)),
      height: Math.max(MIN_ZONE_SIZE.height, ...all.map((rect) => rect.y + rect.height + gaps.padding)),
    },
  };
}
