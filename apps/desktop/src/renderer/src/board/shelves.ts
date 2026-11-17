// Drawing a zone laid out by status (`Zone.layoutMode`). On shelves: its pinned leads and shells in the head row, every
// other agent folded into its stack's card on a shelf, and the stack the user opened fanned out below the shelves. In
// clusters: the same head row, then each unit of work's tiles drawn together, Done's folded behind one line. Only the
// nodes as drawn change: no tile's saved place is touched, so a zone set back to free shows as it was. Pure, so it is
// unit-tested.
import { inFreeArea, layoutClusters, layoutShelves, tileStep, type ClusterLayout, type ShelfCluster, type ShelfLayout, type ShelfStack } from '@agent-board/daemon/shelf-layout';
import type { Agent, NeedsYouShows, ZoneLayout } from '@agent-board/daemon/protocol';
import { isLead } from '@agent-board/daemon/work-units';
import { agentNoteData } from './items/agent-note';
import { isItemNode } from './items/items';
import { stagedTile } from './stage-boards';
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
  /** Where its lanes area's top-left is in the zone: what every place of it is from. */
  origin: { x: number; y: number };
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
  /** Where its lanes area's top-left is in the zone: what every place of it is from. */
  origin: { x: number; y: number };
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

/** A zone's lanes area as it is being dragged by its corner, before it is let go and saved. */
export interface LanesDraft {
  zoneId: string;
  lanes: ZoneLayout;
}

/** A fanned tile draws over the board, and over a tile expanded in place. */
const FAN_Z_INDEX = 6;

/** Whether `agent` is pinned in its shelved zone's head row: a lead (`isLead`) the user hasn't freed. */
export const pinnedLead = (agent: Agent, agents: readonly Agent[], freed: ReadonlySet<string>): boolean =>
  isLead(agent, agents) && !freed.has(agent.sessionId);

/**
 * `nodes` as drawn with each zone laid out by status. On shelves: its head row's tiles at their places, the open stack's
 * tiles fanned out under its card, every other tile of it hidden. In clusters: its head row, then every cluster's tiles
 * at their places, Done's hidden until shown. Either way, the agent notes its stacks stand for are hidden (counted on
 * their card or label), its tiles aren't dragged, and the zone is drawn big enough to hold it all.
 */
