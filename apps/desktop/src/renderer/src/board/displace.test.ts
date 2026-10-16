import { describe, expect, it } from 'vitest';
import type { Agent, BoardItem, Shell, TilePosition, Zone } from '@agent-board/daemon/protocol';
import { rotatedBounds, type Rect } from '../geometry';
import { apart, clearOfExpanded, displaced, droppedOnto, heldFrom, type Movable } from './displace';
import { bringToFront, EXPANDED_SIZE, expandTile, resizeExpanded } from './expanded';
import { AGENT_TILE_SIZE, CREW_GAP, PERCH_ROOM, TILE_GAP, ZONE_PADDING } from '@agent-board/daemon/board-layout';
import { CREW_PADDING, crewFrames } from './crews';
import type { TileNodeType } from './tile';
import { itemNode } from './items/items';
import { isSessionTile, tileNodeId, withTiles, type BoardNode } from './tiles';
import type { ZoneNodeType } from './ZoneNode';
import { zoneNode } from './ZoneNode';

const tile = (id: string, x: number, y: number, width = 100, height = 100): Movable => ({ id, rect: { x, y, width, height } });

/** Whether `a` and `b` come nearer each other than the gap, or overlap. */
const crowded = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + TILE_GAP &&
  b.x < a.x + a.width + TILE_GAP &&
  a.y < b.y + b.height + TILE_GAP &&
  b.y < a.y + a.height + TILE_GAP;

/** `movables` where `clearOfExpanded` puts them. */
function after(fixed: readonly Rect[], movables: readonly Movable[], bounds?: Parameters<typeof clearOfExpanded>[2]): Movable[] {
  const moved = clearOfExpanded(fixed, movables, bounds);
  return movables.map((movable) => ({ id: movable.id, rect: { ...movable.rect, ...moved.get(movable.id) } }));
}

/** Nothing is near an expanded rect, and nothing moved is near anything else. */
function expectClear(fixed: readonly Rect[], before: readonly Movable[], placed: readonly Movable[]): void {
  for (const movable of placed) {
    for (const rect of fixed) expect(crowded(movable.rect, rect), `${movable.id} under an expanded tile`).toBe(false);
  }
  const moved = placed.filter((movable, index) => movable.rect.x !== before[index]!.rect.x || movable.rect.y !== before[index]!.rect.y);
  for (const movable of moved) {
    for (const other of placed) {
      if (other.id !== movable.id) expect(crowded(movable.rect, other.rect), `${movable.id} on ${other.id}`).toBe(false);
    }
  }
}

