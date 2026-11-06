// The user's own queue ("To look at"): its items, what kind each is, and the Needs-you rows it shows beside them.
// They are never copied into the queue: an agent's request stays in Needs you, and the queue reads it live.
import type { QueueJob } from '@agent-board/daemon/protocol';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { askLine } from '../../master/master-view';
import { KIND_TAGS } from '../../inbox/kind-tags';

/** What an item is, from its link: a pull request, an issue, a document, a page, or a note of its own. */
export interface ItemKind {
  /** On its row's chip: "PR #214", "#12", "doc", "link", "note". */
  chip: string;
  /** At the head of its focus card: "PULL REQUEST #214". */
  head: string;
  /** What opening it does, on its focus card's button. */
  open: string;
}

/** What kind of thing the user's queue item `job` is, from its link. */
export function itemKind(job: Pick<QueueJob, 'link'>): ItemKind {
  const link = job.link;
  if (link === null) return { chip: 'note', head: 'NOTE', open: 'Done' };
  const pull = /\/pulls?\/(\d+)\/?(?:[?#].*)?$/.exec(link);
  if (pull !== null) return { chip: `PR #${pull[1]!}`, head: `PULL REQUEST #${pull[1]!}`, open: 'Open pull request' };
  const issue = /(?:^#|\/issues?\/)([\w-]*\d+)\/?(?:[?#].*)?$/.exec(link);
  if (issue !== null) return { chip: `#${issue[1]!}`, head: `ISSUE #${issue[1]!}`, open: 'Open issue' };
  if (/\.(?:md|markdown|txt|html?)(?:[?#].*)?$/i.test(link)) return { chip: 'doc', head: 'DOCUMENT', open: 'Read it' };
  return { chip: 'link', head: 'LINK', open: 'Open link' };
}

/** The Needs-you rows a user's queue shows: those of its zone's agents, or every one for a queue loose on the board. */
export const needsInScope = (entries: readonly NeedsYouEntry[], zoneId: string | null): NeedsYouEntry[] =>
  zoneId === null ? [...entries] : entries.filter((entry) => entry.agent.zoneId === zoneId);

/** One thing to look at: an agent's request from Needs you, or an item of the queue. */
export type LookItem = { kind: 'needs'; entry: NeedsYouEntry } | { kind: 'job'; job: QueueJob };

/**
 * What the user's queue holds, in the order the focus view goes through it: agents' requests first (they block an
 * agent), oldest first, then its open items in the queue's order. Notes it holds are items too.
 */
export function lookItems(jobs: readonly QueueJob[], needs: readonly NeedsYouEntry[]): LookItem[] {
  return [...needs.map((entry) => ({ kind: 'needs' as const, entry })), ...jobs.filter((job) => job.state !== 'done').map((job) => ({ kind: 'job' as const, job }))];
}

/** How many things to look at: the count the card's face, its folded icon and the Captain's row all show. */
export const lookCount = (openJobs: number, needs: readonly NeedsYouEntry[]): number => openJobs + needs.length;

/** A Needs-you row on the user's queue: its tag ("asks"), and what the agent asks in a line. */
export function needsLine(entry: NeedsYouEntry): { tag: string; line: string } {
  return { tag: KIND_TAGS[entry.kind].label, line: askLine(entry.agent, entry.kind) || `${entry.agent.name} waits for you` };
}

/** The key a look item is known by: an agent's request by its agent and kind, an item by its id. */
export const lookKey = (item: LookItem): string => (item.kind === 'needs' ? `needs:${item.entry.agent.sessionId}:${item.entry.kind}` : item.job.id);
