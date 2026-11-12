// Park a thought: a line typed from anywhere in the app goes to the back of the user's own queue, as something for them
// to look at later. Kept apart from React, so which queue it lands in, and the one made when there is none, are tested.
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { QUEUE_CARD_SIZE, type BoardItem, type QueueData } from '@agent-board/daemon/protocol';
import type { AgentsApi, ItemsApi, ShellsApi, ZonesApi } from '../../../preload/api';
import { newQueueData, queueData, queueTitle } from '../board/items/queue-card';

/** The calls parking makes: read what is on the board, make a queue, add a line to one, and take it back. */
export interface ParkApi {
  items: Pick<ItemsApi, 'list' | 'create' | 'changeQueue' | 'delete' | 'readQueue'>;
  zones: Pick<ZonesApi, 'list'>;
  agents: Pick<AgentsApi, 'list'>;
  shells: Pick<ShellsApi, 'list'>;
}

/** A parked line: the queue it went to, whether that queue was made for it, and the line's own id there. */
export interface Parked {
  queueId: string;
  made: boolean;
  jobId: string | null;
}

/** How far right of everything on the board a queue made for parking goes. */
const PARK_GAP = 80;

/** The line to park: what was typed, trimmed; null for an empty or blank one, which parks nothing. */
export function parkLine(typed: string): string | null {
  const line = typed.trim();
  return line === '' ? null : line;
}

/** The user's queue a thought goes to: their loose one (the whole board's) first, else the first of theirs in a zone. */
export function parkQueue(items: readonly BoardItem[]): BoardItem | undefined {
  const theirs = items.filter((item) => item.kind === 'queue' && queueData(item.data).audience === 'user');
  return theirs.find((item) => item.zoneId === null) ?? theirs[0];
}

/**
 * Parks `line` at the back of the user's queue, as one of their jobs to look at. With no queue of theirs yet, it first
 * makes a loose "To look at" one, right of everything on the board: zones, loose items, and loose agent and shell tiles.
 */
export async function parkThought(api: ParkApi, line: string): Promise<Parked> {
  const items = await api.items.list();
  let queue = parkQueue(items);
  const made = queue === undefined;
  if (queue === undefined) {
    const [zones, agents, shells] = await Promise.all([api.zones.list(), api.agents.list(), api.shells.list()]);
    // What is in a zone is placed relative to it, and inside it: the zone's own edge stands for it.
    const tiles = [...agents, ...shells.filter((shell) => shell.owner === null)].flatMap((tile) => (tile.zoneId === null && tile.position !== null ? [{ x: tile.position.x, width: AGENT_TILE_SIZE.width }] : []));
    const boxes = [...items.filter((item) => item.zoneId === null), ...zones, ...tiles];
    const right = Math.max(0, ...boxes.map((box) => box.x + box.width));
    const data: QueueData = { ...newQueueData(), title: queueTitle('user'), audience: 'user' };
    queue = await api.items.create({ kind: 'queue', zoneId: null, x: right + PARK_GAP, y: 0, ...QUEUE_CARD_SIZE, data: { ...data } });
  }
  const { job } = await api.items.changeQueue(queue.id, { action: 'add', kind: 'backlog', text: line });
  return { queueId: queue.id, made, jobId: job?.id ?? null };
}

/**
 * Takes a parked line back: the line, and the queue too when it was made for it and holds nothing else yet. A queue that
 * has had other lines added since keeps them, and loses only this one.
 */
export async function unpark(api: ParkApi, parked: Parked): Promise<void> {
  if (parked.made) {
    const { jobs } = await api.items.readQueue(parked.queueId);
    if (jobs.every((job) => job.id === parked.jobId)) return api.items.delete(parked.queueId);
  }
  if (parked.jobId !== null) await api.items.changeQueue(parked.queueId, { action: 'remove', job: parked.jobId });
}

/** The window event that asks this window's Park a thought field to open, as ⌘⇧P does: ⌘K's action sends it. */
const PARK_EVENT = 'agent-board:park-thought';

/** Opens the Park a thought field; `restore` gives the focus back to what had it once the field closes. */
export function openParkThought(restore: () => void): void {
  window.dispatchEvent(new CustomEvent(PARK_EVENT, { detail: { restore } }));
}

/** Calls `listener` whenever the field is asked to open. Returns the unsubscribe function. */
export function onParkThought(listener: (restore: () => void) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<{ restore: () => void }>).detail.restore);
  window.addEventListener(PARK_EVENT, handle);
  return () => window.removeEventListener(PARK_EVENT, handle);
}
