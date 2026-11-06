// An orchestrator's crew: the agents it started, slotted beside it, framed together, and moved with it.
// Pure, so the layout is unit-tested.
import type { NodeChange } from '@xyflow/react';
import type { TileMove } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';
import { AGENT_TILE_SIZE, clearOf, CREW_GAP, CREW_PER_ROW, CREW_ROWS, crewSpot, footprint, GRID_COLUMN, PERCH_ROOM, ROW_STEP, sizedFootprint, TILE_GAP } from '@agent-board/daemon/board-layout';
import type { TileNodeType } from './tile';
import { compactSizeOf, isSessionTile, isZone, type BoardNode } from './tiles';

/** Space between a crew frame and the tiles in it. */
export const CREW_PADDING = 10;
/** How far right of its orchestrator a crew member's corner may be and still sit with it: its crew's columns. */
const CREW_REACH = AGENT_TILE_SIZE.width + CREW_GAP + CREW_PER_ROW * (AGENT_TILE_SIZE.width + TILE_GAP);
/** The widest gap a crew frame part spans between its tiles: about one free grid column or row, never an empty stretch. */
const MAX_JOIN_GAP = GRID_COLUMN + TILE_GAP;
/** How many grid columns along its row a landing crew member looks for a free spot. */
const MAX_ROW_STEPS = 64;

/**
 * A dashed frame round an orchestrator's crew, relative to their zone: the whole crew, or one part of it, as a crew
 * spread round other tiles is framed in parts that hold none of them.
 */
export interface CrewFrame extends Rect {
  /** The orchestrator's session id. */
  orchestratorId: string;
  zoneId: string;
  /** The orchestrator's name, for the frame's label. */
  name: string;
  /** The session ids of the crew in the frame, in board order. */
  members: string[];
  /** Whether it carries the crew's label: its first part, in reading order, alone does. */
  labelled: boolean;
}

/** An agent's tile. */
const isAgentTile = (node: BoardNode): node is TileNodeType => node.type === 'tile' && node.data.agent !== undefined;

/** The part of the board a tile takes, as drawn: itself (expanded or not) and the room above it for its subagents. */
function tileFootprint(node: TileNodeType): Rect {
  const width = node.width ?? AGENT_TILE_SIZE.width;
  const height = node.height ?? AGENT_TILE_SIZE.height;
  return { x: node.position.x, y: node.position.y - PERCH_ROOM, width, height: height + PERCH_ROOM };
}

/** The tiles of the agents `orchestrator` started that are in its zone, wherever in it they are. */
function zoneCrew(nodes: readonly BoardNode[], orchestrator: TileNodeType): TileNodeType[] {
  const id = orchestrator.data.agent?.sessionId;
  if (id === undefined || orchestrator.parentId === undefined) return [];
  return nodes.filter((node) => isAgentTile(node) && node.data.agent!.spawnedBy === id && node.parentId === orchestrator.parentId) as TileNodeType[];
}

/**
 * The part of `orchestrator`'s crew that sits with it, in its crew's columns beside it: what is dragged and lands with
 * it. The rest of its crew in its zone (laid out in lanes by an arrange, or moved off) stays where it is when it moves.
 */
function crewBeside(nodes: readonly BoardNode[], orchestrator: TileNodeType): TileNodeType[] {
  const { x, y } = orchestrator.position;
  return zoneCrew(nodes, orchestrator).filter(
    (node) => node.position.x > x && node.position.x <= x + CREW_REACH && node.position.y >= y - ROW_STEP && node.position.y <= y + CREW_ROWS * ROW_STEP,
  );
}

/** Where a tile is saved, at its compact size: what decides who sits among whom, an expanded tile changing none of it. */
const savedRect = (node: TileNodeType): Rect => ({ ...node.position, ...compactSizeOf(node) });
/** Where a tile is drawn, expanded or not. */
const drawnRect = (node: TileNodeType): Rect => ({ ...node.position, width: node.width ?? AGENT_TILE_SIZE.width, height: node.height ?? AGENT_TILE_SIZE.height });

/** The rect round `rects`, `pad` out on every side. */
function bounds(rects: readonly Rect[], pad: number): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left - pad, y: top - pad, width: right - left + 2 * pad, height: bottom - top + 2 * pad };
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** How far apart two rects are, across and down: none when they touch or overlap. */
const gapBetween = (a: Rect, b: Rect) =>
  Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width)) + Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));

/**
 * `crew` in as few parts as hold none of `strangers` (every other tile in its zone, its orchestrator's too) and span no
 * gap wider than `MAX_JOIN_GAP`: the nearest two parts are joined first, while they are that near and the frame round
 * them both would cover no stranger. A crew close together with no stranger among it is one part. Each part is pushed
 * aside as one by an expanded tile, so a part never reaches across empty space.
 */
function crewParts(crew: readonly TileNodeType[], strangers: readonly Rect[]): TileNodeType[][] {
  const parts = crew.map((node) => ({ nodes: [node], rect: savedRect(node) }));
  const owner = parts.map((_, index) => index);
  const find = (index: number): number => (owner[index] === index ? index : (owner[index] = find(owner[index]!)));
  const pairs = parts.flatMap((a, i) => parts.slice(i + 1).map((b, k) => ({ i, j: i + 1 + k, gap: gapBetween(a.rect, b.rect) })));
  for (const { i, j } of pairs.toSorted((a, b) => a.gap - b.gap)) {
    const [a, b] = [find(i), find(j)];
    if (a === b || gapBetween(parts[a]!.rect, parts[b]!.rect) > MAX_JOIN_GAP) continue;
    const joined = bounds([parts[a]!.rect, parts[b]!.rect], 0);
    if (strangers.some((stranger) => overlap(bounds([joined], CREW_PADDING), stranger))) continue;
    owner[b] = a;
    parts[a] = { nodes: [...parts[a]!.nodes, ...parts[b]!.nodes], rect: joined };
  }
  return parts.filter((_, index) => find(index) === index).map((part) => part.nodes);
}

