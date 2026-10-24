import { describe, expect, it } from 'vitest';
import { AGENT_TILE_SIZE, overlaps, PERCH_ROOM, type Rect } from '../src/board-layout.ts';
import { arrangeBoard, BOARD_ARRANGE_GAP as GAP, type BoardZone } from '../src/arrange-board.ts';

/** A messy board: six zones of mixed sizes, some on top of each other. */
const MESSY: BoardZone[] = [
  { id: 'web', x: 300, y: 80, width: 900, height: 600 },
  { id: 'api', x: 700, y: 400, width: 700, height: 500 },
  { id: 'docs', x: -200, y: 900, width: 500, height: 300 },
  { id: 'infra', x: 1600, y: 0, width: 600, height: 700 },
  { id: 'ops', x: 50, y: 1400, width: 1100, height: 400 },
  { id: 'misc', x: 1500, y: 1350, width: 400, height: 260 },
];
const STRAYS = [
  { id: 'shell:1', x: 900, y: 2600 },
  { id: 'agent:2', x: -400, y: 40 },
  { id: 'agent:3', x: 1200, y: 760, width: 400, height: 300 },
];

/** Every zone where `arrangeBoard` put it, or where it was. */
const zonesAfter = (zones: readonly BoardZone[], moved: Map<string, { x: number; y: number }>): Rect[] =>
  zones.map((zone) => ({ ...zone, ...moved.get(zone.id) }));
/** Every tile's footprint (with its characters' room) where `arrangeBoard` put it, or where it was. */
const tilesAfter = (tiles: typeof STRAYS, moved: Map<string, { x: number; y: number }>): Rect[] =>
  tiles.map((tile) => {
    const at = { ...tile, ...moved.get(tile.id) };
    const size = { width: tile.width ?? AGENT_TILE_SIZE.width, height: tile.height ?? AGENT_TILE_SIZE.height };
    return { x: at.x, y: at.y - PERCH_ROOM, width: size.width, height: size.height + PERCH_ROOM };
  });
/** `zones` and `tiles` where `arrangeBoard` put them, and arranged again: what that second arrange moves. */
function arrangedAgain(zones: readonly BoardZone[], tiles: typeof STRAYS, fixed: readonly Rect[] = []) {
  const first = arrangeBoard(zones, tiles, fixed);
  return arrangeBoard(
    zones.map((zone) => ({ ...zone, ...first.zones.get(zone.id) })),
    tiles.map((tile) => ({ ...tile, ...first.tiles.get(tile.id) })),
    fixed,
  );
}
const NOTHING = { zones: new Map(), tiles: new Map() };

/** The space between two rects, the larger of the two axes' (negative: they overlap on both). */
const spaceBetween = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));

