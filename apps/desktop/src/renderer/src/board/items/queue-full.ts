// What a queue's full screen shows, worked out from its jobs: its groups, what its search and chips leave, the row
// after the one picked, its keys, and who did what to a job and when. Kept apart from React, so it is tested on its own.
import { isPutOff, isQueueWork, queueKindOn, type USER_QUEUE_KINDS, type HistoryVersion, type QueueAudience, type QueueJob } from '@agent-board/daemon/protocol';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { needsLine } from './to-look-at';
import { whenText, whoText } from './memory-card';
import { handable, isLaterRow, matchingJobs, moveTarget, ordinal, puttable } from './queue-card';

/** The groups a full screen lists: the user's queue by kind, an agents' queue by state. */
export type FullGroupId = 'needs' | (typeof USER_QUEUE_KINDS)[number] | 'taken' | 'waiting' | 'later' | 'done';

/** One row of the list: an agent's request (on the user's queue), or a job, with its place in line while it waits. */
export type FullRow = { kind: 'needs'; key: string; entry: NeedsYouEntry } | { kind: 'job'; key: string; job: QueueJob; place?: number };

export interface FullGroup {
  id: FullGroupId;
  label: string;
  rows: FullRow[];
}

/** The user's kinds in the order the list groups them. */
const KIND_GROUPS = [
  ['review', 'Review'],
  ['questions', 'Questions'],
  ['read', 'Read'],
  ['backlog', 'Backlog'],
] as const satisfies readonly (readonly [(typeof USER_QUEUE_KINDS)[number], string])[];

/** The key a request is known by in the list. */
const needsKey = (entry: NeedsYouEntry) => `needs:${entry.agent.sessionId}:${entry.kind}`;
const jobRow = (job: QueueJob, place?: number): FullRow => ({ kind: 'job', key: job.id, job, ...(place === undefined ? {} : { place }) });

/**
 * A queue's rows in their groups, those with none left out. The user's: what agents ask, then one group a kind, then
 * those marked Later and what was done today. An agents': taken, waiting in order (its jobs numbered, its notes not),
 * marked Later, and done.
 */
export function fullGroups(jobs: readonly QueueJob[], needs: readonly NeedsYouEntry[], audience: QueueAudience, now: Date): FullGroup[] {
  const at = now.toISOString();
  const open = jobs.filter((job) => job.state !== 'done');
  const later = open.filter((job) => job.state === 'queued' && isPutOff(job, at));
  const done = jobs.filter((job) => job.state === 'done');
  const groups: FullGroup[] =
    audience === 'user'
      ? [
          { id: 'needs', label: 'Agents ask you', rows: needs.map((entry) => ({ kind: 'needs', key: needsKey(entry), entry })) },
          ...KIND_GROUPS.map(([kind, label]) => ({
            id: kind,
            label,
            rows: open.filter((job) => !later.includes(job) && queueKindOn('user', job.kind) === kind).map((job) => jobRow(job)),
          })),
          { id: 'later', label: 'Later', rows: later.map((job) => jobRow(job)) },
          { id: 'done', label: 'Done today', rows: done.filter((job) => job.doneAt !== null && new Date(job.doneAt).toDateString() === now.toDateString()).map((job) => jobRow(job)) },
        ]
      : [
          { id: 'taken', label: 'Taken', rows: open.filter((job) => job.state === 'taken').map((job) => jobRow(job)) },
          { id: 'waiting', label: 'Waiting, in order', rows: numbered(open.filter((job) => job.state === 'queued' && !later.includes(job))) },
          { id: 'later', label: 'Later', rows: later.map((job) => jobRow(job)) },
          { id: 'done', label: 'Done', rows: done.map((job) => jobRow(job)) },
        ];
  return groups.filter((group) => group.rows.length > 0);
}

/** Waiting rows with their place in line: the jobs counted from 1, the notes among them unnumbered. */
function numbered(waiting: QueueJob[]): FullRow[] {
  let place = 0;
  return waiting.map((job) => (isQueueWork(job.kind) ? jobRow(job, ++place) : jobRow(job)));
}

/** What the list leaves: rows matching every word of the search, in the chip's group alone when one is on. */
export interface FullFilter {
  search: string;
  group: FullGroupId | null;
}

