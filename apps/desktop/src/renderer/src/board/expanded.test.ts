import { describe, expect, it } from 'vitest';
import { AGENT_TILE_SIZE, clearOf, PERCH_ROOM, sizedFootprint, ZONE_PADDING } from '@agent-board/daemon/board-layout';
import { tidyZone } from '@agent-board/daemon/board-tidy';
import {
  allowingOverlap,
  bringToFront,
  collapsedBetween,
  collapseFront,
  collapseTile,
  EXPANDED_MAX_SIZE,
  EXPANDED_MIN_SIZE,
  EXPANDED_SIZE,
  expandTile,
  tidySize,
  expandedFrom,
  expandedRank,
  keepExpanded,
  keepOverlaps,
  overlapsFrom,
  keepSizes,
  parentKindOf,
  rememberSize,
  resizeAllowed,
  resizeExpanded,
  sizesFrom,
  type ExpandedTiles,
  windowedExpanded,
  withoutOverlaps,
} from './expanded';

const ids = (expanded: ExpandedTiles) => expanded.map((entry) => entry.id);

describe('expanded tiles', () => {
  it('expands a tile at the default size, in front of the ones expanded before', () => {
    const one = expandTile([], 'agent:a');
    expect(one).toEqual([{ id: 'agent:a', ...EXPANDED_SIZE }]);

    const two = expandTile(one, 'shell:b');
    expect(ids(two)).toEqual(['agent:a', 'shell:b']);
  });

  it('brings an expanded tile to the front when it is expanded again, keeping its size', () => {
    const expanded = resizeExpanded(expandTile(expandTile([], 'a'), 'b'), 'a', { width: 900, height: 700 });

    const again = expandTile(expanded, 'a');
    expect(again).toEqual([
      { id: 'b', ...EXPANDED_SIZE },
      { id: 'a', width: 900, height: 700 },
    ]);
    expect(bringToFront(expanded, 'a')).toEqual(again);
  });

  it('leaves the set alone bringing forward a tile already in front, or one not expanded', () => {
    const expanded = expandTile(expandTile([], 'a'), 'b');
    expect(bringToFront(expanded, 'b')).toBe(expanded);
    expect(bringToFront(expanded, 'c')).toBe(expanded);
  });

  it('collapses one tile', () => {
    const expanded = expandTile(expandTile([], 'a'), 'b');
    expect(ids(collapseTile(expanded, 'a'))).toEqual(['b']);
    expect(collapseTile(expanded, 'c')).toBe(expanded);
  });

  it('collapses the one in front, then the next', () => {
    const expanded = expandTile(expandTile(expandTile([], 'a'), 'b'), 'a');
    expect(ids(collapseFront(expanded))).toEqual(['b']);
    expect(ids(collapseFront(collapseFront(expanded)))).toEqual([]);
    expect(collapseFront([])).toEqual([]);
  });

  it('keeps a resized tile at least the minimum size', () => {
    const expanded = resizeExpanded(expandTile([], 'a'), 'a', { width: 10, height: 2000 });
    expect(expanded).toEqual([{ id: 'a', width: EXPANDED_MIN_SIZE.width, height: 2000 }]);
    expect(resizeExpanded(expanded, 'b', { width: 900, height: 900 })).toBe(expanded);
  });

  it('keeps a resized tile at most the maximum size', () => {
    const expanded = resizeExpanded(expandTile([], 'a'), 'a', { width: 99_999, height: 99_999 });
    expect(expanded).toEqual([{ id: 'a', ...EXPANDED_MAX_SIZE }]);
  });

  it('opens a tile at the size it was last let go at, which outlives its collapse', () => {
    const sizes = rememberSize({}, 'a', { width: 1200, height: 800 });
    expect(sizes).toEqual({ a: { width: 1200, height: 800 } });
    expect(expandTile(collapseTile(expandTile([], 'a', sizes), 'a'), 'a', sizes)).toEqual([{ id: 'a', width: 1200, height: 800 }]);
    // Another tile still opens at the first size.
    expect(expandTile([], 'b', sizes)).toEqual([{ id: 'b', ...EXPANDED_SIZE }]);
    // Remembered within the least and greatest sizes.
    expect(rememberSize(sizes, 'b', { width: 1, height: 99_999 }).b).toEqual({ width: EXPANDED_MIN_SIZE.width, height: EXPANDED_MAX_SIZE.height });
  });

  it('forgets the sizes of tiles gone from the board', () => {
    const sizes = rememberSize(rememberSize({}, 'a', EXPANDED_SIZE), 'b', EXPANDED_SIZE);
    expect(Object.keys(keepSizes(sizes, new Set(['b', 'c'])))).toEqual(['b']);
    expect(keepSizes(sizes, new Set(['a', 'b']))).toBe(sizes);
  });

  it('takes back saved sizes, keeping only well-formed ones, within the least and greatest sizes', () => {
    const saved = { a: { width: 1200, height: 800 }, b: { width: 1, height: 99_999 }, c: { width: 'wide', height: 800 }, d: null };
    expect(sizesFrom(saved)).toEqual({ a: { width: 1200, height: 800 }, b: { width: EXPANDED_MIN_SIZE.width, height: EXPANDED_MAX_SIZE.height } });
    expect(sizesFrom(null)).toEqual({});
    expect(sizesFrom([{ width: 1200, height: 800 }])).toEqual({});
  });

  it('forgets tiles that are gone from the board', () => {
    const expanded = expandTile(expandTile([], 'a'), 'b');
    expect(ids(keepExpanded(expanded, new Set(['b', 'c'])))).toEqual(['b']);
    expect(keepExpanded(expanded, new Set(['a', 'b']))).toBe(expanded);
  });

  it('ranks the expanded tiles back to front, and a compact tile not at all', () => {
    const expanded = expandTile(expandTile([], 'a'), 'b');
    expect([expandedRank(expanded, 'a'), expandedRank(expanded, 'b'), expandedRank(expanded, 'c')]).toEqual([0, 1, undefined]);
  });

  it('takes back a saved set, keeping only well-formed entries, once each, at least the minimum size', () => {
    const saved = [
      { id: 'agent:a', width: 900, height: 700 },
      { id: 'shell:b', width: 10, height: 10 },
      { id: 'agent:a', width: 1000, height: 800 },
      { id: 7, width: 900, height: 700 },
      { id: 'agent:c', width: Number.NaN, height: 700 },
      'agent:d',
      null,
    ];
    expect(expandedFrom(saved)).toEqual([
      { id: 'agent:a', width: 900, height: 700 },
      { id: 'shell:b', ...EXPANDED_MIN_SIZE },
    ]);
    expect(expandedFrom(null)).toEqual([]);
    expect(expandedFrom({ id: 'agent:a' })).toEqual([]);
  });

  it('tells where a tile is from its parent: on the board or in a zone', () => {
    expect([parentKindOf(undefined), parentKindOf('z')]).toEqual(['board', 'zone']);
  });

  it('lets an expanded tile be resized from any side on the open board', () => {
    const start = { x: 100, y: 100 };
    expect(resizeAllowed({ x: -500, y: -500 }, start, 'board')).toBe(true);
  });

  it("keeps an expanded tile's top-left inside its zone's padding, unless it already was further out", () => {
    const start = { x: 200, y: 200 };
    expect(resizeAllowed({ x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM }, start, 'zone')).toBe(true);
    expect(resizeAllowed({ x: ZONE_PADDING - 1, y: 200 }, start, 'zone')).toBe(false);
    expect(resizeAllowed({ x: 200, y: ZONE_PADDING + PERCH_ROOM - 1 }, start, 'zone')).toBe(false);
    // Put nearer the edge than that, it can still be resized from its other sides.
    expect(resizeAllowed({ x: 5, y: 5 }, { x: 5, y: 5 }, 'zone')).toBe(true);
  });
  it('remembers which tile was dropped onto which, and forgets the pair when the tile is dropped again', () => {
    const allowed = allowingOverlap(new Map(), 'a', 'b');
    expect([...allowed]).toEqual([['a', 'b']]);
    expect([...allowingOverlap(allowed, 'a', 'c')]).toEqual([['a', 'c']]);
    expect([...allowingOverlap(allowed, 'a', undefined)]).toEqual([]);
    // The tile it was dropped onto, dropped elsewhere, ends the pair too.
    expect([...allowingOverlap(allowed, 'b', undefined)]).toEqual([]);
    const none = new Map<string, string>();
    expect(allowingOverlap(none, 'x', undefined)).toBe(none);
  });

  it('forgets the pairs of tiles moved otherwise, collapsed or gone from the board, on either side', () => {
    const allowed = new Map([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect([...withoutOverlaps(allowed, ['b'])]).toEqual([['c', 'd']]);
    expect([...withoutOverlaps(allowed, ['c'])]).toEqual([['a', 'b']]);
    expect(withoutOverlaps(allowed, ['x'])).toBe(allowed);
    expect([...keepOverlaps(allowed, new Set(['a', 'b', 'c']))]).toEqual([['a', 'b']]);
    expect(keepOverlaps(allowed, new Set(['a', 'b', 'c', 'd']))).toBe(allowed);
  });

  it('reads the pairs saved last run, taking only pairs of node ids', () => {
    expect([...overlapsFrom([['shell:a', 'shell:b'], ['shell:c'], 'shell:d', [1, 'x'], ['agent:e', 'shell:f']])]).toEqual([
      ['shell:a', 'shell:b'],
      ['agent:e', 'shell:f'],
    ]);
    // As an earlier build saved them: one id each. They can't be paired, so they are dropped.
    expect([...overlapsFrom(['shell:a'])]).toEqual([]);
    expect([...overlapsFrom(null)]).toEqual([]);
  });

  it('tells which tiles collapsed between two sets', () => {
    const before = expandTile(expandTile(expandTile([], 'a'), 'b'), 'c');
    expect(collapsedBetween(before, collapseTile(collapseTile(before, 'a'), 'c'))).toEqual(['a', 'c']);
    expect(collapsedBetween(before, bringToFront(before, 'a'))).toEqual([]);
  });
});

describe('windowedExpanded', () => {
  const a = { id: 'a', width: 800, height: 500 };
  const b = { id: 'b', width: 700, height: 400 };
  const sets = (open: string[], docked: string[] = []) => ({ open: new Set(open), all: new Set([...open, ...docked]) });
  const present = new Set(['a', 'b']);

  it('takes an expanded tile out while its window is open, and remembers its size', () => {
    const next = windowedExpanded([a, b], [], sets(['a']), present);
    expect(ids(next.expanded)).toEqual(['b']);
    expect(next.hidden).toEqual([a]);
  });

  it('gives the tile back at its size once the window is closed', () => {
    const next = windowedExpanded([b], [a], sets([]), present);
    expect(next.expanded).toEqual([b, a]);
    expect(next.hidden).toEqual([]);
  });

  it('leaves a tile whose window was compact, compact', () => {
    const next = windowedExpanded([], [], sets([]), present);
    expect(next.expanded).toEqual([]);
  });

  it('keeps it compact while the window is docked, and expanded by hand meanwhile is the state to come back to', () => {
    const docked = windowedExpanded([], [a], sets([], ['a']), present);
    expect(docked.expanded).toEqual([]);
    expect(docked.hidden).toEqual([a]);
    const byHand = { id: 'a', width: 900, height: 600 };
    const expandedAgain = windowedExpanded([byHand], [a], sets([], ['a']), present);
    expect(expandedAgain.expanded).toEqual([byHand]);
    expect(expandedAgain.hidden).toEqual([]);
    // Reopened from the dock, then closed: it comes back as it was when the window opened.
    const reopened = windowedExpanded([byHand], [], sets(['a']), present);
    expect(reopened.hidden).toEqual([byHand]);
    expect(windowedExpanded([], reopened.hidden, sets([]), present).expanded).toEqual([byHand]);
  });

  it('does not duplicate a tile that is already expanded', () => {
    const next = windowedExpanded([a], [a], sets([]), present);
    expect(next.expanded).toEqual([a]);
    expect(next.hidden).toEqual([]);
  });

  it('forgets a tile whose session is gone instead of bringing it back', () => {
    const next = windowedExpanded([], [a], sets([]), new Set(['b']));
    expect(next.expanded).toEqual([]);
    expect(next.hidden).toEqual([]);
  });

  it('returns the same arrays when nothing changes', () => {
    const expanded = [b];
    const hidden = [a];
    const next = windowedExpanded(expanded, hidden, sets(['a']), present);
    expect(next.expanded).toBe(expanded);
    expect(next.hidden).toBe(hidden);
  });
});

describe('tidySize', () => {
  it('is the expanded size for an expanded tile and the compact size for the rest', () => {
    const expanded = expandTile([], 'shell:a');
    expect(tidySize(expanded, 'shell:a', AGENT_TILE_SIZE)).toEqual(EXPANDED_SIZE);
    expect(tidySize(expanded, 'shell:b', AGENT_TILE_SIZE)).toEqual(AGENT_TILE_SIZE);
  });

  it('lays a zone out with nothing under the expanded tile', () => {
    const expanded = expandTile([], 'b');
    const tiles = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, x: 40 + index * 10, y: 60, ...tidySize(expanded, id, AGENT_TILE_SIZE) }));
    const { positions } = tidyZone({ width: 1400, height: 800 }, tiles);
    const rects = tiles.map((tile) => sizedFootprint(positions.get(tile.id)!, tile));
    for (const [index, rect] of rects.entries()) expect(clearOf(rect, rects.filter((_, other) => other !== index))).toBe(true);
  });
});
