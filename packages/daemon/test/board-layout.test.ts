import { describe, expect, it } from 'vitest';
import { MIN_ZONE_SIZE, TILE_SLOT, UNSORTED_GROUP_WIDTH, unsortedGroupHeight } from '../src/protocol.ts';
import {
  AGENT_TILE_SIZE,
  besideSpot,
  clearOf,
  CREW_GAP,
  crewSpot,
  footprint,
  freeItemSpot,
  freeSpotFor,
  ITEM_GAP,
  ITEM_INSET,
  freeTileSlot,
  isFolded,
  unfoldedFrom,
  leastZoneSize,
  nearestFreeSpot,
  packTiles,
  PERCH_ROOM,
  ROW_STEP,
  sizedFootprint,
  slotUnplaced,
  tileSizeKey,
  tileSlot,
  TILE_GAP,
  ZONE_PADDING,
  zoneHeightFor,
  zoneMinSize,
  type ZoneTile,
  type Rect,
} from '../src/board-layout.ts';

const size = { width: 100, height: 50 };

describe('freeSpotFor', () => {
  it('keeps the wanted spot when nothing is there', () => {
    expect(freeSpotFor({ x: 10, y: 20 }, size, [])).toEqual({ x: 10, y: 20 });
  });

  it('keeps the wanted spot when existing zones are clear of it', () => {
    const elsewhere = { x: 500, y: 500, width: 100, height: 50 };
    expect(freeSpotFor({ x: 10, y: 20 }, size, [elsewhere])).toEqual({ x: 10, y: 20 });
  });

  it('steps right past a zone that covers the wanted spot, leaving a gap', () => {
    const covering = { x: 0, y: 0, width: 200, height: 200 };
    expect(freeSpotFor({ x: 10, y: 20 }, size, [covering])).toEqual({ x: 240, y: 20 });
  });

  it('keeps stepping until clear of a row of zones', () => {
    const row = [
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 230, y: 0, width: 200, height: 200 },
    ];
    expect(freeSpotFor({ x: 10, y: 20 }, size, row)).toEqual({ x: 470, y: 20 });
  });
});

describe('tileSlot', () => {
  const step = AGENT_TILE_SIZE.width + TILE_GAP;
  // Each row leaves room above its tiles for their subagent characters.
  const top = ZONE_PADDING + PERCH_ROOM;
  const rowStep = PERCH_ROOM + AGENT_TILE_SIZE.height + TILE_GAP;
  // Room for exactly three tiles across.
  const width = 2 * ZONE_PADDING + 3 * AGENT_TILE_SIZE.width + 2 * TILE_GAP;

  it('puts the first tile in the top-left corner, inside the padding and below room for its characters', () => {
    expect(tileSlot(0, width)).toEqual({ x: ZONE_PADDING, y: top });
  });

  it('fills a row left to right, then wraps', () => {
    expect([1, 2, 3].map((index) => tileSlot(index, width))).toEqual([
      { x: ZONE_PADDING + step, y: top },
      { x: ZONE_PADDING + 2 * step, y: top },
      { x: ZONE_PADDING, y: top + rowStep },
    ]);
  });

  it('keeps one tile per row in a zone narrower than a tile', () => {
    expect(tileSlot(1, 100)).toEqual({ x: ZONE_PADDING, y: top + rowStep });
  });
});

describe('zoneHeightFor', () => {
  const rowHeight = PERCH_ROOM + AGENT_TILE_SIZE.height + TILE_GAP;
  const threeAcross = 2 * ZONE_PADDING + 3 * AGENT_TILE_SIZE.width + 2 * TILE_GAP;

  it('is one row tall for an empty zone, so it never collapses below a row', () => {
    expect(zoneHeightFor(0, threeAcross)).toBe(2 * ZONE_PADDING + rowHeight);
  });

  it('grows a row for every row of tiles', () => {
    expect(zoneHeightFor(3, threeAcross)).toBe(2 * ZONE_PADDING + rowHeight);
    expect(zoneHeightFor(4, threeAcross)).toBe(2 * ZONE_PADDING + 2 * rowHeight);
  });

  it('holds the last tile of tileSlot, with the padding below it', () => {
    for (const count of [1, 4, 7]) {
      const last = tileSlot(count - 1, threeAcross);
      expect(zoneHeightFor(count, threeAcross)).toBeGreaterThanOrEqual(last.y + AGENT_TILE_SIZE.height + ZONE_PADDING);
    }
  });

  it('needs more rows in a narrower zone', () => {
    expect(zoneHeightFor(3, 100)).toBe(2 * ZONE_PADDING + 3 * rowHeight);
  });
});

