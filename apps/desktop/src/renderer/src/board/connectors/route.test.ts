import { describe, expect, it } from 'vitest';
import type { Rect } from '../../geometry';
import { lineShape, samplePath } from './geometry';
import { crossesAny, ROUTE_CLEARANCE, routeAround, routeLine, routes } from './route';

/** Three tiles in a row, 64 apart, and a line from the right of the first to the left of the third. */
const tile = (x: number, y: number): Rect => ({ x, y, width: 256, height: 136 });
const [first, middle, third] = [tile(0, 40), tile(320, 40), tile(640, 40)];
const across = { source: { x: 256, y: 108 }, sourceSide: 'right', target: { x: 640, y: 108 }, targetSide: 'left' } as const;
/** The tiles `across` joins. */
const own = { source: first, target: third };
const xy = (points: readonly { x: number; y: number }[]) => points.map(({ x, y }) => ({ x, y }));

/** How near `samples`, as a polyline, comes to `rect`: 0 if it goes into it. */
function distanceTo(samples: readonly { x: number; y: number }[], rect: Rect): number {
  let least = Infinity;
  for (let index = 1; index < samples.length; index++) {
    const [from, to] = [samples[index - 1]!, samples[index]!];
    for (let step = 0; step <= 20; step++) {
      const x = from.x + ((to.x - from.x) * step) / 20;
      const y = from.y + ((to.y - from.y) * step) / 20;
      const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
      const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
      least = Math.min(least, Math.hypot(dx, dy));
    }
  }
  return least;
}

describe('whether a line crosses a tile', () => {
  it('finds a straight stretch through a tile, and none past it', () => {
    expect(crossesAny(samplePath('M256,108 L640,108'), [middle])).toBe(true);
    expect(crossesAny(samplePath('M256,10 L640,10'), [middle])).toBe(false);
  });

  it('finds a stretch that cuts only a corner of one', () => {
    expect(crossesAny(samplePath('M300,30 L340,60'), [middle])).toBe(true);
  });
});

