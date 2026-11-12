import { WORK_CATEGORIES, type Agent, type NeedsYouShows, type WaitingOn, type WorkCategory, type Zone } from '@agent-board/daemon/protocol';
import { WORK_CATEGORY_GROUP, WORK_CATEGORY_LABELS, WORK_GROUP_LABELS, workCategory } from '@agent-board/daemon/work-category';

/** One agent as the Overview shows it: a card in its project's column, in its category's group. */
export interface OverviewThread {
  sessionId: string;
  zoneId: string | null;
  name: string;
  category: WorkCategory;
  /** What its chip says: the agent's own label, or the category's name. */
  chip: string;
  /** Whether the agent (or its orchestrator) set the category, or the board guessed it. */
  source: 'agent' | 'board';
  /** Why the board guessed it, for its tooltip; null for the agent's own. */
  why: string | null;
  /** One line on where it is: its status, else the first line of its last message, else the board's reason for its guess. */
  line: string;
  waitingOn: WaitingOn | null;
  /** Since when it has been in its category, as far as anyone can tell. */
  since: string;
  /** When anything about it last changed: its state, its status or its category. */
  changedAt: string;
  /** Whether it changed since the user last looked. */
  fresh: boolean;
  /** Its PR as `#n`: the open one, else its newest; null without one. */
  pr: string | null;
  /** What a search reads, lower case. */
  haystack: string;
}

/** The Overview's filter: every thread, a group's, or one of On its own's two categories. */
export const OVERVIEW_FILTERS = ['all', 'on-you', 'stuck', 'on-others', 'working', 'done'] as const;
export type OverviewFilter = (typeof OVERVIEW_FILTERS)[number];

/** Each filter's name: its group's, except Stuck, which reads as its one category, Blocked, as the cards in it do. */
export const OVERVIEW_FILTER_LABELS: Record<OverviewFilter, string> = {
  all: 'All',
  'on-you': WORK_GROUP_LABELS['on-you'],
  stuck: WORK_CATEGORY_LABELS.blocked,
  'on-others': WORK_GROUP_LABELS['on-others'],
  working: WORK_CATEGORY_LABELS.working,
  done: WORK_CATEGORY_LABELS.done,
};

/** How each group's threads are ordered. */
export type GroupSort = 'waiting' | 'newest' | 'name';
/** How the columns are ordered: the board's order, which holds still, or most on you first (then the board's order). */
export type ProjectSort = 'board' | 'on-you';

export interface OverviewOptions {
  filter: OverviewFilter;
  query: string;
  groups: GroupSort;
  projects: ProjectSort;
}

export interface OverviewGroup {
  category: WorkCategory;
  threads: OverviewThread[];
  /** How many changed since the last look: for Done's fold, how many finished since. */
  freshCount: number;
}

export interface OverviewColumn {
  /** The zone's id; null for On the board, the agents in no project. */
  id: string | null;
  name: string;
  color: string | null;
  /** Every thread in it, whatever the filter and search. */
  count: number;
  onYou: number;
  onOthers: number;
  groups: OverviewGroup[];
}

/** The column of the agents in no project. */
const LOOSE_COLUMN = 'On the board';

/**
 * Every agent the Overview shows, read for its category (`workCategory`). The master is left out: it is the one the
 * user talks to. So is a reviewer, unless it needs the user or is stuck: its work shows on the agent it reviews.
 */
export function overviewThreads(agents: readonly Agent[], { shows, seenAt }: { shows: NeedsYouShows; seenAt: string }): OverviewThread[] {
  const seen = Date.parse(seenAt);
  const reviewersOf = new Map<string, Agent[]>();
  for (const agent of agents) if (agent.reviewOf !== null) reviewersOf.set(agent.reviewOf, [...(reviewersOf.get(agent.reviewOf) ?? []), agent]);
  const threads: OverviewThread[] = [];
  for (const agent of agents) {
    if (agent.master) continue;
    const reading = workCategory(agent, { shows, reviewers: reviewersOf.get(agent.sessionId) ?? [] });
    if (agent.reviewOf !== null && reading.category !== 'needs-help' && reading.category !== 'blocked') continue;
    const since = reading.since ?? agent.stateSince;
    const changedAt = latest([agent.stateSince, agent.status?.updatedAt, agent.workCategory?.setAt]);
    // Never the board's reason: it is a fragment ("its usage limit"), kept for the tooltip and the card's name.
    const line = agent.status?.summary || firstLine(agent.lastMessage) || '';
    const chip = reading.label ?? WORK_CATEGORY_LABELS[reading.category];
    const open = agent.pullRequests.find((pr) => pr.state === 'open') ?? agent.pullRequests[0];
    const pr = open === undefined ? null : `#${open.number}`;
    const haystack = [agent.name, line, chip, reading.waitingOn?.who, reading.waitingOn?.ref, pr, open?.title].filter(Boolean).join('\n').toLowerCase();
    threads.push({
      sessionId: agent.sessionId,
      zoneId: agent.zoneId,
      name: agent.name,
      category: reading.category,
      chip,
      source: reading.source,
      why: reading.why,
      line,
      waitingOn: reading.waitingOn,
      since,
      changedAt,
      fresh: Date.parse(changedAt) > seen,
      pr,
      haystack,
    });
  }
  return threads;
}