describe('freeTileSlot', () => {
  const threeAcross = 2 * ZONE_PADDING + 3 * AGENT_TILE_SIZE.width + 2 * TILE_GAP;
  const at = (point: { x: number; y: number }) => ({ ...point, ...AGENT_TILE_SIZE });

  it('takes the first slot in an empty zone, where tileSlot puts the first tile', () => {
    expect(freeTileSlot(threeAcross, [])).toEqual(tileSlot(0, threeAcross));
  });

  it('fills slots in order as tileSlot lays them out, so tiles placed one by one land where they always did', () => {
    const taken = [0, 1, 2, 3].map((index) => at(tileSlot(index, threeAcross)));
    expect(freeTileSlot(threeAcross, taken)).toEqual(tileSlot(4, threeAcross));
  });

  it('skips a slot any tile covers even partly, and takes one a moved tile has left', () => {
    const nudged = at({ x: tileSlot(0, threeAcross).x + 30, y: tileSlot(0, threeAcross).y + 10 });
    expect(freeTileSlot(threeAcross, [nudged])).toEqual(tileSlot(2, threeAcross));
    const movedAway = at({ x: 2000, y: 2000 });
    expect(freeTileSlot(threeAcross, [movedAway, at(tileSlot(1, threeAcross))])).toEqual(tileSlot(0, threeAcross));
  });

  it('skips the slots a resized tile would cover at its own size', () => {
    const big = { width: 2 * AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height };
    expect(freeTileSlot(threeAcross, [at(tileSlot(1, threeAcross))], big)).toEqual(tileSlot(3, threeAcross));
  });
});

describe('zoneMinSize', () => {
  const rowHeight = PERCH_ROOM + AGENT_TILE_SIZE.height + TILE_GAP;

  it('is one row tall for an empty zone', () => {
    expect(zoneMinSize([]).height).toBe(2 * ZONE_PADDING + rowHeight);
  });

  it('holds tiles laid out by tileSlot as zoneHeightFor does', () => {
    const width = 2 * ZONE_PADDING + 3 * AGENT_TILE_SIZE.width + 2 * TILE_GAP;
    const tiles = [0, 1, 2, 3].map((index) => ({ ...tileSlot(index, width), ...AGENT_TILE_SIZE }));
    expect(zoneMinSize(tiles)).toEqual({ width, height: zoneHeightFor(4, width) });
  });

  it('reaches past a tile moved far into the zone, with the padding round it', () => {
    const tile = { x: 700, y: 400, ...AGENT_TILE_SIZE };
    expect(zoneMinSize([tile])).toEqual({
      width: 700 + AGENT_TILE_SIZE.width + ZONE_PADDING,
      height: 400 + AGENT_TILE_SIZE.height + TILE_GAP + ZONE_PADDING,
    });
  });
});

/** The tile geometry these scenarios are built from: a tile's size, the gap between tiles, a zone's padding, the perch. */
const W = AGENT_TILE_SIZE.width;
const H = AGENT_TILE_SIZE.height;
/** Where a zone's first row of tiles sits: below its padding and the room for perched subagents. */
const TOP = ZONE_PADDING + PERCH_ROOM;
/** From one row of tiles to the next. */
const ROW = H + TILE_GAP + PERCH_ROOM;
/** The narrowest zone that holds two tiles side by side. */
const TWO_WIDE = 2 * ZONE_PADDING + 2 * W + TILE_GAP;