describe('clearOfExpanded', () => {
  it('moves nothing that is clear of every expanded rect', () => {
    const movables = [tile('a', 500, 0), tile('b', 0, 500)];
    expect(clearOfExpanded([{ x: 0, y: 0, width: 300, height: 300 }], movables).size).toBe(0);
  });

  it('pushes each neighbour out along its shortest axis, away from the expanded rect', () => {
    const expanded = { x: 0, y: 0, width: 400, height: 400 };
    const movables = [
      tile('right', 350, 150),
      tile('left', -50, 150),
      tile('below', 150, 350),
      tile('above', 150, -50),
    ];
    const moved = clearOfExpanded([expanded], movables);
    expect(moved.get('right')).toEqual({ x: 400 + TILE_GAP, y: 150 });
    expect(moved.get('left')).toEqual({ x: -100 - TILE_GAP, y: 150 });
    expect(moved.get('below')).toEqual({ x: 150, y: 400 + TILE_GAP });
    expect(moved.get('above')).toEqual({ x: 150, y: -100 - TILE_GAP });
  });

  it('cascades: a pushed neighbour pushes the one beyond it the same way', () => {
    const expanded = { x: 0, y: 0, width: 300, height: 100 };
    const movables = [tile('a', 250, 0), tile('b', 250 + 100 + TILE_GAP, 0), tile('c', 250 + 2 * (100 + TILE_GAP), 0)];
    const moved = clearOfExpanded([expanded], movables);
    expect(moved.get('a')).toEqual({ x: 300 + TILE_GAP, y: 0 });
    expect(moved.get('b')).toEqual({ x: 300 + TILE_GAP + 100 + TILE_GAP, y: 0 });
    expect(moved.get('c')).toEqual({ x: 300 + TILE_GAP + 2 * (100 + TILE_GAP), y: 0 });
    expectClear([expanded], movables, after([expanded], movables));
  });

  it('works against several expanded rects at once', () => {
    const fixed = [
      { x: 0, y: 0, width: 400, height: 300 },
      { x: 600, y: 0, width: 400, height: 300 },
    ];
    // Between the two, and touching both.
    const movables = [tile('between', 380, 100, 240, 100), tile('under', 450, 250)];
    expectClear(fixed, movables, after(fixed, movables));
  });

  it('keeps the moves inside the hard bounds, preferring spots inside the soft ones', () => {
    const expanded = { x: 20, y: 20, width: 400, height: 300 };
    // Pushing it left or up would take it past the zone's padding; there is room below, inside the zone.
    const movables = [tile('a', 20, 20)];
    const bounds = { left: 20, top: 20, right: 600, bottom: 600 };
    const placed = after([expanded], movables, bounds);
    expect(placed[0]!.rect.x).toBeGreaterThanOrEqual(20);
    expect(placed[0]!.rect.y).toBeGreaterThanOrEqual(20);
    expect(placed[0]!.rect.x + 100).toBeLessThanOrEqual(600);
    expect(placed[0]!.rect.y + 100).toBeLessThanOrEqual(600);
    expectClear([expanded], movables, placed);
  });

  it('goes past the soft bounds, never the hard ones, when there is no room inside', () => {
    const expanded = { x: 20, y: 20, width: 400, height: 300 };
    const movables = [tile('a', 40, 40), tile('b', 200, 40)];
    const bounds = { left: 20, top: 20, right: 440, bottom: 340 };
    const placed = after([expanded], movables, bounds);
    for (const movable of placed) {
      expect(movable.rect.x).toBeGreaterThanOrEqual(20);
      expect(movable.rect.y).toBeGreaterThanOrEqual(20);
    }
    expectClear([expanded], movables, placed);
  });

  it('moves one hanging over the hard bounds back inside them', () => {
    // Over the zone's top-left corner, as a tile may hang over a zone's edge, and under the expanded tile.
    const expanded = { x: 20, y: 44, width: 960, height: 600 };
    const movables = [tile('a', 5, -14, 256, 160)];
    const placed = after([expanded], movables, { left: 20, top: 20, right: 700, bottom: 460 });
    expect(Number.isFinite(placed[0]!.rect.x) && Number.isFinite(placed[0]!.rect.y)).toBe(true);
    expect(placed[0]!.rect.x).toBeGreaterThanOrEqual(20);
    expect(placed[0]!.rect.y).toBeGreaterThanOrEqual(20);
    expectClear([expanded], movables, placed);
  });

  it('is deterministic, whatever order the neighbours come in', () => {
    const fixed = [{ x: 0, y: 0, width: 500, height: 400 }];
    const movables = [tile('a', 100, 100), tile('b', 300, 100), tile('c', 100, 300), tile('d', 450, 350)];
    const forward = clearOfExpanded(fixed, movables);
    const backward = clearOfExpanded(fixed, movables.toReversed());
    expect(new Map([...backward].toSorted())).toEqual(new Map([...forward].toSorted()));
    expect(clearOfExpanded(fixed, movables)).toEqual(forward);
  });

  it('leaves nothing under anything, over many random boards', () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let run = 0; run < 200; run++) {
      const fixed = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
        x: Math.round(random() * 1200),
        y: Math.round(random() * 800),
        width: 400 + Math.round(random() * 600),
        height: 300 + Math.round(random() * 300),
      }));
      // A grid of tiles, as a board has, each clear of the others.
      const movables: Movable[] = [];
      for (let row = 0; row < 6; row++) {
        for (let column = 0; column < 8; column++) {
          if (random() < 0.4) movables.push(tile(`t${row}-${column}`, column * (256 + TILE_GAP), row * (160 + TILE_GAP), 256, 160));
        }
      }
      expectClear(fixed, movables, after(fixed, movables));
    }
  });

  it('leaves nothing under anything and nothing past the hard bounds, in many random zones', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let run = 0; run < 200; run++) {
      const bounds = { left: 20, top: 20, right: 400 + Math.round(random() * 800), bottom: 300 + Math.round(random() * 500) };
      const fixed = [{ x: 20 + Math.round(random() * 300), y: 20 + Math.round(random() * 200), width: 640, height: 360 }];
      // Some hanging over the zone's edges, as tiles may.
      const movables = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) =>
        tile(`t${index}`, Math.round(random() * 900) - 100, Math.round(random() * 700) - 100, 256, 160),
      );
      const placed = after(fixed, movables, bounds);
      for (const [index, movable] of placed.entries()) {
        const was = movables[index]!.rect;
        if (movable.rect.x === was.x && movable.rect.y === was.y) continue;
        expect(movable.rect.x).toBeGreaterThanOrEqual(bounds.left);
        expect(movable.rect.y).toBeGreaterThanOrEqual(bounds.top);
      }
      for (const movable of placed) for (const rect of fixed) expect(crowded(movable.rect, rect)).toBe(false);
    }
  });
});

const zone = (id: string, x: number, y: number, width = 800, height = 300) =>
  zoneNode({ id, x, y, width, height, repoRoot: null, folder: '', name: id, color: '#4c6ef5' } as Zone);
const shell = (id: string, zoneId: string | null, position: TilePosition) =>
  ({ id, zoneId, position, name: id, cwd: '/', layout: { type: 'pane', sessionId: `${id}-pane` }, endedPanes: [] }) as unknown as Shell;
const at = (x: number, y: number): TilePosition => ({ x, y, z: 0 });

/** A node's rect on the board, a tile's with the room above it for its subagents. */
function boardRect(nodes: BoardNode[], node: BoardNode): Rect {
  const parent = nodes.find((known) => known.id === node.parentId);
  const x = node.position.x + (parent?.position.x ?? 0);
  const y = node.position.y + (parent?.position.y ?? 0);
  const perch = node.type === 'tile' && node.data.expanded !== true ? PERCH_ROOM : 0;
  return { x, y: y - perch, width: node.width!, height: node.height! + perch };
}

