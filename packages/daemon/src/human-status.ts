// The six statuses anyone can read an agent by, whatever its harness's own states: what it shows under the Simplified
// design, and what arranging a zone by status lanes it by.

import { needsYouKind, REQUEST_WORDS, type Agent, type AgentState, type NeedsYouFacts, type NeedsYouShows } from './protocol.ts';

/** The six, those that want the user first. */
export const HUMAN_STATUSES = ['needs-you', 'problem', 'working', 'done', 'paused', 'scheduled'] as const;
export type HumanStatus = (typeof HUMAN_STATUSES)[number];

/** Each status's word, as the app shows it beside its glyph or its character. */
export const HUMAN_STATUS_LABELS: Record<HumanStatus, string> = {
  'needs-you': 'Needs you',
  problem: 'Problem',
  working: 'Working',
  done: 'Done',
  paused: 'Paused',
  scheduled: 'Scheduled',
};

/**
 * What marks an agent's tile without needing the user to act, so nothing counts it (`needsYouReading`): last words at its
 * prompt that ask something, open changes at its prompt or ended, and a restart that stopped it.
 */
export const TILE_CUES = ['asks-in-words', 'pr-ready', 'stopped-by-restart'] as const;
export type TileCue = (typeof TILE_CUES)[number];

/** Each cue's word, which the tile shows in place of its status's, and its line. */
export const TILE_CUE_WORDS: Record<TileCue, { word: string; detail: string }> = {
  'asks-in-words': { word: 'Asks you', detail: 'Its last message asks you' },
  'pr-ready': { word: 'To review', detail: 'Changes ready to review' },
  'stopped-by-restart': { word: 'Stopped', detail: 'Stopped when the app restarted' },
};

/** An agent's status, why in a few words when there is more to say than its word, and the cue that marks its tile. */
export interface HumanStatusReading {
  status: HumanStatus;
  detail: string | null;
  /** Null unless a cue marks it: its status stays the one under the cue, so nothing counts it as needing the user. */
  cue: TileCue | null;
}

/** The agent fields the mapping reads. */
export type HumanStatusFacts = NeedsYouFacts & Pick<Agent, 'exitCode' | 'reviewOf' | 'lastMessage' | 'pullRequests' | 'hibernated'>;

/** What a reviewer's implementer is read for: whether it is at work, and its name. */
export type ImplementerFacts = Pick<Agent, 'name' | 'state' | 'endedAt'>;

/** Each state's status on its own, for a live agent asking nothing. */
export const HUMAN_STATUS_BY_STATE: Record<AgentState, HumanStatus> = {
  running: 'working',
  thinking: 'working',
  starting: 'working',
  'handing-off': 'working',
  'on-command': 'working',
  idle: 'done',
  waiting: 'done',
  done: 'done',
  'needs-permission': 'needs-you',
  'stopped-by-restart': 'paused',
  failed: 'problem',
  'rate-limited': 'paused',
  hibernated: 'paused',
  scheduled: 'scheduled',
};

/** The states an agent is at work in: its status is Working. */
export const WORKING_STATES: ReadonlySet<AgentState> = new Set(
  (Object.keys(HUMAN_STATUS_BY_STATE) as AgentState[]).filter((state) => HUMAN_STATUS_BY_STATE[state] === 'working'),
);

/** The working states and its usage limit, which it carries on from by itself: someone has it, and it is busy. */
export const CARRYING_ON_STATES: ReadonlySet<AgentState> = new Set<AgentState>([...WORKING_STATES, 'rate-limited']);

/** A sentence's first letter in capitals. */
const capital = (text: string): string => `${text[0]!.toUpperCase()}${text.slice(1)}`;

/**
 * What may follow a question mark that still ends the message on it: closing emphasis, code, quotes and brackets, an
 * emoji (skin tones and joined ones too), and a "(y/n)".
 */