/** The tiles crew frames are drawn round: none in a zone on status shelves, whose crew is in its stacks and keeps its chips. */
export function frameableTiles(nodes: readonly BoardNode[]): TileNodeType[] {
  const shelved = new Set(nodes.flatMap((node) => (isZone(node) && node.data.zone.layoutMode === 'shelves' ? [node.id] : [])));
  return nodes.filter((node): node is TileNodeType => isSessionTile(node) && (node.parentId === undefined || !shelved.has(node.parentId)));
}

/**
 * The frames round each orchestrator's crew in its zone, wherever in it they are: who is in each part decided where they
 * are saved (`tiles`), and the frame round where they are drawn (`drawn`), so tiles an expanded tile pushed aside stay
 * in it. Where they are saved, a frame holds no other tile, its orchestrator's included: a crew spread round other
 * tiles, or far apart, is framed in parts, the first in reading order labelled. Drawn, a part round a member expanded
 * past where it is saved may reach over another tile.
 */
export function crewFrames(tiles: readonly TileNodeType[], drawn: readonly TileNodeType[] = tiles): CrewFrame[] {
  const shown = new Map(drawn.map((node) => [node.id, node]));
  const frames: CrewFrame[] = [];
  for (const orchestrator of tiles) {
    const crew = zoneCrew(tiles, orchestrator);
    if (crew.length === 0) continue;
    const strangers = tiles.filter((node) => node.parentId === orchestrator.parentId && !crew.includes(node)).map(savedRect);
    const parts = crewParts(crew, strangers)
      // Each part's members in board order, the parts in reading order.
      .map((part) => tiles.filter((node) => part.includes(node)))
      .map((part) => ({ part, at: bounds(part.map(savedRect), 0) }))
      .toSorted((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
    parts.forEach(({ part }, index) =>
      frames.push({
        orchestratorId: orchestrator.data.agent!.sessionId,
        zoneId: orchestrator.parentId!,
        name: orchestrator.data.agent!.name,
        members: part.map((node) => node.data.agent!.sessionId),
        labelled: index === 0,
        ...bounds(
          part.map((node) => drawnRect(shown.get(node.id) ?? node)),
          CREW_PADDING,
        ),
      }),
    );
  }
  return frames;
}

/**
 * `changes` with an orchestrator's crew dragged along with it: each beside it moved by as much as it moved,
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
    for (const member of crewBeside(nodes, orchestrator)) {
      if (moving.has(member.id)) continue;
      following.push({ id: member.id, type: 'position', position: { x: member.position.x + dx, y: member.position.y + dy }, dragging: true });
    }
  }
  return following.length === 0 ? changes : [...changes, ...following];
}

/** The first spot right of `spot`, a grid column at a time, clear of `taken`: in its row, as a lane is. */
function alongRow(spot: { x: number; y: number }, taken: readonly Rect[]): { x: number; y: number } | undefined {
  for (let step = 1; step <= MAX_ROW_STEPS; step++) {
    const next = { x: spot.x + step * GRID_COLUMN, y: spot.y };
    if (clearOf(footprint(next), taken)) return next;
  }
  return undefined;
}

/**
 * Where the crew beside `orchestrator` (as drawn) goes when it lands at `move`: each as far from it as it is
 * now, in the zone (or the part of the board) it landed in. Where that is taken by `others` (relative to the same
 * zone: the tiles and items already there), one that would land under its lead takes the next free spot of its crew
 * beside it, and any other the next free spot along its own row, so a crew laid out in lanes keeps its lanes.
 */
export function crewMoves(
  nodes: readonly BoardNode[],
  orchestrator: TileNodeType,
  move: TileMove,
  others: readonly Rect[],
): { node: TileNodeType; move: TileMove }[] {
  const crew = crewBeside(nodes, orchestrator);
  // At its size as drawn, expanded too: its crew lands clear of it, the next free spot right of its edge.
  const drawn = { width: orchestrator.width ?? AGENT_TILE_SIZE.width, height: orchestrator.height ?? AGENT_TILE_SIZE.height };
  const lead = sizedFootprint(move, drawn);
  const taken = [...others, lead];
  return crew.map((node) => {
    const kept = { x: move.x + node.position.x - orchestrator.position.x, y: move.y + node.position.y - orchestrator.position.y };
    // Under its lead (grown, or landed by it): beside it. In the way of anything else: along its own row, never out of it.
    const underLead = !clearOf(footprint(kept), [lead]);
    const spot = clearOf(footprint(kept), taken) ? kept : ((underLead ? crewSpot(move, taken, drawn.width) : alongRow(kept, taken)) ?? kept);
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
  const moving = new Set([orchestrator.id, ...crewBeside(nodes, orchestrator).map((node) => node.id)]);
  return nodes.flatMap((node): Rect[] => {
    if (node.type === 'zone') return parentId === undefined ? [{ ...node.position, width: node.width ?? 0, height: node.height ?? 0 }] : [];
    if (node.parentId !== parentId || moving.has(node.id)) return [];
    if (node.type === 'tile') return [tileFootprint(node)];
    return [{ ...node.position, width: node.width ?? 0, height: node.height ?? 0 }];
  });
}
