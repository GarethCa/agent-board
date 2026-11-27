// What the Classic agent tile says at rest (tile B): a short line on what the agent is for, a line on what is true
// now, its state in a word with a time that moves in steps, and at most one button. Pure, so the rules are unit-tested;
// HybridTile draws them. The Simplified tile (`calm-tile.ts`) keeps its own.
import { needsYouKind, needsYouReading, planPending, statusLine, type Agent, type AgentState, type NeedsYouReadingFacts, type NeedsYouShows, type WorkCategory } from '@agent-board/daemon/protocol';
import { WORKING_STATES } from '@agent-board/daemon/human-status';
import { agentPill, TILE_STATE_LABELS } from '../states';
import { sinceText } from '../../../shared/needs-you';
import { clockWakes, endedAs, exitedLine, wakeAct } from './paused';
import { clockTime } from './items/agent-note';
import { whenLabel } from './schedule';

/** The seven states the tile tells apart, each with its word in the tile's bottom row. */
export type TileState = 'thinking' | 'needs-you' | 'waiting' | 'idle' | 'done' | 'paused' | 'failed';

export const TILE_STATE_WORDS: Record<TileState, string> = {
  thinking: 'Thinking',
  'needs-you': 'Needs you',
  waiting: 'Waiting',
  idle: 'Idle',
  done: 'Done',
  paused: 'Paused',
  failed: 'Failed',
};

/**
 * Its state's word: Paused reads Stopped for one a restart stopped, which sleeps as a paused one does; Failed reads
 * Exited for one whose process ended on an error, which Wake starts again; Waiting reads Scheduled for one its clock wakes.
 */
export function tileWord(agent: Parameters<typeof clockWakes>[0], state: TileState): string {
  if (state === 'waiting' && clockWakes(agent)) return 'Scheduled';
  if (state === 'paused' && agent.state === 'stopped-by-restart') return 'Stopped';
  if (state === 'failed' && endedAs(agent) === 'exited') return 'Exited';
  return TILE_STATE_WORDS[state];
}

/** The states a tile lies flat in, with no shadow: its turn is over and it asks nothing. */
export const FLAT_STATES: ReadonlySet<TileState> = new Set<TileState>(['idle', 'done', 'paused']);

/** The work categories it may set that wait on something other than the user. */
const WAITS_ON_OTHERS: ReadonlySet<WorkCategory> = new Set<WorkCategory>(['waiting-on-others', 'in-review', 'blocked']);

/** `text` as one line: its lines joined by spaces, trimmed; undefined when nothing is left. */
function oneLine(text: string | null | undefined): string | undefined {
  const line = text?.replace(/\s*\n\s*/g, ' ').trim();
  return line === undefined || line === '' ? undefined : line;
}

/** The first line of `text` with words on it, trimmed. */
function firstLine(text: string): string | undefined {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '');
}

/** The last line of `text` with words on it, trimmed. */
function lastLine(text: string | null): string | undefined {
  return text?.split('\n').map((line) => line.trim()).findLast((line) => line !== '');
}

/**
 * What the agent is for, in one line: its purpose, which it writes for this; else its issue's title; else its task's
 * first line. Undefined when it has none of them.
 */
export function tileAbout(agent: Pick<Agent, 'purpose' | 'issue' | 'description'>): string | undefined {
  return oneLine(agent.purpose) ?? oneLine(agent.issue?.title) ?? firstLine(agent.description);
}

/**
 * Its state on the tile, from its record and the state its pill draws (`pill`, which says how an ended or seen agent
 * reads). Needs you is what the needs-you inbox lists, seen or not (only its orange outline goes once seen), or a restart
 * that stopped it. Waiting is on something other
 * than the user: its usage limit, its next scheduled run, or a work category it set that waits on others.
 */
export function tileState(agent: Agent, shows: NeedsYouShows, pill: AgentState): TileState {
  if (agent.flag?.to === 'user' || needsYouKind(agent, shows) !== null) return 'needs-you';
  // Its clock wakes it by itself, paused between runs or ended: it waits on its next run.
  if (clockWakes(agent)) return 'waiting';
  // Stopped by a restart, it waits to be woken as a paused one does, asking nothing.
  if (pill === 'hibernated' || agent.state === 'stopped-by-restart') return 'paused';
  if (pill === 'failed' || agent.startup?.failed === true) return 'failed';
  if (pill === 'done' || agent.endedAt !== null) return 'done';
  if (WORKING_STATES.has(pill)) return 'thinking';
  if (pill === 'rate-limited' || pill === 'scheduled') return 'waiting';
  if (agent.workFinishedAt !== null) return 'done';
  if (agent.workCategory !== null && WAITS_ON_OTHERS.has(agent.workCategory.category)) return 'waiting';
  return 'idle';
}