describe('packTiles', () => {
  it('never moves a resized tile: the zone stops at its edge, and the default-size tiles pack round it', () => {
    const big = { id: 'big', x: 20, y: 44, width: 400, height: 300 };
    // Its far edge needs 20 + 400 + padding; narrower than that, the zone can't shrink.
    expect(packTiles({ width: 440, height: 400 }, [big])?.get('big')).toEqual({ x: 20, y: 44 });
    expect(packTiles({ width: 430, height: 400 }, [big])).toBeUndefined();
    expect(packTiles({ width: 440, height: 300 }, [big])).toBeUndefined();
  });

  const tiles = (places: Record<string, [number, number]>) => Object.entries(places).map(([id, [x, y]]) => ({ id, x, y }));
  const placed = (packed: ReadonlyMap<string, { x: number; y: number }> | undefined) =>
    packed && Object.fromEntries([...packed].map(([id, { x, y }]) => [id, [x, y]]));

  it('leaves every tile where it is while they all still fit', () => {
    expect(placed(packTiles({ width: 700, height: 300 }, tiles({ a: [20, 44], b: [400, 44] })))).toEqual({ a: [20, 44], b: [400, 44] });
  });

  it('moves only a tile that no longer fits, just far enough inward', () => {
    expect(placed(packTiles({ width: 600, height: 300 }, tiles({ a: [20, TOP], b: [500, TOP] })))).toEqual({ a: [20, TOP], b: [600 - ZONE_PADDING - W, TOP] });
  });

  it('moves a tile that no longer fits to the nearest free spot when the spot inward is taken', () => {
    expect(placed(packTiles({ width: 420, height: 400 }, tiles({ a: [20, TOP], b: [300, TOP] })))).toEqual({ a: [20, TOP], b: [420 - ZONE_PADDING - W, TOP + ROW] });
  });

  it('finds the nearest free spot however far it is from the tiles in the way', () => {
    // Every spot near b is taken: the nearest free one is under the lower row.
    const width = TWO_WIDE + 24;
    const right = ZONE_PADDING + W + TILE_GAP;
    const packed = packTiles({ width, height: TOP + 2 * ROW + H + ZONE_PADDING + TILE_GAP + 76 }, tiles({ a: [20, TOP], c: [right, TOP], d: [20, TOP + ROW], e: [right, TOP + ROW], b: [400, TOP] }));
    expect(placed(packed)).toEqual({ a: [20, TOP], c: [right, TOP], d: [20, TOP + ROW], e: [right, TOP + ROW], b: [width - ZONE_PADDING - W, TOP + 2 * ROW] });
  });

  it('keeps clear of notes, text and shapes in the zone', () => {
    const sticky = { x: 20, y: TOP + H + TILE_GAP, width: 200, height: 200 };
    const packed = packTiles({ width: 420, height: sticky.y + 200 + TILE_GAP + PERCH_ROOM + H + ZONE_PADDING + TILE_GAP + 40 }, tiles({ a: [20, TOP], b: [300, TOP] }), [sticky]);
    expect(packed!.get('b')).toEqual({ x: 420 - ZONE_PADDING - W, y: sticky.y + 200 + TILE_GAP + PERCH_ROOM });
  });

  it('refuses rather than move a tile that still fits, when the cut tiles have nowhere to go', () => {
    expect(packTiles({ width: 536, height: 330 }, tiles({ a: [150, 100], b: [600, 44] }))).toBeUndefined();
  });

  it('gives up once the tiles fit no tighter: the zone is at its least size for them', () => {
    const two = tiles({ a: [20, TOP], b: [600, TOP] });
    expect(packTiles({ width: TWO_WIDE, height: 300 }, two)).toBeDefined();
    expect(packTiles({ width: TWO_WIDE - 1, height: 300 }, two)).toBeUndefined();
    expect(packTiles({ width: 300, height: 200 }, two)).toBeUndefined();
  });

  it('packs nothing in a zone with no tiles', () => {
    expect(packTiles({ width: 10, height: 10 }, [])).toEqual(new Map());
  });

  /** Shrinks a zone `size` from its right edge 10px at a time, packing from where the last step left the tiles, until it refuses. */
  function shrink(size: { width: number; height: number }, start: ZoneTile[], obstacles: Rect[] = []) {
    const steps: { width: number; before: ZoneTile[]; after: ZoneTile[] }[] = [];
    let now = start;
    for (let width = size.width - 10; width >= MIN_ZONE_SIZE.width; width -= 10) {
      const packed = packTiles({ width, height: size.height }, now, obstacles);
      if (packed === undefined) break;
      const after = now.map((tile) => ({ id: tile.id, ...packed.get(tile.id)! }));
      steps.push({ width, before: now, after });
      now = after;
    }
    return steps;
  }

  const fits = (tile: ZoneTile, size: { width: number; height: number }) =>
    tile.x >= 20 && tile.y >= TOP && tile.x <= size.width - W - ZONE_PADDING && tile.y <= size.height - H - ZONE_PADDING - TILE_GAP;

  it('never moves a tile that still fits as the zone shrinks, nor brings a moved one back', () => {
    const size = { width: 1400, height: 640 };
    const start = [
      { id: 't0', x: 205, y: 227 },
      { id: 't1', x: 495, y: 194 },
      { id: 't2', x: 281, y: 454 },
      { id: 't3', x: 792, y: 469 },
    ];
    const steps = shrink(size, start);
    for (const { width, before, after } of steps) {
      before.forEach((tile, index) => {
        if (fits(tile, { width, height: size.height })) expect(after[index], `${tile.id} at ${width}`).toEqual(tile);
      });
    }
    // t0 fits all the way, so it never moves; the zone stops once the column round it is full.
    expect(steps.every((step) => step.after[0]!.x === start[0]!.x && step.after[0]!.y === start[0]!.y)).toBe(true);
    const last = steps.at(-1)!;
    expect(last.width).toBeLessThan(792 + W + ZONE_PADDING);
    expect(packTiles({ width: last.width - 10, height: size.height }, last.after)).toBeUndefined();
  });

  it('over random hand-placed layouts: keeps tiles that fit, and keeps every tile inside and clear of the rest', () => {
    let seed = 7;
    // Thousands of checks per run: collect what breaks and assert once, as a matcher call per check dominates the cost.
    const broken: string[] = [];
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let run = 0; run < 150; run++) {
      const size = { width: 1400, height: 640 };
      const start: ZoneTile[] = [];
      const count = 2 + Math.floor(random() * 5);
      while (start.length < count) {
        const tile = {
          id: `t${start.length}`,
          x: 20 + Math.round(random() * (size.width - 2 * ZONE_PADDING - W)),
          y: TOP + Math.round(random() * (size.height - TOP - H - ZONE_PADDING - TILE_GAP)),
        };
        const clear = start.every(
          (other) => Math.abs(other.x - tile.x) >= AGENT_TILE_SIZE.width + TILE_GAP || Math.abs(other.y - tile.y) >= AGENT_TILE_SIZE.height + TILE_GAP + PERCH_ROOM,
        );
        if (clear) start.push(tile);
      }
      const steps = shrink(size, start);
      for (const { width, before, after } of steps) {
        const zone = { width, height: size.height };
        after.forEach((tile, index) => {
          if (!fits(tile, zone)) broken.push(`run ${run}: ${tile.id} inside at ${width}`);
          const was = before[index]!;
          if (fits(was, zone) && (tile.x !== was.x || tile.y !== was.y)) broken.push(`run ${run}: ${tile.id} kept at ${width}`);
          for (const other of after.slice(index + 1)) {
            const apart =
              Math.abs(other.x - tile.x) >= AGENT_TILE_SIZE.width + TILE_GAP - 1e-6 ||
              Math.abs(other.y - tile.y) >= AGENT_TILE_SIZE.height + TILE_GAP + PERCH_ROOM - 1e-6;
            if (!apart) broken.push(`run ${run}: ${tile.id} and ${other.id} apart at ${width}`);
          }
        });
      }
      // It shrinks at least until the first tile is cut.
      const rightmost = Math.max(...start.map((tile) => tile.x)) + AGENT_TILE_SIZE.width + ZONE_PADDING;
      if (!((steps.at(-1)?.width ?? size.width) < rightmost)) broken.push(`run ${run} stopped`);
    }
    expect(broken).toEqual([]);
  });
});

