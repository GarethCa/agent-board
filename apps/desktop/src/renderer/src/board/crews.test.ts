import { describe, expect, it } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import type { Agent, Shell, TilePosition, Zone } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';
import { AGENT_TILE_SIZE, CREW_GAP, footprint, PERCH_ROOM, TILE_GAP } from '@agent-board/daemon/board-layout';
import { CREW_PADDING, crewFrames, crewMoves, frameableTiles, landingRects, withCrewFollowing } from './crews';
import { withTiles, type BoardNode } from './tiles';
import type { TileNodeType } from './tile';
import { zoneNode } from './ZoneNode';

const { width, height } = AGENT_TILE_SIZE;
const zone = (id: string) => zoneNode({ id, x: 0, y: 0, width: 1600, height: 900, repoRoot: '/code/app', folder: '', name: id, color: '#4c6ef5', spacing: 'normal' } as Zone);
const agent = (sessionId: string, zoneId: string | null, position: TilePosition | null, spawnedBy: string | null = null) =>
  ({ sessionId, zoneId, position, spawnedBy, repoRoot: '/code/app', name: sessionId, harness: 'claude', endedAt: null }) as Agent;
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

  it('frames the crew in its orchestrator’s zone, and leaves out one in another zone', () => {
    const frames = crewFrames(tiles(laidOut()));
    expect(frames).toEqual([
      {
        orchestratorId: 'boss',
        zoneId: 'z',
        members: ['w1', 'w2'],
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

  it('takes the crew of an expanded orchestrator along right of it as drawn, never under it', () => {
    const nodes = laidOut();
    const open = { ...byId(nodes, 'agent:boss'), width: 960, height: 600 };
    const landing = { zoneId: 'other', x: 100, y: 200 };
    expect(crewMoves(nodes, open, landing, []).map(({ move }) => move)).toEqual([
      { zoneId: 'other', x: 100 + 960 + CREW_GAP, y: 200 },
      { zoneId: 'other', x: 100 + 960 + CREW_GAP + width + TILE_GAP, y: 200 },
    ]);
  });

  it('frames no crew loose on the board, nor a member in another zone, so each carries its chip', () => {
    const loose = withTiles(
      [zone('z')],
      [agent('boss', null, { x: 2000, y: 0, z: 1 }), agent('w1', null, null, 'boss')],
      [],
      [],
    );
    expect(byId(loose, 'agent:w1').position).toEqual({ x: 2000 + width + CREW_GAP, y: 0 });
    expect(crewFrames(tiles(loose))).toEqual([]);

    const elsewhere = withTiles([zone('z'), zone('other')], [agent('boss', 'z', { ...at, z: 1 }), agent('w1', 'other', { x: 40, y: 44, z: 2 }, 'boss')], [], []);
    expect(crewFrames(tiles(elsewhere))).toEqual([]);
  });

  it('frames its whole crew in its zone, wherever an arrange laid it out: many lanes down, far right, or under it', () => {
    // An expanded orchestrator top-left with its crew in lanes below it, as an arrange by issue lays them out.
    const lanes = [
      agent('boss', 'z', { x: 20, y: 44, z: 1 }),
      agent('first', 'z', { x: 300, y: 800, z: 2 }, 'boss'),
      agent('deep', 'z', { x: 300, y: 5200, z: 3 }, 'boss'),
      agent('wide', 'z', { x: 2400, y: 1200, z: 4 }, 'boss'),
      agent('under', 'z', { x: 20, y: 3000, z: 5 }, 'boss'),
      agent('stranger', 'other', { x: 300, y: 900, z: 6 }, 'boss'),
    ];
    const nodes = withTiles([zone('z'), zone('other')], lanes, [], []);
    const parts = crewFrames(tiles(nodes));
    expect(parts.flatMap((part) => part.members).toSorted()).toEqual(['deep', 'first', 'under', 'wide']);
    // Far apart, each is a part on its own, in reading order.
    expect(parts.map((part) => part.members)).toEqual([['first'], ['wide'], ['under'], ['deep']]);
  });

  it('frames a crew close together in one part, across a free grid column but not past it', () => {
    const row = (gap: number) =>
      crewFrames(
        tiles(withTiles([zone('z')], [agent('boss', 'z', { ...at, z: 1 }), agent('a', 'z', { x: 300, y: 800, z: 2 }, 'boss'), agent('b', 'z', { x: 300 + width + gap, y: 800, z: 3 }, 'boss')], [], [])),
      ).map((part) => part.members);
    expect(row(width + 2 * TILE_GAP)).toEqual([['a', 'b']]);
    expect(row(width + 2 * TILE_GAP + 1)).toEqual([['a'], ['b']]);
  });

  it('drags along only the crew beside it: a member in a lane far below stays where it is', () => {
    const nodes = withTiles(
      [zone('z')],
      [agent('boss', 'z', { ...at, z: 1 }), agent('w1', 'z', { ...beside, z: 2 }, 'boss'), agent('deep', 'z', { x: 300, y: 5200, z: 3 }, 'boss')],
      [],
      [],
    );
    const drag: NodeChange<BoardNode>[] = [{ id: 'agent:boss', type: 'position', position: { x: at.x + 100, y: at.y }, dragging: true }];
    expect(withCrewFollowing(drag, nodes)).toEqual([...drag, { id: 'agent:w1', type: 'position', position: { x: beside.x + 100, y: beside.y }, dragging: true }]);
    expect(crewMoves(nodes, byId(nodes, 'agent:boss'), { zoneId: 'z', x: at.x + 100, y: at.y }, []).map(({ node }) => node.id)).toEqual(['agent:w1']);
  });

  it('keeps a lane member in its row when its lead is nudged and something stands in its way, never up beside its lead', () => {
    const lane = { x: 300, y: 3000 };
    const nodes = withTiles(
      [zone('z')],
      [agent('boss', 'z', { ...at, z: 1 }), agent('deep', 'z', { ...lane, z: 2 }, 'boss'), agent('stranger', 'z', { x: lane.x + width + TILE_GAP, y: lane.y, z: 3 })],
      [],
      [],
    );
    const boss = byId(nodes, 'agent:boss');
    const [landed] = crewMoves(nodes, boss, { zoneId: 'z', x: at.x + 100, y: at.y }, landingRects(nodes, 'z', boss));
    expect(landed!.move.y).toBe(lane.y);
    expect(landed!.move.x).toBeGreaterThan(lane.x + 100);
  });

  it('frames no crew in a zone on status shelves, so its crew keep their chips there', () => {
    const shelved = zoneNode({ id: 's', x: 2000, y: 0, width: 1600, height: 900, repoRoot: '/code/app', folder: '', name: 's', color: '#4c6ef5', spacing: 'normal', layoutMode: 'shelves' } as Zone);
    const nodes = withTiles([zone('z'), shelved], [agent('boss', 's', { ...at, z: 1 }), agent('w1', 's', null, 'boss'), agent('lead', 'z', { ...at, z: 2 }), agent('w2', 'z', null, 'lead')], [], []);
    expect(crewFrames(frameableTiles(nodes)).map((frame) => frame.orchestratorId)).toEqual(['lead']);
  });

  it('slots a loose orchestrator’s new agent clear of the zones', () => {
    const nodes = withTiles([zone('z')], [agent('boss', null, { x: 1600 - width - CREW_GAP - 10, y: 44, z: 1 }), agent('w1', null, null, 'boss')], [], []);
    const spot = byId(nodes, 'agent:w1').position;
    expect(spot.x).toBeGreaterThanOrEqual(1600);
  });
});

describe('a crew frame on a board like the real one', () => {
  /** Whether two rects on the zone share any place. */
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  /** The rect round `rects`, `CREW_PADDING` out on every side. */
  const around = (rects: Rect[]): Rect => {
    const x = Math.min(...rects.map((rect) => rect.x)) - CREW_PADDING;
    const y = Math.min(...rects.map((rect) => rect.y)) - CREW_PADDING;
    return { x, y, width: Math.max(...rects.map((rect) => rect.x + rect.width)) + CREW_PADDING - x, height: Math.max(...rects.map((rect) => rect.y + rect.height)) + CREW_PADDING - y };
  };
  const rectOf = (node: TileNodeType): Rect => ({ ...node.position, width: node.width!, height: node.height! });
  const lanePitch = 300;
  /**
   * An orchestrator top-left, expanded, and below it lanes of its crew (an implementer and a reviewer each), with a
   * user's own agent in a lane between them, a second orchestrator's crew in a lane of its own, and a shell; 30 agents.
   */
  const board = () => {
    const agents: Agent[] = [agent('boss', 'z', { x: 20, y: 44, z: 1 }), agent('other-lead', 'z', { x: 2000, y: 44, z: 2 })];
    let z = 3;
    for (let lane = 0; lane < 14; lane++) {
      const y = 800 + lane * lanePitch;
      const lead = lane === 5 ? null : lane === 9 ? 'other-lead' : 'boss';
      agents.push(agent(`impl-${lane}`, 'z', { x: 300, y, z: z++ }, lead), agent(`review-${lane}`, 'z', { x: 300 + width + TILE_GAP, y, z: z++ }, lead));
    }
    const expanded = new Map([['agent:review-3', { width: 900, height: 560 }]]);
    const shells = [{ id: 'sh', zoneId: 'z', position: { x: 300, y: 800 + 14 * lanePitch, z: 99 }, name: 'sh', cwd: '/', layout: { type: 'pane', sessionId: 'sh-pane' }, endedPanes: [] } as unknown as Shell];
    const nodes = withTiles([zoneNode({ id: 'z', x: 0, y: 0, width: 3200, height: 6000, repoRoot: '/code/app', folder: '', name: 'z', color: '#4c6ef5', spacing: 'normal' } as Zone)], agents, shells, []);
    const shown = tiles(nodes).map((node) => {
      const size = expanded.get(node.id);
      return size === undefined ? { ...node, width: node.width ?? width, height: node.height ?? height } : { ...node, ...size };
    });
    return { nodes: shown, crew: agents.filter((one) => one.spawnedBy === 'boss').map((one) => one.sessionId) };
  };

  it('frames every member of the crew, and no other tile, not even its lead, in parts that each hold no stranger', () => {
    const { nodes, crew } = board();
    const parts = crewFrames(nodes).filter((frame) => frame.orchestratorId === 'boss');
    expect(parts.flatMap((part) => part.members).toSorted()).toEqual(crew.toSorted());
    for (const part of parts) {
      const box = around(nodes.filter((node) => part.members.includes(node.data.agent?.sessionId ?? '')).map(rectOf));
      for (const node of nodes) {
        const id = node.data.agent?.sessionId;
        if (id === undefined || crew.includes(id)) continue;
        expect(overlaps(rectOf(node), box), `${node.id}, no crew of boss, clear of every part`).toBe(false);
      }
    }
  });

  it('frames the other orchestrator’s crew apart, in a part of its own', () => {
    const { nodes } = board();
    expect(crewFrames(nodes).filter((frame) => frame.orchestratorId === 'other-lead').map((part) => part.members)).toEqual([['impl-9', 'review-9']]);
  });
});
