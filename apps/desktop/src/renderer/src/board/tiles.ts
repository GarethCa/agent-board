import type { Node } from '@xyflow/react';
import {
  DEFAULT_ZONE_SIZE,
  MIN_ZONE_SIZE,
  type Agent,
  type ExternalSession,
  type Shell,
  type TileMove,
  type TilePosition,
  type ZoneLayout,
} from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { isItemNode, type ItemNodeType } from './items/items';
import { expandedRank, type ExpandedTiles } from './expanded';
import { tileSizeOf, type TileSizes } from './tile-size';
import { AGENT_TILE_SIZE, CHIP_SIZE, isFolded, PERCH_ROOM, slotUnplaced, tileSizeKey, ZONE_PADDING, zoneMinSize } from '@agent-board/daemon/board-layout';
import type { TileData, TileNodeType } from './tile';
import type { ZoneCovers, ZoneNodeType } from './ZoneNode';

export type BoardNode = ZoneNodeType | TileNodeType | ItemNodeType;

export const AGENT_NODE_PREFIX = 'agent:';
export const SHELL_NODE_PREFIX = 'shell:';
export const EXTERNAL_NODE_PREFIX = 'external:';

/** What a session tile stands for: an agent (by its session id), a shell tile or an external session. */
export type TileKind = 'agent' | 'shell' | 'external';

const TILE_PREFIXES: Record<TileKind, string> = { agent: AGENT_NODE_PREFIX, shell: SHELL_NODE_PREFIX, external: EXTERNAL_NODE_PREFIX };

/**
 * The node id of the tile for an agent (by its session id), a shell tile or an external session: the daemon's
 * `tileSizeKey`, as its resized size is kept by it.
 */
export const tileNodeId = (kind: TileKind, id: string): string => tileSizeKey(kind, id);

/** Which session a tile's node stands for, read from its id; undefined for any other node. */
export function tileSubject(nodeId: string): { kind: TileKind; id: string } | undefined {
  for (const kind of ['agent', 'shell', 'external'] as const) {
    if (nodeId.startsWith(TILE_PREFIXES[kind])) return { kind, id: nodeId.slice(TILE_PREFIXES[kind].length) };
  }
  return undefined;
}

/** Tiles draw over zones (0) and under items (2), except the one being dragged, which comes to the front. */
const TILE_Z_INDEX = 1;
export const DRAGGED_TILE_Z_INDEX = 3;
/** Expanded tiles draw over everything else on the board, the one in front highest (this plus its rank). */
const EXPANDED_Z_INDEX = 4;
/** What drags an expanded tile: its header. The terminal and buttons under it take input instead. */
export const EXPANDED_DRAG_HANDLE = '.expanded-tile-head';

export const isZone = (node: Node): node is ZoneNodeType => node.type === 'zone';

/** A tile the board makes for an agent, shell or external session (not a benchmark's placeholder). */
export const isSessionTile = (node: Node): node is TileNodeType =>
  node.id.startsWith(AGENT_NODE_PREFIX) || node.id.startsWith(SHELL_NODE_PREFIX) || node.id.startsWith(EXTERNAL_NODE_PREFIX);

export function layoutOf(node: ZoneNodeType): ZoneLayout {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? node.measured?.width ?? DEFAULT_ZONE_SIZE.width,
    height: node.height ?? node.measured?.height ?? DEFAULT_ZONE_SIZE.height,
  };
}

/** The agent, shell or external session a tile stands for: what is placed, with its zone and place. */
export function subjectOf(data: TileData): { zoneId: string | null; position: TilePosition | null } {
  return data.agent ?? data.shell ?? data.external ?? { zoneId: null, position: null };
}

/** A tile's size as the board has it: what it was resized to, or the default. */
export const sizeOfNode = (node: Node): { width: number; height: number } => ({
  width: node.width ?? AGENT_TILE_SIZE.width,
  height: node.height ?? AGENT_TILE_SIZE.height,
});

/** A tile's compact size: what it was resized to; an expanded tile counts as the default, as its zone does. */
export const compactSizeOf = (node: TileNodeType): { width: number; height: number } =>
  node.data.expanded === true ? AGENT_TILE_SIZE : sizeOfNode(node);

/** A tile's stacking order: never-raised tiles under the rest. */
const zOf = (node: TileNodeType) => subjectOf(node.data).position?.z ?? -Infinity;

/**
 * The shell tile the session is a pane of, if any, in its own panes or one of its tabs: not an agent's tab, whose own
 * tab holds the agent's session too.
 */
