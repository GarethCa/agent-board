// Drawing a zone laid out by status (`Zone.layoutMode`). On shelves: its pinned leads and shells in the head row, every
// other agent folded into its stack's card on a shelf, and the stack the user opened fanned out below the shelves. In
// clusters: the same head row, then each unit of work's tiles drawn together, Done's folded behind one line. Only the
// nodes as drawn change: no tile's saved place is touched, so a zone set back to free shows as it was. Pure, so it is
// unit-tested.
import { layoutClusters, layoutShelves, tileStep, type ClusterLayout, type ShelfCluster, type ShelfLayout, type ShelfStack } from '@agent-board/daemon/shelf-layout';
import { isOrchestratorRole, type Agent, type NeedsYouShows } from '@agent-board/daemon/protocol';
import { agentNoteData } from './items/agent-note';
import { isItemNode } from './items/items';
import type { TileNodeType } from './tile';
import { AGENT_TILE_SIZE, CHIP_SIZE } from '@agent-board/daemon/board-layout';
import type { Rect } from '../geometry';
import { isSessionTile, isZone, sizeOfNode, tileNodeId, tileSubject, type BoardNode } from './tiles';
import type { ZoneNodeType } from './ZoneNode';

/** A stack as its card draws it: with its agents, and how many agent notes they wrote that its card stands for. */
export interface DrawnStack extends ShelfStack {
  agents: Agent[];
  notes: number;
}

/** What a shelved zone's node draws under its tiles. */
export interface ShelfView extends Omit<ShelfLayout, 'stacks'> {
  stacks: DrawnStack[];
  /** The stack fanned out, if any. */
  open: string | null;
}

/** A cluster as its outline draws it: with how many agent notes its agents wrote, folded into its label. */
export interface DrawnCluster extends ShelfCluster {
  notes: number;
}

/** What a zone in clusters draws under its tiles: the outlines and labels, and Done's line. */
export interface ClusterView extends Omit<ClusterLayout, 'clusters'> {
  clusters: DrawnCluster[];
}

/** What the user chose for the shelved zones, in this window. */
export interface ShelvesChoice {
  /** The leads freed from the head row, by session id: each is a stack like any other. */
  freed: ReadonlySet<string>;
  /** The zones whose Done shelf shows its chips, not only its line. */
  doneShown: ReadonlySet<string>;
  /** The stack fanned out, and its zone. */
  open: { zoneId: string; key: string } | null;
}

/** A fanned tile draws over the board, and over a tile expanded in place. */
const FAN_Z_INDEX = 6;

/**
 * Whether `agent` leads: an orchestrator by its role, the Captain, or an agent that started a crew of its own among
 * `agents`. Every agent the user starts may orchestrate; only these do.
 */
export const isLead = (agent: Pick<Agent, 'sessionId' | 'roleName' | 'master'>, agents: readonly Pick<Agent, 'spawnedBy'>[]): boolean =>
  isOrchestratorRole(agent.roleName) || agent.master || agents.some((each) => each.spawnedBy === agent.sessionId);

/** Whether `agent` is pinned in its shelved zone's head row: a lead (`isLead`) the user hasn't freed. */
export const pinnedLead = (agent: Pick<Agent, 'sessionId' | 'roleName' | 'master'>, agents: readonly Pick<Agent, 'spawnedBy'>[], freed: ReadonlySet<string>): boolean =>
  isLead(agent, agents) && !freed.has(agent.sessionId);

/**
 * `nodes` as drawn with each zone laid out by status. On shelves: its head row's tiles at their places, the open stack's
 * tiles fanned out under its card, every other tile of it hidden. In clusters: its head row, then every cluster's tiles
 * at their places, Done's hidden until shown. Either way, the agent notes its stacks stand for are hidden (counted on
 * their card or label), its tiles aren't dragged, and the zone is drawn big enough to hold it all.
 */
