// What a crew card draws (a `crew` item), from what the daemon wrote of its crew and the board's agents as they are
// now: its rounds, a row for each member of its prefab, its last hand-off, and where it stopped with what the user can
// do there. Nothing here changes a crew: each action names a call the card's node makes for the user.
import {
  needsYouKind,
  type Agent,
  type AgentState,
  type BoardItem,
  type CrewCardData,
  type CrewCardMember,
  type CrewReviewer,
  type NeedsYouKind,
  type NeedsYouShows,
  type PullRequest,
} from '@agent-board/daemon/protocol';
import { HUMAN_STATUS_LABELS, humanStatus, type HumanStatus } from '@agent-board/daemon/human-status';
import { memberLabel } from '../../crews/prefab-flow';
import { TILE_STATE_LABELS, agentPill } from '../../states';
import { clockTime } from './agent-note';

/** A crew card's data, as the daemon wrote it. */
export const crewCardData = (data: Record<string, unknown>): CrewCardData => data as unknown as CrewCardData;

/** Whether `item` is the card of a crew still running: one the daemon keeps on the board until its crew stops. */
export const cardOfRunningCrew = (item: Pick<BoardItem, 'kind' | 'data'>) => item.kind === 'crew' && crewCardData(item.data).crew.stopped === null;

/**
 * The card's look: a crew at work, ready to merge, waiting on the user, stopped at its round limit (the user's to choose
 * what next, so ringed as one that waits on them), or over.
 */
export type CrewTone = 'running' | 'ready' | 'needs' | 'limit' | 'over';

/** A round's chip: done, the one the crew is in, the one it was stopped in unfinished (`cut`), or still to come. */
export interface CrewRoundChip {
  round: number;
  state: 'done' | 'now' | 'cut' | 'next';
}

/** What a member's row says in place of an agent's own state: where the crew has it. */
export type CrewMark = 'waits' | 'approved' | 'changes' | 'gone';

export interface CrewRow {
  member: CrewCardMember;
  name: string;
  /** Its pill: its agent's own while its turn is on, else in the state's colours with `mark`. */
  pill: { state: AgentState; label: string };
  mark?: CrewMark;
  /** Its agent's status as the Simplified design reads agents, where the card is asked for it: drawn in place of the pill. */
  status?: HumanStatus;
  /** What follows its name: what its agent is doing, the round it reviewed, what it waits for. */
  detail: string;
  /** Its agent, while it has one on the board: the row opens its tile. */
  sessionId?: string;
}

/**
 * What the user can do from the card: open the builder's pull request (where merging stays their click), open an agent
 * (the one that needs them, or the builder, to look over its work or steer it themselves), or ask for one more round
 * or another try at starting the round's reviewers (`round`).
 */
export interface CrewAction {
  id: 'pull-request' | 'agent' | 'round';
  label: string;
  primary: boolean;
  /** The agent it opens, for one that opens an agent. */
  sessionId?: string;
}

export interface CrewCardModel {
  tone: CrewTone;
  /** Where it stopped, or what it waits on: nothing while it runs. */
  label: string | null;
  /** A chip for each round up to its limit; none for a limit too long for the card, which `roundText` still gives. */
  rounds: CrewRoundChip[];
  roundText: string;
  rows: CrewRow[];
  /** Its last hand-off, while it runs. */
  last: string | null;
  /** Why it stopped or waits, in a sentence. */
  why: string | null;
  /** What went wrong, as the daemon said it: why a round's reviewers could not be started. */
  error: string | null;
  actions: CrewAction[];
  /** Its builder's pull request, and that builder, while both are there. */
  pullRequest?: { pr: PullRequest; sessionId: string };
  /** How many of its agents are on the board now: fewer than its rows before a reviewer starts, and once any is closed. */
  agents: number;
}