describe('displaced', () => {
  const s = (id: string) => tileNodeId('shell', id);

  it('is the same nodes when nothing is expanded', () => {
    const nodes = withTiles([], [], [shell('a', null, at(0, 0))], []);
    expect(displaced(nodes, [])).toBe(nodes);
  });

  it('moves loose neighbours on every side clear of an expanded tile, and changes none of the nodes it was given', () => {
    const middle = { x: 1000, y: 1000 };
    const shells = [
      shell('middle', null, at(middle.x, middle.y)),
      shell('right', null, at(middle.x + AGENT_TILE_SIZE.width + TILE_GAP, middle.y)),
      shell('left', null, at(middle.x - AGENT_TILE_SIZE.width - TILE_GAP, middle.y)),
      shell('below', null, at(middle.x, middle.y + AGENT_TILE_SIZE.height + PERCH_ROOM + TILE_GAP)),
      shell('far', null, at(5000, 5000)),
    ];
    const expanded = expandTile([], s('middle'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const before = structuredClone(nodes);
    const shown = displaced(nodes, expanded);

    expect(nodes).toEqual(before);
    const open = boardRect(shown, shown.find((node) => node.id === s('middle'))!);
    expect(open).toEqual({ ...middle, ...EXPANDED_SIZE });
    for (const id of ['right', 'left', 'below']) {
      const rect = boardRect(shown, shown.find((node) => node.id === s(id))!);
      const clear = rect.x >= open.x + open.width || rect.x + rect.width <= open.x || rect.y >= open.y + open.height || rect.y + rect.height <= open.y;
      expect(clear, id).toBe(true);
    }
    // The one on the left was already clear of it.
    expect(shown.find((node) => node.id === s('left'))).toBe(nodes.find((node) => node.id === s('left')));
    expect(shown.find((node) => node.id === s('far'))).toBe(nodes.find((node) => node.id === s('far')));
  });

  it("rearranges a zone's own tiles within it, growing it only when they don't fit, and pushes other zones clear", () => {
    const zones = [zone('z', 0, 0, 1200, 400), zone('next', 1240, 0)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const shells = [
      shell('a', 'z', at(first.x, first.y)),
      shell('b', 'z', at(first.x + AGENT_TILE_SIZE.width + TILE_GAP, first.y)),
      shell('c', 'z', at(first.x + 2 * (AGENT_TILE_SIZE.width + TILE_GAP), first.y)),
    ];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles(zones, [], shells, [], new Map(), expanded);
    const shown = displaced(nodes, expanded);

    const open = boardRect(shown, shown.find((node) => node.id === s('a'))!);
    const grown = shown.find((node) => node.id === 'z')!;
    for (const id of ['b', 'c']) {
      const node = shown.find((known) => known.id === s(id))!;
      expect(node.parentId).toBe('z');
      const rect = boardRect(shown, node);
      expect(rect.x + rect.width + ZONE_PADDING, `${id} inside its zone`).toBeLessThanOrEqual(grown.width! + 1e-6);
      const clear = rect.x >= open.x + open.width || rect.x + rect.width <= open.x || rect.y >= open.y + open.height || rect.y + rect.height <= open.y;
      expect(clear, id).toBe(true);
    }
    // The next zone is clear of the expanded tile and of its grown zone.
    const next = boardRect(shown, shown.find((node) => node.id === 'next')!);
    for (const rect of [open, boardRect(shown, grown)]) {
      const clear = next.x >= rect.x + rect.width || next.x + next.width <= rect.x || next.y >= rect.y + rect.height || next.y + next.height <= rect.y;
      expect(clear).toBe(true);
    }
  });

  it('grows a zone to hold a lone expanded tile in it, and nothing else changes', () => {
    const zones = [zone('z', 0, 0, 720, 480)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const expanded = expandTile([], s('a'));
    const shown = displaced(withTiles(zones, [], [shell('a', 'z', at(first.x, first.y))], [], new Map(), expanded), expanded);
    const grown = shown.find((node) => node.id === 'z') as ZoneNodeType;
    expect({ width: grown.width, height: grown.height }).toEqual({
      width: first.x + EXPANDED_SIZE.width + ZONE_PADDING,
      height: first.y + EXPANDED_SIZE.height + TILE_GAP + ZONE_PADDING,
    });
    expect(grown.data.grown).toBe(true);
    expect(grown.position).toEqual({ x: 0, y: 0 });
  });

  it("holds the expanded tile and every one of the zone's tiles in the grown zone", () => {
    const zones = [zone('z', 100, 100, 720, 480)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const step = AGENT_TILE_SIZE.width + TILE_GAP;
    const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', 'z', at(first.x + step, first.y)), shell('c', 'z', at(first.x, first.y + 200))];
    const expanded = expandTile([], s('a'));
    const shown = displaced(withTiles(zones, [], shells, [], new Map(), expanded), expanded);
    const holder = boardRect(shown, shown.find((node) => node.id === 'z')!);
    for (const id of ['a', 'b', 'c']) {
      const rect = boardRect(shown, shown.find((node) => node.id === s(id))!);
      expect(rect.x + rect.width + ZONE_PADDING, id).toBeLessThanOrEqual(holder.x + holder.width + 1e-6);
      expect(rect.y + rect.height + ZONE_PADDING, id).toBeLessThanOrEqual(holder.y + holder.height + 1e-6);
    }
  });

  it('rearranges first: a zone with room for its tiles beside the expanded one does not grow', () => {
    const zones = [zone('z', 0, 0, 1600, 900)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', 'z', at(first.x + AGENT_TILE_SIZE.width + TILE_GAP, first.y))];
    const expanded = expandTile([], s('a'));
    const shown = displaced(withTiles(zones, [], shells, [], new Map(), expanded), expanded);
    const z = shown.find((node) => node.id === 'z') as ZoneNodeType;
    expect({ width: z.width, height: z.height, grown: z.data.grown }).toEqual({ width: 1600, height: 900, grown: undefined });
    expect(shown.find((node) => node.id === s('b'))!.position).not.toEqual({ x: first.x + AGENT_TILE_SIZE.width + TILE_GAP, y: first.y });
  });

  it('grows a zone with a tile expanded and resized mid-drag, live', () => {
    const zones = [zone('z', 0, 0, 1600, 900)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const expanded = expandTile([], s('a'));
    const nodes = withTiles(zones, [], [shell('a', 'z', at(first.x, first.y))], [], new Map(), expanded).map((node) =>
      node.id === s('a') ? { ...node, resizing: true, width: 2000, height: 1000 } : node,
    );
    const z = displaced(nodes, expanded).find((node) => node.id === 'z')!;
    expect({ width: z.width, height: z.height }).toEqual({ width: first.x + 2000 + ZONE_PADDING, height: first.y + 1000 + TILE_GAP + ZONE_PADDING });
  });

  it('marks a zone it grows, and no other', () => {
    const zones = [zone('z', 0, 0, 720, 480), zone('far', 5000, 0)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', 'z', at(first.x + AGENT_TILE_SIZE.width + TILE_GAP, first.y))];
    const expanded = expandTile([], s('a'));
    const shown = displaced(withTiles(zones, [], shells, [], new Map(), expanded), expanded);
    const grown = shown.find((node) => node.id === 'z') as ZoneNodeType;
    expect(grown.height).toBeGreaterThan(480);
    expect(grown.data.grown).toBe(true);
    expect((shown.find((node) => node.id === 'far') as ZoneNodeType).data.grown).toBeUndefined();
  });

  it("moves a zone's notes and cards clear of an expanded tile in it, as its tiles", () => {
    const item = (id: string, x: number, y: number): BoardItem =>
      ({ id, kind: 'sticky', zoneId: 'z', x, y, width: 200, height: 200, z: 0, rotation: 0, data: {}, createdAt: '', updatedAt: '' }) as BoardItem;
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const expanded = expandTile([], s('a'));
    const nodes = withTiles(
      [zone('z', 0, 0, 1600, 900), itemNode(item('beside', 400, 100)), itemNode(item('below', 40, 500))],
      [],
      [shell('a', 'z', at(first.x, first.y))],
      [],
      new Map(),
      expanded,
    );
    const shown = displaced(nodes, expanded);
    const open = boardRect(shown, shown.find((node) => node.id === s('a'))!);
    for (const id of ['item:beside', 'item:below']) {
      const node = shown.find((known) => known.id === id)!;
      expect(node.parentId).toBe('z');
      const rect = boardRect(shown, node);
      const clear = rect.x >= open.x + open.width || rect.x + rect.width <= open.x || rect.y >= open.y + open.height || rect.y + rect.height <= open.y;
      expect(clear, id).toBe(true);
      expect(rect.x).toBeGreaterThanOrEqual(ZONE_PADDING);
    }
  });

  it("moves a rotated note clear by the box round it, not its straight one", () => {
    const middle = { x: 1000, y: 1000 };
    // Straight, it would be clear of the expanded tile by more than the gap; turned 45°, its corners reach under it.
    const note = {
      id: 'tilted', kind: 'sticky', zoneId: null, x: middle.x + EXPANDED_SIZE.width + 30, y: middle.y, width: 200, height: 200, z: 0,
      rotation: 45, data: {}, createdAt: '', updatedAt: '',
    } satisfies BoardItem;
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([itemNode(note)], [], [shell('a', null, at(middle.x, middle.y))], [], new Map(), expanded);
    const shown = displaced(nodes, expanded);
    const open = boardRect(shown, shown.find((node) => node.id === s('a'))!);
    const moved = shown.find((node) => node.id === 'item:tilted')!;
    const bounds = rotatedBounds({ ...moved.position, width: 200, height: 200 }, 45);
    expect(bounds.x).toBeGreaterThanOrEqual(open.x + open.width + TILE_GAP - 1e-6);
  });

  it('reflows live from the size React Flow gives an expanded tile as it is resized', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(2000, 0))];
    const expanded = expandTile([], s('a'));
    // Mid-resize, well past the neighbour: it moves out of the way at once, not when the resize ends.
    const nodes = withTiles([], [], shells, [], new Map(), expanded).map((node) =>
      node.id === s('a') ? { ...node, resizing: true, width: 2400 } : node,
    );
    const shown = displaced(nodes, expanded);
    const rect = boardRect(shown, shown.find((node) => node.id === s('b'))!);
    expect(crowded(rect, { x: 0, y: 0, width: 2400, height: EXPANDED_SIZE.height })).toBe(false);
  });

  it('leaves what is being dragged where it is', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(AGENT_TILE_SIZE.width + TILE_GAP, 0))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded).map((node) => (node.id === s('b') ? { ...node, dragging: true } : node));
    expect(displaced(nodes, expanded)).toBe(nodes);
  });
});

describe('apart', () => {
  it('leaves rects that are already clear of each other where they are', () => {
    expect(apart([tile('a', 0, 0, 400, 300), tile('b', 600, 0, 400, 300)]).size).toBe(0);
  });

  it('keeps the first in reading order where it is and moves a later one to the clear spot nearest where it was', () => {
    const moves = apart([tile('b', 200, 100, 400, 300), tile('a', 0, 0, 400, 300)]);
    expect(moves.has('a')).toBe(false);
    expect(moves.get('b')).toEqual({ x: 400 + TILE_GAP, y: 100 });
  });

  it('puts the anchored ones first, whatever their place in reading order', () => {
    const moves = apart([tile('a', 0, 0, 400, 300), tile('b', 100, 200, 400, 300)], undefined, new Set(['b']));
    expect(moves.has('b')).toBe(false);
    expect(moves.get('a')).toEqual({ x: 0, y: 200 - TILE_GAP - 300 });
  });

  it('keeps the moves inside the hard bounds', () => {
    const moves = apart([tile('a', 20, 20, 400, 300), tile('b', 30, 30, 400, 300)], { left: 20, top: 20, right: 900, bottom: 400 });
    const b = moves.get('b')!;
    expect(b.x).toBeGreaterThanOrEqual(20);
    expect(b.y).toBeGreaterThanOrEqual(20);
  });

  it('is deterministic, and nothing crowds anything, over many random boards', () => {
    let seed = 3;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let run = 0; run < 200; run++) {
      const rects = Array.from({ length: 2 + Math.floor(random() * 4) }, (_, index) =>
        tile(`e${index}`, Math.round(random() * 1500), Math.round(random() * 1000), 640 + Math.round(random() * 600), 360 + Math.round(random() * 300)),
      );
      const bounds = random() < 0.5 ? undefined : { left: 0, top: 0, right: 1600, bottom: 1200 };
      const moves = apart(rects, bounds);
      expect(apart(rects.toReversed(), bounds)).toEqual(moves);
      const placed = rects.map(({ id, rect }) => ({ ...rect, ...moves.get(id) }));
      for (const [index, rect] of placed.entries()) {
        for (const other of placed.slice(index + 1)) expect(crowded(rect, other)).toBe(false);
      }
    }
  });
});

describe('displaced, with several tiles expanded', () => {
  const s = (id: string) => tileNodeId('shell', id);
  const step = AGENT_TILE_SIZE.width + TILE_GAP;
  /** Each expanded or compact tile's rect on the board, as drawn. */
  const drawn = (shown: BoardNode[], ids: readonly string[]) => ids.map((id) => boardRect(shown, shown.find((node) => node.id === s(id))!));
  /** No two of `rects` crowd each other. */
  const expectApart = (rects: readonly Rect[]) => {
    for (const [index, rect] of rects.entries()) {
      for (const [offset, other] of rects.slice(index + 1).entries()) expect(crowded(rect, other), `${index} and ${index + 1 + offset}`).toBe(false);
    }
  };

  it('keeps two expanded loose tiles clear of each other, and of the tiles round them', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(step, 0)), shell('c', null, at(2 * step, 0)), shell('d', null, at(0, 400))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const shown = displaced(withTiles([], [], shells, [], new Map(), expanded), expanded);
    expectApart(drawn(shown, ['a', 'b', 'c', 'd']));
    // The first in reading order stays where it is.
    expect(shown.find((node) => node.id === s('a'))!.position).toEqual({ x: 0, y: 0 });
  });

  it('lays them out the same whichever is in front: bringing one forward moves nothing', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(step, 0)), shell('c', null, at(0, 300))];
    const expanded = expandTile(expandTile(expandTile([], s('a')), s('b')), s('c'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const places = (order: typeof expanded) => displaced(nodes, order).map((node) => [node.id, node.position]);
    expect(places(expanded.toReversed())).toEqual(places(expanded));
    expect(places(bringToFront(expanded, s('a')))).toEqual(places(expanded));
  });

  it('keeps two expanded tiles in a zone clear of each other and of its other tiles, the zone grown to hold them all', () => {
    const zones = [zone('z', 0, 0, 1200, 400), zone('next', 1240, 0)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const shells = ['a', 'b', 'c', 'd'].map((id, index) => shell(id, 'z', at(first.x + index * step, first.y)));
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const shown = displaced(withTiles(zones, [], shells, [], new Map(), expanded), expanded);
    const rects = drawn(shown, ['a', 'b', 'c', 'd']);
    expectApart(rects);
    const holder = boardRect(shown, shown.find((node) => node.id === 'z')!);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(holder.x + ZONE_PADDING);
      expect(rect.y).toBeGreaterThanOrEqual(holder.y + ZONE_PADDING);
      expect(rect.x + rect.width + ZONE_PADDING).toBeLessThanOrEqual(holder.x + holder.width + 1e-6);
      expect(rect.y + rect.height + ZONE_PADDING).toBeLessThanOrEqual(holder.y + holder.height + 1e-6);
    }
    expect(crowded(holder, boardRect(shown, shown.find((node) => node.id === 'next')!))).toBe(false);
  });

  it('keeps two zones, each grown round an expanded tile, clear of each other', () => {
    const zones = [zone('z', 0, 0, 720, 480), zone('y', 760, 0, 720, 480)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', 'y', at(first.x, first.y))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const shown = displaced(withTiles(zones, [], shells, [], new Map(), expanded), expanded);
    const [z, y] = ['z', 'y'].map((id) => boardRect(shown, shown.find((node) => node.id === id)!));
    expect(crowded(z!, y!)).toBe(false);
    expectApart(drawn(shown, ['a', 'b']));
    // The one first in reading order stays.
    expect(z!.x).toBe(0);
  });

  it('keeps a loose expanded tile and a zone grown round another clear of each other', () => {
    const zones = [zone('z', 0, 0, 720, 480)];
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', null, at(800, 100))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const shown = displaced(withTiles(zones, [], shells, [], new Map(), expanded), expanded);
    const [z] = ['z'].map((id) => boardRect(shown, shown.find((node) => node.id === id)!));
    expect(crowded(z!, drawn(shown, ['b'])[0]!)).toBe(false);
  });

  it('leaves a tile dragged onto an expanded one there, and the expanded one where it is', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    expect(displaced(nodes, expanded, new Map([[s('b'), s('a')]]))).toBe(nodes);
  });

  it('leaves a compact tile an expanded one was dragged onto under it', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    expect(displaced(nodes, expanded, new Map([[s('a'), s('b')]]))).toBe(nodes);
  });

  it('leaves a loose tile dropped onto an expanded one in a zone there, and the zone where it is', () => {
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const zones = [zone('z', 0, 0, 720, 480)];
    for (const open of [['a'], ['a', 'b']]) {
      const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', null, at(300, 200))];
      const expanded = open.reduce((tiles, id) => expandTile(tiles, s(id)), [] as ReturnType<typeof expandTile>);
      const nodes = withTiles(zones, [], shells, [], new Map(), expanded);
      const shown = displaced(nodes, expanded, new Map([[s('b'), s('a')]]));
      expect(shown.find((node) => node.id === s('b'))!.position, open.join()).toEqual({ x: 300, y: 200 });
      expect(shown.find((node) => node.id === 'z')!.position, open.join()).toEqual({ x: 0, y: 0 });
    }
  });

  it('lets a dropped tile overlap only the tile it was dropped onto: another expanded tile still moves it clear', () => {
    // b was dropped onto a; c, expanded later beside b, is not a.
    const shells = [shell('a', null, at(-2000, 0)), shell('b', null, at(300, 200)), shell('c', null, at(0, 0))];
    const expanded = expandTile(expandTile([], s('a')), s('c'));
    const shown = displaced(withTiles([], [], shells, [], new Map(), expanded), expanded, new Map([[s('b'), s('a')]]));
    const [b, c] = drawn(shown, ['b', 'c']);
    expect(crowded(b!, c!)).toBe(false);
  });

  it('keeps a dropped expanded tile apart from every expanded tile but the one it was dropped onto', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200)), shell('c', null, at(600, 400))];
    const expanded = expandTile(expandTile(expandTile([], s('a')), s('b')), s('c'));
    const shown = displaced(withTiles([], [], shells, [], new Map(), expanded), expanded, new Map([[s('b'), s('a')]]));
    const [a, b, c] = drawn(shown, ['a', 'b', 'c']);
    expect(crowded(a!, b!)).toBe(true);
    expect(crowded(c!, a!) || crowded(c!, b!)).toBe(false);
  });

  it('leaves an expanded tile dragged onto another there, and the other where it is, while what else it covers moves', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200)), shell('c', null, at(300 + 900, 300))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const shown = displaced(nodes, expanded, new Map([[s('b'), s('a')]]));
    expect(shown.find((node) => node.id === s('a'))).toBe(nodes.find((node) => node.id === s('a')));
    expect(shown.find((node) => node.id === s('b'))).toBe(nodes.find((node) => node.id === s('b')));
    const [a, b, c] = drawn(shown, ['a', 'b', 'c']);
    expect(crowded(c!, a!) || crowded(c!, b!)).toBe(false);
  });

  it('moves no compact tile out of the way of an expanded one being dragged over it, so it can be dropped there', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded).map((node) => (node.id === s('a') ? { ...node, dragging: true } : node));
    expect(displaced(nodes, expanded)).toBe(nodes);
  });

  it('leaves an expanded tile being dragged over another where it is, and the other too, until it is dropped', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded).map((node) => (node.id === s('b') ? { ...node, dragging: true } : node));
    expect(displaced(nodes, expanded)).toBe(nodes);
  });

  it('leaves no tile under another, whatever is expanded, over many random boards, the same every time', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let run = 0; run < 100; run++) {
      const ids: string[] = [];
      const shells: Shell[] = [];
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < 6; column++) {
          if (random() < 0.5) continue;
          const id = `t${row}-${column}`;
          ids.push(id);
          shells.push(shell(id, null, at(column * step, row * (AGENT_TILE_SIZE.height + PERCH_ROOM + TILE_GAP))));
        }
      }
      let expanded = expandTile([], s(ids[0] ?? 'none'));
      for (const id of ids) if (random() < 0.25) expanded = expandTile(expanded, s(id));
      const nodes = withTiles([], [], shells, [], new Map(), expanded);
      const shown = displaced(nodes, expanded);
      expectApart(drawn(shown, ids));
      expect(displaced(nodes, expanded.toReversed())).toEqual(shown);
    }
  });
});

