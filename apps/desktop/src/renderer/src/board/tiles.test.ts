import { describe, expect, it } from 'vitest';
import type { Agent, ExternalSession, Shell, TilePosition, Zone } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE, freeTileSlot, tileSlot, ZONE_PADDING } from './layout';
import { DRAGGED_TILE_Z_INDEX, EXPANDED_DRAG_HANDLE, holdsTiles, tileNodeId, tileSubject, withTiles, type BoardNode } from './tiles';
import { EXPANDED_SIZE, expandTile } from './expanded';
import type { TileNodeType } from './tile';
import { itemNode } from './items/items';
import { zoneNode, type ZoneNodeType } from './ZoneNode';

const zone = (id: string, x = 0, repoRoot: string | null = '/code/app'): ZoneNodeType =>
  zoneNode({ id, x, y: 0, width: 800, height: 300, repoRoot, folder: '', name: id, color: '#4c6ef5' } as Zone);

const agent = (sessionId: string, zoneId: string | null, position: TilePosition | null = null, repoRoot = '/code/app') =>
  ({ sessionId, zoneId, position, repoRoot, name: sessionId, harness: 'claude' }) as Agent;
const shell = (id: string, zoneId: string | null, position: TilePosition | null = null) =>
  ({ id, zoneId, position, name: id, cwd: '/', layout: { type: 'pane', sessionId: `${id}-pane` }, endedPanes: [] }) as unknown as Shell;
const external = (id: string, zoneId: string | null, position: TilePosition | null = null) =>
  ({ id, zoneId, position, name: id, harness: 'claude' }) as ExternalSession;

const tiles = (nodes: BoardNode[]) => nodes.filter((node): node is TileNodeType => node.type === 'tile');
const tile = (nodes: BoardNode[], id: string) => tiles(nodes).find((node) => node.id === id)!;

