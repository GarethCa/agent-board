// What an agent's glance tile says, whichever glance design draws it (Shelf, Porthole): one of eleven states, how much
// it asks of the user, its word, one line of what it is doing or asks, and at most one action. Pure, so it is
// unit-tested; each design only draws it.

import { needsYouKind, statusLine, type Agent, type NeedsYouShows } from '@agent-board/daemon/protocol';
import type { HumanStatus, ImplementerFacts } from '@agent-board/daemon/human-status';
import { calmFace, type CalmAction } from './calm-tile';

/** The states a glance tile tells apart: finer than the six statuses, so working and thinking, done and idle differ. */
export const GLANCE_STATES = ['working', 'thinking', 'needs', 'permission', 'failed', 'idle', 'done', 'paused', 'limit', 'review', 'scheduled'] as const;
export type GlanceState = (typeof GLANCE_STATES)[number];

/** Each state's word, beside its glyph, so a state never rests on a colour alone. */
const GLANCE_WORDS: Record<GlanceState, string> = {
  working: 'Working',
  thinking: 'Thinking',
  needs: 'Needs you',
  permission: 'Permission',
  failed: 'Failed',
  idle: 'Idle',
  done: 'Done',
  paused: 'Paused',
  limit: 'Usage limit',
  review: 'In review',
  scheduled: 'Scheduled',
};

/**
 * How loud a state is: 0 quiet, 1 at work, 2 wants the user, 3 a problem. Only 2 and 3 fill their band or ring with
 * colour, so the colour on the board is the work waiting for the user.
 */
export type GlanceLevel = 0 | 1 | 2 | 3;

export const GLANCE_LEVELS: Record<GlanceState, GlanceLevel> = {
  working: 1,
  thinking: 1,
  needs: 2,
  permission: 2,
  failed: 3,
  idle: 0,
  done: 0,
  paused: 0,
  limit: 0,
  review: 0,
  scheduled: 0,
};

/**
 * An agent's glance tile: its status (which its character acts out), its state, how loud it is, its word, its line
 * (null for nothing to say), and its one action.
 */
export interface GlanceFace {
  status: HumanStatus;
  state: GlanceState;
  level: GlanceLevel;
  word: string;
  line: string | null;
  action: CalmAction | null;
}

/** The glance state of an agent read as `status`: the status, split by the agent's own state where the eye wants it. */
function glanceStateOf(status: HumanStatus, agent: Pick<Agent, 'state' | 'endedAt'>, permission: boolean): GlanceState {
  const { state } = agent;
  switch (status) {
    case 'needs-you':
      return permission ? 'permission' : 'needs';
    case 'problem':
      return 'failed';
    case 'working':
      return state === 'thinking' ? 'thinking' : 'working';
    case 'done':
      return agent.endedAt === null ? 'idle' : 'done';
    case 'paused':
      // At its prompt with its work under review: a reviewer's implementer still works.
      return state === 'hibernated' ? 'paused' : state === 'rate-limited' ? 'limit' : 'review';
    case 'scheduled':
      return 'scheduled';
  }
}

/**
 * The action's words on a glance tile: the short ones its controls are drawn with (Answer, Review, Open, Wake, Open
 * PR), where today's tile has longer ones.
 */
const GLANCE_LABELS: Partial<Record<string, string>> = { 'Review & allow': 'Review', 'Review changes': 'Open PR' };

/**
 * What the glance tile says about `agent`. Its line is the calm tile's (what it asks, its flag, its notice, its status
 * line), else the start of its last message, so a tile at rest still says where it got to. A line that only says its
 * word again (Usage limit) gives way to its status line or last message: the word is on the tile already.
 */
export function glanceFace(agent: Agent, shows: NeedsYouShows, implementer?: ImplementerFacts | null): GlanceFace {
  const calm = calmFace(agent, shows, implementer);
  const state = glanceStateOf(calm.status, agent, needsYouKind(agent, shows) === 'permission');
  const word = GLANCE_WORDS[state];
  // Its status line is its summary alone: its bar shows the progress, so a line at the cap still fits its box.
  const summary = agent.status === null || agent.status.summary.trim() === '' ? null : agent.status.summary;
  const line = calm.line === word ? summary : agent.status !== null && calm.line === statusLine(agent.status) ? summary : calm.line;
  return { status: calm.status, state, level: GLANCE_LEVELS[state], word, line: line ?? lastLine(agent), action: actionOf(agent, state, calm.action) };
}

function actionOf(agent: Agent, state: GlanceState, calm: CalmAction | null): CalmAction | null {
  if (calm !== null) return { ...calm, label: GLANCE_LABELS[calm.label] ?? calm.label };
  // A failed agent's session is where its error is.
  if (state === 'failed') return { kind: 'open', label: 'Open', prominent: true };
  // Its changes wait on a reviewer: the PR is one click away, quietly.
  if (state === 'review' && agent.pullRequests.some((pr) => pr.state === 'open')) return { kind: 'pull-request', label: 'Open PR', prominent: false };
  return null;
}

/** The first line of its last message with words in it, or null. */
function lastLine(agent: Pick<Agent, 'lastMessage'>): string | null {
  const line = agent.lastMessage?.split('\n').find((each) => each.trim() !== '');
  return line === undefined ? null : line.trim();
}

/** A glance tile's line, with a command it asks permission to run shown as the command itself, set in mono. */
export function glanceLine(line: string | null, state: GlanceState): { text: string; command: boolean } | null {
  if (line === null) return null;
  const command = state === 'permission' ? /^Bash: (.+)$/s.exec(line) : null;
  return command === null ? { text: line, command: false } : { text: command[1]!, command: true };
}