describe('droppedOnto', () => {
  const s = (id: string) => tileNodeId('shell', id);

  it('is the tile a tile was dropped over, if one of the two is expanded', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200)), shell('c', null, at(2000, 0)), shell('d', null, at(2100, 50))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    expect(droppedOnto(nodes, s('b'), expanded)).toBe(s('a'));
    expect(droppedOnto(nodes, s('a'), expanded)).toBe(s('b'));
  });

  it('is the expanded one, then the one covered most, of several under it', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(100, 100)), shell('c', null, at(500, 100)), shell('d', null, at(700, 150))];
    const expanded = expandTile(expandTile([], s('a')), s('d'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    expect(droppedOnto(nodes, s('a'), expanded)).toBe(s('d'));
    // d now compact and moved off to cover least.
    const alone = expandTile([], s('a'));
    const moved = shells.map((known) => (known.id === 'd' ? { ...known, position: at(850, 150) } : known));
    expect(droppedOnto(withTiles([], [], moved, [], new Map(), alone), s('a'), alone)).toBe(s('b'));
  });

  it('is none for a tile dropped clear of every expanded tile, or over a compact one with nothing expanded', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(2000, 0)), shell('c', null, at(2100, 50))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    expect(droppedOnto(nodes, s('b'), expanded)).toBeUndefined();
    expect(droppedOnto(nodes, s('c'), expanded)).toBeUndefined();
  });

  it('reckons a tile in a zone where it is on the board', () => {
    const zones = [zone('z', 1000, 1000, 720, 480)];
    const shells = [shell('a', null, at(1100, 1100)), shell('b', 'z', at(ZONE_PADDING, ZONE_PADDING + PERCH_ROOM))];
    const expanded = expandTile([], s('a'));
    const nodes = withTiles(zones, [], shells, [], new Map(), expanded);
    expect(droppedOnto(nodes, s('b'), expanded)).toBe(s('a'));
  });
});