describe('withTiles', () => {
  it('puts tiles with no place in free slots, in the order tileSlot always laid them out', () => {
    const nodes = withTiles([zone('z')], [agent('a', 'z'), agent('b', 'z')], [shell('s', 'z')], [external('e', 'z')]);

    expect(tiles(nodes).map((node) => [node.id, node.parentId, node.position])).toEqual([
      ['agent:a', 'z', tileSlot(0, 800)],
      ['agent:b', 'z', tileSlot(1, 800)],
      ['shell:s', 'z', tileSlot(2, 800)],
      ['external:e', 'z', tileSlot(3, 800)],
    ]);
    expect(tiles(nodes).every((node) => node.draggable !== false)).toBe(true);
  });

  it('puts a tile where it was placed, and slots the rest round it', () => {
    const placed = { ...tileSlot(0, 800), z: 1 };
    const nodes = withTiles([zone('z')], [agent('a', 'z'), agent('b', 'z', placed)], [], []);

    expect(tile(nodes, 'agent:b').position).toEqual({ x: placed.x, y: placed.y });
    expect(tile(nodes, 'agent:a').position).toEqual(tileSlot(1, 800));
  });

  it('puts a loose shell on the board at its place, with no parent', () => {
    const nodes = withTiles([zone('z')], [], [shell('s', null, { x: -400, y: 900, z: 2 })], []);
    expect(tile(nodes, 'shell:s')).toMatchObject({ position: { x: -400, y: 900 } });
    expect(tile(nodes, 'shell:s').parentId).toBeUndefined();
  });

  it('puts a loose shell with no place clear of the zones', () => {
    const nodes = withTiles([zone('z')], [], [shell('s', null)], []);
    const { position } = tile(nodes, 'shell:s');
    expect(position.x).toBeGreaterThanOrEqual(800);
  });

  it('draws tiles in their stacking order, the never-raised ones first', () => {
    const nodes = withTiles(
      [zone('z')],
      [agent('a', 'z', { x: 0, y: 0, z: 5 }), agent('b', 'z', { x: 300, y: 0, z: null }), agent('c', 'z', { x: 600, y: 0, z: 2 })],
      [],
      [],
    );
    expect(tiles(nodes).map((node) => node.id)).toEqual(['agent:b', 'agent:c', 'agent:a']);
  });

  it('leaves a tile being dragged where the pointer has it, keeping what React Flow knows of it', () => {
    const first = withTiles([zone('z')], [agent('a', 'z')], [], []);
    const dragging = first.map((node) =>
      node.id === 'agent:a' ? { ...node, dragging: true, selected: true, position: { x: 999, y: 7 } } : node,
    );

    const next = withTiles(dragging, [{ ...agent('a', 'z'), name: 'renamed' }], [], []);

    expect(tile(next, 'agent:a')).toMatchObject({ position: { x: 999, y: 7 }, selected: true, data: { label: 'renamed' } });
  });

  it('slots an external session with no place in its zone, which is the Unsorted group when no other holds it', () => {
    const nodes = withTiles([zone('unsorted')], [], [], [external('e', 'unsorted')]);
    expect(tile(nodes, 'external:e')).toMatchObject({ parentId: 'unsorted', position: freeTileSlot(800, []), draggable: true });
  });

  it('leaves an external tile being dragged where the pointer has it, when the sessions change meanwhile', () => {
    const before = withTiles([zone('z')], [], [], [external('e', 'z')]);
    const dragging = before.map((node) => (node.id === 'external:e' ? { ...node, position: { x: 30, y: 900 }, dragging: true } : node));
    const next = withTiles(dragging, [], [], [{ ...external('e', 'z'), name: 'renamed' }]);
    expect(tile(next, 'external:e')).toMatchObject({ parentId: 'z', position: { x: 30, y: 900 }, data: { label: 'renamed' } });
  });

  it('puts agents and external sessions placed loose on the board there, with no parent', () => {
    const nodes = withTiles([zone('z')], [agent('a', null, { x: -500, y: 10, z: 1 })], [], [external('e', null, { x: -900, y: 5, z: 2 })]);
    expect(tile(nodes, 'agent:a')).toMatchObject({ position: { x: -500, y: 10 } });
    expect(tile(nodes, 'external:e')).toMatchObject({ position: { x: -900, y: 5 } });
    expect(tile(nodes, 'agent:a').parentId).toBeUndefined();
    expect(tile(nodes, 'external:e').parentId).toBeUndefined();
  });

  it("shows an agent's repo on its tile when it sits outside every zone of its repo", () => {
    const nodes = withTiles(
      [zone('z'), zone('other', 1000, '/code/other'), zone('ideas', 2000, null)],
      [agent('home', 'z'), agent('away', 'other'), agent('idea', 'ideas'), agent('loose', null, { x: -500, y: 0, z: 1 })],
      [],
      [],
    );
    expect(tile(nodes, 'agent:home').data.repo).toBeUndefined();
    expect(['away', 'idea', 'loose'].map((id) => tile(nodes, `agent:${id}`).data.repo)).toEqual(['app', 'app', 'app']);
    const windows = withTiles([zone('z')], [agent('w', null, { x: -500, y: 0, z: 1 }, 'C:\\code\\web')], [], []);
    expect(tile(windows, 'agent:w').data.repo).toBe('web');
  });

  it('grows a zone to hold its tiles, wherever they were put', () => {
    const far = { x: 900, y: 500, z: 1 };
    const [grown] = withTiles([zone('z')], [agent('a', 'z', far)], [], []) as ZoneNodeType[];
    expect(grown!.width).toBe(far.x + AGENT_TILE_SIZE.width + ZONE_PADDING);
    expect(grown!.height).toBeGreaterThan(far.y + AGENT_TILE_SIZE.height);
    expect(grown!.data.covers).toMatchObject({ right: grown!.width, bottom: grown!.height, left: far.x - ZONE_PADDING });
  });

  it('leaves out tiles of zones the board does not have', () => {
    expect(tiles(withTiles([], [agent('a', 'gone')], [shell('s', 'gone')], []))).toEqual([]);
  });

  it('draws an expanded tile at its own size, over everything, dragged by its header', () => {
    const expanded = expandTile(expandTile([], 'shell:s'), 'agent:a');
    const nodes = withTiles([zone('z')], [agent('a', 'z'), agent('b', 'z')], [shell('s', 'z')], [], new Map(), expanded);

    expect(tile(nodes, 'agent:a')).toMatchObject({ ...EXPANDED_SIZE, dragHandle: EXPANDED_DRAG_HANDLE, data: { expanded: true } });
    expect(tile(nodes, 'agent:b')).toMatchObject(AGENT_TILE_SIZE);
    expect(tile(nodes, 'agent:b').data.expanded).toBeUndefined();
    expect(tile(nodes, 'agent:b').dragHandle).toBeUndefined();
    // Over compact tiles, notes and a dragged tile; the one expanded last in front.
    expect(tile(nodes, 'shell:s').zIndex).toBeGreaterThan(DRAGGED_TILE_Z_INDEX);
    expect(tile(nodes, 'agent:a').zIndex).toBeGreaterThan(tile(nodes, 'shell:s').zIndex!);
  });

  it('keeps an expanded tile in front while it is dragged, and at the size and place React Flow has while it is resized', () => {
    const expanded = expandTile([], 'agent:a');
    const first = withTiles([zone('z')], [agent('a', 'z')], [], [], new Map(), expanded);
    const front = tile(first, 'agent:a').zIndex;
    const moving = first.map((node) => (node.id === 'agent:a' ? { ...node, dragging: true } : node));
    expect(tile(withTiles(moving, [agent('a', 'z')], [], [], new Map(), expanded), 'agent:a').zIndex).toBe(front);

    // Resized from its top-left, where React Flow has moved it too.
    const resizing = first.map((node) =>
      node.id === 'agent:a' ? { ...node, resizing: true, width: 1200, height: 800, position: { x: 7, y: 9 } } : node,
    );
    expect(tile(withTiles(resizing, [agent('a', 'z')], [], [], new Map(), expanded), 'agent:a')).toMatchObject({
      width: 1200,
      height: 800,
      position: { x: 7, y: 9 },
    });
  });

  it('keeps a zone to the compact size of an expanded tile, so the expanded tile floats over it', () => {
    const [kept] = withTiles([zone('z')], [agent('a', 'z', { x: 500, y: 20, z: 1 })], [], [], new Map(), expandTile([], 'agent:a')) as ZoneNodeType[];
    expect(kept!.width).toBe(800);
    expect(kept!.height).toBe(300);
  });

  it('slots a tile with no place clear of the zone\'s board items', () => {
    const item = itemNode({
      id: 'i', kind: 'issue', zoneId: 'z', x: 30, y: 40, width: 240, height: 112, z: 1, data: {}, createdAt: '', updatedAt: '',
    });
    const nodes = withTiles([zone('z'), item], [agent('a', 'z')], [], []);

    expect(tile(nodes, 'agent:a').position).not.toEqual(tileSlot(0, 800));
    expect(tile(nodes, 'agent:a').position).toEqual(tileSlot(1, 800));
  });
});

