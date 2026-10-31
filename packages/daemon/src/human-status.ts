// The six statuses anyone can read an agent by, whatever its harness's own states: what it shows under the Simplified
// design, and what arranging a zone by status lanes it by.

import { needsYouKind, type Agent, type AgentState, type NeedsYouFacts, type NeedsYouKind, type NeedsYouShows } from './protocol.ts';

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

/** An agent's status, and why in a few words when there is more to say than its word. */
export interface HumanStatusReading {
  status: HumanStatus;
  detail: string | null;
}

/** The agent fields the mapping reads. */
export type HumanStatusFacts = NeedsYouFacts & Pick<Agent, 'exitCode' | 'reviewOf' | 'lastMessage' | 'pullRequests' | 'hibernated'>;

/** What a reviewer's implementer is read for: whether it is at work, and its name. */
export type ImplementerFacts = Pick<Agent, 'name' | 'state' | 'endedAt'>;

/** Each state's status on its own, for a live agent asking nothing. */
const BY_STATE: Record<AgentState, HumanStatus> = {
  running: 'working',
  thinking: 'working',
  starting: 'working',
  'handing-off': 'working',
  'on-command': 'working',
  idle: 'done',
  waiting: 'done',
  done: 'done',
  'needs-permission': 'needs-you',
  'stopped-by-restart': 'needs-you',
  failed: 'problem',
  'rate-limited': 'paused',
  hibernated: 'paused',
  scheduled: 'scheduled',
};

const NEEDS_YOU_DETAILS: Record<Exclude<NeedsYouKind, 'flagged'>, string | null> = {
  permission: 'Wants your permission',
  asks: 'Asks you',
  plan: 'Plan to review',
  turn: null,
};

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
 * An agent's status, one of six. Whatever waits on the user is Needs you, first: a permission prompt, a question, a
 * plan, a flag, every finished turn when the inbox lists them (`shows`), an agent a restart stopped, a last message
 * at its prompt that asks something, and open changes waiting for review, at its prompt or ended as done. A reviewer at its
 * prompt asking none of that is Paused while `implementer`, the agent it reviews, works or is paused. An ended agent
 * is a Problem when the daemon says it failed, else Done, whatever its exit code (a stop can leave one). The mapping
 * reads no harness: Claude's and Codex's agents share these states.
 */
export function humanStatus(agent: HumanStatusFacts, shows: NeedsYouShows, implementer?: ImplementerFacts | null): HumanStatusReading {
  const kind = needsYouKind(agent, shows);
  if (kind !== null) return needsYou(kind === 'flagged' ? (agent.flag?.reason ?? null) : NEEDS_YOU_DETAILS[kind]);
  const { state } = agent;
  if (state === 'stopped-by-restart') return needsYou('Stopped when the app restarted');
  if (state === 'hibernated') return { status: 'paused', detail: agent.hibernated?.reason === undefined ? null : 'Paused for usage' };
  if (state === 'failed' && agent.endedAt !== null) {
    return { status: 'problem', detail: agent.exitCode === null || agent.exitCode === 0 ? null : `Ended · exit ${agent.exitCode}` };
  }
  if (state === 'rate-limited') return { status: 'paused', detail: 'Usage limit' };
  const ended = agent.endedAt !== null;
  const atPrompt = !ended && (state === 'idle' || state === 'waiting');
  // Its question goes with its session; its open changes outlive it.
  if (atPrompt && agent.lastMessage !== null && asksInWords(agent.lastMessage)) return needsYou('Asks you');
  if ((atPrompt || ended) && agent.pullRequests.some((pr) => pr.state === 'open')) return needsYou('Changes ready to review');
  if (ended) return { status: 'done', detail: null };
  if (atPrompt && agent.reviewOf !== null && implementer != null && waitedOn(implementer)) {
    return { status: 'paused', detail: `Waits for ${implementer.name}` };
  }
  return { status: BY_STATE[state], detail: null };
}

/** Whether a reviewer waits on its implementer: one live and working or at its usage limit, or one paused. */
function waitedOn(implementer: ImplementerFacts): boolean {
  if (implementer.state === 'hibernated') return true;
  const status = BY_STATE[implementer.state];
  return implementer.endedAt === null && (status === 'working' || status === 'paused');
}

function needsYou(detail: string | null): HumanStatusReading {
  return { status: 'needs-you', detail };
}