describe('displaced, as a drag or a resize begins', () => {
  const s = (id: string) => tileNodeId('shell', id);
  const places = (nodes: BoardNode[]) => Object.fromEntries(nodes.map((node) => [node.id, { ...node.position, width: node.width, height: node.height }]));
  /**
   * `nodes` with `id` dragged, as React Flow starts a drag: flagged, at where it is drawn in `shown`; or resized from its
   * bottom-right, flagged at its stored place (a resize from there sends no position).
   */
  const begin = (nodes: BoardNode[], shown: BoardNode[], id: string, change: 'dragging' | 'resizing') =>
    nodes.map((node) => (node.id !== id ? node : change === 'dragging' ? { ...node, dragging: true, position: shown.find((known) => known.id === id)!.position } : { ...node, resizing: true }));

  it('keeps a resized expanded tile, moved clear of another, where it is drawn, and the other too (review r1, 1)', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const rest = displaced(nodes, expanded);
    expect(rest.find((node) => node.id === s('b'))!.position).not.toEqual({ x: 300, y: 200 });
    const resizing = begin(nodes, rest, s('b'), 'resizing');
    expect(places(displaced(resizing, expanded, new Map(), heldFrom(nodes, rest)))).toEqual(places(rest));
  });

  it("moves nothing as an expanded tile's drag begins, the one moved clear of it included (review r1, 2)", () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(300, 200))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const rest = displaced(nodes, expanded);
    const dragging = begin(nodes, rest, s('a'), 'dragging');
    expect(places(displaced(dragging, expanded, new Map(), heldFrom(nodes, rest)))).toEqual(places(rest));
  });

  it("moves no zone as a drag of a compact tile in one begins (review r1, 2)", () => {
    const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
    const zones = [zone('z', 0, 0, 720, 480), zone('y', 400, 100, 720, 480)];
    const shells = [shell('a', 'z', at(first.x, first.y)), shell('b', 'y', at(first.x, first.y)), shell('c', 'y', at(first.x, first.y + 200))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles(zones, [], shells, [], new Map(), expanded);
    const rest = displaced(nodes, expanded);
    const dragging = begin(nodes, rest, s('c'), 'dragging');
    expect(places(displaced(dragging, expanded, new Map(), heldFrom(nodes, rest)))).toEqual(places(rest));
  });

  it('moves the others clear of a resized tile as it grows, from where they were drawn', () => {
    const shells = [shell('a', null, at(0, 0)), shell('b', null, at(1100, 0)), shell('c', null, at(0, 800))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const rest = displaced(nodes, expanded);
    const grown = begin(nodes, rest, s('a'), 'resizing').map((node) => (node.id === s('a') ? { ...node, width: 1400, height: 900 } : node));
    const shown = displaced(grown, expanded, new Map(), heldFrom(nodes, rest));
    expect(shown.find((node) => node.id === s('a'))!.position).toEqual({ x: 0, y: 0 });
    const [a, b, c] = ['a', 'b', 'c'].map((id) => boardRect(shown, shown.find((node) => node.id === s(id))!));
    expect(crowded({ ...a!, width: 1400, height: 900 }, b!)).toBe(false);
    expect(crowded({ ...a!, width: 1400, height: 900 }, c!)).toBe(false);
  });

  // Left for a ruling (handover): at rest, expanded tiles are kept apart in reading order, so once a resize that grew
  // into one earlier in that order ends, that one goes back and the resized one makes way instead.
  it('lays out again in reading order once the resize ends: the resized tile then makes way for the one it grew into', () => {
    const shells = [shell('a', null, at(0, 300)), shell('b', null, at(1100, 0))];
    const expanded = expandTile(expandTile([], s('a')), s('b'));
    const nodes = withTiles([], [], shells, [], new Map(), expanded);
    const rest = displaced(nodes, expanded);
    const size = { width: 1400, height: 600 };
    const grown = begin(nodes, rest, s('a'), 'resizing').map((node) => (node.id === s('a') ? { ...node, ...size } : node));
    const during = displaced(grown, expanded, new Map(), heldFrom(nodes, rest));
    expect(during.find((node) => node.id === s('a'))!.position).toEqual({ x: 0, y: 300 });
    const ended = resizeExpanded(expanded, s('a'), size);
    const after = displaced(withTiles([], [], shells, [], new Map(), ended), ended);
    expect(after.find((node) => node.id === s('b'))!.position).toEqual({ x: 1100, y: 0 });
    expect(after.find((node) => node.id === s('a'))!.position).not.toEqual({ x: 0, y: 300 });
  });

  it('moves no node as any node begins to be dragged, or an expanded tile resized, over many random boards with zones', () => {
    let seed = 23;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let run = 0; run < 60; run++) {
      const { nodes, expanded, overlaps, ids } = randomBoard(random);
      const rest = displaced(nodes, expanded, overlaps);
      const held = heldFrom(nodes, rest);
      for (const node of nodes) {
        const label = `run ${run}, ${node.id}`;
        expect(places(displaced(begin(nodes, rest, node.id, 'dragging'), expanded, overlaps, held)), `${label} dragged`).toEqual(places(rest));
        if (expanded.some((entry) => entry.id === node.id)) {
          expect(places(displaced(begin(nodes, rest, node.id, 'resizing'), expanded, overlaps, held)), `${label} resized`).toEqual(places(rest));
        }
      }
      // At rest: nothing under anything but a dropped tile over its own, and the same layout every time.
      const paired = (a: string, b: string) => overlaps.get(s(a)) === s(b) || overlaps.get(s(b)) === s(a);
      const rects = ids.map((id) => boardRect(rest, rest.find((known) => known.id === s(id))!));
      for (const [i, a] of ids.entries()) {
        for (const [j, b] of ids.entries()) {
          if (j > i && !paired(a, b)) expect(crowded(rects[i]!, rects[j]!), `run ${run}: ${a} on ${b}`).toBe(false);
        }
      }
      expect(displaced(nodes, expanded.toReversed(), overlaps)).toEqual(rest);
    }
  });
});