export function shellWithPane(shells: readonly Shell[] | undefined, sessionId: string): Shell | undefined {
  const holder = shells?.find((shell) => shell.owner?.kind !== 'agent' && paneIds(shell.layout).includes(sessionId));
  const tileId = holder?.owner?.id;
  return tileId === undefined ? holder : shells?.find((shell) => shell.id === tileId && !shell.owner);
}

/** `subject` (an agent, shell or external session) as it is while `move` is being saved. */
function placedAt<T extends { zoneId: string | null; position: TilePosition | null }>(subject: T, move: TileMove | undefined): T {
  if (move === undefined) return subject;
  // Brought to the front, it draws over every other until the daemon says with what z.
  const z = move.toFront === true ? Infinity : (move.z ?? subject.position?.z ?? null);
  return { ...subject, zoneId: move.zoneId, position: { x: move.x, y: move.y, z } };
}

interface Placed {
  id: string;
  /** The zone it is in, if any. */
  parentId: string | undefined;
  position: { x: number; y: number } | undefined;
  data: TileData;
  draggable: boolean;
}

/**
 * `nodes` with a tile for each agent, shell and external session. A tile sits where it was placed (relative to its
 * zone, a child node so it moves with it, or on the board when loose). One with no place yet gets the first free slot
 * in its zone, or a spot clear of the zones on the board, which the board then saves. An agent outside every zone of its repo
 * has its repo's name on its tile. A zone grows to hold its tiles, and
 * remembers the least size they need for its resizer. Tiles keep what React Flow added to them (selection,
 * measurements), and one being dragged stays under the pointer. Parents stay before their children, as React Flow
 * needs, and tiles are in stacking order.
 */