describe('tile node ids', () => {
  it('names the tile of an agent, a shell tile or an external session, and reads the session back', () => {
    expect([tileNodeId('agent', 's1'), tileNodeId('shell', 'sh'), tileNodeId('external', 'claude:x')]).toEqual(['agent:s1', 'shell:sh', 'external:claude:x']);
    expect(tileSubject('external:claude:x')).toEqual({ kind: 'external', id: 'claude:x' });
    expect(tileSubject('agent:s1')).toEqual({ kind: 'agent', id: 's1' });
    expect(tileSubject('item:n1')).toBeUndefined();
    expect(tileSubject('zone-1')).toBeUndefined();
  });
});

describe('holdsTiles', () => {
  const covers = { left: 20, top: 20, right: 500, bottom: 300 };
  const now = { x: 0, y: 0, width: 600, height: 400 };

  it('lets a zone be resized down to what it must cover, and no further', () => {
    expect(holdsTiles(covers, now, { x: 20, y: 20, width: 480, height: 280 })).toBe(true);
    expect(holdsTiles(covers, now, { x: 21, y: 0, width: 579, height: 400 })).toBe(false);
    expect(holdsTiles(covers, now, { x: 0, y: 0, width: 499, height: 400 })).toBe(false);
    expect(holdsTiles(covers, now, { x: 0, y: 0, width: 600, height: 299 })).toBe(false);
  });

  it('lets a zone a tile hangs out of grow, but not shrink further', () => {
    const hanging = { ...covers, left: -50 };
    expect(holdsTiles(hanging, now, { x: -10, y: 0, width: 610, height: 400 })).toBe(true);
    expect(holdsTiles(hanging, now, { x: 0, y: 0, width: 550, height: 400 })).toBe(true);
    expect(holdsTiles(hanging, now, { x: 10, y: 0, width: 590, height: 400 })).toBe(false);
  });

  it('lets a zone with no tiles be resized freely', () => {
    expect(holdsTiles(undefined, now, { x: 300, y: 300, width: 10, height: 10 })).toBe(true);
  });
});

// The slot logic itself is layout.ts's; this only pins that withTiles uses it.
it('uses freeTileSlot for new tiles', () => {
  expect(tile(withTiles([zone('z')], [agent('a', 'z')], [], []), 'agent:a').position).toEqual(freeTileSlot(800, []));
});
