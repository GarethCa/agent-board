// Drawing a zone's stage board: a block of four stages (To do, Doing, Waiting for review, Done) that holds the work its
// zone's agents started. Doing's tickets are bands of their live tiles, drawn on the block; the other stages' are quiet
// cards, their tiles hidden behind them. A ticket moves stage as its agents' state does, so nothing is saved for it but
// the block's own place and size, and which agents were dragged on or off it: a tile's saved place stays as it was, for
// when it leaves the block. Pure, so it is unit-tested.
import { zoneGrid } from '@agent-board/daemon/board-layout';
import { jobParts } from '@agent-board/daemon/memory-lines';
import { QUEUE_LATER, type Agent, type BoardItem, type NeedsYouShows, type QueueJob } from '@agent-board/daemon/protocol';
import { layOutStageBoard, leads, stageBoardData, stageBoardDrop, stageBoardMembers, STAGE_BOARD_KIND, type StageBoardData, type StageBoardLayout, type StageTicket } from '@agent-board/daemon/stage-board';
import { agentNoteData } from './items/agent-note';
import { isItemNode, type ItemNodeType } from './items/items';
import type { TileNodeType } from './tile';
import { AGENT_NODE_PREFIX, isSessionTile, isZone, sizeOfNode, type BoardNode } from './tiles';
import type { ZoneNodeType } from './ZoneNode';

/** A ticket as the block draws it: with its agents, and how many agent notes they wrote that its card stands for. */
export interface DrawnStageTicket extends StageTicket {
  agents: Agent[];
  notes: number;
}

/** What a stage board's node draws: its stages, and its tickets' cards and bands. */
export interface StageBoardView extends Omit<StageBoardLayout, 'tickets'> {
  tickets: DrawnStageTicket[];
  /** Its zone's colour, that its Doing bands are tinted with. */
  color: string;
}

const isStageBoard = (node: BoardNode): node is ItemNodeType => isItemNode(node) && node.data.item.kind === STAGE_BOARD_KIND;

/**
 * `nodes` with each zone's stage board drawn: the block as big as its stages take, the tiles of its Doing tickets on it
 * (dragged off it to leave), with their agents' notes under them, every other tile it holds hidden, with its agents' notes (counted on their card), and the zone big
 * enough to hold the block, and marked as holding it. A zone laid out by status says the same on its shelves, so its stage board is hidden.
 */
export function withStageBoards(
  nodes: readonly BoardNode[],
  {
    agents,
    links,
    shows,
    later,
  }: {
    agents: readonly Agent[];
    links: readonly { from: string; to: string }[];
    shows: NeedsYouShows;
    /** What is put off for later in each zone, by zone id: drawn at the foot of its To do. */
    later?: StageLater;
  },
): BoardNode[] {
  const boards = nodes.filter(isStageBoard);
  if (boards.length === 0) return [...nodes];
  const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const drawn = new Map<string, Partial<BoardNode>>();
  for (const block of boards) {
    const zone = nodes.find((node): node is ZoneNodeType => isZone(node) && node.id === block.parentId);
    if (zone === undefined || zone.data.zone.layoutMode !== 'free') {
      drawn.set(block.id, { hidden: true });
      continue;
    }
    const tiles = nodes.filter((node): node is TileNodeType => node.type === 'tile' && node.parentId === zone.id);
    const sizes = new Map(tiles.map((node) => [node.id, sizeOfNode(node)]));
    const notes = new Map<string, string[]>();
    for (const node of nodes) {
      if (!isItemNode(node) || node.parentId !== zone.id || node.data.item.kind !== 'agent-note') continue;
      const note = agentNoteData(node.data.item.data);
      const owner = note.about ?? note.agent.sessionId;
      notes.set(owner, [...(notes.get(owner) ?? []), node.id]);
    }
    const layout = layOutStageBoard({
      agents,
      zoneId: zone.id,
      data: stageBoardData(block.data.item.data),
      links,
      shows,
      spacing: zone.data.zone.spacing,
      sizeOf: (key) => sizes.get(key) ?? { width: 0, height: 0 },
      footOf: (ids) => ids.some((id) => (byId.get(id)?.pullRequests.length ?? 0) > 0 || notes.has(id)),
      notesOf: (sessionId) => (notes.get(sessionId) ?? []).map((key) => ({ key, size: sizeOfNode(nodeById.get(key)!) })),
      later: later?.get(zone.id) ?? [],
    });
    const origin = block.position;
    for (const ticket of layout.tickets) {
      for (const sessionId of ticket.members) {
        const id = `agent:${sessionId}`;
        const at = layout.tiles.get(id);
        if (at === undefined) {
          drawn.set(id, { hidden: true });
          for (const note of notes.get(sessionId) ?? []) drawn.set(note, { hidden: true });
        } else {
          // One being dragged goes where the drag has it, or it could never be dragged off.
          if (nodeById.get(id)?.dragging !== true) drawn.set(id, { position: { x: origin.x + at.x, y: origin.y + at.y } });
          for (const note of notes.get(sessionId) ?? []) {
            const noteAt = layout.tiles.get(note);
            // A band's note goes with its agent's tile, so it isn't dragged on its own.
            if (noteAt !== undefined) drawn.set(note, { position: { x: origin.x + noteAt.x, y: origin.y + noteAt.y }, draggable: false });
          }
        }
      }
    }
    const tickets = layout.tickets.map((ticket): DrawnStageTicket => ({
      ...ticket,
      agents: ticket.members.map((id) => byId.get(id)!),
      notes: ticket.live ? 0 : ticket.members.reduce((sum, id) => sum + (notes.get(id)?.length ?? 0), 0),
    }));
    drawn.set(block.id, { ...layout.size, dragHandle: '.stage-board-head', data: { ...block.data, stages: { ...layout, tickets, color: zone.data.zone.color } } } as Partial<ItemNodeType>);
    const { padding } = zoneGrid(zone.data.zone.spacing).gaps;
    const grown = drawn.get(zone.id) as Partial<ZoneNodeType> | undefined;
    drawn.set(zone.id, {
      width: Math.max(grown?.width ?? zone.width ?? 0, origin.x + layout.size.width + padding),
      height: Math.max(grown?.height ?? zone.height ?? 0, origin.y + layout.size.height + padding),
      data: { ...zone.data, stageBoard: true },
    } as Partial<ZoneNodeType>);
  }
  return nodes.map((node) => {
    const change = drawn.get(node.id);
    return change === undefined ? node : ({ ...node, ...change } as BoardNode);
  });
}