export function withShelves(
  nodes: readonly BoardNode[],
  { agents, links, shows, choice }: { agents: readonly Agent[]; links: readonly { from: string; to: string }[]; shows: NeedsYouShows; choice: ShelvesChoice },
): BoardNode[] {
  const laidOut = nodes.filter((node): node is ZoneNodeType => isZone(node) && node.data.zone.layoutMode !== 'free');
  if (laidOut.length === 0) return [...nodes];
  const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
  const drawn = new Map<string, Partial<BoardNode>>();
  for (const zone of laidOut) {
    const tiles = nodes.filter((node): node is TileNodeType => node.type === 'tile' && node.parentId === zone.id);
    // As drawn: an expanded tile at its expanded size, so its cluster, the head row and the zone grow round it, never
    // under it.
    const sizes = new Map(tiles.map((node) => [node.id, sizeOfNode(node)]));
    // Each agent's notes in the zone, by its session id: its card or label counts them, folded into it.
    const notes = new Map<string, string[]>();
    for (const node of nodes) {
      if (!isItemNode(node) || node.parentId !== zone.id || node.data.item.kind !== 'agent-note') continue;
      // A lead's note about one of its crew is that agent's, as its tether says.
      const note = agentNoteData(node.data.item.data);
      const owner = note.about ?? note.agent.sessionId;
      notes.set(owner, [...(notes.get(owner) ?? []), node.id]);
    }
    const noteCount = (members: readonly string[]) => members.reduce((sum, id) => sum + (notes.get(id)?.length ?? 0), 0);
    const common = {
      agents,
      zoneId: zone.id,
      spacing: zone.data.zone.spacing,
      // As saved: never as drawn, which this draws bigger only when what it lays out doesn't fit it.
      width: zone.data.zone.width,
      pinned: new Set(agents.filter((agent) => agent.zoneId === zone.id && pinnedLead(agent, agents, choice.freed)).map((agent) => agent.sessionId)),
      // Its shells, external sessions and agents being started: by id, so the row is the same however they are listed.
      heads: tiles.filter((node) => tileSubject(node.id)?.kind !== 'agent').map((node) => node.id).sort(),
      links,
      shows,
      sizeOf: (key: string) => sizes.get(key) ?? { width: 0, height: 0 },
      doneShown: choice.doneShown.has(zone.id),
    };
    const places = new Map<string, { x: number; y: number; z?: number }>();
    let members: readonly (readonly string[])[];
    let data: Partial<ZoneNodeType['data']>;
    let size: { width: number; height: number };
    if (zone.data.zone.layoutMode === 'clusters') {
      const layout = layoutClusters(common);
      for (const place of layout.head) places.set(place.key, place);
      for (const cluster of layout.clusters) if (cluster.placed) for (const place of cluster.tiles) places.set(place.key, place);
      const clusters = layout.clusters.map((cluster): DrawnCluster => ({ ...cluster, notes: noteCount(cluster.members) }));
      members = clusters.map((cluster) => cluster.members);
      data = { clusters: { ...layout, clusters } };
      size = layout.size;
    } else {
      const open = choice.open?.zoneId === zone.id ? choice.open.key : null;
      const layout = layoutShelves({ ...common, footOf: (ids) => ids.some((id) => (byId.get(id)?.pullRequests.length ?? 0) > 0 || notes.has(id)), open });
      for (const place of layout.head) places.set(place.key, place);
      for (const place of layout.fan) places.set(place.key, { ...place, z: FAN_Z_INDEX });
      const stacks = layout.stacks.map((stack): DrawnStack => ({ ...stack, agents: stack.members.map((id) => byId.get(id)!), notes: noteCount(stack.members) }));
      members = stacks.map((stack) => stack.members);
      data = { shelves: { ...layout, stacks, open } };
      size = layout.size;
    }
    for (const node of tiles) {
      const at = places.get(node.id);
      if (at === undefined) drawn.set(node.id, { hidden: true });
      else drawn.set(node.id, { position: { x: at.x, y: at.y }, draggable: false, ...(at.z === undefined ? {} : { zIndex: at.z }) });
    }
    // The notes its stacks stand for are counted where they are drawn, and stay folded.
    for (const ids of members) for (const id of ids) for (const note of notes.get(id) ?? []) drawn.set(note, { hidden: true });
    drawn.set(zone.id, {
      width: Math.max(zone.width ?? 0, size.width),
      height: Math.max(zone.height ?? 0, size.height),
      data: { ...zone.data, ...data },
    } as Partial<ZoneNodeType>);
  }
  return nodes.map((node) => {
    const change = drawn.get(node.id);
    return change === undefined ? node : ({ ...node, ...change } as BoardNode);
  });
}