/**
 * What is true now, by its state: the status line it is working to; its question, or the last thing it said; what it
 * waits on; what it finished; what waking does; what failed; when a restart stopped it, as of `now`. Undefined when there is nothing to say: the tile then shows
 * only what it is for.
 */
export function tileNow(agent: Agent, state: TileState, now: number = Date.now()): string | undefined {
  const status = agent.status === null ? undefined : statusLine(agent.status);
  switch (state) {
    case 'thinking':
      // Its last message is its last turn's: not what it is doing now.
      return status;
    case 'needs-you':
      if (planPending(agent)) return `Plan to review: ${agent.plan.title}`;
      return lastLine(agent.lastMessage) ?? status;
    case 'idle':
      // Its status line first, then its last line: a line it set says what it is doing more surely than the last thing it
      // said, which its hover card holds (the design said its last line; this keeps the status line the board has shown).
      return status ?? lastLine(agent.lastMessage);
    case 'waiting':
      // Exited on an error, its clock still on: how it ended stays on its face till the clock runs it again.
      return exitedLine(agent) ?? waitsLine(agent, now);
    case 'done':
      return finishedLine(agent);
    case 'paused':
      if (agent.state === 'stopped-by-restart') return `Stopped by a restart · ${sinceText(agent.endedAt ?? agent.stateSince, now)}`;
      return 'Wake starts it where it left off.';
    case 'failed':
      return agent.notice ?? exitedLine(agent) ?? lastLine(agent.lastMessage) ?? status ?? 'It failed';
  }
}

/** What a waiting agent waits on, in words: "Waits on its review · PR #46". */
function waitsLine(agent: Agent, now: number): string {
  if (agent.state === 'rate-limited') return 'Waits on its usage limit';
  // Its clock wakes it: when, "Wakes 22:30".
  if (clockWakes(agent) && agent.schedule?.nextRunAt != null) return `Wakes ${whenLabel(new Date(agent.schedule.nextRunAt), new Date(now))}`;
  if (agent.state === 'scheduled' || clockWakes(agent)) return 'Waits on its next run';
  const own = agent.workCategory;
  const open = agent.pullRequests.find((pr) => pr.state === 'open');
  const pr = open === undefined ? '' : ` · PR #${open.number}`;
  if (own?.category === 'blocked') return own.label === null ? `Blocked${pr}` : `Blocked · ${own.label}`;
  if (own?.waitingOn != null) return `Waits on ${own.waitingOn.who}${own.waitingOn.ref === null ? pr : ` · ${own.waitingOn.ref}`}`;
  if (own?.label != null) return `Waits on ${own.label}${pr}`;
  return `Waits on ${own?.category === 'in-review' ? 'its review' : 'others'}${pr}`;
}

/** Its open pull request, the one Review opens. */
export function reviewablePr(agent: Pick<Agent, 'pullRequests'>): Agent['pullRequests'][number] | undefined {
  return agent.pullRequests.find((pr) => pr.state === 'open');
}

/**
 * What a done agent finished: its open pull request ready to review, or the one that merged. Once its process has ended,
 * when it finished: "Finished 18:02".
 */
function finishedLine(agent: Agent): string {
  const finished = endedAs(agent) === 'done' && agent.endedAt !== null ? `Finished ${clockTime(agent.endedAt)}` : 'Finished';
  const open = reviewablePr(agent);
  if (open !== undefined) return `${finished} · PR #${open.number} is ready to review`;
  const merged = agent.pullRequests.find((pr) => pr.state === 'merged');
  return merged === undefined ? finished : `${finished} · PR #${merged.number} merged`;
}

/** What its tile's time reads. */
type TileSinceFacts = NeedsYouReadingFacts & Pick<Agent, 'stateSince' | 'hibernated'>;

/**
 * When the state its tile shows began: a pause when it was paused, Needs you when it asked (`needsYouReading`, as the
 * inbox and the Overview give it, else its state), any other when its state did. Its time and the time's tooltip both
 * count from it.
 */
export function tileSince(agent: TileSinceFacts, state: TileState, shows: NeedsYouShows): string {
  if (state === 'paused') return agent.hibernated?.at ?? agent.stateSince;
  if (state === 'needs-you') return needsYouReading(agent, shows)?.since ?? agent.stateSince;
  return agent.stateSince;
}