/**
 * A random board: up to three zones in a row, each with a few tiles in its slots, and tiles loose below them; about a
 * quarter expanded, and now and then a tile dropped onto an expanded one. Nothing overlaps as laid out.
 */
function randomBoard(random: () => number) {
  const s = (id: string) => tileNodeId('shell', id);
  const step = AGENT_TILE_SIZE.width + TILE_GAP;
  const row = AGENT_TILE_SIZE.height + PERCH_ROOM + TILE_GAP;
  const zones = Array.from({ length: Math.floor(random() * 3) + 1 }, (_, index) =>
    zone(`z${index}`, index * 900, 0, 600 + Math.round(random() * 200), 400 + Math.round(random() * 200)),
  );
  const shells: Shell[] = [];
  for (const node of zones) {
    for (let slot = 0; slot < 4; slot++) {
      if (random() < 0.4) continue;
      shells.push(shell(`${node.id}-${slot}`, node.id, at(ZONE_PADDING + (slot % 2) * step, ZONE_PADDING + PERCH_ROOM + Math.floor(slot / 2) * row)));
    }
  }
  for (let column = 0; column < 6; column++) if (random() < 0.5) shells.push(shell(`loose-${column}`, null, at(column * step, 1000 + PERCH_ROOM)));
  const ids = shells.map((known) => known.id);
  let expanded = expandTile([], s(ids[0]!));
  for (const id of ids) if (random() < 0.25) expanded = expandTile(expanded, s(id));
  const overlaps = new Map<string, string>();
  for (const id of ids) {
    if (random() >= 0.1 || expanded.some((entry) => entry.id === s(id))) continue;
    const onto = expanded[Math.floor(random() * expanded.length)]!.id;
    if (![...overlaps].flat().includes(onto)) overlaps.set(s(id), onto);
  }
  return { nodes: withTiles(zones, [], shells, [], new Map(), expanded), expanded, overlaps, ids };
}

