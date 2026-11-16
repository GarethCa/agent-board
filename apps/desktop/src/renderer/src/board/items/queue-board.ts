// What a queue reads from the board around it: the live agents (for the user's queue's Needs-you rows, and who can be
// handed a job), how to open an agent or a link; which user's queue is going through its things in its tile; and Hand
// on, mounted once beside the board.
import { createContext, useSyncExternalStore } from 'react';
import { takesHandOn, type Agent } from '@agent-board/daemon/protocol';
import { FIRST_PLACE, type GoThroughPlace } from './go-through';

export interface QueueBoard {
  agents: readonly Agent[];
  openAgent(agent: Agent): void;
  openLink(url: string): void;
}

export const QueueBoardContext = createContext<QueueBoard>({ agents: [], openAgent: () => {}, openLink: () => {} });

/** A value any component sets and the board's views read live. */
function shared<T>() {
  let value: T | undefined;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    set(next: T | undefined) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    get: () => value,
    // The same value read on the server: tiles are rendered to strings in tests.
    use: () => useSyncExternalStore(subscribe, () => value, () => value),
  };
}

/**
 * The user's queue going through its things in its tile: which queue, the thing it shows, and which start this is. It
 * lives here, not in the tile, as the board stops drawing a tile off screen: panned back, the tile shows the same thing.
 */
export interface GoingThrough {
  queueId: string;
  place: GoThroughPlace;
  /** New each time it is started, so the tile takes the focus again. */
  start: number;
}

const going = shared<GoingThrough>();
let starts = 0;

/** Has the user's queue `queueId` go through its things one at a time, in its own tile, from the first: from its card, its peek, or the Captain's For you. */
export const goThrough = (queueId: string): void => going.set({ queueId, place: FIRST_PLACE, start: ++starts });
/** Shows another thing, if `queueId` is the queue going through. */
export function moveGoingThrough(queueId: string, place: GoThroughPlace): void {
  const now = going.get();
  if (now?.queueId === queueId) going.set({ ...now, place });
}
/** Back to its list: ← Back, or once nothing is left. */
export const stopGoingThrough = (): void => going.set(undefined);
/** Stops going through unless its queue is one of `userQueueIds`: gone from the board, or no longer the user's, it stops. */
export function stopGoingThroughUnless(userQueueIds: readonly string[]): void {
  const now = going.get();
  if (now !== undefined && !userQueueIds.includes(now.queueId)) going.set(undefined);
}
/** The queue going through its things in its tile, and where it is, if one is. */
export const useGoingThrough = (): GoingThrough | undefined => going.use();
/** The same, read once, outside a component. */
export const readGoingThrough = (): GoingThrough | undefined => going.get();
/** The queue going through, read once: as a key is pressed. */
export const goingThroughNow = (): string | undefined => going.get()?.queueId;

/** What is dragged when a job's row is: the queue and the job, for a tile to take. */
export const JOB_DRAG = 'application/x-agent-board-job';

/** Whether a job of a queue in `zoneId` (null: loose on the board) can be handed to `agent`: one in its scope, and idle. */
export const inHandScope = (agent: Agent, zoneId: string | null): boolean => agent.endedAt === null && (zoneId === null || agent.zoneId === zoneId);
export const takesJobFrom = (agent: Agent, zoneId: string | null): boolean => inHandScope(agent, zoneId) && takesHandOn(agent);

/** The job being dragged, and its queue's zone: a drag's data can't be read until it is dropped, so it is kept here. */
let dragged: { queueId: string; jobId: string; zoneId: string | null } | undefined;
export const startJobDrag = (job: typeof dragged): void => {
  dragged = job;
};
export const draggedJob = () => dragged;

const jobDropOver = shared<string>();
/** The agent tile a dragged job would land on now, lit as a drop for it: only an idle one in scope. */
export const setJobDropOver = (sessionId: string | undefined): void => jobDropOver.set(sessionId);
export const useJobDropOver = (): string | undefined => jobDropOver.use();

/** A job to hand on: its queue, the job, and the agent it was dropped on, if it was. */
export interface HandOnTarget {
  queueId: string;
  jobId: string;
  sessionId?: string;
}

const handing = shared<HandOnTarget>();

const draining = shared<string>();

/** Opens the drain sheet of the queue `queueId` (Start agents to take jobs), or closes it. */
export const openDrain = (queueId: string | undefined): void => draining.set(queueId);
/** The queue whose drain sheet is open, if one is. */
export const useDrainSheet = (): string | undefined => draining.use();

/** Opens Hand on for a job (from its row's button, or its row dropped on an agent's tile), or closes it. */
export const openHandOn = (target: HandOnTarget | undefined): void => handing.set(target);
/** The job being handed on, if one is. */
export const useHandOn = (): HandOnTarget | undefined => handing.use();
