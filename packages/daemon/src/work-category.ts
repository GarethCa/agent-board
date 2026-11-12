// An agent's work category (ADR-0024): what kind of wait its work is in, for the overview's groups. The agent sets its
// own (`board.setStatus` with `category`); when it hasn't, the board guesses one from what it can see.

import { asksInWords, HUMAN_STATUS_BY_STATE, type HumanStatusFacts } from './human-status.ts';
import {
  MAX_WAITING_ON_LENGTH,
  MAX_WORK_LABEL_LENGTH,
  WORK_CATEGORIES,
  needsYouKind,
  permissionPrompt,
  questionPrompt,
  type Agent,
  type AgentState,
  type NeedsYouKind,
  type NeedsYouShows,
  type WaitingOn,
  type WorkCategory,
  type WorkCategorySet,
} from './protocol.ts';

/** The four groups the seven fall in, in their order: each sets its categories' place, and what the user reads first. */
export const WORK_GROUPS = ['on-you', 'stuck', 'on-others', 'on-its-own'] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

export const WORK_CATEGORY_GROUP: Record<WorkCategory, WorkGroup> = {
  'needs-help': 'on-you',
  'ready-for-review': 'on-you',
  blocked: 'stuck',
  'waiting-on-others': 'on-others',
  'in-review': 'on-others',
  working: 'on-its-own',
  done: 'on-its-own',
};

/** Each category's name, as its chip shows it when the agent gave no label of its own. */
export const WORK_CATEGORY_LABELS: Record<WorkCategory, string> = {
  'needs-help': 'Needs help',
  'ready-for-review': 'Ready for review',
  blocked: 'Blocked',
  'waiting-on-others': 'Waiting on others',
  'in-review': 'In review',
  working: 'Working',
  done: 'Done',
};

/** Each group's name, as the overview's filter shows it. */
export const WORK_GROUP_LABELS: Record<WorkGroup, string> = {
  'on-you': 'On you',
  stuck: 'Stuck',
  'on-others': 'On others',
  'on-its-own': 'On its own',
};

/** The categories that wait on other people: the only ones an agent may name who it waits on for. */
export const WAITING_CATEGORIES: readonly WorkCategory[] = ['waiting-on-others', 'in-review'];

/** An agent's category as the overview shows it: set by the agent (or its orchestrator), or the board's guess. */
export interface WorkCategoryReading {
  category: WorkCategory;
  /** The agent's own label, or the board's ("CI"), in place of the category's name; null for the name. */
  label: string | null;
  source: 'agent' | 'board';
  /** With `agent`, the orchestrator that set it for its crew member; null when the agent did, and for the board. */
  setBy: string | null;
  /** For the board's guess, why in a few words ("a permission prompt"); null for the agent's own. */
  why: string | null;
  waitingOn: WaitingOn | null;
  /** Since when it has been in it, when known: the set, the ask, the flag. Null when the board can't tell. */
  since: string | null;
}

/** The agent fields the reading takes. */
export type WorkCategoryFacts = HumanStatusFacts & Pick<Agent, 'stepsWait' | 'workFinishedAt' | 'workCategory'>;

/** What a reviewer of the agent's work is read for: whether it is reviewing now, and its name. */
export type ReviewerFacts = Pick<Agent, 'name' | 'state' | 'endedAt'>;

export interface WorkCategoryContext {
  /** What the needs-you inbox lists (`DaemonSettings.needsYouShows`). */
  shows: NeedsYouShows;
  /** The agents reviewing its work (their `reviewOf` is it), live or not. */
  reviewers?: readonly ReviewerFacts[];
}

const WORKING_STATES: ReadonlySet<AgentState> = new Set(
  (Object.keys(HUMAN_STATUS_BY_STATE) as AgentState[]).filter((state) => HUMAN_STATUS_BY_STATE[state] === 'working'),
);