describe('displaced, with a crew in the way', () => {
  const agent = (sessionId: string, zoneId: string | null, position: TilePosition, spawnedBy: string | null = null) =>
    ({ sessionId, zoneId, position, spawnedBy, orchestrate: null, repoRoot: '/code/app', name: sessionId, harness: 'claude' }) as Agent;
  const a = (id: string) => tileNodeId('agent', id);
  const { width, height } = AGENT_TILE_SIZE;
  const boss = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
  const column = (n: number) => boss.x + width + CREW_GAP + n * (width + TILE_GAP);
  const row = (n: number) => boss.y + n * (PERCH_ROOM + height + TILE_GAP);
  /** A boss with an L of three crew a row down, under a stranger beside it, in a roomy zone. */
  const board = () => {
    const agents = [
      agent('boss', 'z', at(boss.x, boss.y)),
      agent('stranger', 'z', at(column(0), row(0))),
      agent('w1', 'z', at(column(0), row(1)), 'boss'),
      agent('w2', 'z', at(column(1), row(1)), 'boss'),
      agent('w3', 'z', at(column(0), row(2)), 'boss'),
    ];
    return (expanded: ReturnType<typeof expandTile>) => withTiles([zone('z', 0, 0, 2400, 1600)], agents, [], [], new Map(), expanded);
  };
  const crew = [a('w1'), a('w2'), a('w3')];
  const crews = [crew];
  const shift = (nodes: BoardNode[], shown: BoardNode[], id: string) => {
    const was = nodes.find((node) => node.id === id)!.position;
    const now = shown.find((node) => node.id === id)!.position;
    return { dx: now.x - was.x, dy: now.y - was.y };
  };
  const clear = (rect: Rect, of: Rect) =>
    rect.x >= of.x + of.width || rect.x + rect.width <= of.x || rect.y >= of.y + of.height || rect.y + rect.height <= of.y;

  it('moves a crew a stranger expanded over as one block, by one shift down or right, frame and all', () => {
    const expanded = expandTile([], a('stranger'));
    const nodes = board()(expanded);
    const shown = displaced(nodes, expanded, new Map(), new Map(), crews);

    const [first, ...rest] = crew.map((id) => shift(nodes, shown, id));
    expect(first!.dx === 0 && first!.dy > 0).toBe(true);
    for (const each of rest) expect(each).toEqual(first);
    const open = boardRect(shown, shown.find((node) => node.id === a('stranger'))!);
    const tiles = (list: BoardNode[]) => list.filter(isSessionTile) as TileNodeType[];
    const [frame] = crewFrames(tiles(nodes), tiles(shown));
    expect(frame!.members).toEqual(['w1', 'w2', 'w3']);
    expect(clear(frame!, open)).toBe(true);
    // The zone grows to hold the frame.
    const z = shown.find((node) => node.id === 'z')!;
    expect(frame!.y + frame!.height).toBeLessThanOrEqual(z.height! - ZONE_PADDING + CREW_PADDING);
  });

  it('moves the crew as one block clear of its own orchestrator expanded', () => {
    const expanded = expandTile([], a('boss'));
    const nodes = board()(expanded);
    const shown = displaced(nodes, expanded, new Map(), new Map(), crews);
    const [first, ...rest] = crew.map((id) => shift(nodes, shown, id));
    expect(first).not.toEqual({ dx: 0, dy: 0 });
    for (const each of rest) expect(each).toEqual(first);
  });

  it('moves the rest of a crew on their own when one of them is expanded', () => {
    const expanded = expandTile([], a('w1'));
    const nodes = board()(expanded);
    const shown = displaced(nodes, expanded, new Map(), new Map(), crews);
    expect(shown.find((node) => node.id === a('w1'))!.position).toEqual(nodes.find((node) => node.id === a('w1'))!.position);
    const open = boardRect(shown, shown.find((node) => node.id === a('w1'))!);
    for (const id of [a('w2'), a('w3')]) expect(clear(boardRect(shown, shown.find((node) => node.id === id)!), open), id).toBe(true);
  });

  it('leaves a crew member dropped onto an expanded stranger there, and moves the rest of its crew on their own', () => {
    const expanded = expandTile([], a('stranger'));
    const nodes = board()(expanded);
    const shown = displaced(nodes, expanded, new Map([[a('w1'), a('stranger')]]), new Map(), crews);
    expect(shift(nodes, shown, a('w1'))).toEqual({ dx: 0, dy: 0 });
    const open = boardRect(shown, shown.find((node) => node.id === a('stranger'))!);
    for (const id of [a('w2'), a('w3')]) expect(clear(boardRect(shown, shown.find((node) => node.id === id)!), open), id).toBe(true);
  });

  it('pushes a group zone clear of a loose expanded tile as one block, its tiles with it', () => {
    const shells = [shell('loose', null, at(0, 0)), shell('in', 'g', at(ZONE_PADDING, ZONE_PADDING + PERCH_ROOM))];
    const expanded = expandTile([], tileNodeId('shell', 'loose'));
    const nodes = withTiles([zone('g', 400, 300)], [], shells, [], new Map(), expanded);
    const shown = displaced(nodes, expanded);
    expect(shift(nodes, shown, 'g')).not.toEqual({ dx: 0, dy: 0 });
    expect(shift(nodes, shown, tileNodeId('shell', 'in'))).toEqual({ dx: 0, dy: 0 });
  });
});