describe('leastZoneSize', () => {
  it('is as narrow as rows of tiles at its height allow, and as short as rows at its width allow', () => {
    // Two rows fit, not three; three tiles need two to a row.
    const height = TOP + ROW + H + ZONE_PADDING + 20;
    expect(leastZoneSize(3, { width: 900, height })).toEqual({ width: TWO_WIDE, height: zoneHeightFor(3, 900) });
    expect(packTiles({ width: TWO_WIDE, height }, [0, 1, 2].map((i) => ({ id: `${i}`, x: 900, y: 0 })))).toBeDefined();
    expect(packTiles({ width: TWO_WIDE - 1, height }, [0, 1, 2].map((i) => ({ id: `${i}`, x: 900, y: 0 })))).toBeUndefined();
  });

  it('is one tile wide in a zone too short for a second row, with its tiles in one row', () => {
    expect(leastZoneSize(2, { width: 900, height: TOP + H + ZONE_PADDING }).width).toBe(TWO_WIDE);
  });

  it('is no size at all with no tiles', () => {
    expect(leastZoneSize(0, { width: 900, height: 340 })).toEqual({ width: 0, height: 0 });
  });
});

describe('freeItemSpot', () => {
  const card = { width: 240, height: 112 };

  it('is the zone\'s top-left inset when nothing is there', () => {
    expect(freeItemSpot(800, card, [])).toEqual({ x: ITEM_INSET, y: ITEM_INSET });
  });

  it('steps past what covers a spot, even partly, along the row then down', () => {
    const first = { x: ITEM_INSET, y: ITEM_INSET };
    const tile = { x: 20, y: 44, ...AGENT_TILE_SIZE };
    expect(freeItemSpot(800, card, [tile])).toEqual({ x: first.x + card.width + ITEM_GAP, y: ITEM_INSET });
    const row = [tile, { x: 300, y: 44, ...AGENT_TILE_SIZE }, { x: 600, y: 44, ...AGENT_TILE_SIZE }];
    const spot = freeItemSpot(800, card, row);
    expect(row.some((other) => spot.x < other.x + other.width && other.x < spot.x + card.width && spot.y < other.y + other.height && other.y < spot.y + card.height)).toBe(false);
  });

  it('is one to a row in a zone too narrow for two', () => {
    expect(freeItemSpot(100, card, [{ x: ITEM_INSET, y: ITEM_INSET, ...card }])).toEqual({ x: ITEM_INSET, y: ITEM_INSET + card.height + ITEM_GAP });
  });
});

