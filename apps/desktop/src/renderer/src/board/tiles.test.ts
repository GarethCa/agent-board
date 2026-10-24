import { describe, expect, it } from 'vitest';
import type { Agent, AgentStart, ExternalSession, Shell, TilePosition, Zone } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE, CHIP_SIZE, freeTileSlot, tileSlot, ZONE_PADDING } from '@agent-board/daemon/board-layout';
import { DRAGGED_TILE_Z_INDEX, EXPANDED_DRAG_HANDLE, holdsTiles, savedMove, savedPlace, shellWithPane, tileNodeId, tileSubject, withTiles, type BoardNode } from './tiles';
import { EXPANDED_SIZE, expandTile } from './expanded';
import type { TileNodeType } from './tile';
import { itemNode } from './items/items';
import { zoneNode, type ZoneNodeType } from './ZoneNode';

const zone = (id: string, x = 0, repoRoot: string | null = '/code/app'): ZoneNodeType =>
  zoneNode({ id, x, y: 0, width: 800, height: 300, repoRoot, folder: '', name: id, color: '#4c6ef5', spacing: 'normal' } as Zone);

const agent = (sessionId: string, zoneId: string | null, position: TilePosition | null = null, repoRoot = '/code/app') =>
  ({ sessionId, zoneId, position, repoRoot, name: sessionId, harness: 'claude', endedAt: null }) as Agent;
const shell = (id: string, zoneId: string | null, position: TilePosition | null = null) =>
  ({ id, zoneId, position, name: id, cwd: '/', layout: { type: 'pane', sessionId: `${id}-pane` }, endedPanes: [], owner: null }) as unknown as Shell;
const external = (id: string, zoneId: string | null, position: TilePosition | null = null) =>
  ({ id, zoneId, position, name: id, harness: 'claude' }) as ExternalSession;

const start = (sessionId: string, zoneId: string | null, position: { x: number; y: number } | null = null): AgentStart => ({
  sessionId,
  zoneId,
  position,
  name: sessionId,
  harness: 'claude',
  model: null,
  spawnedBy: null,
  steps: [{ kind: 'worktree', state: 'now', detail: null }],
  error: null,
  confirm: false,
});

const tiles = (nodes: BoardNode[]) => nodes.filter((node): node is TileNodeType => node.type === 'tile');
const tile = (nodes: BoardNode[], id: string) => tiles(nodes).find((node) => node.id === id)!;