/**
 * Whether `node` is a session tile drawn where its zone's layout puts it, not at its saved place: in a zone on shelves or
 * in clusters. Nothing may save such a tile's place from where it is drawn (an align, a drop onto it).
 */
export function laidOutTile(node: BoardNode, nodes: readonly BoardNode[]): boolean {
  if (!isSessionTile(node) || node.parentId === undefined) return false;
  const zone = nodes.find((each): each is ZoneNodeType => each.id === node.parentId && isZone(each));
  return zone !== undefined && zone.data.zone.layoutMode !== 'free';
}

/** How to show an agent folded out of sight: its zone and stack, whether Done must be shown first, and what to bring into view. */
export interface Unfold {
  zoneId: string;
  key: string;
  /** Its stack or cluster is in Done, folded behind its one line. */
  showDone: boolean;
  /** On shelves, its stack is fanned out to show it; in clusters its tiles are already drawn once its cluster is. */
  fan: boolean;
  /** The part of the board (absolute) to bring into view: where it will be drawn (a stack's card down to its fanned tiles), or near enough. */
  rect: Rect;
}

/**
 * How to show the agent `sessionId` when it is folded out of sight in a zone laid out by status among `drawn`: into a
 * stack on shelves (fanned out to show it, Done shown first if that is where it is), or into a cluster folded into
 * Done. Undefined for an agent drawn as a tile, which is shown where it is. `tileHeight` is the room its tile takes.
 */
export function foldedStack(drawn: readonly BoardNode[], sessionId: string, tileHeight: number): Unfold | undefined {
  const tile = drawn.find((node) => node.id === tileNodeId('agent', sessionId));
  if (tile === undefined || tile.hidden !== true || tile.parentId === undefined) return undefined;
  const zone = drawn.find((node): node is ZoneNodeType => node.id === tile.parentId && isZone(node));
  if (zone === undefined) return undefined;
  const { shelves, clusters } = zone.data;
  const stack = shelves?.stacks.find((each) => each.members.includes(sessionId)) ?? clusters?.clusters.find((each) => each.members.includes(sessionId));
  if (stack === undefined) return undefined;
  if (shelves !== undefined) {
    // As wide as its tiles side by side, as they fan out.
    const across = stack.members.length * AGENT_TILE_SIZE.width + (stack.members.length - 1) * tileStep(zone.data.zone.spacing);
    // Folded into Done, it is shown under Done's line once Done is shown: near enough to bring into view.
    const box = stack.placed ? stack : shelves.doneLine;
    if (box === null) return undefined;
    const x = zone.position.x + box.x;
    const y = zone.position.y + box.y;
    // Down to its fanned tiles, below the shelves.
    const bottom = zone.position.y + shelves.fanTop + tileHeight + (stack.placed ? 0 : 2 * CHIP_SIZE.height);
    return { zoneId: zone.id, key: stack.key, showDone: !stack.placed, fan: true, rect: { x, y, width: Math.max(box.width, across), height: Math.max(bottom - y, box.height) } };
  }
  // In clusters only Done's are folded, each keeping the place it is drawn at once Done is shown: bring that into view.
  if (stack.placed) return undefined;
  return { zoneId: zone.id, key: stack.key, showDone: true, fan: false, rect: { x: zone.position.x + stack.x, y: zone.position.y + stack.y, width: stack.width, height: stack.height } };
}
