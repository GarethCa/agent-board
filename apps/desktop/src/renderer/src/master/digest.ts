// "Since you last looked" (the Simplified pane's digest): what the app saw agents finish since the user last had the
// Needs-you list in view, and the Captain's own line on what comes next. Derived from the agents, never stored but
// for the moment of the last look.
import { statusLine, type Agent, type NeedsYouShows } from '@agent-board/daemon/protocol';
import { clockTime } from '../board/items/agent-note';
import { boardMaster } from './master-view';
import { needsYouEntries } from '../../../shared/needs-you';

/** The most finished agents the digest lists; the rest are counted. */
export const MAX_DONE_ROWS = 5;

/** An agent that said its work is finished since the last look. */
export interface DoneEntry {
  agent: Agent;
  finishedAt: string;
  /** What it said it did, when its status line was set as it finished; null says only that it finished. */
  summary: string | null;
}

export interface Digest {
  /** Oldest first, as the Needs-you list is. */
  done: DoneEntry[];
  /** The Captain's status line, when it set one since the last look. */
  upNext: { text: string; at: string } | null;
}

const after = (iso: string, since: number): boolean => {
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > since;
};

/**
 * What changed since `since` (epoch ms). Done is the agents (not the Captain) that said their work is finished
 * (`workFinishedAt`) after it, and have no ask open (a question, plan, permission or flag): those are in the list above, never here. A turn ended is not an ask, so an agent waiting at its prompt can be Done.
 * Up next is the Captain's status line when it wrote it after `since`, and only while the Captain is live: nothing
 * is made up, and a line written before the user last looked has been seen.
 */
export function sinceLastLooked(agents: readonly Agent[], since: number, asking: ReadonlySet<string>): Digest {
  const done = agents
    .filter((agent) => !agent.master && agent.workFinishedAt !== null && after(agent.workFinishedAt, since) && !asking.has(agent.sessionId))
    .map((agent): DoneEntry => {
      const finishedAt = agent.workFinishedAt!;
      // A status set as it finished says what it did; one from earlier in its work does not.
      const summary = agent.status !== null && Date.parse(agent.status.updatedAt) >= Date.parse(finishedAt) ? agent.status.summary : null;
      return { agent, finishedAt, summary };
    })
    .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  const captain = boardMaster(agents);
  const status = captain?.endedAt === null ? captain.status : null;
  const upNext = status && status.summary.trim() !== '' && after(status.updatedAt, since) ? { text: statusLine(status), at: status.updatedAt } : null;
  return { done, upNext };
}

export const isEmptyDigest = (digest: Digest): boolean => digest.done.length === 0 && digest.upNext === null;

/** When the user last looked: the time of day, and the day too when it was not today. */
export function lookedAt(since: number, now: number = Date.now()): string {
  const time = clockTime(new Date(since).toISOString());
  if (new Date(since).toDateString() === new Date(now).toDateString()) return time;
  return `${new Date(since).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * The agents with a real ask open (a question, plan, permission or flag), which the list above holds and Done leaves
 * out. A turn ended is no ask: under "every agent waiting" a finished agent at its prompt is in the list as one, and
 * is still Done.
 */
export const askingIds = (agents: readonly Agent[], shows: NeedsYouShows): Set<string> =>
  new Set(needsYouEntries(agents, shows).filter((entry) => entry.kind !== 'turn').map((entry) => entry.agent.sessionId));