describe('withTiles', () => {
  it("gives an agent being started a tile in its zone's next slot, which its agent takes once it is listed", () => {
    const starting = withTiles([zone('z')], [agent('a', 'z')], [shell('s', 'z')], [], new Map(), [], {}, new Set(), [start('b', 'z')]);

    expect(tiles(starting).map((node) => [node.id, node.position])).toEqual([
      ['agent:a', tileSlot(0, 800)],
      ['start:b', tileSlot(1, 800)],
      ['shell:s', tileSlot(2, 800)],
    ]);
    // It can be moved and renamed while it starts.
    expect(tile(starting, 'start:b')).toMatchObject({ parentId: 'z', draggable: true, data: { label: 'b', start: start('b', 'z') } });

    const started = withTiles(starting, [agent('a', 'z'), agent('b', 'z')], [shell('s', 'z')], [], new Map(), [], {}, new Set(), [start('b', 'z')]);
    expect(tiles(started).map((node) => [node.id, node.position])).toEqual([
      ['agent:a', tileSlot(0, 800)],
      ['agent:b', tileSlot(1, 800)],
      ['shell:s', tileSlot(2, 800)],
    ]);
  });

  it('puts a loose start where it was asked for, and drops its tile once the start is over', () => {
    const starting = withTiles([], [], [], [], new Map(), [], {}, new Set(), [start('b', null, { x: 40, y: 60 })]);
    expect(tile(starting, 'start:b')).toMatchObject({ position: { x: 40, y: 60 } });
    expect(tiles(withTiles(starting, [], [], []))).toEqual([]);
  });

  it("gives an agent's tabs to its tile, never tiles of their own", () => {
    const tab = { ...shell('tab', null), owner: { kind: 'agent', id: 'a' } } as Shell;
    const nodes = withTiles([zone('z')], [agent('a', 'z'), agent('b', 'z')], [shell('s', 'z'), tab], []);

    expect(tiles(nodes).map((node) => node.id)).toEqual([tileNodeId('agent', 'a'), tileNodeId('agent', 'b'), tileNodeId('shell', 's')]);
    expect(tile(nodes, tileNodeId('agent', 'a')).data.tabs).toEqual([tab]);
    expect(tile(nodes, tileNodeId('agent', 'b')).data.tabs).toBeUndefined();
  });

  it("makes no tile of a shell tile's tabs, nor gives them to an agent that shares the id", () => {
    const tab = { ...shell('tab', null), owner: { kind: 'shell', id: 's' } } as Shell;
    const nodes = withTiles([zone('z')], [agent('s', 'z')], [shell('s', 'z'), tab], []);

    expect(tiles(nodes).map((node) => node.id)).toEqual([tileNodeId('agent', 's'), tileNodeId('shell', 's')]);
    expect(tile(nodes, tileNodeId('agent', 's')).data.tabs).toBeUndefined();
  });

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

  it('grows a zone only as far as its tiles need now: grown round where they were, it shrinks back to its own size once they move in', () => {
    const far = { x: 900, y: 500, z: 1 };
    const [grown] = withTiles([zone('z')], [agent('a', 'z', far)], [], []) as ZoneNodeType[];
    // Its tile moves back in, while the zone keeps the size it was saved at: the size it was grown to goes.
    const near = { x: 20, y: 44, z: 1 };
    const [after] = withTiles([grown!], [agent('a', 'z', near)], [], []) as ZoneNodeType[];
    expect(after!.width).toBe(grown!.data.zone.width);
    expect(after!.height).toBe(grown!.data.zone.height);
  });

  it('draws a resized tile at its own size, grows its zone to hold it and slots the others clear of it', () => {
    const sizes = { 'agent:a': { width: 480, height: 320 } };
    const nodes = withTiles([zone('z')], [agent('a', 'z', { x: 700, y: 500, z: 1 }), agent('b', 'z')], [], [], new Map(), [], sizes);
    expect(tile(nodes, 'agent:a')).toMatchObject({ width: 480, height: 320 });
    expect(tile(nodes, 'agent:b')).toMatchObject(AGENT_TILE_SIZE);
    const [grown] = nodes as ZoneNodeType[];
    expect(grown!.width).toBe(700 + 480 + ZONE_PADDING);
    expect(grown!.height).toBeGreaterThanOrEqual(500 + 320 + ZONE_PADDING);
  });

  it('keeps the size React Flow has for a compact tile while it is resized', () => {
    const [first] = tiles(withTiles([zone('z')], [agent('a', 'z', { x: 20, y: 44, z: 1 })], [], []));
    const resizing = { ...first!, width: 333, height: 222, resizing: true };
    const nodes = withTiles([zone('z'), resizing], [agent('a', 'z', { x: 20, y: 44, z: 1 })], [], [], new Map(), [], { 'agent:a': { width: 400, height: 304 } });
    expect(tile(nodes, 'agent:a')).toMatchObject({ width: 333, height: 222 });
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
      id: 'i', kind: 'issue', zoneId: 'z', x: 30, y: 40, width: 240, height: 112, z: 1, rotation: 0, data: {}, createdAt: '', updatedAt: '',
    });
    const nodes = withTiles([zone('z'), item], [agent('a', 'z')], [], []);

    expect(tile(nodes, 'agent:a').position).not.toEqual(tileSlot(0, 800));
    expect(tile(nodes, 'agent:a').position).toEqual(tileSlot(1, 800));
  });
});

