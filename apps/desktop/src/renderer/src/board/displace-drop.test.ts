import { describe, expect, it } from 'vitest';
import type { BoardItem, Shell, TilePosition, Zone } from '@agent-board/daemon/protocol';
import { PERCH_ROOM, TILE_GAP, ZONE_PADDING } from '@agent-board/daemon/board-layout';
import type { Rect } from '../geometry';
import { displaced } from './displace';
import { expandTile } from './expanded';
import { isItemNode, itemNode } from './items/items';
import { tileNodeId, withTiles, type BoardNode } from './tiles';
import { zoneNode } from './ZoneNode';

// An item the user puts down clear of everything drawn is saved where it was drawn. Drawn again from that, it must
// stay there: in a zone with an expanded tile, it was pushed again by the tile's growth, landing lower or further
// right, often on another item.

const zone = (id: string, width: number, height: number) =>
  zoneNode({ id, x: 0, y: 0, width, height, repoRoot: null, folder: '', name: id, color: '#4c6ef5', spacing: 'normal' } as Zone);
const shell = (id: string, zoneId: string | null, position: TilePosition) =>
  ({ id, zoneId, position, name: id, cwd: '/', layout: { type: 'pane', sessionId: `${id}-pane` }, endedPanes: [] }) as unknown as Shell;
const item = (id: string, kind: string, x: number, y: number, width: number, height: number) =>
  ({ id, kind, zoneId: 'z', x, y, width, height, z: 0, rotation: 0, data: {}, createdAt: '', updatedAt: '' }) as BoardItem;

const FOLDED = { width: 64, height: 64 };
const OPEN = { width: 280, height: 320 };
const KINDS = ['queue', 'todo', 'memory'] as const;

/** A seeded random number in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const crowded = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + TILE_GAP && b.x < a.x + a.width + TILE_GAP && a.y < b.y + b.height + TILE_GAP && b.y < a.y + a.height + TILE_GAP;
const overlapping = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const rectOf = (node: BoardNode): Rect => ({ ...node.position, width: node.width ?? 0, height: node.height ?? 0 });

const wide = tileNodeId('shell', 'wide');
const pinned = new Set([wide]);
const expanded = expandTile([], wide);
const board = (items: readonly BoardItem[], tiles: readonly Shell[] = []) =>
  withTiles([zone('z', 2000, 1400), ...items.map(itemNode)] as BoardNode[], [], [shell('wide', 'z', { x: ZONE_PADDING, y: ZONE_PADDING + 40, z: 0 }), ...tiles], [], new Map(), expanded);
const shown = (nodes: BoardNode[]) => displaced(nodes, expanded, new Map(), new Map(), [], {}, pinned);

/**
 * Drops `id` at `spot` and draws the board again: saved where it was drawn, and, as the board does on a drag, marked
 * as put by hand.
 */
function dropped(nodes: readonly BoardNode[], id: string, spot: { x: number; y: number }) {
  const byHand = (node: BoardNode) =>
    isItemNode(node) ? { ...node, data: { ...node.data, item: { ...node.data.item, data: { ...node.data.item.data, placedByHand: true } } } } : node;
  return shown(nodes.map((node) => (node.id === id ? { ...byHand(node), position: spot } : node)));
}

