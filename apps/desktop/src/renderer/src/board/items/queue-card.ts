// What a queue card shows, worked out from its data and jobs: kept apart from React, so it is tested on its own.
import { isPutOff, isQueueWork, type QueueAudience, type QueueData, type QueueJob, type QueueJobChange } from '@agent-board/daemon/protocol';
import { whoText } from './list-card-text';

/** How many done jobs the peek shows, under the open ones. */
export const DONE_SHOWN = 5;

/** A queue card's data as saved, with what an older card lacks filled in. */
export function queueData(data: Record<string, unknown>): QueueData {
  const saved = data as Partial<QueueData>;
  return {
    title: typeof saved.title === 'string' && saved.title !== '' ? saved.title : 'Jobs',
    madeBy: saved.madeBy ?? { kind: 'user' },
    audience: saved.audience === 'user' ? 'user' : 'agents',
    noAgents: saved.noAgents === true,
    count: typeof saved.count === 'number' ? saved.count : 0,
    folded: saved.folded === true,
    ...(saved.drain === undefined ? {} : { drain: saved.drain }),
  };
}

/** A queue's name for its audience: "api jobs" (or "Jobs") for agents, "To look at" for the user. */
export function queueTitle(audience: QueueAudience, zoneName?: string): string {
  if (audience === 'user') return 'To look at';
  return zoneName === undefined ? 'Jobs' : `${zoneName} jobs`;
}