/** Whether `node` is a session tile a stage board draws on its block, where nothing may save its place from. */
export function stagedTile(node: BoardNode, nodes: readonly BoardNode[]): boolean {
  if (!isSessionTile(node) || node.parentId === undefined) return false;
  return nodes.some((each) => isStageBoard(each) && each.parentId === node.parentId && each.data.stages?.tiles.has(node.id) === true);
}

/**
 * What dropping agent `sessionId`'s tile at board point `at` does to the stage boards in `nodes` (as drawn): the data
 * each one it changes keeps now, and whether the tile keeps the place it had (`kept`) rather than landing where it was
 * dropped. Dropped on a block, it joins it, or stays on it; dropped off the block it was on, it leaves, landing there. One
 * dropped on the block of its own zone keeps its place, for the day it leaves; one from elsewhere moves into that zone.
 * Dropped in another zone, it is on neither of its old block's lists, so it is a member again by who started it if it
 * ever comes back.
 */
export function stageBoardDrops(
  sessionId: string,
  at: { x: number; y: number },
  nodes: readonly BoardNode[],
  agents: readonly Agent[],
): { changes: { id: string; data: StageBoardData }[]; kept: boolean } {
  const agent = agents.find((each) => each.sessionId === sessionId);
  const changes: { id: string; data: StageBoardData }[] = [];
  let kept = false;
  if (agent === undefined) return { changes, kept };
  for (const block of nodes.filter(isStageBoard)) {
    const zone = nodes.find((node) => isZone(node) && node.id === block.parentId);
    if (zone === undefined || block.hidden === true || block.data.stages === undefined) continue;
    const { width, height } = sizeOfNode(block);
    const x = zone.position.x + block.position.x;
    const y = zone.position.y + block.position.y;
    const onBlock = at.x >= x && at.x <= x + width && at.y >= y && at.y <= y + height;
    const room = sizeOfNode(zone);
    const inZone = at.x >= zone.position.x && at.x <= zone.position.x + room.width && at.y >= zone.position.y && at.y <= zone.position.y + room.height;
    const data = stageBoardData(block.data.item.data);
    const member = stageBoardMembers(agents, zone.id, data).includes(sessionId);
    // Off a block it was never on, in its zone: nothing to leave. Away from the zone, the block forgets it either way.
    if (!onBlock && inZone && !member) continue;
    const next = stageBoardDrop(agent, data, onBlock ? 'on' : inZone ? 'off' : 'away');
    if (next !== undefined) changes.push({ id: block.data.item.id, data: next });
    // A lead never goes on: dropped on its own zone's block, it goes back where it was rather than cover it.
    if (onBlock && agent.zoneId === zone.id && (member || next !== undefined || leads(agent))) kept = true;
  }
  return { changes, kept };
}

/** The stage boards drawn at a size their items don't keep yet, with that size: to save, so the daemon lays out round them. */
export function stageBoardResizes(nodes: readonly BoardNode[]): { id: string; width: number; height: number }[] {
  return nodes.flatMap((node) => {
    if (!isStageBoard(node) || node.hidden === true || node.data.stages === undefined) return [];
    const { item } = node.data;
    const { width, height } = node.data.stages.size;
    return item.width === width && item.height === height ? [] : [{ id: item.id, width, height }];
  });
}

/**
 * Where a new stage board goes in zone `zoneId`, relative to it: at its padding, under everything that stays outside the
 * block (the tiles it will hold, and their notes, leave for it), so it covers nothing.
 */
