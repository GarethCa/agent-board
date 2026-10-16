import { describe, expect, it } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import type { Agent, TilePosition, Zone } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE, CREW_GAP, footprint, PERCH_ROOM, TILE_GAP } from '@agent-board/daemon/board-layout';
import { CREW_PADDING, crewFrames, crewMoves, landingRects, withCrewFollowing } from './crews';
import { withTiles, type BoardNode } from './tiles';
import type { TileNodeType } from './tile';
import { zoneNode } from './ZoneNode';

const { width, height } = AGENT_TILE_SIZE;
const zone = (id: string) => zoneNode({ id, x: 0, y: 0, width: 1600, height: 900, repoRoot: '/code/app', folder: '', name: id, color: '#4c6ef5' } as Zone);
const agent = (sessionId: string, zoneId: string | null, position: TilePosition | null, spawnedBy: string | null = null) =>
  ({ sessionId, zoneId, position, spawnedBy, orchestrate: null, repoRoot: '/code/app', name: sessionId, harness: 'claude', endedAt: null }) as Agent;
const tiles = (nodes: BoardNode[]) => nodes.filter((node): node is TileNodeType => node.type === 'tile');
const byId = (nodes: BoardNode[], id: string) => tiles(nodes).find((node) => node.id === id)!;

const at = { x: 20, y: 44 };
const beside = { x: at.x + width + CREW_GAP, y: at.y };

describe('a crew on the board', () => {
  const laidOut = () =>
    withTiles(
      [zone('z'), zone('other')],
      [agent('boss', 'z', { ...at, z: 1 }), agent('w1', 'z', null, 'boss'), agent('w2', 'z', null, 'boss'), agent('away', 'other', null, 'boss')],
      [],
      [],
    );

  it('slots an orchestrator’s new agents beside it, and says whose they are', () => {
    const nodes = laidOut();
    expect(byId(nodes, 'agent:w1').position).toEqual(beside);
    expect(byId(nodes, 'agent:w2').position).toEqual({ x: beside.x + width + TILE_GAP, y: at.y });
    expect(byId(nodes, 'agent:w1').data.from).toEqual({ sessionId: 'boss', name: 'boss' });
    expect(byId(nodes, 'agent:boss').data.crew).toBe(3);
  });

  it('frames the crew that sits with its orchestrator, and leaves out one moved elsewhere', () => {
    const frames = crewFrames(tiles(laidOut()));
    expect(frames).toEqual([
      {
        orchestratorId: 'boss',
        zoneId: 'z',
        name: 'boss',
        members: ['w1', 'w2'],
        x: beside.x - CREW_PADDING,
        y: at.y - CREW_PADDING,
        width: 2 * width + TILE_GAP + 2 * CREW_PADDING,
        height: height + 2 * CREW_PADDING,
      },
    ]);
  });

  it('moves the crew with its orchestrator as it is dragged, but not a member dragged with it', () => {
    const nodes = laidOut();
    const drag = (ids: string[]): NodeChange<BoardNode>[] =>
      ids.map((id) => ({ id, type: 'position', position: { x: byId(nodes, id).position.x + 30, y: byId(nodes, id).position.y - 10 }, dragging: true }));
    const changes = withCrewFollowing(drag(['agent:boss']), nodes);
    expect(changes).toEqual([
      ...drag(['agent:boss']),
      { id: 'agent:w1', type: 'position', position: { x: beside.x + 30, y: at.y - 10 }, dragging: true },
      { id: 'agent:w2', type: 'position', position: { x: beside.x + width + TILE_GAP + 30, y: at.y - 10 }, dragging: true },
    ]);
    expect(withCrewFollowing(drag(['agent:boss', 'agent:w1']), nodes)).toHaveLength(3);
    // Let go, it is the board's to save.
    const dropped: NodeChange<BoardNode>[] = [{ id: 'agent:boss', type: 'position', position: at, dragging: false }];
    expect(withCrewFollowing(dropped, nodes)).toBe(dropped);
  });

  it('takes the crew along where its orchestrator lands, each where it was beside it, or clear of what is there', () => {
    const nodes = laidOut();
    const boss = byId(nodes, 'agent:boss');
    const landing = { zoneId: 'other', x: 100, y: 200 };
    expect(crewMoves(nodes, boss, landing, []).map(({ node, move }) => [node.id, move])).toEqual([
      ['agent:w1', { zoneId: 'other', x: 100 + width + CREW_GAP, y: 200 }],
      ['agent:w2', { zoneId: 'other', x: 100 + 2 * width + CREW_GAP + TILE_GAP, y: 200 }],
    ]);
    // A tile already where w1 would land: w1 takes the crew's next free spot instead.
    const inTheWay = footprint({ x: 100 + width + CREW_GAP, y: 200 });
    expect(crewMoves(nodes, boss, landing, [inTheWay]).map(({ move }) => move)).toEqual([
      { zoneId: 'other', x: 100 + 2 * width + CREW_GAP + TILE_GAP, y: 200 },
      { zoneId: 'other', x: 100 + 3 * width + CREW_GAP + 2 * TILE_GAP, y: 200 },
    ]);
    // What is there: the agent already in that zone, not the crew landing.
    expect(landingRects(nodes, 'other', boss)).toEqual([{ ...byId(nodes, 'agent:away').position, y: byId(nodes, 'agent:away').position.y - PERCH_ROOM, width, height: height + PERCH_ROOM }]);
  });

  it('frames no crew loose on the board, nor a member moved off from its crew, so each carries its chip', () => {
    const loose = withTiles(
      [zone('z')],
      [agent('boss', null, { x: 2000, y: 0, z: 1 }), agent('w1', null, null, 'boss')],
      [],
      [],
    );
    expect(byId(loose, 'agent:w1').position).toEqual({ x: 2000 + width + CREW_GAP, y: 0 });
    expect(crewFrames(tiles(loose))).toEqual([]);

    const far = withTiles([zone('z')], [agent('boss', 'z', { ...at, z: 1 }), agent('w1', 'z', { x: 1300, y: 700, z: 2 }, 'boss')], [], []);
    expect(crewFrames(tiles(far))).toEqual([]);
  });

  it('slots a loose orchestrator’s new agent clear of the zones', () => {
    const nodes = withTiles([zone('z')], [agent('boss', null, { x: 1600 - width - CREW_GAP - 10, y: 44, z: 1 }), agent('w1', null, null, 'boss')], [], []);
    const spot = byId(nodes, 'agent:w1').position;
    expect(spot.x).toBeGreaterThanOrEqual(1600);
  });
});