export function withTiles(
  nodes: BoardNode[],
  agents: readonly Agent[],
  shells: readonly Shell[],
  externals: readonly ExternalSession[],
  /** Moves made here the daemon hasn't saved yet, by node id: tiles show there meanwhile. */
  pending: ReadonlyMap<string, TileMove> = new Map(),
  /** The tiles expanded in place, drawn at their size over the rest. */
  expanded: ExpandedTiles = [],
  /** The sizes tiles were resized to, by node id: a tile not here is `AGENT_TILE_SIZE`. */
  sizes: TileSizes = {},
  /** The closed agents the user unfolded, by node id: the other closed agents are folded to chips. */
  unfolded: ReadonlySet<string> = new Set(),
): BoardNode[] {
  const known = new Map(nodes.filter(isSessionTile).map((node) => [node.id, node]));
  const zones = new Map(nodes.filter(isZone).map((zone) => [zone.id, zone]));
  const entries: Placed[] = [];
  const add = (id: string, zoneId: string | null, data: TileData) => {
    if (zoneId !== null && !zones.has(zoneId)) return;
    entries.push({ id, parentId: zoneId ?? undefined, position: undefined, data, draggable: true });
  };
  const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
  const crews = new Map<string, number>();
  const folded = new Set<string>();
  for (const agent of agents) {
    if (agent.spawnedBy !== null && byId.has(agent.spawnedBy)) crews.set(agent.spawnedBy, (crews.get(agent.spawnedBy) ?? 0) + 1);
  }
  // An agent's or shell tile's tabs are shells of its session window, not tiles of their own; an agent's tile shows its.
  const tabs = new Map<string, Shell[]>();
  for (const shell of shells) if (shell.owner?.kind === 'agent') tabs.set(shell.owner.id, [...(tabs.get(shell.owner.id) ?? []), shell]);
  for (const listed of agents) {
    const id = tileNodeId('agent', listed.sessionId);
    const agent = placedAt(listed, pending.get(id));
    // Outside every zone of its repo, its tile says which repo it works in.
    const home = agent.zoneId !== null && zones.get(agent.zoneId)?.data.zone.repoRoot === agent.repoRoot;
    const orchestrator = agent.spawnedBy === null ? undefined : byId.get(agent.spawnedBy);
    const crew = crews.get(agent.sessionId);
    // A closed agent is a chip, unless the user unfolded it or it is expanded in place.
    if (isFolded(agent, unfolded) && expandedRank(expanded, id) === undefined) folded.add(id);
    add(id, agent.zoneId, {
      label: agent.name,
      harness: agent.harness,
      agent,
      ...(home ? {} : { repo: repoName(agent.repoRoot) }),
      ...(orchestrator === undefined ? {} : { from: { sessionId: orchestrator.sessionId, name: orchestrator.name } }),
      ...(crew === undefined ? {} : { crew }),
      ...(tabs.has(agent.sessionId) ? { tabs: tabs.get(agent.sessionId) } : {}),
      ...(folded.has(id) ? { folded: true as const, lift: chipLift(tileSizeOf(sizes, id).height) } : {}),
    });
  }
  for (const listed of shells) {
    if (listed.owner) continue;
    const id = tileNodeId('shell', listed.id);
    const shell = placedAt(listed, pending.get(id));
    add(id, shell.zoneId, { label: shell.name, harness: null, shell });
  }
  for (const listed of externals) {
    const id = tileNodeId('external', listed.id);
    const session = placedAt(listed, pending.get(id));
    const data = { label: session.name, harness: session.harness, external: session };
    add(id, session.zoneId, data);
  }

  // A chip sits centred in its tile's place, as drawn in the crew-layout mock, so an edge to a full tile beside it is straight.
  const lifted = new Set<string>();
  // Where each is: under the pointer while dragged, or where React Flow keeps it while it (expanded) or its zone is
  // resized from the left or top; else where it was put. Then the rest in free spots.
  for (const entry of entries) {
    const dragged = known.get(entry.id);
    const resizing = dragged?.resizing === true || (entry.parentId !== undefined && zones.get(entry.parentId)?.resizing === true);
    if (dragged !== undefined && (dragged.dragging === true || resizing)) {
      entry.parentId = dragged.parentId;
      entry.position = dragged.position;
      lifted.add(entry.id);
    } else {
      const position = subjectOf(entry.data).position;
      if (position !== null) entry.position = { x: position.x, y: position.y };
    }
  }
  /**
   * A compact tile's size as drawn: a chip's, else what it is being resized to until it is let go, else what it was last let go at.
   * An expanded tile counts as its compact size here: its zone keeps to that, so it floats over it.
   */
  const sizeOf = (id: string) => {
    if (folded.has(id)) return CHIP_SIZE;
    const before = known.get(id);
    const saved = tileSizeOf(sizes, id);
    return before?.resizing === true && expandedRank(expanded, id) === undefined ? { width: before.width ?? saved.width, height: before.height ?? saved.height } : saved;
  };
  const rect = (entry: Placed) => ({ ...entry.position!, ...sizeOf(entry.id) });
  /** What a placed tile takes for a new crew member: its size as drawn (expanded or not), and the room above it. */
  const footprintOf = (entry: Placed) => {
    const rank = expandedRank(expanded, entry.id);
    const size = rank === undefined ? sizeOf(entry.id) : expanded[rank]!;
    return { x: entry.position!.x, y: entry.position!.y - PERCH_ROOM, width: size.width, height: size.height + PERCH_ROOM };
  };
  // After a tile with no place is slotted: a dragged chip is already where it is drawn.
  for (const entry of entries) {
    if (entry.data.lift !== undefined && !lifted.has(entry.id)) entry.position = { x: entry.position!.x, y: entry.position!.y + entry.data.lift };
  }
  const zoneRects = [...zones.values()].map(layoutOf);
  // Board items in each zone (an issue card, a sticky), and loose on the board, are in the way too.
  const items = new Map<string | undefined, ZoneLayout[]>();
  for (const node of nodes.filter(isItemNode)) items.set(node.parentId, [...(items.get(node.parentId) ?? []), node.data.item]);
  // An orchestrator's new agent goes beside it, in its crew (BA2), when it starts where its orchestrator is.
  slotUnplaced(entries, {
    zoneOf: (entry) => entry.parentId,
    placeOf: (entry) => entry.position,
    place: (entry, spot) => (entry.position = spot),
    agentOf: (entry) => entry.data.agent?.sessionId,
    orchestratorOf: (entry) => entry.data.from?.sessionId,
    rect,
    footprint: footprintOf,
    zoneWidth: (zoneId) => layoutOf(zones.get(zoneId)!).width,
    zones: zoneRects,
    items: (zoneId) => items.get(zoneId) ?? [],
  });

  const sized = nodes
    .filter((node) => !isSessionTile(node))
    .map((node) => {
      if (!isZone(node)) return node;
      // A tile being dragged out doesn't stretch its zone after it.
      const held = entries.filter((entry) => entry.parentId === node.id && known.get(entry.id)?.dragging !== true).map(rect);
      return fitToTiles(node, held);
    });

  const tiles = entries.map((entry): TileNodeType => {
    const before = known.get(entry.id);
    const rank = expandedRank(expanded, entry.id);
    const open = rank === undefined ? undefined : expanded[rank]!;
    const { parentId, ...fresh } = {
      id: entry.id,
      type: 'tile' as const,
      parentId: entry.parentId,
      position: entry.position!,
      // An expanded tile being resized has the size React Flow is giving it until it is let go.
      ...(open === undefined
        ? sizeOf(entry.id)
        : before?.resizing === true
          ? { width: before.width ?? open.width, height: before.height ?? open.height }
          : { width: open.width, height: open.height }),
      draggable: entry.draggable,
      data: open === undefined ? entry.data : { ...entry.data, expanded: true as const },
      zIndex: rank !== undefined ? EXPANDED_Z_INDEX + rank : before?.dragging === true ? DRAGGED_TILE_Z_INDEX : TILE_Z_INDEX,
    };
    // Out of every zone, it must lose the one it had; collapsed, its drag handle.
    const node: TileNodeType = { ...before, ...fresh };
    if (parentId === undefined) delete node.parentId;
    else node.parentId = parentId;
    if (open === undefined) delete node.dragHandle;
    else node.dragHandle = EXPANDED_DRAG_HANDLE;
    return node;
  });
  // Stable, so tiles of equal z keep the order they were listed in.
  return [...sized, ...tiles.toSorted((a, b) => (zOf(a) === zOf(b) ? 0 : zOf(a) - zOf(b)))];
}