describe('arrangeBoard', () => {
  it('lays zones out in rows in reading order from the top-left of where they are, a gap apart, top-aligned', () => {
    const zones = [
      { id: 'b', x: 2000, y: 130, width: 600, height: 300 },
      { id: 'a', x: 100, y: 100, width: 500, height: 400 },
      { id: 'c', x: 50, y: 1200, width: 700, height: 200 },
    ];
    const { zones: moved } = arrangeBoard(zones, []);
    expect(moved).toEqual(
      new Map([
        ['a', { x: 50, y: 100 }],
        ['b', { x: 50 + 500 + GAP, y: 100 }],
        ['c', { x: 50 + 500 + GAP + 600 + GAP, y: 100 }],
      ]),
    );
  });

  it('leaves a messy board of six zones and strays with no overlaps and every zone at least a gap from the rest', () => {
    const { zones, tiles } = arrangeBoard(MESSY, STRAYS);
    const all = [...zonesAfter(MESSY, zones), ...tilesAfter(STRAYS, tiles)];
    for (const [index, a] of all.entries()) {
      for (const b of all.slice(index + 1)) expect(overlaps(a, b), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(false);
    }
    const placed = zonesAfter(MESSY, zones);
    for (const [index, a] of placed.entries()) for (const b of placed.slice(index + 1)) expect(spaceBetween(a, b)).toBeGreaterThanOrEqual(GAP);
    // From the zones' own top-left, whatever the strays: three to a row, so two rows, the second a gap below the
    // tallest of the first.
    expect(Math.min(...placed.map((zone) => zone.x))).toBe(-200);
    expect(new Set(placed.map((zone) => zone.y))).toEqual(new Set([0, 700 + GAP]));
  });

  it('gathers the loose tiles in rows a gap below the zones, in reading order', () => {
    const { zones, tiles } = arrangeBoard(MESSY, STRAYS);
    const bottom = Math.max(...zonesAfter(MESSY, zones).map((zone) => zone.y + zone.height));
    const footprints = tilesAfter(STRAYS, tiles);
    expect(Math.min(...footprints.map((tile) => tile.y))).toBe(bottom + GAP);
    // agent:2 is topmost, then agent:3, then shell:1: left to right.
    const order = [...tiles.entries()].toSorted(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([id]) => id);
    expect(order).toEqual(['agent:2', 'agent:3', 'shell:1']);
  });

  it('keeps a gap from the notes and shapes loose on the board, which stay put', () => {
    const sticky = { x: 600, y: 100, width: 200, height: 200 };
    const zones: BoardZone[] = [
      { id: 'a', x: 0, y: 0, width: 500, height: 400 },
      { id: 'b', x: 2000, y: 0, width: 500, height: 400 },
    ];
    const { zones: moved, tiles } = arrangeBoard(zones, [{ id: 'shell:1', x: 0, y: 900 }], [sticky]);
    expect(moved.get('b')).toEqual({ x: sticky.x + sticky.width + GAP, y: 0 });
    expect(arrangedAgain(zones, [{ id: 'shell:1', x: 0, y: 900 }], [sticky])).toEqual(NOTHING);
    for (const rect of [...zonesAfter(zones, moved), ...tilesAfter([{ id: 'shell:1', x: 0, y: 900 }], tiles)]) {
      expect(spaceBetween(rect, sticky)).toBeGreaterThanOrEqual(GAP);
    }
  });

  it('takes a zone below a wide shape loose across its row rather than far past its end, the nearer free spot', () => {
    const divider = { x: -5000, y: 300, width: 20_000, height: 50 };
    const zones: BoardZone[] = [
      { id: 'a', x: 0, y: 0, width: 500, height: 400 },
      { id: 'b', x: 0, y: 1000, width: 500, height: 400 },
      { id: 'c', x: 0, y: 2000, width: 500, height: 400 },
    ];
    const { zones: moved } = arrangeBoard(zones, [], [divider]);
    const below = divider.y + divider.height + GAP;
    expect(moved).toEqual(
      new Map([
        ['a', { x: 0, y: below }],
        ['b', { x: 500 + GAP, y: below }],
        ['c', { x: 2 * (500 + GAP), y: below }],
      ]),
    );
    expect(arrangedAgain(zones, [], [divider])).toEqual(NOTHING);
  });

  it('moves a whole row down past a sticky in its first slot, keeping it top-aligned, and arranged again moves nothing', () => {
    const sticky = { x: 0, y: 0, width: 300, height: 100 };
    const zones: BoardZone[] = [
      { id: 'a', x: 0, y: 0, width: 500, height: 300 },
      { id: 'b', x: 2000, y: 0, width: 400, height: 300 },
    ];
    const below = sticky.height + GAP;
    expect(arrangeBoard(zones, [], [sticky]).zones).toEqual(
      new Map([
        ['a', { x: 0, y: below }],
        ['b', { x: 500 + GAP, y: below }],
      ]),
    );
    expect(arrangedAgain(zones, [], [sticky])).toEqual(NOTHING);
    expect(arrangedAgain(zones, [{ id: 'shell:1', x: 0, y: 900 }], [sticky])).toEqual(NOTHING);
  });

  it('puts the next row below a zone that went below a shape, and the strays below that', () => {
    const shape = { x: 600, y: 0, width: 300, height: 500 };
    const zones: BoardZone[] = [
      { id: 'a', x: 0, y: 0, width: 500, height: 300 },
      { id: 'b', x: 2000, y: 0, width: 400, height: 300 },
      { id: 'c', x: 0, y: 900, width: 500, height: 300 },
      { id: 'd', x: 0, y: 2000, width: 500, height: 300 },
    ];
    const { zones: moved, tiles } = arrangeBoard(zones, [{ id: 'shell:1', x: 0, y: 3000 }], [shape]);
    const placed = zonesAfter(zones, moved);
    for (const [index, a] of placed.entries()) {
      expect(spaceBetween(a, shape)).toBeGreaterThanOrEqual(GAP);
      for (const b of placed.slice(index + 1)) expect(spaceBetween(a, b)).toBeGreaterThanOrEqual(GAP);
    }
    const bottom = Math.max(...placed.map((zone) => zone.y + zone.height));
    expect(tiles.get('shell:1')!.y - PERCH_ROOM).toBe(bottom + GAP);
    // Each row top-aligned.
    expect(new Set(placed.slice(0, 3).map((zone) => zone.y)).size).toBe(1);
    expect(arrangedAgain(zones, [{ id: 'shell:1', x: 0, y: 3000 }], [shape])).toEqual(NOTHING);
  });

  it('arranges the same board the same way however it is listed, and an arranged board moves nothing', () => {
    const first = arrangeBoard(MESSY, STRAYS);
    expect(arrangeBoard(MESSY.toReversed(), STRAYS.toReversed())).toEqual(first);
    const again = arrangeBoard(
      zonesAfter(MESSY, first.zones).map((rect, index) => ({ ...rect, id: MESSY[index]!.id })),
      STRAYS.map((tile) => ({ ...tile, ...first.tiles.get(tile.id) })),
    );
    expect(again).toEqual({ zones: new Map(), tiles: new Map() });
  });

  it('lays out loose tiles alone from where the topmost is, and has nothing to do on an empty board', () => {
    const { zones, tiles } = arrangeBoard([], [{ id: 'a', x: 500, y: 300 }, { id: 'b', x: 100, y: 900 }]);
    expect(zones).toEqual(new Map());
    expect(tiles).toEqual(new Map([['a', { x: 100, y: 300 }], ['b', { x: 100 + AGENT_TILE_SIZE.width + 16, y: 300 }]]));
    expect(arrangeBoard([], [])).toEqual({ zones: new Map(), tiles: new Map() });
  });

  it('leaves the strays where they went when a fixed item sent the first zone of every row right', () => {
    const zones: BoardZone[] = [{ id: 'z', x: 353, y: -657, width: 973, height: 956 }];
    const fixed = [{ x: 440, y: -130, width: 110, height: 332 }];
    const tiles = [
      { id: 't0', x: 900, y: 2000 },
      { id: 't1', x: -300, y: 1500 },
      { id: 't2', x: 100, y: 2600 },
    ];
    const { zones: moved, tiles: placed } = arrangeBoard(zones, tiles, fixed);
    // The strays start at the zones' new left edge.
    expect(Math.min(...[...placed.values()].map((tile) => tile.x))).toBe(moved.get('z')!.x);
    expect(arrangedAgain(zones, tiles, fixed)).toEqual(NOTHING);
  });

  it('leaves strays alone on a board of no zones where a fixed item takes their first slot', () => {
    const fixed = [
      { x: -839, y: 196, width: 461, height: 42 },
      { x: -754, y: -2381, width: 237, height: 84 },
    ];
    const tiles = [
      { id: 't0', x: -538, y: -2560 },
      { id: 't1', x: 3043, y: 1757 },
    ];
    expect(arrangedAgain([], tiles, fixed)).toEqual(NOTHING);
  });

  it('keeps zones and strays a gap apart, clear of fixed items, and still on a second arrange, over thousands of random boards', () => {
    // A fixed seed, so a failure names the same board every run.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const between = (low: number, high: number) => Math.floor(low + random() * (high - low));
    const failures: string[] = [];
    for (let board = 0; board < 3000; board++) {
      // One in four with no zones, strays alone.
      const zones = Array.from({ length: board % 4 === 0 ? 0 : between(1, 8) }, (_, index) => ({
        id: `z${index}`,
        x: between(-2000, 4000),
        y: between(-2000, 4000),
        width: between(200, 1500),
        height: between(150, 1000),
      }));
      // One in ten with fixed items 20,000 px wide.
      const fixed = Array.from({ length: between(0, 6) }, () => ({
        x: between(-3000, 5000),
        y: between(-3000, 5000),
        width: between(20, board % 10 === 0 ? 20_000 : 600),
        height: between(20, 600),
      }));
      const tiles = Array.from({ length: between(0, 5) }, (_, index) => ({ id: `t${index}`, x: between(-3000, 5000), y: between(-3000, 5000) }));
      const first = arrangeBoard(zones, tiles, fixed);
      const placed = zonesAfter(zones, first.zones);
      const footprints = tilesAfter(tiles, first.tiles);
      const label = JSON.stringify({ zones, tiles, fixed });
      for (const [index, a] of placed.entries()) {
        if (placed.slice(index + 1).some((b) => spaceBetween(a, b) < GAP)) failures.push(`zones closer than the gap: ${label}`);
        if (fixed.some((rect) => spaceBetween(a, rect) < GAP)) failures.push(`zone closer than the gap to a fixed item: ${label}`);
      }
      for (const [index, a] of footprints.entries()) {
        if ([...footprints.slice(index + 1), ...placed, ...fixed].some((b) => overlaps(a, b))) failures.push(`stray overlaps: ${label}`);
      }
      const again = arrangedAgain(zones, tiles, fixed);
      if (again.zones.size + again.tiles.size > 0) failures.push(`moved on a second arrange: ${label}`);
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });
});