export const NO_FILTER: FullFilter = { search: '', group: null };

/** The groups as the search and the chip leave them. */
export function shownGroups(groups: readonly FullGroup[], filter: FullFilter): FullGroup[] {
  // A chip whose group has emptied (its last row done, or answered) filters nothing, so the list never strands empty.
  const only = groups.some((group) => group.id === filter.group) ? filter.group : null;
  return groups
    .filter((group) => only === null || group.id === only)
    .map((group) => ({ ...group, rows: group.rows.filter((row) => matches(row, filter.search)) }))
    .filter((group) => group.rows.length > 0);
}

function matches(row: FullRow, search: string): boolean {
  if (row.kind === 'job') return matchingJobs([row.job], search).length === 1;
  const words = search.toLowerCase().split(/\s+/).filter((word) => word !== '');
  const text = `${row.entry.agent.name} ${needsLine(row.entry).line}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The rows in the order the list draws them. */
export const rowsOf = (groups: readonly FullGroup[]): FullRow[] => groups.flatMap((group) => group.rows);

/** The row ↑ or ↓ goes to from `key` (the first row, from none), staying at either end. */
export function rowBy(rows: readonly FullRow[], key: string | undefined, by: -1 | 1): FullRow | undefined {
  const at = rows.findIndex((row) => row.key === key);
  if (at < 0) return rows[0];
  return rows[Math.min(rows.length - 1, Math.max(0, at + by))];
}

/** What Next ▸ steps to: the first row after `key` still to do (not done), if there is one. */
export function nextRow(rows: readonly FullRow[], key: string | undefined): FullRow | undefined {
  const at = rows.findIndex((row) => row.key === key);
  return rows.slice(at + 1).find((row) => row.kind === 'needs' || row.job.state !== 'done');
}

/** What a key does on the full screen, out of a field: move, reorder, finish, mark Later, hand on, edit, add, search. */
export type FullKey = 'up' | 'down' | 'raise' | 'lower' | 'done' | 'later' | 'hand' | 'edit' | 'add' | 'search';

export function fullKey(event: { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): FullKey | undefined {
  if (event.metaKey || event.ctrlKey) return undefined;
  if (event.key === 'ArrowUp') return event.altKey ? 'raise' : 'up';
  if (event.key === 'ArrowDown') return event.altKey ? 'lower' : 'down';
  if (event.altKey) return undefined;
  const keys: Record<string, FullKey> = { d: 'done', l: 'later', h: 'hand', e: 'edit', n: 'add', '/': 'search' };
  return keys[event.key.toLowerCase()];
}

/** What a key does to the picked row's job: move it before another (null: to the end), finish it, mark it Later or move it back up, hand it on, or edit it. */
export type FullAction = { op: 'move'; job: QueueJob; before: QueueJob | null } | { op: 'done' | 'later' | 'back' | 'hand' | 'edit'; job: QueueJob };

/**
 * The action a key takes on the picked row, or none when it can't: ⌥↑⌥↓ move a waiting job among the rows of its own
 * group, as the list shows them, never past its group's ends.
 */
export function fullAction(key: FullKey, row: FullRow | undefined, groups: readonly FullGroup[], audience: QueueAudience, can: { hand: boolean; later: boolean }): FullAction | undefined {
  if (row?.kind !== 'job') return undefined;
  const { job } = row;
  if (key === 'raise' || key === 'lower') {
    if (job.state !== 'queued' || isLaterRow(job)) return undefined;
    const line = groups.find((group) => group.rows.some((each) => each.key === row.key))?.rows.flatMap((each) => (each.kind === 'job' ? [each.job] : [])) ?? [];
    const target = moveTarget(line, job, key === 'raise' ? -1 : 1);
    return target === undefined ? undefined : { op: 'move', job, before: target.before };
  }
  if (key === 'done') return isQueueWork(job.kind) && job.state !== 'done' ? { op: 'done', job } : undefined;
  if (key === 'later' && can.later) return puttable(job) ? { op: 'later', job } : job.state === 'queued' && isLaterRow(job) ? { op: 'back', job } : undefined;
  if (key === 'hand') return can.hand && handable(job, audience) ? { op: 'hand', job } : undefined;
  if (key === 'edit') return { op: 'edit', job };
  return undefined;
}

/** One line of "Who and when": who did what, and when. */
export interface WhoWhenLine {
  who: string;
  what: string;
  at: string;
}

/**
 * Who did what to a job and when, oldest first: from its history when it is read, else from what the job holds (who
 * queued it, its taker, who finished it, its last change).
 */
export function whoWhen(job: QueueJob, versions?: readonly HistoryVersion<QueueJob>[]): WhoWhenLine[] {
  if (versions !== undefined && versions.length > 0)
    return [...versions].reverse().map((version, index, all) => ({ who: whoText(version.by), what: whatHappened(version, all[index - 1]?.value ?? null), at: version.at }));
  const lines: WhoWhenLine[] = [{ who: whoText(job.madeBy), what: 'queued it', at: job.createdAt }];
  if (job.takenBy !== null && job.takenAt !== null) lines.push({ who: whoText(job.takenBy), what: 'took it', at: job.takenAt });
  if (job.doneAt !== null) lines.push({ who: job.doneBy === null ? 'someone' : whoText(job.doneBy), what: 'finished it', at: job.doneAt });
  const last = whatHappened({ action: job.lastChange, value: job }, null);
  if (job.updatedAt > (lines.at(-1)?.at ?? '') && !['add', 'take', 'done'].includes(job.lastChange)) lines.push({ who: whoText(job.changedBy), what: last, at: job.updatedAt });
  return lines.sort((one, other) => one.at.localeCompare(other.at));
}

function whatHappened({ action, value }: Pick<HistoryVersion<QueueJob>, 'action' | 'value'>, before: QueueJob | null): string {
  if (action === 'add') return 'queued it';
  if (action === 'take') return 'took it';
  if (action === 'drop') return 'put it back in line';
  if (action === 'done') return 'finished it';
  if (action === 'restore') return 'put it back';
  if (action === 'remove') return 'removed it';
  if (value !== null && before !== null && value.text !== before.text) return 'changed the text';
  if (value !== null && before !== null && value.link !== before.link) return 'changed the link';
  if (value !== null && before !== null && value.hiddenUntil !== before.hiddenUntil) return value.hiddenUntil === null ? 'moved it up from Later' : 'marked it Later';
  return 'changed it';
}

/** What the picked job's head says beside its chip: where it stands, and for whom. */
export function standing(job: QueueJob, place: number | undefined, audience: QueueAudience, now: Date): string {
  if (!isQueueWork(job.kind)) return 'a note: read, never taken';
  if (job.state === 'done') return job.doneAt === null ? 'done' : `finished ${whenText(job.doneAt, now)}`;
  if (job.state === 'taken') return job.takenBy === null ? 'taken' : `${whoText(job.takenBy)} took it${job.takenAt === null ? '' : ` · ${whenText(job.takenAt, now)}`}`;
  if (isPutOff(job, now.toISOString())) return 'waits till you move it up';
  if (audience === 'user') return 'yours: no agent takes it';
  return place === undefined ? 'waiting' : place === 1 ? 'next: the first an agent takes' : `${ordinal(place)} in line`;
}

/** An agents' queue's head: what is left to do, waiting and taken; its chips carry the rest. */
export function headCount(jobs: readonly QueueJob[], now: Date): string {
  if (jobs.length === 0) return 'No jobs yet';
  const at = now.toISOString();
  const waiting = jobs.filter((job) => job.state === 'queued' && isQueueWork(job.kind) && !isPutOff(job, at)).length;
  const taken = jobs.filter((job) => job.state === 'taken').length;
  if (waiting + taken === 0) return 'Nothing waiting';
  return [waiting > 0 && `${waiting} waiting`, taken > 0 && `${taken} taken`].filter(Boolean).join(' · ');
}

/** Where a row of the user's queue is among what is still to look at, in list order: "2 of 7 to look at". */
export function lookPlace(groups: readonly FullGroup[], key: string, total: number): string | undefined {
  const at = rowsOf(groups)
    .filter((row) => row.kind === 'needs' || row.job.state !== 'done')
    .findIndex((row) => row.key === key);
  return at < 0 ? undefined : `${at + 1} of ${total} to look at`;
}
