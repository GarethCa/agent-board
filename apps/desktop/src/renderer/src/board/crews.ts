// An orchestrator's crew (BA2): the agents it started, slotted beside it, framed together, and moved with it.
// Pure, so the layout is unit-tested.
import type { NodeChange } from '@xyflow/react';
import type { TileMove } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';
import { AGENT_TILE_SIZE, clearOf, footprint, PERCH_ROOM, ROW_STEP, TILE_GAP } from './layout';
import type { TileNodeType } from './tile';
import type { BoardNode } from './tiles';

/** Space between an orchestrator and its crew's first column: room for the frame between them. */
export const CREW_GAP = 40;
/** Space between a crew frame and the tiles in it. */
export const CREW_PADDING = 10;
/** How many of a crew go to a row beside their orchestrator before the next row. */
const CREW_PER_ROW = 3;
/** How many rows down a new crew member is looked for a spot before the zone slots it as any other. */
const CREW_ROWS = 20;
/** How far right of its orchestrator a crew member's corner may be and still sit with it: its crew's columns. */
const CREW_REACH = AGENT_TILE_SIZE.width + CREW_GAP + CREW_PER_ROW * (AGENT_TILE_SIZE.width + TILE_GAP);

/** The spot `col` along and `row` down of the crew of the orchestrator at `at`. */
const crewSlot = (at: { x: number; y: number }, col: number, row: number) => ({
  x: at.x + AGENT_TILE_SIZE.width + CREW_GAP + col * (AGENT_TILE_SIZE.width + TILE_GAP),
  y: at.y + row * ROW_STEP,
});

/** Where the next of a crew goes beside its orchestrator at `at`: the first spot in its rows clear of `taken`. */
export function crewSpot(at: { x: number; y: number }, taken: readonly Rect[]): { x: number; y: number } | undefined {
  for (let row = 0; row < CREW_ROWS; row++) {
    for (let col = 0; col < CREW_PER_ROW; col++) {
      const spot = crewSlot(at, col, row);
      if (clearOf(footprint(spot), taken)) return spot;
    }
  }
  return undefined;
}

/** The dashed frame round the crew that sits with its orchestrator, relative to their zone. */
export interface CrewFrame extends Rect {
  /** The orchestrator's session id. */
  orchestratorId: string;
  zoneId: string;
  /** The orchestrator's name, for the frame's label. */
  name: string;
  /** The session ids of the crew in the frame, in board order. */
  members: string[];
}

/** An agent's tile. */
const isAgentTile = (node: BoardNode): node is TileNodeType => node.type === 'tile' && node.data.agent !== undefined;

/** The part of the board a tile takes, as drawn: itself (expanded or not) and the room above it for its subagents. */
function tileFootprint(node: TileNodeType): Rect {
  const width = node.width ?? AGENT_TILE_SIZE.width;
  const height = node.height ?? AGENT_TILE_SIZE.height;
  return { x: node.position.x, y: node.position.y - PERCH_ROOM, width, height: height + PERCH_ROOM };
}

/**
 * The tiles of the agents `orchestrator` started that sit with it: in its zone, in its crew's columns. One moved
 * further off, or loose on the board, carries a "from" chip instead, and stays where it is when it moves.
 */
function crewTiles(nodes: readonly BoardNode[], orchestrator: TileNodeType): TileNodeType[] {
  const id = orchestrator.data.agent?.sessionId;
  if (id === undefined || orchestrator.parentId === undefined) return [];
  const { x, y } = orchestrator.position;
  return nodes.filter(
    (node) =>
      isAgentTile(node) &&
      node.data.agent!.spawnedBy === id &&
      node.parentId === orchestrator.parentId &&
      node.position.x > x &&
      node.position.x <= x + CREW_REACH &&
      node.position.y >= y - ROW_STEP &&
      node.position.y <= y + CREW_ROWS * ROW_STEP,
  ) as TileNodeType[];
}