export function newStageBoardPlace(zoneId: string, nodes: readonly BoardNode[], agents: readonly Agent[]): { x: number; y: number } {
  const zone = nodes.find((node): node is ZoneNodeType => isZone(node) && node.id === zoneId);
  const { padding, lane } = zoneGrid(zone?.data.zone.spacing ?? 'normal').gaps;
  const held = new Set(stageBoardMembers(agents, zoneId, { joined: [], left: [] }));
  const stays = nodes.filter((node) => {
    if (node.parentId !== zoneId || node.hidden === true) return false;
    if (node.id.startsWith(AGENT_NODE_PREFIX)) return !held.has(node.id.slice(AGENT_NODE_PREFIX.length));
    if (isItemNode(node) && node.data.item.kind === 'agent-note') {
      const note = agentNoteData(node.data.item.data);
      return !held.has(note.about ?? note.agent.sessionId);
    }
    return true;
  });
  const bottom = Math.max(0, ...stays.map((node) => node.position.y + sizeOfNode(node).height));
  return { x: padding, y: stays.length === 0 ? padding : bottom + lane };
}

/**
 * Where a stage board dragged to board position `at` is saved: in its own `zone` still, as the daemon keeps it there,
 * moved back inside the zone's padding if it was dragged past an edge.
 */
export function stageBoardDropPlace(
  at: { x: number; y: number },
  size: { width: number; height: number },
  zone: { id: string; x: number; y: number; width: number; height: number },
  padding: number,
): { zoneId: string; x: number; y: number } {
  const within = (value: number, room: number) => Math.max(padding, Math.min(value, room - padding));
  return { zoneId: zone.id, x: within(at.x - zone.x, zone.width - size.width), y: within(at.y - zone.y, zone.height - size.height) };
}

/** What saving `shown` as whether stage board `item` shows Done's cards does: the item and the data it keeps then. */
export function doneShown(item: BoardItem, shown: boolean): { id: string; data: StageBoardData } {
  return { id: item.id, data: { ...stageBoardData(item.data), showDone: shown } };
}

/** The queues in the zones that have a stage board, with when each last changed: what their To do's Later items come from. */
export function stageQueues(nodes: readonly BoardNode[]): { id: string; zoneId: string; updatedAt: string }[] {
  const zones = new Set(nodes.filter(isStageBoard).map((node) => node.parentId));
  return nodes.flatMap((node) => {
    if (!isItemNode(node) || node.data.item.kind !== 'queue' || !zones.has(node.parentId)) return [];
    const { id, zoneId, updatedAt } = node.data.item;
    return zoneId === null ? [] : [{ id, zoneId, updatedAt }];
  });
}

/**
 * Whether `job` is for later at `now`, so a stage board draws it at the foot of To do: open, and marked Later or put off
 * until a time still ahead.
 */
export function isLater(job: QueueJob, now: number): boolean {
  return job.state !== 'done' && job.hiddenUntil !== null && Date.parse(job.hiddenUntil) > now;
}

/**
 * A queue's jobs for later at `now` (`isLater`), by their headline, and the soonest time one put off until a time comes
 * back (null with none): when to read them again. A job marked Later comes back only when moved up, which reads it again.
 */
export function laterJobs(jobs: readonly QueueJob[], now: number): { later: { id: string; text: string }[]; until: number | null } {
  const later = jobs.filter((job) => isLater(job, now));
  const times = later.flatMap((job) => (job.hiddenUntil === null || job.hiddenUntil === QUEUE_LATER ? [] : [Date.parse(job.hiddenUntil)]));
  return { later: later.map((job) => ({ id: job.id, text: jobParts(job.text).headline })), until: times.length === 0 ? null : Math.min(...times) };
}

/** What each stage board draws at the foot of its To do, by zone. */
export type StageLater = ReadonlyMap<string, readonly { id: string; text: string }[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A read of the stage boards' queues (null for one that couldn't be read: it draws nothing, and the next write reads
 * it again): the jobs each zone draws as Later, and how long until they must be read again, just after the soonest
 * comes back. Null when nothing is put off, as only a write changes it then. At most a day off: a timer set further
 * ahead than about 24 days fires at once.
 */
export function laterByZone(reads: readonly ({ zoneId: string; jobs: readonly QueueJob[] } | null)[], now: number): { byZone: Map<string, { id: string; text: string }[]>; wait: number | null } {
  const byZone = new Map<string, { id: string; text: string }[]>();
  let until: number | null = null;
  for (const read of reads) {
    if (read === null) continue;
    const off = laterJobs(read.jobs, now);
    if (off.later.length > 0) byZone.set(read.zoneId, [...(byZone.get(read.zoneId) ?? []), ...off.later]);
    if (off.until !== null) until = until === null ? off.until : Math.min(until, off.until);
  }
  return { byZone, wait: until === null ? null : Math.min(DAY_MS, until - now + 50) };
}

/** Whether two reads draw the same Later cards, so a read that changes nothing keeps the board's nodes as they were. */
export const sameLater = (a: StageLater, b: StageLater): boolean => JSON.stringify([...a]) === JSON.stringify([...b]);

/** A stage heading's count of the tickets that need you: "1 needs you", "2 need you". */
export const needYouLabel = (count: number): string => `${count} ${count === 1 ? 'needs' : 'need'} you`;