// The daemon makes the Unsorted group (and works out where a zone is drawn) with its own copy of these numbers.
describe('the daemon\'s copy of the tile slots', () => {
  it('is the board\'s', () => {
    expect(TILE_SLOT).toEqual({ ...AGENT_TILE_SIZE, padding: ZONE_PADDING, gap: TILE_GAP, perchRoom: PERCH_ROOM });
  });

  it('sizes the Unsorted group as the board would size a zone for its tiles', () => {
    for (const count of [0, 1, 2, 3, 4, 7]) expect(unsortedGroupHeight(count)).toBe(zoneHeightFor(count, UNSORTED_GROUP_WIDTH));
    expect(tileSlot(1, UNSORTED_GROUP_WIDTH).y).toBe(tileSlot(0, UNSORTED_GROUP_WIDTH).y);
    expect(tileSlot(2, UNSORTED_GROUP_WIDTH).y).toBeGreaterThan(tileSlot(0, UNSORTED_GROUP_WIDTH).y);
  });
});

describe('besideSpot', () => {
  const of = { x: 100, y: 200, width: 300, height: 150 };

  it('puts a tile a gap to the right or left of another, level with it', () => {
    expect(besideSpot(of, 'right', AGENT_TILE_SIZE)).toEqual({ x: 100 + 300 + TILE_GAP, y: 200 });
    expect(besideSpot(of, 'left', AGENT_TILE_SIZE)).toEqual({ x: 100 - TILE_GAP - AGENT_TILE_SIZE.width, y: 200 });
  });

  it('puts a tile below or above another with room for its characters, lined up on its left', () => {
    expect(besideSpot(of, 'below', AGENT_TILE_SIZE)).toEqual({ x: 100, y: 200 + 150 + TILE_GAP + PERCH_ROOM });
    expect(besideSpot(of, 'above', AGENT_TILE_SIZE)).toEqual({ x: 100, y: 200 - PERCH_ROOM - TILE_GAP - AGENT_TILE_SIZE.height });
  });

  it('leaves the tile clear of the one it is beside, on every side', () => {
    for (const side of ['below', 'right', 'left', 'above'] as const) {
      expect(clearOf(sizedFootprint(besideSpot(of, side, AGENT_TILE_SIZE), AGENT_TILE_SIZE), [sizedFootprint(of, of)])).toBe(true);
    }
  });
});