/** Whether a thread is in a filter. */
function inFilter(thread: Pick<OverviewThread, 'category'>, filter: OverviewFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'working' || filter === 'done') return thread.category === filter;
  return WORK_CATEGORY_GROUP[thread.category] === filter;
}

/** How many threads each filter holds. */
export function filterCounts(threads: readonly OverviewThread[]): Record<OverviewFilter, number> {
  const counts = Object.fromEntries(OVERVIEW_FILTERS.map((filter) => [filter, 0])) as Record<OverviewFilter, number>;
  for (const thread of threads) for (const filter of OVERVIEW_FILTERS) if (inFilter(thread, filter)) counts[filter] += 1;
  return counts;
}

/**
 * The Overview's columns: one per project with threads, then On the board for the threads in no project, each with its
 * threads grouped by category in the seven's order and sorted. The filter and search leave out threads, and a column
 * left with none; its counts stay those of all its threads.
 */
export function overviewColumns(threads: readonly OverviewThread[], zones: readonly Zone[], options: OverviewOptions): OverviewColumn[] {
  const query = options.query.trim().toLowerCase();
  const known = new Map(zones.map((zone) => [zone.id, zone]));
  const byZone = new Map<string | null, OverviewThread[]>();
  for (const thread of threads) {
    const key = thread.zoneId !== null && known.has(thread.zoneId) ? thread.zoneId : null;
    byZone.set(key, [...(byZone.get(key) ?? []), thread]);
  }
  const boardOrder = [...zones].sort((a, b) => a.y - b.y || a.x - b.x);
  const columns: OverviewColumn[] = [];
  for (const zone of [...boardOrder, null]) {
    const all = byZone.get(zone?.id ?? null);
    if (all === undefined) continue;
    const shown = all.filter((thread) => inFilter(thread, options.filter) && (query === '' || thread.haystack.includes(query)));
    if (shown.length === 0) continue;
    columns.push({
      id: zone?.id ?? null,
      name: zone?.name ?? LOOSE_COLUMN,
      color: zone?.color ?? null,
      count: all.length,
      onYou: all.filter((thread) => WORK_CATEGORY_GROUP[thread.category] === 'on-you').length,
      onOthers: all.filter((thread) => WORK_CATEGORY_GROUP[thread.category] === 'on-others').length,
      groups: WORK_CATEGORIES.flatMap((category) => {
        const inGroup = shown.filter((thread) => thread.category === category);
        if (inGroup.length === 0) return [];
        return [{ category, threads: inGroup.sort(GROUP_SORTS[options.groups]), freshCount: inGroup.filter((thread) => thread.fresh).length }];
      }),
    });
  }
  if (options.projects === 'on-you') {
    // The loose column stays last; a stable sort keeps the board's order among equals.
    const loose = columns.at(-1)?.id === null ? columns.pop() : undefined;
    columns.sort((a, b) => b.onYou - a.onYou);
    if (loose !== undefined) columns.push(loose);
  }
  return columns;
}

const GROUP_SORTS: Record<GroupSort, (a: OverviewThread, b: OverviewThread) => number> = {
  waiting: (a, b) => Date.parse(a.since) - Date.parse(b.since) || byName(a, b),
  newest: (a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt) || byName(a, b),
  name: (a, b) => byName(a, b),
};

const byName = (a: OverviewThread, b: OverviewThread) => a.name.localeCompare(b.name, undefined, { numeric: true });

const DAY = 24 * 60 * 60 * 1000;

/** How long a thread has waited: when it began under a day (`when`), else whole days, which read as old. */
export function ageText(since: string, now: Date): { text: string; old: boolean } {
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return { text: '', old: false };
  const days = Math.floor((now.getTime() - at.getTime()) / DAY);
  return days >= 1 ? { text: `${days} d`, old: true } : { text: when(at, now), old: false };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A moment as the user would say it, from `now`: `HH:MM` today, `yesterday HH:MM`, the weekday and time within the
 * week, else the day and month. In the user's time zone.
 */
export function when(at: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return clock(at);
  if (days === 1) return `yesterday ${clock(at)}`;
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${clock(at)}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** A time as `HH:MM`, in the user's time zone. */
function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** Who a thread waits on, short: the first letters of up to three words, or a single word's first three. */
export function initials(who: string): string {
  const words = who.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function firstLine(text: string | null): string {
  return text?.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

function latest(times: readonly (string | null | undefined)[]): string {
  let best = '';
  for (const time of times) if (time && (best === '' || Date.parse(time) > Date.parse(best))) best = time;
  return best;
}