/**
 * `zone` grown right and down to hold `tiles` (relative to it), remembering for its resizer the part of the board it
 * must cover and how many tiles it holds.
 */
function fitToTiles(zone: ZoneNodeType, tiles: readonly ZoneLayout[]): ZoneNodeType {
  const { x, y } = zone.position;
  const least = zoneMinSize(tiles);
  const covers = {
    left: Math.min(...tiles.map((tile) => x + tile.x - ZONE_PADDING)),
    top: Math.min(...tiles.map((tile) => y + tile.y - ZONE_PADDING - PERCH_ROOM)),
    right: x + Math.max(MIN_ZONE_SIZE.width, least.width),
    bottom: y + Math.max(MIN_ZONE_SIZE.height, least.height),
  };
  const known = zone.data.covers;
  const same =
    zone.data.tileCount === tiles.length &&
    known !== undefined &&
    (['left', 'top', 'right', 'bottom'] as const).every((edge) => known[edge] === covers[edge]);
  const data = { ...zone.data, covers, tileCount: tiles.length };
  // Not mid-resize: the resizer works from the size the drag started at and would fight a size changed under it.
  if (zone.resizing === true) return same ? zone : { ...zone, data };
  const layout = layoutOf(zone);
  const width = Math.max(layout.width, covers.right - x);
  const height = Math.max(layout.height, covers.bottom - y);
  if (width === layout.width && height === layout.height && same) return zone;
  return { ...zone, width, height, data };
}

/**
 * Whether a zone resized to `next` still holds its tiles: no edge moves in past what it `covers`, unless it was
 * already past (a tile hanging over its edge), and then only outwards.
 */
export function holdsTiles(covers: ZoneCovers | undefined, now: ZoneLayout, next: ZoneLayout): boolean {
  if (covers === undefined) return true;
  return (
    next.x <= Math.max(covers.left, now.x) &&
    next.y <= Math.max(covers.top, now.y) &&
    next.x + next.width >= Math.min(covers.right, now.x + now.width) &&
    next.y + next.height >= Math.min(covers.bottom, now.y + now.height)
  );
}

/** A repo's name, as a tile shows it: its folder's. */
export const repoName = (repoRoot: string) => repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? repoRoot;

/** How far below its tile's top a chip is drawn to sit centred in the tile's place, for a tile `tileHeight` high. */
const chipLift = (tileHeight: number): number => Math.max(0, Math.floor((tileHeight - CHIP_SIZE.height) / 2));

/** Where a tile's place is saved: its drawn position, less how far a folded chip is drawn below it. */
export const savedPlace = (node: TileNodeType): { x: number; y: number } => ({ x: node.position.x, y: node.position.y - (node.data.lift ?? 0) });

/** `move` as it is saved for `tile`: a folded chip is drawn `lift` below the place it was saved at, so a move of it is as well. */
export const savedMove = (tile: TileData, move: TileMove): TileMove => (tile.lift === undefined ? move : { ...move, y: move.y - tile.lift });