/** A frame round each orchestrator's crew that sits with it, in its zone. */
export function crewFrames(tiles: readonly TileNodeType[]): CrewFrame[] {
  const frames: CrewFrame[] = [];
  for (const orchestrator of tiles) {
    const crew = crewTiles(tiles, orchestrator);
    if (crew.length === 0) continue;
    const size = (node: TileNodeType) => ({ width: node.width ?? AGENT_TILE_SIZE.width, height: node.height ?? AGENT_TILE_SIZE.height });
    const left = Math.min(...crew.map((node) => node.position.x));
    const top = Math.min(...crew.map((node) => node.position.y));
    const right = Math.max(...crew.map((node) => node.position.x + size(node).width));
    const bottom = Math.max(...crew.map((node) => node.position.y + size(node).height));
    frames.push({
      orchestratorId: orchestrator.data.agent!.sessionId,
      zoneId: orchestrator.parentId!,
      name: orchestrator.data.agent!.name,
      members: crew.map((node) => node.data.agent!.sessionId),
      x: left - CREW_PADDING,
      y: top - CREW_PADDING,
      width: right - left + 2 * CREW_PADDING,
      height: bottom - top + 2 * CREW_PADDING,
    });
  }
  return frames;
}

/**
 * `changes` with an orchestrator's crew dragged along with it: each that sits with it moved by as much as it moved,
 * unless it is dragged itself. Changes of a drag let go come back as they were: the board saves where each lands.
 */
export function withCrewFollowing(changes: NodeChange<BoardNode>[], nodes: readonly BoardNode[]): NodeChange<BoardNode>[] {
  const moving = new Set(changes.flatMap((change) => (change.type === 'position' ? [change.id] : [])));
  const following: NodeChange<BoardNode>[] = [];
  for (const change of changes) {
    if (change.type !== 'position' || change.position === undefined || change.dragging !== true) continue;
    const orchestrator = nodes.find((node) => node.id === change.id);
    if (orchestrator === undefined || !isAgentTile(orchestrator)) continue;
    const dx = change.position.x - orchestrator.position.x;
    const dy = change.position.y - orchestrator.position.y;
    if (dx === 0 && dy === 0) continue;
    for (const member of crewTiles(nodes, orchestrator)) {
      if (moving.has(member.id)) continue;
      following.push({ id: member.id, type: 'position', position: { x: member.position.x + dx, y: member.position.y + dy }, dragging: true });
    }
  }
  return following.length === 0 ? changes : [...changes, ...following];
}

/**
 * Where the crew that sits with `orchestrator` (as drawn) goes when it lands at `move`: each as far from it as it is
 * now, in the zone (or the part of the board) it landed in, or, where that is taken by `others` (relative to the same
 * zone: the tiles and items already there), the next free spot of its crew.
 */
export function crewMoves(
  nodes: readonly BoardNode[],
  orchestrator: TileNodeType,
  move: TileMove,
  others: readonly Rect[],
): { node: TileNodeType; move: TileMove }[] {
  const crew = crewTiles(nodes, orchestrator);
  const taken = [...others, footprint(move)];
  return crew.map((node) => {
    const kept = { x: move.x + node.position.x - orchestrator.position.x, y: move.y + node.position.y - orchestrator.position.y };
    const spot = clearOf(footprint(kept), taken) ? kept : (crewSpot(move, taken) ?? kept);
    taken.push(footprint(spot));
    return { node, move: { zoneId: move.zoneId, ...spot } };
  });
}

/**
 * What a crew landing with `orchestrator` in `zoneId` (null for loose on the board) must keep clear of, relative to
 * there: the tiles and items already there, and, loose, the zones.
 */
export function landingRects(nodes: readonly BoardNode[], zoneId: string | null, orchestrator: TileNodeType): Rect[] {
  const parentId = zoneId ?? undefined;
  const moving = new Set([orchestrator.id, ...crewTiles(nodes, orchestrator).map((node) => node.id)]);
  return nodes.flatMap((node): Rect[] => {
    if (node.type === 'zone') return parentId === undefined ? [{ ...node.position, width: node.width ?? 0, height: node.height ?? 0 }] : [];
    if (node.parentId !== parentId || moving.has(node.id)) return [];
    if (node.type === 'tile') return [tileFootprint(node)];
    return [{ ...node.position, width: node.width ?? 0, height: node.height ?? 0 }];
  });
}