describe('nearestFreeSpot', () => {
  const open = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

  it('keeps the wanted spot when it is clear', () => {
    expect(nearestFreeSpot({ x: 40, y: 60 }, [], open)).toEqual({ x: 40, y: 60 });
  });

  it('moves the least distance clear of what is in the way, at the size given', () => {
    const big = { width: 400, height: 300 };
    const blocking = [sizedFootprint({ x: 0, y: 100 }, AGENT_TILE_SIZE)];
    const spot = nearestFreeSpot({ x: 0, y: 120 }, blocking, open, big)!;
    expect(clearOf(sizedFootprint(spot, big), blocking)).toBe(true);
    expect(spot).toEqual({ x: 0, y: 100 + AGENT_TILE_SIZE.height + TILE_GAP + PERCH_ROOM });
  });

  it('stays inside the region it is given', () => {
    const region = { left: ZONE_PADDING, top: ZONE_PADDING + PERCH_ROOM, right: Infinity, bottom: Infinity };
    expect(nearestFreeSpot({ x: -500, y: -500 }, [], region)).toEqual({ x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM });
  });
});

describe('tileSizeKey', () => {
  it("is the board's node id of a tile, which its resized size is kept under in the view state", () => {
    expect(tileSizeKey('agent', 'abc')).toBe('agent:abc');
    expect(tileSizeKey('shell', 'abc')).toBe('shell:abc');
  });
});

describe('crewSpot', () => {
  const { width } = AGENT_TILE_SIZE;
  const at = { x: 20, y: 44 };
  const beside = { x: at.x + width + CREW_GAP, y: at.y };

  it('puts the first of a crew beside its orchestrator, and the next beside that', () => {
    expect(crewSpot(at, [footprint(at)])).toEqual(beside);
    expect(crewSpot(at, [footprint(at), footprint(beside)])).toEqual({ x: beside.x + width + TILE_GAP, y: at.y });
  });

  it('goes round a tile in the way, a row down once a row is full', () => {
    const row = [0, 1, 2].map((col) => ({ x: beside.x + col * (width + TILE_GAP), y: at.y }));
    expect(crewSpot(at, [footprint(at), ...row.map(footprint)])).toEqual({ x: beside.x, y: at.y + ROW_STEP });
  });
});

describe('slotUnplaced', () => {
  interface Tile {
    id: string;
    zoneId?: string;
    at?: { x: number; y: number };
    from?: string;
  }
  const slot = (tiles: Tile[], items: Record<string, Rect[]> = {}) => {
    slotUnplaced(tiles, {
      zoneOf: (tile) => tile.zoneId,
      placeOf: (tile) => tile.at,
      place: (tile, spot) => (tile.at = spot),
      agentOf: (tile) => tile.id,
      orchestratorOf: (tile) => tile.from,
      rect: (tile) => ({ ...tile.at!, ...AGENT_TILE_SIZE }),
      footprint: (tile) => footprint(tile.at!),
      zoneWidth: () => 900,
      zones: [{ x: 0, y: 0, width: 900, height: 600 }],
      items: (zoneId) => items[zoneId ?? ''] ?? [],
    });
    return Object.fromEntries(tiles.map((tile) => [tile.id, tile.at]));
  };

  it('leaves a placed tile be, and slots the rest of its zone into the free slots after it', () => {
    expect(slot([{ id: 'a', zoneId: 'z', at: tileSlot(0, 900) }, { id: 'b', zoneId: 'z' }, { id: 'c', zoneId: 'z' }])).toEqual({
      a: tileSlot(0, 900),
      b: tileSlot(1, 900),
      c: tileSlot(2, 900),
    });
  });

  it("puts an orchestrator's new agent beside it, in its crew's rows", () => {
    const lead = tileSlot(0, 900);
    expect(slot([{ id: 'lead', zoneId: 'z', at: lead }, { id: 'w', zoneId: 'z', from: 'lead' }]).w).toEqual({ x: lead.x + AGENT_TILE_SIZE.width + CREW_GAP, y: lead.y });
  });

  it('keeps a slotted tile off the zone items, and a loose one clear of the zones', () => {
    const note = { ...tileSlot(0, 900), width: 200, height: 100 };
    expect(slot([{ id: 'a', zoneId: 'z' }], { z: [note] }).a).toEqual(tileSlot(1, 900));
    expect(slot([{ id: 'loose' }]).loose).toEqual(freeSpotFor({ x: 0, y: 0 }, AGENT_TILE_SIZE, [{ x: 0, y: 0, width: 900, height: 600 }]));
  });
});