const AFTER_QUESTION = /^(?:[\s*_`"'”’)\]}]|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200D|\uFE0F|\((?:y\/n|yes\/no)\))*$/iu;

/**
 * Whether a finished turn's last message asks the user something, read from its words alone: it ends in a question
 * mark (or a full-width one), past anything `AFTER_QUESTION` allows. A stand-in until a turn's question can be told
 * better; a rhetorical question passes too.
 */
export function asksInWords(message: string): boolean {
  const last = Math.max(message.lastIndexOf('?'), message.lastIndexOf('\uFF1F'));
  return last !== -1 && AFTER_QUESTION.test(message.slice(last + 1));
}

/**
 * An agent's status, one of six. What needs the user to act is Needs you, first (`needsYouKind`): a permission prompt, a
 * question, a plan, a flag, every finished turn when the inbox lists them (`shows`). A cue (`TileCue`) keeps the status
 * under it, Done, and only marks its tile (`standsOut`): a last message at its prompt that asks something, and open
 * changes waiting for review, at its prompt or ended, of an agent no orchestrator leads. A reviewer at its
 * prompt asking none of that is Paused while `implementer`, the agent it reviews, works or is paused. An ended agent
 * is a Problem when the daemon says it failed, else Done, whatever its exit code (a stop can leave one). A crew member
 * at its prompt, its orchestrator live (`ledBy`), is Working "With" that orchestrator, which takes its turns, questions
 * and changes: only a permission prompt or a flag to the user reach the user. One a restart stopped is Paused, as a paused one is, with its cue. The mapping
 * reads no harness: Claude's and Codex's agents share these states.
 */
export function humanStatus(agent: HumanStatusFacts, shows: NeedsYouShows, implementer?: ImplementerFacts | null): HumanStatusReading {
  const kind = needsYouKind(agent, shows);
  if (kind !== null) return reading('needs-you', kind === 'flagged' ? (agent.flag?.reason ?? null) : kind === 'turn' ? null : capital(REQUEST_WORDS[kind].says));
  const { state } = agent;
  // Stopped by a restart, it sleeps as a paused one does: it waits to be woken, asking nothing.
  if (state === 'stopped-by-restart') return cued('paused', 'stopped-by-restart');
  if (state === 'hibernated') return reading('paused', null);
  if (state === 'failed' && agent.endedAt !== null) {
    return reading('problem', agent.exitCode === null || agent.exitCode === 0 ? null : `Ended · exit ${agent.exitCode}`);
  }
  if (state === 'rate-limited') return reading('paused', 'Usage limit');
  const ended = agent.endedAt !== null;
  const atPrompt = !ended && (state === 'idle' || state === 'waiting');
  // A reviewer waiting on its implementer is paused, whoever leads it.
  const waiting = atPrompt && agent.reviewOf !== null && implementer != null && waitedOn(implementer);
  // A crew member at its prompt is between turns for its live orchestrator, which takes its questions and its changes.
  if (atPrompt && !waiting && agent.ledBy !== null) return reading('working', `With ${agent.ledBy}`);
  // Its question goes with its session; its open changes outlive it, and an ended crew member's are its orchestrator's.
  if (atPrompt && agent.lastMessage !== null && asksInWords(agent.lastMessage)) return cued('done', 'asks-in-words');
  if ((atPrompt || ended) && agent.ledBy === null && agent.pullRequests.some((pr) => pr.state === 'open')) return cued('done', 'pr-ready');
  if (ended) return reading('done', null);
  if (waiting && implementer != null) return reading('paused', `Waits for ${implementer.name}`);
  return reading(HUMAN_STATUS_BY_STATE[state], null);
}

/** Whether its tile stands out as one that needs the user does: it needs them, or a cue that asks them to look marks it. */
export const standsOut = (status: HumanStatusReading): boolean => status.status === 'needs-you' || status.cue === 'asks-in-words' || status.cue === 'pr-ready';

/** Whether a reviewer waits on its implementer: one live and working or at its usage limit, or one paused. */
function waitedOn(implementer: ImplementerFacts): boolean {
  if (implementer.state === 'hibernated') return true;
  const status = HUMAN_STATUS_BY_STATE[implementer.state];
  return implementer.endedAt === null && (status === 'working' || status === 'paused');
}

function reading(status: HumanStatus, detail: string | null): HumanStatusReading {
  return { status, detail, cue: null };
}

function cued(status: HumanStatus, cue: TileCue): HumanStatusReading {
  return { status, detail: TILE_CUE_WORDS[cue].detail, cue };
}