/**
 * The time on its bottom row, on Needs you and Paused only, in steps so it never changes every minute: "just now" under
 * 5 minutes, then 5-minute steps, whole hours, then days, from `tileSince`.
 */
export function tileTime(agent: TileSinceFacts, state: TileState, shows: NeedsYouShows, now: number): string | undefined {
  if (state !== 'needs-you' && state !== 'paused') return undefined;
  const since = tileSince(agent, state, shows);
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes)) return undefined;
  if (minutes < 5) return 'just now';
  if (minutes < 60) return `${Math.floor(minutes / 5) * 5} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

/** The tile's one button: Open, Review (its pull request) or Wake. Filled only when it needs the user. */
export interface TileButton {
  kind: 'open' | 'review' | 'wake';
  label: string;
  prominent: boolean;
  /** Shown only while the tile is hovered or holds the focus: a scheduled agent's Wake now, as its clock wakes it anyway. */
  onHover?: true;
}

/**
 * Its one button, only when there is something to do: none of them answers, approves or nudges the agent. Review only
 * while a pull request of its is open; an asleep agent (paused, or stopped by a restart) wakes, even one that flags the
 * user, and so does one done or exited, which Wake starts again here; one its clock wakes has Wake now, on hover only. A
 * reviewer whose round ended has none.
 */
export function tileButton(agent: Pick<Agent, 'state' | 'pullRequests' | 'endedAt' | 'reviewOf' | 'shellHarness' | 'schedule'>, state: TileState): TileButton | undefined {
  const wake = wakeAct(agent);
  if (wake === 'resume') return { kind: 'wake', label: 'Wake', prominent: state === 'needs-you' };
  switch (state) {
    case 'needs-you':
      return { kind: 'open', label: 'Open', prominent: true };
    case 'failed':
      return wake === 'restart' ? { kind: 'wake', label: 'Wake', prominent: false } : { kind: 'open', label: 'Open', prominent: false };
    case 'done':
      if (reviewablePr(agent) !== undefined) return { kind: 'review', label: 'Review', prominent: false };
      return wake === 'restart' ? { kind: 'wake', label: 'Wake', prominent: false } : undefined;
    case 'paused':
      return { kind: 'wake', label: 'Wake', prominent: false };
    default:
      return wake === 'run-now' ? { kind: 'wake', label: 'Wake now', prominent: false, onHover: true } : undefined;
  }
}

/** The pill an agent's tile draws, its state on the tile and its one button: the parts of its footer's line that are not chips. */
export interface TileMark {
  pill: { state: AgentState; label: string };
  state: TileState;
  button: TileButton | undefined;
}

/**
 * Its tile's mark, from its record: `sending` while it hands work on, `receiving` while work comes to it. These change
 * with no change to its state (an ask landing makes a finished turn need the user, with a wider pill and an Open
 * button), so what measures the footer must take them in, not its state alone.
 */
export function tileMark(agent: Agent, shows: NeedsYouShows, sending: boolean, receiving: boolean): TileMark {
  const pill = sending ? { state: 'handing-off' as const, label: TILE_STATE_LABELS['handing-off'] } : agentPill(agent, shows, TILE_STATE_LABELS);
  const state = tileState(agent, shows, pill.state);
  return { pill, state, button: sending || receiving ? undefined : tileButton(agent, state) };
}

/** What the footer's fold must measure again on, of its mark: its pill's face, its state on the tile and its button. */
export const tileMarkKey = ({ pill, state, button }: TileMark): string => JSON.stringify([pill.state, pill.label, state, button?.label ?? null]);

/** The parts of a tile's mark, beside the mark itself, that change its width in the footer's line. */
export interface FooterMark {
  mark: TileMark;
  /** The tile part that shows its state as a pill, not as a word and a time. */
  statePill: boolean;
  /** The pill's age and the word's time: each changes as the minutes pass. */
  age: string | undefined;
  stateTime: string | undefined;
  character: string;
  onCredits: boolean;
}

/**
 * The key the footer's fold measures again on: the footer's own parts, then its mark. The mark sits in the same line
 * and changes with no change to the agent's state, so a key without it keeps a fold measured for a narrower mark.
 */
export const footerFoldKey = (line: readonly unknown[], { mark, statePill, age, stateTime, character, onCredits }: FooterMark): string =>
  JSON.stringify([...line, tileMarkKey(mark), statePill, age ?? null, stateTime ?? null, character, onCredits]);