describe('an item put down clear of everything drawn, in a zone with an expanded tile', () => {
  for (const kind of KINDS) {
    for (const [fold, size] of [['folded', FOLDED], ['unfolded', OPEN]] as const) {
      it(`a ${kind}, ${fold}, below the expanded tile stays where it was put`, () => {
        // Another item under the expanded tile puts the rows below it in its way, so they are pushed down as a block.
        const put = item('a', kind, 40, 200, size.width, size.height);
        const nodes = board([put, item('b', 'note', ZONE_PADDING, ZONE_PADDING + 300, OPEN.width, OPEN.height)]);
        const tile = rectOf(shown(nodes).find((node) => node.id === wide)!);
        const spot = { x: tile.x, y: tile.y + tile.height + 2 * TILE_GAP };

        const again = dropped(nodes, itemNode(put).id, spot);

        expect(again.find((node) => node.id === itemNode(put).id)!.position).toEqual(spot);
        expect(again.filter((node) => node.parentId === 'z' && node.id !== itemNode(put).id).some((node) => overlapping(rectOf(node), { ...spot, ...size }))).toBe(false);
      });

      it(`a ${kind}, ${fold}, right of the expanded tile stays where it was put`, () => {
        // Another item under the expanded tile, right of its compact spot, puts what is right of it in its way.
        const put = item('a', kind, 40, 200, size.width, size.height);
        const nodes = board([put, item('b', 'note', ZONE_PADDING + 300, ZONE_PADDING + 40, OPEN.width, OPEN.height)]);
        const tile = rectOf(shown(nodes).find((node) => node.id === wide)!);
        const spot = { x: tile.x + tile.width + 2 * TILE_GAP, y: tile.y };

        const again = dropped(nodes, itemNode(put).id, spot);

        expect(again.find((node) => node.id === itemNode(put).id)!.position).toEqual(spot);
        expect(again.filter((node) => node.parentId === 'z' && node.id !== itemNode(put).id).some((node) => overlapping(rectOf(node), { ...spot, ...size }))).toBe(false);
      });
    }
  }

  it('stays where it was put, and on top of nothing, wherever it is put among other items and tiles', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const items = Array.from({ length: 4 }, (_, index) => {
        const size = next() < 0.5 ? FOLDED : OPEN;
        return item(`i${index}`, KINDS[index % 3]!, Math.round(next() * 1200), Math.round(next() * 800), size.width, size.height);
      });
      const tiles = Array.from({ length: 3 }, (_, index) => shell(`t${index}`, 'z', { x: Math.round(next() * 1200), y: Math.round(next() * 800), z: 0 }));
      const nodes = board(items, tiles);
      const id = itemNode(items[0]!).id;
      const drawn = shown(nodes);
      const moving = drawn.find((node) => node.id === id)!;
      const others = drawn.filter((node) => node.parentId === 'z' && node.id !== id).map(rectOf);
      let spot: { x: number; y: number } | undefined;
      for (let tries = 0; tries < 200 && spot === undefined; tries++) {
        const at = { x: Math.round(next() * 1500), y: Math.round(next() * 1000) };
        if (!others.some((rect) => crowded({ ...at, width: moving.width!, height: moving.height! }, rect))) spot = at;
      }
      if (spot === undefined) continue;

      const again = dropped(nodes, id, spot);

      const now = again.find((node) => node.id === id)!;
      const under = again.filter((node) => node.parentId === 'z' && node.id !== id && overlapping(rectOf(now), rectOf(node)));
      if (now.position.x !== spot.x || now.position.y !== spot.y) failures.push(`seed ${seed}: put at ${JSON.stringify(spot)}, drawn at ${JSON.stringify(now.position)}`);
      if (under.length > 0) failures.push(`seed ${seed}: on top of ${under.map((node) => node.id).join(', ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('a tile pushed aside by the expanded tile makes way for an item, never lands on it', () => {
    // A tile beside the expanded tile's compact spot is pushed right; an item put clear of the expanded tile, just
    // where that push would land, stays, and the tile goes elsewhere.
    const put = item('a', 'queue', 0, 0, OPEN.width, OPEN.height);
    const nodes = withTiles(
      [zone('z', 2000, 1400), itemNode(put)] as BoardNode[],
      [],
      [shell('wide', 'z', { x: ZONE_PADDING, y: ZONE_PADDING + 40, z: 0 }), shell('other', 'z', { x: ZONE_PADDING + 400, y: ZONE_PADDING + 40, z: 0 })],
      [],
      new Map(),
      expanded,
    );
    const tile = rectOf(shown(nodes).find((node) => node.id === wide)!);
    const spot = { x: tile.x + tile.width + 2 * TILE_GAP, y: tile.y };

    const again = dropped(nodes, itemNode(put).id, spot);

    const queue = again.find((node) => node.id === itemNode(put).id)!;
    const other = again.find((node) => node.id === tileNodeId('shell', 'other'))!;
    expect(queue.position).toEqual(spot);
    expect(overlapping(rectOf(queue), rectOf(other))).toBe(false);
    expect(overlapping(rectOf(other), tile)).toBe(false);
  });

  it('a row of tiles, each with the note gathered below it, moves as one: no tile out of line, no note left behind', () => {
    // As a Clean up leaves them: each tile's top under the expanded tile, its note below it.
    const row = [0, 1, 2, 3].map((index) => shell(`d${index}`, 'z', { x: ZONE_PADDING + index * 300, y: 520, z: 0 }));
    const notes = row.map((tile, index) => ({ ...item(`n${index}`, 'agent-note', tile.position!.x, 750, 200, 100), data: { gatheredTo: `agent:${tile.id}` } }));
    const nodes = board(notes, row);

    const drawn = shown(nodes);

    const shiftOf = (id: string) => {
      const saved = nodes.find((node) => node.id === id)!.position;
      const now = drawn.find((node) => node.id === id)!.position;
      return `${now.x - saved.x},${now.y - saved.y}`;
    };
    const tileShifts = row.map((tile) => shiftOf(tileNodeId('shell', tile.id)));
    expect(new Set(tileShifts).size).toBe(1);
    expect(tileShifts[0]).not.toBe('0,0');
    expect(notes.map((note) => shiftOf(itemNode(note).id))).toEqual(tileShifts);
  });

  it('a note the user put down by hand is not carried off with the tiles beside it', () => {
    const row = [shell('d0', 'z', { x: ZONE_PADDING, y: 520, z: 0 })];
    const note = { ...item('n0', 'agent-note', 1200, 750, 200, 100), data: { placedByHand: true } };
    const nodes = board([note], row);

    const drawn = shown(nodes);

    expect(drawn.find((node) => node.id === itemNode(note).id)!.position).toEqual({ x: 1200, y: 750 });
  });
});

describe('a tile put down clear of everything drawn, with an expanded tile open', () => {
  const putDown = (nodes: readonly BoardNode[], id: string, spot: { x: number; y: number }) => nodes.map((node) => (node.id === id ? { ...node, position: spot } : node));
  const drawnAgain = (nodes: BoardNode[], put: ReadonlySet<string>) => displaced(nodes, expanded, new Map(), new Map(), [], {}, pinned, put);
  const under = tileNodeId('shell', 'under');
  const b = tileNodeId('shell', 'b');

  it('in a zone, stays where it was put beside a row pushed down, and the row still moves', () => {
    const nodes = board([], [shell('under', 'z', { x: ZONE_PADDING, y: 320, z: 0 }), shell('b', 'z', { x: 1400, y: 1100, z: 0 })]);
    const row = shown(nodes).find((node) => node.id === under)!;
    const spot = { x: row.position.x + 456, y: row.position.y };

    const again = drawnAgain(putDown(nodes, b, spot), new Set([b]));

    expect(again.find((node) => node.id === b)!.position).toEqual(spot);
    expect(again.find((node) => node.id === under)!.position).toEqual(row.position);
    const tile = again.find((node) => node.id === b)!;
    expect(again.filter((node) => node.parentId === 'z' && node.id !== b).some((node) => overlapping(rectOf(node), rectOf(tile)))).toBe(false);
  });

  it('in a zone, wherever it is put among items and tiles, stays there on top of nothing', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const items = Array.from({ length: 3 }, (_, index) => item(`i${index}`, KINDS[index % 3]!, Math.round(next() * 1200), Math.round(next() * 800), FOLDED.width, FOLDED.height));
      const tiles = Array.from({ length: 4 }, (_, index) => shell(`t${index}`, 'z', { x: Math.round(next() * 1200), y: Math.round(next() * 800), z: 0 }));
      const nodes = board(items, tiles);
      const id = tileNodeId('shell', 't0');
      const drawn = shown(nodes);
      const moving = drawn.find((node) => node.id === id)!;
      const others = drawn.filter((node) => node.parentId === 'z' && node.id !== id).map(rectOf);
      let spot: { x: number; y: number } | undefined;
      for (let tries = 0; tries < 200 && spot === undefined; tries++) {
        const at = { x: Math.round(next() * 1500), y: Math.round(next() * 1000) };
        // With the room above a tile for its subagents.
        const rect = { ...rectOf({ ...moving, position: at }), y: at.y - PERCH_ROOM, height: moving.height! + PERCH_ROOM };
        if (!others.some((other) => crowded(rect, other))) spot = at;
      }
      if (spot === undefined) continue;

      const again = drawnAgain(putDown(nodes, id, spot), new Set([id]));

      const now = again.find((node) => node.id === id)!;
      const under = again.filter((node) => node.parentId === 'z' && node.id !== id && overlapping(rectOf(now), rectOf(node)));
      if (now.position.x !== spot.x || now.position.y !== spot.y) failures.push(`seed ${seed}: put at ${JSON.stringify(spot)}, drawn at ${JSON.stringify(now.position)}`);
      if (under.length > 0) failures.push(`seed ${seed}: on top of ${under.map((node) => node.id).join(', ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('on the bare board, stays where it was put in the grid of the expanded tile, and the row still moves', () => {
    // A tile left of the expanded one is in its grid but not pushed; one put down below that is in the rows below.
    const loose = (id: string, x: number, y: number) => shell(id, null, { x, y, z: 0 });
    const nodes = withTiles([] as BoardNode[], [], [loose('wide', 0, 0), loose('left', -272, 0), loose('under', 0, 160), loose('b', 3000, 3000)], [], new Map(), expanded);
    const row = shown(nodes).find((node) => node.id === under)!;
    expect(row.position.y).toBeGreaterThan(600);
    const spot = { x: -272, y: 240 };

    const again = drawnAgain(putDown(nodes, b, spot), new Set([b]));

    expect(again.find((node) => node.id === b)!.position).toEqual(spot);
    expect(again.find((node) => node.id === under)!.position).toEqual(row.position);
  });
});