const NEEDS_HELP_WHY: Record<Exclude<NeedsYouKind, 'turn'>, string> = {
  permission: 'a permission prompt',
  asks: 'a question in Needs you',
  plan: 'a plan to review',
  steps: 'questions in Needs you',
  todo: 'a to-do of yours',
  flagged: 'it flagged you',
};

/**
 * An agent's work category. What waits on the user now is Needs help over anything the agent set: a permission prompt,
 * a question, a plan, steps or a to-do, a flag, a restart that stopped it, or last words that ask. A finished turn the
 * inbox lists is not (every agent at its prompt would be), nor a crew member's question, which its orchestrator takes.
 * An ended session reads by how it ended, which the agent can no longer change. Otherwise the agent's own stands, and
 * without one the board guesses: Working while it runs, paused or is scheduled; Blocked at its usage limit; In review
 * while a reviewer of its work runs; Waiting on others ("CI") while its open PR's checks run; Blocked while they fail;
 * Ready for review for an open PR; Working for a draft; Done for a merged PR or work it said is finished; then a crew
 * member is Working with its orchestrator, and any other agent whose turn ended asking nothing is Done. A crew member
 * reads by its PR and reviewer as any agent: its PR waits on review whoever does it.
 */
export function workCategory(agent: WorkCategoryFacts, { shows, reviewers = [] }: WorkCategoryContext): WorkCategoryReading {
  const help = needsHelp(agent, shows);
  if (help !== null) return help;
  const ended = agent.endedAt !== null;
  const own = agent.workCategory;
  if (own !== null && !ended) {
    return { category: own.category, label: own.label, source: 'agent', setBy: own.setBy, why: null, waitingOn: own.waitingOn, since: own.setAt };
  }
  if (ended && agent.state === 'failed') {
    return guess('blocked', agent.exitCode === null || agent.exitCode === 0 ? 'it failed' : `it failed · exit ${agent.exitCode}`);
  }
  if (!ended) {
    if (WORKING_STATES.has(agent.state)) return guess('working', null);
    if (agent.state === 'rate-limited') return guess('blocked', 'its usage limit');
    if (agent.state === 'hibernated') return guess('working', 'paused');
    if (agent.state === 'scheduled') return guess('working', 'scheduled');
  }
  const reviewing = reviewers.find((each) => each.endedAt === null && WORKING_STATES.has(each.state));
  if (reviewing !== undefined) return { ...guess('in-review', 'its reviewer is running'), waitingOn: { who: reviewing.name, ref: null } };
  const open = agent.pullRequests.find((pr) => pr.state === 'open');
  if (open !== undefined && open.checks === 'pending') return { ...guess('waiting-on-others', `PR #${open.number} checks running`), label: 'CI' };
  if (open !== undefined && open.checks === 'failing') return guess('blocked', `PR #${open.number} checks failing`);
  if (open !== undefined) return guess('ready-for-review', `PR #${open.number} open, no reviewer yet`);
  const draft = agent.pullRequests.find((pr) => pr.state === 'draft');
  if (draft !== undefined && !ended) return guess('working', `PR #${draft.number} draft`);
  const newest = agent.pullRequests[0];
  if (newest?.state === 'merged') return guess('done', `PR #${newest.number} merged`);
  if (ended) return guess('done', 'its session ended');
  if (agent.workFinishedAt !== null) return guess('done', 'it said its work is finished', agent.workFinishedAt);
  // A crew member at its prompt waits on its orchestrator for what comes next: not done.
  if (agent.ledBy !== null) return guess('working', `with ${agent.ledBy}`);
  return guess('done', 'its turn ended');
}