export function withShelves(
  nodes: readonly BoardNode[],
  {
    agents: allAgents,
    links,
    shows,
    choice,
    lanesDraft = null,
  }: { agents: readonly Agent[]; links: readonly { from: string; to: string }[]; shows: NeedsYouShows; choice: ShelvesChoice; lanesDraft?: LanesDraft | null },
): BoardNode[] {
  const laidOut = nodes.filter((node): node is ZoneNodeType => isZone(node) && node.data.zone.layoutMode !== 'free');
  if (laidOut.length === 0) return [...nodes];
  const byId = new Map(allAgents.map((agent) => [agent.sessionId, agent]));
  const drawn = new Map<string, Partial<BoardNode>>();
  for (const zone of laidOut) {
    // Undefined from a daemon from before zones had lanes areas of their own.
    const saved = (zone.data.zone.lanes as ZoneLayout | null | undefined) ?? null;
    // Its tiles the user put in its free area, outside its lanes area, stay where they were put: draggable, and in no
    // lane. Every other tile of it is laid out, wherever it was saved or slotted.
    const inZone = nodes.filter((node): node is TileNodeType => node.type === 'tile' && node.parentId === zone.id);
    const free = new Set(inZone.filter((node) => inFreeArea(zone.data.zone, node.id)).map((node) => node.id));
    const tiles = inZone.filter((node) => !free.has(node.id));
    const agents = free.size === 0 ? allAgents : allAgents.filter((agent) => !free.has(tileNodeId('agent', agent.sessionId)));
    // Its lanes area as it is being dragged, else as saved; null while its lanes fill it.
    const area = lanesDraft?.zoneId === zone.id ? lanesDraft.lanes : saved;
    const origin = area === null ? { x: 0, y: 0 } : { x: area.x, y: area.y };
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
      // As saved: never as drawn, which this draws bigger only when what it lays out doesn't fit it. Being resized, at
      // the width it is being dragged to, so what it holds reflows as it goes.
      // A lanes area of its own lays them out at its width.
      width: area !== null ? area.width : zone.resizing === true && zone.width !== undefined ? zone.width : zone.data.zone.width,
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
    // How narrow what it holds can be laid out, for its resizer: worked out only while it shows, as a second layout.
    const sizing = zone.selected === true || zone.resizing === true || lanesDraft?.zoneId === zone.id;
    let leastWidth = 0;
    if (zone.data.zone.layoutMode === 'clusters') {
      const layout = layoutClusters(common);
      if (sizing) leastWidth = layoutClusters({ ...common, width: 0 }).size.width;
      for (const place of layout.head) places.set(place.key, place);
      for (const cluster of layout.clusters) if (cluster.placed) for (const place of cluster.tiles) places.set(place.key, place);
      const clusters = layout.clusters.map((cluster): DrawnCluster => ({ ...cluster, notes: noteCount(cluster.members) }));
      members = clusters.map((cluster) => cluster.members);
      data = { clusters: { ...layout, clusters, origin } };
      size = layout.size;
    } else {
      const open = choice.open?.zoneId === zone.id ? choice.open.key : null;
      const footOf = (ids: readonly string[]) => ids.some((id) => (byId.get(id)?.pullRequests.length ?? 0) > 0 || notes.has(id));
      const layout = layoutShelves({ ...common, footOf, open });
      if (sizing) leastWidth = layoutShelves({ ...common, width: 0, footOf, open }).size.width;
      for (const place of layout.head) places.set(place.key, place);
      for (const place of layout.fan) places.set(place.key, { ...place, z: FAN_Z_INDEX });
      const stacks = layout.stacks.map((stack): DrawnStack => ({ ...stack, agents: stack.members.map((id) => byId.get(id)!), notes: noteCount(stack.members) }));
      members = stacks.map((stack) => stack.members);
      data = { shelves: { ...layout, stacks, open, origin } };
      size = layout.size;
    }
    for (const node of tiles) {
      const at = places.get(node.id);
      if (at === undefined) drawn.set(node.id, { hidden: true });
      else drawn.set(node.id, { position: { x: origin.x + at.x, y: origin.y + at.y }, draggable: false, ...(at.z === undefined ? {} : { zIndex: at.z }) });
    }
    // The notes its stacks stand for are counted where they are drawn, and stay folded.
    for (const ids of members) for (const id of ids) for (const note of notes.get(id) ?? []) drawn.set(note, { hidden: true });
    // Let go, from its saved size, and measured at what it is drawn at: React Flow resizes from the measured size it is
    // handed, and a resize's changes can leave a size on the node after the one it saved, which a drag of one edge would
    // keep for the other side.
    const at = zone.resizing === true ? { width: zone.width ?? 0, height: zone.height ?? 0 } : zone.data.zone;
    // Its lanes area as drawn: never smaller than its lanes; filling the zone, without one of its own.
    const lanes = area === null ? null : { ...area, width: Math.max(area.width, size.width), height: Math.max(area.height, size.height) };
    const shown = {
      width: Math.max(at.width, (lanes?.x ?? 0) + (lanes?.width ?? size.width)),
      height: Math.max(at.height, (lanes?.y ?? 0) + (lanes?.height ?? size.height)),
    };
    // Resized by hand, it goes no smaller than its lanes, nor, with a lanes area of its own, than that and its free tiles.
    const covers = zone.data.covers;
    const fits =
      lanes === null
        ? { width: leastWidth, height: size.height }
        : {
            width: Math.max(lanes.x + lanes.width, free.size > 0 && covers !== undefined ? covers.right - zone.position.x : 0),
            height: Math.max(lanes.y + lanes.height, free.size > 0 && covers !== undefined ? covers.bottom - zone.position.y : 0),
          };
    const lanesArea = { area: lanes ?? { x: 0, y: 0, ...shown }, fits: { width: leastWidth, height: size.height } };
    drawn.set(zone.id, {
      ...shown,
      measured: shown,
      data: { ...zone.data, ...data, ...(sizing ? { fits, lanesArea } : {}) },
    } as Partial<ZoneNodeType>);
  }
  return nodes.map((node) => {
    const change = drawn.get(node.id);
    return change === undefined ? node : ({ ...node, ...change } as BoardNode);
  });
}

/**
 * Whether `node` is a session tile drawn where its zone's layout puts it, not at its saved place: in a zone on shelves or
 * in clusters, or on a stage board. Nothing may save such a tile's place from where it is drawn (an align, a drop onto it).
 */
export function laidOutTile(node: BoardNode, nodes: readonly BoardNode[]): boolean {
  if (!isSessionTile(node) || node.parentId === undefined) return false;
  const zone = nodes.find((each): each is ZoneNodeType => each.id === node.parentId && isZone(each));
  // One in its free area, outside its lanes area, is where it was put.
  return (zone !== undefined && zone.data.zone.layoutMode !== 'free' && !inFreeArea(zone.data.zone, node.id)) || stagedTile(node, nodes);
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
    const x = zone.position.x + shelves.origin.x + box.x;
    const y = zone.position.y + shelves.origin.y + box.y;
    // Down to its fanned tiles, below the shelves.
    const bottom = zone.position.y + shelves.origin.y + shelves.fanTop + tileHeight + (stack.placed ? 0 : 2 * CHIP_SIZE.height);
    return { zoneId: zone.id, key: stack.key, showDone: !stack.placed, fan: true, rect: { x, y, width: Math.max(box.width, across), height: Math.max(bottom - y, box.height) } };
  }
  // In clusters only Done's are folded, each keeping the place it is drawn at once Done is shown: bring that into view.
  if (stack.placed) return undefined;
  const origin = clusters?.origin ?? { x: 0, y: 0 };
  return { zoneId: zone.id, key: stack.key, showDone: true, fan: false, rect: { x: zone.position.x + origin.x + stack.x, y: zone.position.y + origin.y + stack.y, width: stack.width, height: stack.height } };
}