describe('a route round the tiles between its ends', () => {
  it('goes round a tile directly between them, with clearance, and leaves and arrives square', () => {
    const route = routeAround(across, [middle], own)!;
    expect(route).toBeDefined();
    expect(route[0]).toEqual(across.source);
    expect(route.at(-1)).toEqual(across.target);
    // Out of the source's right side and into the target's left side, across.
    expect(route[1]!.y).toBe(across.source.y);
    expect(route[1]!.x).toBeGreaterThan(across.source.x);
    expect(route.at(-2)!.y).toBe(across.target.y);
    expect(route.at(-2)!.x).toBeLessThan(across.target.x);
    // Every stretch square.
    for (let index = 1; index < route.length; index++) {
      const [from, to] = [route[index - 1]!, route[index]!];
      expect(from.x === to.x || from.y === to.y).toBe(true);
    }
    expect(distanceTo(route, middle)).toBeGreaterThanOrEqual(ROUTE_CLEARANCE);
  });

  it('keeps clear of its own two tiles past where it leaves and arrives', () => {
    const route = routeAround(across, [middle], own)!;
    // Its first and last stretches are on its tiles' sides; past them it never comes back within the clearance.
    expect(distanceTo(route.slice(2, -2), first)).toBeGreaterThanOrEqual(ROUTE_CLEARANCE);
    expect(distanceTo(route.slice(2, -2), third)).toBeGreaterThanOrEqual(ROUTE_CLEARANCE);
  });

  it('takes the gap between two rows to a tile below and across', () => {
    const [low, lowMiddle] = [tile(0, 240), tile(320, 240)];
    const ends = { source: { x: 256, y: 308 }, sourceSide: 'right', target: { x: 768, y: 176 }, targetSide: 'bottom' } as const;
    const route = routeAround(ends, [first, middle, lowMiddle, tile(640, 240)], { source: low, target: third })!;
    for (const rect of [middle, lowMiddle]) expect(distanceTo(route, rect)).toBeGreaterThanOrEqual(ROUTE_CLEARANCE);
    // Into the bottom of its tile, going up.
    expect(route.at(-2)!.x).toBe(768);
    expect(route.at(-2)!.y).toBeGreaterThan(176);
  });

  it('goes down the middle of a wide gap, not along the margin of a tile beside it', () => {
    const [left, between, right] = [tile(0, 40), tile(520, 40), tile(1040, 40)];
    const ends = { source: { x: 256, y: 108 }, sourceSide: 'right', target: { x: 1040, y: 108 }, targetSide: 'left' } as const;
    const route = routeAround(ends, [between], { source: left, target: right })!;
    // Its first turn is halfway across the gap between the first two tiles.
    expect(route[1]!.x).toBe((256 + 520) / 2);
    expect(route.at(-2)!.x).toBe((776 + 1040) / 2);
  });

  it('is not needed when nothing is in the way', () => {
    expect(routeAround(across, [], own)).toBeUndefined();
  });

  it('goes round a tile a tile gap from its end, where the margins meet, a half clearance from each', () => {
    // A lane: the agent, its reviewer two slots right, and a note on the agent in the slot past the reviewer, 16 from
    // it. The note's line leaves its card's left side, across the reviewer, to the agent's right side.
    const [agent, reviewer] = [tile(1380, 1804), tile(1924, 1804)];
    const note = { x: 2196, y: 1804, width: 256, height: 267 };
    const ends = { source: { x: 2196, y: 1948 }, sourceSide: 'left', target: { x: 1636, y: 1872 }, targetSide: 'right' } as const;
    const samples = samplePath('M2196,1948 L1636,1872');
    const route = routeLine(ends, samples, [reviewer], { source: note, target: agent })!;
    expect(route).toBeDefined();
    expect(crossesAny(route, [reviewer])).toBe(false);
    expect(distanceTo(route, reviewer)).toBeGreaterThanOrEqual(ROUTE_CLEARANCE / 2);
  });

  it('goes no nearer than half the clearance: a note closer to the tile than a tile gap gives up', () => {
    // As above, but a note the reviewer's height, 12 from it: room for 4 clear of each, not 8.
    const [agent, reviewer, note] = [tile(1380, 1804), tile(1924, 1804), tile(2192, 1804)];
    const ends = { source: { x: 2192, y: 1872 }, sourceSide: 'left', target: { x: 1636, y: 1872 }, targetSide: 'right' } as const;
    expect(routeLine(ends, samplePath('M2192,1872 L1636,1872'), [reviewer], { source: note, target: agent })).toBeUndefined();
  });

  it('gives up when an end is boxed in, leaving the line as it was', () => {
    // A tile hard against the source's side: there is no room to leave it.
    const against = { x: 262, y: 0, width: 40, height: 300 };
    expect(routeAround(across, [against, middle], own)).toBeUndefined();
  });

  it('gives up when no way through is clear', () => {
    // A wall round the target, open nowhere.
    const walls = [
      { x: 560, y: -200, width: 500, height: 40 },
      { x: 560, y: 360, width: 500, height: 40 },
      { x: 560, y: -200, width: 40, height: 600 },
      { x: 1020, y: -200, width: 40, height: 600 },
    ];
    expect(routeAround(across, [middle, ...walls], own)).toBeUndefined();
  });

  it('routes 30 lines down across a board of 50 tiles, every one of them, without blowing up', () => {
    const tiles = Array.from({ length: 50 }, (_, index) => tile((index % 10) * 320, Math.floor(index / 10) * 200));
    const started = performance.now();
    let routed = 0;
    for (let line = 0; line < 30; line++) {
      const from = tiles[line % 10]!;
      const to = tiles[40 + ((line * 3) % 10)]!;
      const ends = { source: { x: from.x + 128, y: from.y + 136 }, sourceSide: 'bottom', target: { x: to.x + 128, y: to.y }, targetSide: 'top' } as const;
      const samples = samplePath(lineShape('elbow', ends, []).path);
      if (routeLine(ends, samples, tiles.filter((rect) => rect !== from && rect !== to), { source: from, target: to }) !== undefined) routed++;
    }
    expect(routed).toBe(30);
    // A few milliseconds in all; the limit is only there to catch a search that has blown up, on however busy a machine.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('which lines route', () => {
  it('an elbow or a curve the user never bent', () => {
    expect(routes('elbow', [], false)).toBe(true);
    expect(routes('curved', [], false)).toBe(true);
  });

  it('never a straight line', () => {
    expect(routes('straight', [], false)).toBe(false);
  });

  it('not one the user bent, or a curve they bowed: it goes where they put it', () => {
    expect(routes('elbow', [{ x: 10, y: -40 }], false)).toBe(false);
    expect(routes('curved', [{ x: 10, y: -40, bow: true }], false)).toBe(false);
  });

  it('not while an end is being dragged', () => {
    expect(routes('elbow', [], true)).toBe(false);
  });
});

describe('whether a line is routed', () => {
  it('is, round a tile its line would cross', () => {
    const samples = samplePath(lineShape('elbow', across, []).path);
    expect(routeLine(across, samples, [middle], own)).toEqual(routeAround(across, [middle], own));
  });

  it('is not when its line crosses nothing but its own two tiles, which it leaves and meets', () => {
    expect(routeLine(across, samplePath(lineShape('curved', across, []).path), [], own)).toBeUndefined();
  });

  it('is not when its line passes by a tile without crossing it', () => {
    const below = { ...middle, y: 140 };
    expect(routeLine(across, samplePath(lineShape('elbow', across, []).path), [below], own)).toBeUndefined();
  });
});

describe('a routed line drawn', () => {
  const route = routeAround(across, [middle], own)!;

  it('goes through the route square on an elbow', () => {
    const shape = lineShape('elbow', across, route.slice(1, -1), undefined, true);
    expect(samplePath(shape.path)).toEqual(xy(route));
  });

  it('rounds the corners of a curve, still the clearance from the tile between', () => {
    const shape = lineShape('curved', across, route.slice(1, -1), undefined, true);
    expect(shape.path).toMatch(/Q/);
    // Within a pixel: the curve is checked at a few points on each corner.
    expect(distanceTo(samplePath(shape.path), middle)).toBeGreaterThan(ROUTE_CLEARANCE - 1);
  });

  it('rounds a corner less where it turns round a tile with no room to spare, so it keeps the clearance there too', () => {
    // A wall above the row and one below it, each 32 from it: the only lanes past the middle tile hug its margin, and
    // the route's turns there wrap its corners.
    const walls = [
      { x: -200, y: -200, width: 1300, height: 208 },
      { x: -200, y: 208, width: 1300, height: 200 },
    ];
    const tight = routeAround(across, [middle, ...walls], own)!;
    expect(tight.slice(1, -1).some(({ radius }) => radius! < 40)).toBe(true);
    const shape = lineShape('curved', across, tight.slice(1, -1), undefined, true);
    expect(distanceTo(samplePath(shape.path), middle)).toBeGreaterThan(ROUTE_CLEARANCE - 1);
  });

  it('offers one place to pull out a bend, halfway along it', () => {
    expect(lineShape('elbow', across, route.slice(1, -1), undefined, true).inserts).toHaveLength(1);
  });
});