/** Needs help, when something waits on the user now; null otherwise. */
function needsHelp(agent: WorkCategoryFacts, shows: NeedsYouShows): WorkCategoryReading | null {
  const kind = needsYouKind(agent, shows);
  if (kind !== null && kind !== 'turn') return guess('needs-help', NEEDS_HELP_WHY[kind], askedSince(agent, kind));
  if (agent.endedAt !== null) return null;
  if (agent.state === 'stopped-by-restart') return guess('needs-help', 'the app restarted under it');
  const atPrompt = agent.state === 'idle' || agent.state === 'waiting';
  if (atPrompt && agent.ledBy === null && agent.lastMessage !== null && asksInWords(agent.lastMessage)) return guess('needs-help', 'its last message asks you');
  return null;
}

/** When what it asks of the user began, as far as the agent's record says. */
function askedSince(agent: WorkCategoryFacts, kind: Exclude<NeedsYouKind, 'turn'>): string | null {
  switch (kind) {
    case 'permission':
      return permissionPrompt(agent)?.requestedAt ?? null;
    case 'asks':
      return agent.ask?.askedAt ?? questionPrompt(agent)?.requestedAt ?? null;
    case 'plan':
      return agent.plan?.presentedAt ?? null;
    case 'steps':
    case 'todo':
      return agent.stepsWait?.since ?? null;
    case 'flagged':
      return agent.flag?.at ?? null;
  }
}

function guess(category: WorkCategory, why: string | null, since: string | null = null): WorkCategoryReading {
  return { category, label: null, source: 'board', setBy: null, why, waitingOn: null, since };
}

/** The word that clears an agent's category, giving the board's guess back. */
export const NO_CATEGORY = 'none';

/**
 * A category to set, from what `board.setStatus` was given: `category` one of the seven or `none`, a `label` and a
 * `waitingOn` with it. Undefined when none of the three was given. Throws, saying why, on anything else.
 */
export function parseWorkCategorySet({ category, label, waitingOn }: { category?: unknown; label?: unknown; waitingOn?: unknown }): WorkCategorySet | undefined {
  if (category === undefined) {
    if (label !== undefined) throw new Error('a label goes with a category');
    if (waitingOn !== undefined) throw new Error('waitingOn goes with a category');
    return undefined;
  }
  if (category === NO_CATEGORY || category === null) {
    if (label !== undefined || waitingOn !== undefined) throw new Error(`category ${NO_CATEGORY} takes no label or waitingOn: it gives the board's guess back`);
    return { category: null };
  }
  if (!(WORK_CATEGORIES as readonly unknown[]).includes(category)) {
    throw new Error(`unknown category '${String(category)}'; categories: ${[...WORK_CATEGORIES, NO_CATEGORY].join(', ')}`);
  }
  const set: WorkCategorySet = { category: category as WorkCategory };
  if (label !== undefined) set.label = text(label, 'label', MAX_WORK_LABEL_LENGTH);
  if (waitingOn !== undefined) {
    if (!WAITING_CATEGORIES.includes(set.category!)) throw new Error(`waitingOn is only for ${WAITING_CATEGORIES.join(' and ')}`);
    if (typeof waitingOn !== 'object' || waitingOn === null || Array.isArray(waitingOn)) throw new Error('waitingOn must be an object with a who, and a ref if you like');
    const { who, ref, ...rest } = waitingOn as Record<string, unknown>;
    const extra = Object.keys(rest)[0];
    if (extra !== undefined) throw new Error(`waitingOn takes who and ref, not ${extra}`);
    if (who === undefined) throw new Error('waitingOn needs a who');
    set.waitingOn = { who: text(who, 'who', MAX_WAITING_ON_LENGTH), ...(ref === undefined ? {} : { ref: text(ref, 'ref', MAX_WAITING_ON_LENGTH) }) };
  }
  return set;
}

/** A label, a who or a ref: one line, trimmed, not blank, and at most `max` characters. */
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`the ${name} must be a string`);
  const line = value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (line === '') throw new Error(`the ${name} must not be blank`);
  if (line.length > max) throw new Error(`the ${name} is ${line.length} characters; at most ${max}`);
  return line;
}