describe('a crew frame round tiles an expanded tile pushed aside', () => {
  const laidOut = () =>
    withTiles([zone('z')], [agent('boss', 'z', { ...at, z: 1 }), agent('w1', 'z', null, 'boss'), agent('w2', 'z', null, 'boss')], [], []);
  /** `nodes` as drawn with each tile `pushed` moved by as much. */
  const drawn = (nodes: BoardNode[], pushed: Record<string, { dx: number; dy: number }>) =>
    tiles(nodes).map((node) => {
      const by = pushed[node.id];
      return by === undefined ? node : { ...node, position: { x: node.position.x + by.dx, y: node.position.y + by.dy } };
    });

  it('keeps its members, decided where they are saved, and wraps them where they are drawn', () => {
    const nodes = laidOut();
    // Pushed far past the crew's columns and rows: still in the crew.
    const [frame] = crewFrames(tiles(nodes), drawn(nodes, { 'agent:w1': { dx: 0, dy: 3000 }, 'agent:w2': { dx: 2000, dy: 0 } }));
    expect(frame).toEqual({
      orchestratorId: 'boss',
      zoneId: 'z',
      name: 'boss',
      members: ['w1', 'w2'],
      x: beside.x - CREW_PADDING,
      y: at.y - CREW_PADDING,
      width: 2000 + 2 * width + TILE_GAP + 2 * CREW_PADDING,
      height: 3000 + height + 2 * CREW_PADDING,
    });
  });

  it('wraps a member expanded at the size it is drawn', () => {
    const nodes = laidOut();
    const shown = tiles(nodes).map((node) => (node.id === 'agent:w2' ? { ...node, width: 900, height: 600 } : node));
    const [frame] = crewFrames(tiles(nodes), shown);
    expect(frame!.width).toBe(width + TILE_GAP + 900 + 2 * CREW_PADDING);
    expect(frame!.height).toBe(600 + 2 * CREW_PADDING);
  });
});