/** A new queue the user makes, for agents, named after the zone it lands in. */
export function newQueueData(zoneName?: string): QueueData {
  return { title: queueTitle('agents', zoneName), madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
}

/** The time now, as the jobs' times are written: what `isPutOff` compares them with. */
const nowText = (): string => new Date().toISOString();

/** Whether a row is put off at `now`: marked Later, or put off until a time still ahead. */
export const isLaterRow = (job: QueueJob, now = nowText()): boolean => isPutOff(job, now);

/** Whether a row can be handed to an agent: a waiting job of a queue for agents, not marked Later. */
export const handable = (job: QueueJob, audience: QueueAudience) => audience === 'agents' && isQueueWork(job.kind) && job.state === 'queued' && !isLaterRow(job);

/** Whether a row can be marked Later: a waiting job, not yet put off. */
export const puttable = (job: QueueJob) => isQueueWork(job.kind) && job.state === 'queued' && !isLaterRow(job);

/**
 * The open rows in the order the card lists them: those taken first, then those waiting in their queue's order, then
 * those marked Later (or put off until a time), at its foot.
 */
export function openInCardOrder(jobs: readonly QueueJob[], now = nowText()): QueueJob[] {
  const open = jobs.filter((job) => job.state !== 'done');
  const later = open.filter((job) => job.state === 'queued' && isPutOff(job, now));
  const waiting = open.filter((job) => job.state === 'queued' && !isPutOff(job, now));
  return [...open.filter((job) => job.state === 'taken'), ...waiting, ...later];
}

/**
 * Where ⌥↑ or ⌥↓ puts a waiting row among `open` (the rows in their queue's order): just before the row it passes, or
 * last (null); undefined when it is at that end already.
 */
export function moveTarget(open: readonly QueueJob[], job: QueueJob, by: -1 | 1): { before: QueueJob | null } | undefined {
  const at = open.findIndex((each) => each.id === job.id);
  if (at < 0 || at + by < 0 || at + by >= open.length) return undefined;
  return { before: by < 0 ? open[at - 1]! : (open[at + 2] ?? null) };
}

/** The done jobs, newest first, as the daemon lists them. */
export const doneJobs = (jobs: readonly QueueJob[]): QueueJob[] => jobs.filter((job) => job.state === 'done');

/** The job an agent's `queue take` takes next: the first waiting job (not info, nor one marked Later) in the queue's order. */
export function nextJob(jobs: readonly QueueJob[], now = nowText()): QueueJob | undefined {
  return jobs.find((job) => isQueueWork(job.kind) && job.state === 'queued' && !isPutOff(job, now));
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** The tone of a row's state chip, which its CSS colours. */
export type JobTone = 'queued' | 'next' | 'taken' | 'back' | 'done' | 'note' | 'later';

/**
 * A row's state chip: "taken", "next" (what `take` takes), "queued", "later" (marked Later, or put off until a time), a
 * note's "note", "done". A job dropped back (by its
 * taker, or as its taker's session ended) has the dashed "back" look, and its corner says which try comes next.
 */
export function jobState(job: QueueJob, next: QueueJob | undefined): { text: string; tone: JobTone } {
  if (!isQueueWork(job.kind)) return { text: 'note', tone: 'note' };
  if (job.state === 'done') return { text: 'done', tone: 'done' };
  if (job.state === 'taken') return { text: 'taken', tone: 'taken' };
  if (isPutOff(job, nowText())) return { text: 'later', tone: 'later' };
  const tone = job.id === next?.id ? 'next' : 'queued';
  return { text: tone, tone: job.drops > 0 ? 'back' : tone };
}

/** A link said short: an issue or pull request by its number ("#12"), else its last part. */
export function linkText(link: string): string {
  const number = /(?:^#|\/(?:issues|pull|pulls)\/)(\d+)\/?$/.exec(link);
  if (number !== null) return `#${number[1]!}`;
  const parts = link.replace(/[?#].*$/, '').split('/').filter((part) => part !== '');
  return parts.at(-1) ?? link;
}

/**
 * What a row's corner says: its taker while taken, who finished it once done, else its link and, for a job dropped back,
 * the try that comes next ("#12 · 2nd try"), else the agent that queued it. The user's own rows say nothing there: they
 * are the card's default.
 */
export function jobCorner(job: QueueJob): string {
  if (job.state === 'taken' && job.takenBy !== null) return whoText(job.takenBy);
  if (job.state === 'done' && job.doneBy !== null) return whoText(job.doneBy);
  const said = job.link !== null ? linkText(job.link) : job.madeBy.kind === 'agent' ? whoText(job.madeBy) : '';
  const tried = job.state === 'queued' && job.drops > 0 ? `${ordinal(job.drops + 1)} try` : '';
  return [said, tried].filter((part) => part !== '').join(' · ');
}

/** A job's text on one line. */
export const jobLine = (job: Pick<QueueJob, 'text'>): string => job.text.replace(/\s+/g, ' ').trim();

/** The card's counts: "2 queued · 1 taken · 1 later · 3 done", with notes their own ("3 to look at", in the user's); "No jobs yet" for none. */
export function countsText(jobs: readonly QueueJob[], audience: QueueAudience = 'agents'): string {
  const of = (match: (job: QueueJob) => boolean) => jobs.filter(match).length;
  const now = nowText();
  const parts = [
    [of((job) => isQueueWork(job.kind) && job.state === 'queued' && !isPutOff(job, now)), audience === 'user' ? 'to look at' : 'queued'],
    [of((job) => job.state === 'taken'), 'taken'],
    [of((job) => isQueueWork(job.kind) && isPutOff(job, now)), 'later'],
    [of((job) => !isQueueWork(job.kind)), 'note'],
    [of((job) => job.state === 'done'), 'done'],
  ] as const;
  const said = parts.filter(([count]) => count > 0).map(([count, what]) => (what === 'note' ? `${count} note${count === 1 ? '' : 's'}` : `${count} ${what}`));
  return said.length === 0 ? 'No jobs yet' : said.join(' · ');
}

/** Those of `jobs` whose text or link holds every word of `search`, any case. */
export function matchingJobs(jobs: readonly QueueJob[], search: string): QueueJob[] {
  const words = search.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...jobs];
  return jobs.filter((job) => {
    const text = `${job.text} ${job.link ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * The row an agent changed since `seen` (an `updatedAt`), for the card to flash: the newest change, when an agent made
 * it. A move changes no `updatedAt`, so it doesn't flash.
 */
export function freshJob(jobs: readonly QueueJob[], seen: string | undefined): QueueJob | undefined {
  if (seen === undefined) return undefined;
  const newest = jobs.reduce<QueueJob | undefined>((best, job) => (best === undefined || job.updatedAt > best.updatedAt ? job : best), undefined);
  return newest !== undefined && newest.updatedAt > seen && newest.changedBy.kind === 'agent' ? newest : undefined;
}

/** The newest `updatedAt` of `jobs`, or undefined for none. */
export function newestChange(jobs: readonly QueueJob[]): string | undefined {
  return jobs.reduce<string | undefined>((best, job) => (best === undefined || job.updatedAt > best ? job.updatedAt : best), undefined);
}

const VERBS: Record<QueueJobChange, string> = { add: 'queued', edit: 'changed', take: 'took', drop: 'put back', done: 'finished', restore: 'put back' };

/** Who last changed a row, and how, for the folded icon to say: "impl-2 took Fix the login", "impl-2 put back Docs". */
export function agentLine(job: QueueJob): string {
  return `${whoText(job.changedBy)} ${VERBS[job.lastChange]} ${jobLine(job)}`;
}