describe('shellWithPane', () => {
  it("finds the shell tile a pane is in, through its tabs too, but never an agent's tab", () => {
    const tile = shell('s', null);
    const tileTab = { ...shell('t', null), owner: { kind: 'shell', id: 's' } } as Shell;
    const agentTab = { ...shell('a', null), owner: { kind: 'agent', id: 'agent' } } as Shell;
    const shells = [tile, tileTab, agentTab];

    expect([shellWithPane(shells, 's-pane'), shellWithPane(shells, 't-pane'), shellWithPane(shells, 'a-pane'), shellWithPane(shells, 'nope')]).toEqual([
      tile,
      tile,
      undefined,
      undefined,
    ]);
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

describe('withTiles: folded chips', () => {
  const ended = (sessionId: string, state: Agent['state'] = 'done') => ({ ...agent(sessionId, 'z', { x: 40, y: 80, z: null }), endedAt: '2026-01-01T00:00:00Z', state, shellSessionId: null, shellHarness: null }) as Agent;
  const live = (sessionId: string) => ({ ...agent(sessionId, 'z', { x: 340, y: 80, z: null }), endedAt: null, state: 'idle' }) as Agent;

  it('draws a closed agent as a chip where its tile was, and leaves live ones full size', () => {
    const nodes = withTiles([zone('z')], [ended('a'), live('b')], [], []);

    expect(tile(nodes, 'agent:a')).toMatchObject({ width: CHIP_SIZE.width, height: CHIP_SIZE.height, data: { folded: true } });
    expect(tile(nodes, 'agent:b')).toMatchObject({ width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height });
    expect(tile(nodes, 'agent:b').data.folded).toBeUndefined();
  });

  it("draws a chip centred in its tile's place, as the crew-layout mock has it, so an edge to a tile beside it is straight", () => {
    const nodes = withTiles([zone('z')], [ended('a'), live('b')], [], []);
    const [chip, full] = [tile(nodes, 'agent:a'), tile(nodes, 'agent:b')];

    expect(chip.position.y + CHIP_SIZE.height / 2).toBe(full.position.y + AGENT_TILE_SIZE.height / 2);
    expect(chip.position.x).toBe(40);
    expect(chip.data.lift).toBe(chip.position.y - 80);
  });

  it('saves a move of a chip from where its tile is, not where the chip is drawn', () => {
    const chip = tile(withTiles([zone('z')], [ended('a')], [], []), 'agent:a');
    expect(savedMove(chip.data, { zoneId: 'z', x: 100, y: 200 })).toEqual({ zoneId: 'z', x: 100, y: 200 - chip.data.lift! });
    const full = tile(withTiles([zone('z')], [live('b')], [], []), 'agent:b');
    expect(savedMove(full.data, { zoneId: 'z', x: 100, y: 200 })).toEqual({ zoneId: 'z', x: 100, y: 200 });
  });

  it('keeps a chip exactly where it was through a zone delete and its undo, however many times: what is recorded is the saved place', () => {
    const start = withTiles([zone('z')], [ended('a')], [], []);
    const drawn = tile(start, 'agent:a').position;
    let nodes = start;
    for (let round = 0; round < 2; round++) {
      // The delete records where the tile is saved; the undo saves that again, and the board draws it from there.
      const at = savedPlace(tile(nodes, 'agent:a'));
      expect(at).toEqual({ x: 40, y: 80 });
      const restored = new Map([['agent:a', { zoneId: 'z', ...at }]]);
      nodes = withTiles([zone('z')], [ended('a')], [], [], restored);
      expect(tile(nodes, 'agent:a').position).toEqual(drawn);
    }
  });

  it('keeps a closed agent the user unfolded, or one expanded in place, a full tile', () => {
    const unfolded = withTiles([zone('z')], [ended('a')], [], [], new Map(), [], {}, new Set(['agent:a']));
    expect(tile(unfolded, 'agent:a').data.folded).toBeUndefined();
    expect(tile(unfolded, 'agent:a').width).toBe(AGENT_TILE_SIZE.width);

    const expanded = withTiles([zone('z')], [ended('a')], [], [], new Map(), expandTile([], 'agent:a'));
    expect(tile(expanded, 'agent:a').data.folded).toBeUndefined();
  });

  it('does not fold an ended agent whose pane is a live shell: its tile keeps its Restart', () => {
    const inShell = { ...ended('a'), shellSessionId: 'shell-1' } as Agent;
    expect(tile(withTiles([zone('z')], [inShell], [], []), 'agent:a').data.folded).toBeUndefined();
  });

  it('does not fold an agent a restart stopped, which is resumed', () => {
    const nodes = withTiles([zone('z')], [ended('a', 'stopped-by-restart')], [], []);
    expect(tile(nodes, 'agent:a').data.folded).toBeUndefined();
  });

  it('draws a chip at the chip size whatever size the tile was resized to', () => {
    const nodes = withTiles([zone('z')], [ended('a')], [], [], new Map(), [], { 'agent:a': { width: 480, height: 320 } });
    expect(tile(nodes, 'agent:a')).toMatchObject({ width: CHIP_SIZE.width, height: CHIP_SIZE.height });
  });
});