describe('a full or crowded zone', () => {
  // A zone whose every slot the search tries is covered: the searches stop at their cap, and take a spot below it all.
  const wall: Rect = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };

  it('still gives a new tile a spot, below everything, once every slot is taken', () => {
    expect(freeTileSlot(900, [wall])).toEqual({ x: ZONE_PADDING, y: wall.y + wall.height + TILE_GAP + PERCH_ROOM });
  });

  it('still gives a new item a spot, below everything', () => {
    expect(freeItemSpot(900, size, [wall])).toEqual({ x: ITEM_INSET, y: wall.y + wall.height + ITEM_GAP });
  });

  it('steps a new zone past any number of zones in a row, and stops', () => {
    const row = Array.from({ length: 500 }, (_, index) => ({ x: index * 100, y: 0, width: 120, height: 100 }));
    const spot = freeSpotFor({ x: 0, y: 0 }, size, row);
    for (const zone of row) expect(spot.x >= zone.x + zone.width).toBe(true);
  });

  it('slots unplaced tiles into a crowded zone without hanging', () => {
    const tiles = Array.from({ length: 50 }, (_, index) => ({ id: `t${index}`, at: undefined as { x: number; y: number } | undefined }));
    slotUnplaced(tiles, {
      zoneOf: () => 'z',
      placeOf: (tile) => tile.at,
      place: (tile, spot) => (tile.at = spot),
      agentOf: () => undefined,
      orchestratorOf: () => undefined,
      rect: (tile) => ({ ...tile.at!, ...AGENT_TILE_SIZE }),
      footprint: (tile) => footprint(tile.at!),
      zoneWidth: () => 300,
      zones: [],
      items: () => [wall],
    });
    expect(tiles.every((tile) => tile.at !== undefined)).toBe(true);
  });
});

describe('isFolded', () => {
  const closed = { sessionId: 'a', endedAt: '2026-01-01T00:00:00Z', state: 'done', shellSessionId: null, shellHarness: null } as const;

  it('folds a closed agent unless the user unfolded it', () => {
    expect(isFolded(closed, new Set())).toBe(true);
    expect(isFolded(closed, new Set(['agent:a']))).toBe(false);
  });

  it('never folds a live agent, nor one a restart stopped', () => {
    expect(isFolded({ ...closed, endedAt: null, state: 'idle' }, new Set())).toBe(false);
    expect(isFolded({ ...closed, state: 'stopped-by-restart' }, new Set())).toBe(false);
  });

  it('never folds an ended agent whose pane is a live shell, or whose harness the user runs by hand in it: it keeps its Restart', () => {
    expect(isFolded({ ...closed, shellSessionId: 'shell-1' }, new Set())).toBe(false);
    expect(isFolded({ ...closed, shellSessionId: 'shell-1', shellHarness: 'claude' }, new Set())).toBe(false);
  });
});

describe('unfoldedFrom', () => {
  it('takes only strings, once each', () => {
    expect(unfoldedFrom(['agent:a', 3, 'agent:a', null, 'agent:b'])).toEqual(['agent:a', 'agent:b']);
    expect(unfoldedFrom({ a: 1 })).toEqual([]);
  });
});
