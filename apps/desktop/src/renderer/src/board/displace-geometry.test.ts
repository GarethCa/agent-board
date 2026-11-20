import { describe, expect, it } from 'vitest';
import type { Shell, TilePosition, Zone } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE, TILE_GAP, ZONE_PADDING, PERCH_ROOM } from '@agent-board/daemon/board-layout';
import { displaced, geometryKey, redisplaced } from './displace';
import { expandTile } from './expanded';
import { tileNodeId, withTiles, type BoardNode } from './tiles';
import { zoneNode } from './ZoneNode';

const zone = (id: string, x: number, y: number, width = 800, height = 300) =>
  zoneNode({ id, x, y, width, height, repoRoot: null, folder: '', name: id, color: '#4c6ef5', spacing: 'normal' } as Zone);
const shell = (id: string, zoneId: string | null, position: TilePosition) =>
  ({ id, zoneId, position, name: id, cwd: '/', layout: { type: 'pane', sessionId: `${id}-pane` }, endedPanes: [] }) as unknown as Shell;
const at = (x: number, y: number): TilePosition => ({ x, y, z: 0 });
const s = (id: string) => tileNodeId('shell', id);

/** A zone with three tiles in a row, and a zone beside it: expanding the first pushes the others and grows the zone. */
function board() {
  const first = { x: ZONE_PADDING, y: ZONE_PADDING + PERCH_ROOM };
  const shells = [
    shell('a', 'z', at(first.x, first.y)),
    shell('b', 'z', at(first.x + AGENT_TILE_SIZE.width + TILE_GAP, first.y)),
    shell('c', 'z', at(first.x + 2 * (AGENT_TILE_SIZE.width + TILE_GAP), first.y)),
  ];
  const expanded = expandTile([], s('a'));
  return { nodes: withTiles([zone('z', 0, 0, 1200, 400), zone('next', 1240, 0)], [], shells, [], new Map(), expanded), expanded };
}

/** `nodes` with the node `id` given new data: what a status line changing does. */
const withData = (nodes: BoardNode[], id: string, data: Record<string, unknown>): BoardNode[] =>
  nodes.map((node) => (node.id === id ? ({ ...node, data: { ...node.data, ...data } } as BoardNode) : node));

const moved = (nodes: BoardNode[], id: string, change: Partial<BoardNode>): BoardNode[] =>
  nodes.map((node) => (node.id === id ? ({ ...node, ...change } as BoardNode) : node));

describe('geometryKey', () => {
  it('is the same when only what a node shows changes', () => {
    const { nodes } = board();
    expect(geometryKey(withData(nodes, s('b'), { label: 'renamed', status: 'working' }))).toBe(geometryKey(nodes));
  });

  it('changes with a place, a size, a drag or resize under way, the nodes and their order', () => {
    const { nodes } = board();
    const key = geometryKey(nodes);
    const b = nodes.find((node) => node.id === s('b'))!;
    expect(geometryKey(moved(nodes, s('b'), { position: { x: b.position.x + 1, y: b.position.y } }))).not.toBe(key);
    expect(geometryKey(moved(nodes, s('b'), { width: (b.width ?? 0) + 1 }))).not.toBe(key);
    expect(geometryKey(moved(nodes, s('b'), { measured: { width: 1, height: 2 } }))).not.toBe(key);
    expect(geometryKey(moved(nodes, s('b'), { dragging: true }))).not.toBe(key);
    expect(geometryKey(moved(nodes, s('b'), { resizing: true }))).not.toBe(key);
    expect(geometryKey(moved(nodes, s('b'), { parentId: 'next' }))).not.toBe(key);
    expect(geometryKey(nodes.filter((node) => node.id !== s('c')))).not.toBe(key);
    expect(geometryKey(nodes.toReversed())).not.toBe(key);
  });

  it("changes with a zone's fold, size or spacing", () => {
    const { nodes } = board();
    const key = geometryKey(nodes);
    const z = nodes.find((node) => node.id === 'z')!;
    const zoneData = (change: Partial<Zone>) => withData(nodes, 'z', { zone: { ...(z.data as { zone: Zone }).zone, ...change } });
    expect(geometryKey(zoneData({ folded: true }))).not.toBe(key);
    expect(geometryKey(zoneData({ width: 1300 }))).not.toBe(key);
    expect(geometryKey(zoneData({ spacing: 'roomy' } as Partial<Zone>))).not.toBe(key);
    expect(geometryKey(zoneData({ name: 'renamed' }))).toBe(key);
  });
});

describe('displaced and geometryKey', () => {
  it('lays out alike two boards with the same key', () => {
    const { nodes, expanded } = board();
    const places = (laidOut: BoardNode[]) => laidOut.map((node) => [node.id, node.position, node.width, node.height]);
    for (const id of [s('a'), s('b'), s('c'), 'z', 'next']) {
      const next = withData(nodes, id, { label: 'new text', status: 'working' });
      expect(geometryKey(next)).toBe(geometryKey(nodes));
      expect(places(displaced(next, expanded)), id).toEqual(places(displaced(nodes, expanded)));
    }
  });
});

describe('redisplaced', () => {
  it('lays out a board whose nodes only show something new as displaced would, with their new data', () => {
    const { nodes, expanded } = board();
    const shown = displaced(nodes, expanded);
    // The layout moves b and c and grows z: there is something to carry over.
    expect(shown.find((node) => node.id === s('b'))).not.toBe(nodes.find((node) => node.id === s('b')));
    expect((shown.find((node) => node.id === 'z')!.data as { grown?: true }).grown).toBe(true);

    for (const id of [s('a'), s('b'), 'z', 'next']) {
      const next = withData(nodes, id, { label: 'new text' });
      expect(geometryKey(next)).toBe(geometryKey(nodes));
      expect(redisplaced(next, nodes, shown), id).toEqual(displaced(next, expanded));
    }
  });

  it("keeps the given nodes' own objects for what doesn't move", () => {
    const { nodes, expanded } = board();
    const shown = displaced(nodes, expanded);
    const next = withData(nodes, 'next', { label: 'new text' });
    const again = redisplaced(next, nodes, shown);
    next.forEach((node, index) => {
      if (shown[index] === nodes[index]) expect(again[index]).toBe(node);
    });
  });

  it('is the given nodes when nothing was moved', () => {
    const { nodes } = board();
    const next = withData(nodes, s('b'), { label: 'new text' });
    expect(redisplaced(next, nodes, nodes)).toBe(next);
  });
});