/** The most rounds drawn as chips: a longer limit is given in words alone. */
const MAX_ROUND_CHIPS = 6;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A member's name on the card: its own, else its key in words. */
const nameOf = (member: CrewCardMember) => memberLabel({ id: member.id, name: member.name === member.id ? null : member.name });

/** Names in a list: `A`, `A and B`, `A, B and C`. */
const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** How each flag the crew raises on its builder starts (the daemon's `crewFlag`): its own flag is no one asking. */
const crewFlag = (prefab: string) => `The ${prefab} crew `;

/**
 * Why the agent holds its crew up for the user, as the crew's loop sees it: a permission prompt, a question, a plan, a
 * steps card, or a flag that isn't the crew's own. Never a turn that only ended, which the loop takes as a hand-off.
 */
function holdsUp(agent: Agent, prefab: string): NeedsYouKind | null {
  const kind = needsYouKind(agent, 'explicit');
  return kind === 'flagged' && agent.flag?.reason.startsWith(crewFlag(prefab)) ? null : kind;
}

function asking(name: string, agent: Agent, kind: NeedsYouKind): string {
  if (kind === 'asks' && agent.ask !== null) return `${name} asks: “${agent.ask.question}”`;
  if (kind === 'asks') return `${name} asks you a question.`;
  if (kind === 'permission') return `${name} waits for you to allow a step.`;
  if (kind === 'plan') return `${name} has a plan for you to review.`;
  if (kind === 'flagged' && agent.flag !== null) return `${name} flagged: ${agent.flag.reason}`;
  return `${name} waits on a steps card for you.`;
}

/** The newest review round of each reviewing member, by its key. */
function latestReviews(reviewers: readonly CrewReviewer[]): Map<string, CrewReviewer> {
  const latest = new Map<string, CrewReviewer>();
  for (const reviewer of reviewers) {
    if ((latest.get(reviewer.member)?.round ?? 0) <= reviewer.round) latest.set(reviewer.member, reviewer);
  }
  return latest;
}

function roundChips(data: CrewCardData): CrewRoundChip[] {
  const { round, roundLimit, stopped } = data.crew;
  if (roundLimit > MAX_ROUND_CHIPS) return [];
  // Its last round is done once it stopped with every review in; stopped by hand, or its builder gone, that round was cut short.
  const finished = stopped === 'ready-to-merge' || stopped === 'merged' || stopped === 'round-limit';
  return Array.from({ length: roundLimit }, (_, index): CrewRoundChip => {
    const each = index + 1;
    if (each < round || (each === round && finished)) return { round: each, state: 'done' };
    if (each > round) return { round: each, state: 'next' };
    return { round: each, state: stopped === null ? 'now' : 'cut' };
  });
}

/** What the card says of a pull request's checks where its crew is ready to merge: nothing of checks that pass, or of none. */
function checksSaid(pr: PullRequest | undefined): string {
  if (pr?.checks === 'failing') return ` #${pr.number}’s checks are failing.`;
  if (pr?.checks === 'pending') return ` #${pr.number}’s checks are still running.`;
  return '';
}

/**
 * What the card draws for `data`, with the board's `agents` as they are and the pills as the inbox's `shows` has them.
 * With `human` (the Simplified design, its technical details off) a row whose agent's turn is on reads that agent by its
 * status, as its tile does, rather than by its raw state; where the crew has a member (waits, approved, changes, gone)
 * reads the same in both.
 */
export function crewCardModel(data: CrewCardData, agents: readonly Agent[], shows: NeedsYouShows, human = false): CrewCardModel {
  const { crew } = data;
  const agent = (sessionId: string) => agents.find((each) => each.sessionId === sessionId);
  const running = crew.stopped === null;
  const builder = agent(crew.builder);
  const builderMember = data.members.find((member) => member.starts !== 'handoff');
  const builderName = builderMember === undefined ? (builder?.name ?? 'The builder') : nameOf(builderMember);
  const latest = latestReviews(crew.reviewers);
  const nowReviewing = crew.reviewers.filter((reviewer) => reviewer.round === crew.round);
  const memberName = (key: string) => {
    const member = data.members.find((each) => each.id === key);
    return member === undefined ? key : nameOf(member);
  };
  const live = (sessionId: string) => {
    const found = agent(sessionId);
    if (found === undefined) return undefined;
    const row = { pill: agentPill(found, shows, TILE_STATE_LABELS), detail: found.status?.summary ?? '', sessionId };
    if (!human) return row;
    const { status } = humanStatus(found, shows, found.reviewOf === null ? null : (agent(found.reviewOf) ?? null));
    return { ...row, pill: { ...row.pill, label: HUMAN_STATUS_LABELS[status] }, status };
  };
  // A merged crew closed its agents itself; any other agent that is no longer there was closed from under it.
  const gone: Pick<CrewRow, 'pill' | 'mark' | 'detail'> = { pill: { state: 'idle', label: crew.stopped === 'merged' ? 'closed' : 'gone' }, mark: 'gone', detail: '' };

  const rows = data.members.map((member): CrewRow => {
    const row = { member, name: nameOf(member) };
    if (member === builderMember) {
      const own = live(crew.builder);
      if (own === undefined) return { ...row, ...gone };
      // Its turn is over while its reviewers read: unless it asks something, it waits for them.
      if (running && crew.phase === 'reviewing' && holdsUp(builder!, crew.prefab) === null) {
        return { ...row, pill: { state: 'idle', label: 'waits' }, mark: 'waits', detail: 'for the reviews', sessionId: own.sessionId };
      }
      return { ...row, ...own };
    }
    const review = latest.get(member.id);
    if (review === undefined) {
      return { ...row, pill: { state: 'idle', label: running ? 'waits' : 'not started' }, mark: 'waits', detail: running ? `for ${builderName}’s hand-off` : '' };
    }
    const sessionId = agent(review.sessionId)?.sessionId;
    if (review.verdict === 'approve') return { ...row, pill: { state: 'done', label: 'approved' }, mark: 'approved', detail: `r${review.round}`, sessionId };
    if (review.verdict === 'changes-requested') {
      // Its changes went back to the builder: it reviews again at the next hand-off.
      if (running && review.round < crew.round) return { ...row, pill: { state: 'idle', label: 'waits' }, mark: 'waits', detail: 'for the fixes', sessionId };
      const blockers = review.blockers === null || review.blockers === 0 ? '' : ` · ${plural(review.blockers, 'blocker')}`;
      return { ...row, pill: { state: 'idle', label: 'changes' }, mark: 'changes', detail: `r${review.round}${blockers}`, sessionId };
    }
    const own = live(review.sessionId);
    if (own === undefined) return { ...row, ...gone, detail: `r${review.round}` };
    return { ...row, ...own, detail: own.detail === '' ? `r${review.round}` : own.detail };
  });

  const pr = builder?.pullRequests[0];
  const base = {
    rounds: roundChips(data),
    rows,
    last: null,
    why: null,
    error: null,
    actions: [],
    ...(builder !== undefined && pr !== undefined ? { pullRequest: { pr, sessionId: builder.sessionId } } : {}),
    agents: new Set([crew.builder, ...crew.reviewers.map((reviewer) => reviewer.sessionId)].filter((sessionId) => agent(sessionId) !== undefined)).size,
  } satisfies Partial<CrewCardModel>;
  const inRounds = `done in ${plural(crew.round, 'round')}`;
  const stoppedIn = `stopped in round ${crew.round}`;

  if (crew.stopped === 'ready-to-merge') {
    const approving = nowReviewing.length === 1 ? `${memberName(nowReviewing[0]!.member)} approves` : nowReviewing.length === 2 ? 'Both reviewers approve' : `All ${nowReviewing.length} reviewers approve`;
    return {
      ...base,
      tone: 'ready',
      label: 'Ready to merge',
      roundText: inRounds,
      why: `${approving} round ${crew.round}, with no blocker open.${checksSaid(pr)} Merging stays your click.`,
      actions: [
        ...(builder === undefined || pr === undefined ? [] : [{ id: 'pull-request' as const, label: 'Open pull request', primary: true }]),
        ...(builder === undefined ? [] : [{ id: 'agent' as const, label: `Open ${builderName}`, primary: pr === undefined, sessionId: builder.sessionId }]),
      ],
    };
  }
  if (crew.stopped === 'round-limit') {
    const asked = nowReviewing.filter((reviewer) => reviewer.verdict !== 'approve' || (reviewer.blockers ?? 0) > 0);
    const blockers = asked.reduce((sum, reviewer) => sum + (reviewer.blockers ?? 0), 0);
    const who = asked.length === 0 ? 'Its reviewers' : listed(asked.map((reviewer) => memberName(reviewer.member)));
    const still = blockers > 0 ? `still ${asked.length > 1 ? 'have' : 'has'} ${plural(blockers, 'blocker')} open` : `still ${asked.length === 1 ? 'asks' : 'ask'} for changes`;
    return {
      ...base,
      tone: 'limit',
      label: 'Round limit',
      roundText: `stopped at round ${crew.round} of ${crew.roundLimit}`,
      why: `${who} ${still}. Nothing more was sent.`,
      actions: [
        { id: 'round', label: 'One more round', primary: true },
        ...(builder === undefined ? [] : [{ id: 'agent' as const, label: 'Take over', primary: false, sessionId: builder.sessionId }]),
      ],
    };
  }
  if (crew.stopped === 'merged') {
    return { ...base, tone: 'over', label: 'Merged', roundText: inRounds, why: 'Its pull request was merged, and its agents were closed.' };
  }
  if (crew.stopped === 'builder-gone') {
    return { ...base, tone: 'over', label: 'Builder gone', roundText: stoppedIn, why: `${builderName} was closed, so the crew stopped.` };
  }
  if (crew.stopped === 'stopped') {
    return { ...base, tone: 'over', label: 'Stopped', roundText: stoppedIn, why: 'Nothing more is handed on. Its agents stay as they are.' };
  }

  // Running. The round's reviewers that didn't start hold it up first: no one is there to ask anything.
  const paused = `paused in round ${crew.round}`;
  if (data.startFailed) {
    return {
      ...base,
      tone: 'needs',
      label: 'Needs you',
      roundText: paused,
      why: `Round ${crew.round}’s reviewers could not be started. Nothing was sent.`,
      // Loose: a card written by an older daemon has no reason.
      error: data.startError ?? null,
      actions: [{ id: 'round', label: 'Try again', primary: true }],
    };
  }
  const turn = [{ sessionId: crew.builder, name: builderName }, ...(crew.phase === 'reviewing' ? nowReviewing.map((reviewer) => ({ sessionId: reviewer.sessionId, name: memberName(reviewer.member) })) : [])];
  for (const { sessionId, name } of turn) {
    const found = agent(sessionId);
    const kind = found === undefined ? null : holdsUp(found, crew.prefab);
    if (found === undefined || kind === null) continue;
    return {
      ...base,
      tone: 'needs',
      label: 'Needs you',
      roundText: paused,
      why: asking(name, found, kind),
      actions: [{ id: 'agent', label: kind === 'asks' ? 'Answer' : `Open ${name}`, primary: true, sessionId }],
    };
  }

  const at = clockTime(data.phaseAt);
  const reviews = latest.size === 1 ? 'Review' : 'Reviews';
  const last =
    crew.phase === 'reviewing'
      ? `${builderName} handed off (round ${crew.round})`
      : crew.round > 1
        ? `${reviews} went to ${builderName} (round ${crew.round})`
        : `Started from ${crew.prefab}`;
  return { ...base, tone: 'running', label: null, roundText: `round ${crew.round} of ${crew.roundLimit}`, last: `${at === '' ? '' : `${at} `}${last}` };
}
