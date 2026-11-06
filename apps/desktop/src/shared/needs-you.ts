import { needsYouKind, needsYouNow, questionPrompt, type Agent, type AgentAsk, type AgentStepsWait, type NeedsYouKind, type NeedsYouShows, type PermissionPrompt, type PromptQuestion } from '@agent-board/daemon/protocol';
import { isOpenPullRequest } from '@agent-board/daemon/gate-rules';

/** Longest tool summary shown; the full input is in the agent's terminal. */
const MAX_SUMMARY_LENGTH = 300;

/** An agent in the needs-you inbox, and why it is there. */
export interface NeedsYouEntry {
  agent: Agent;
  kind: NeedsYouKind;
  /** When it began asking: its first permission prompt, its question or plan, its flag, or its turn's end. */
  since: string;
}

/** When the agent began asking for what puts it in the inbox. */
function askedSince(agent: Agent, kind: NeedsYouKind): string {
  switch (kind) {
    case 'permission':
      return agent.permissions.map((prompt) => prompt.requestedAt).sort()[0] ?? agent.finishedAt ?? agent.createdAt;
    case 'asks':
      return agent.ask?.askedAt ?? questionPrompt(agent)?.requestedAt ?? agent.createdAt;
    case 'plan':
      return agent.plan!.presentedAt;
    case 'steps':
    case 'todo':
      return agent.stepsWait!.since;
    case 'flagged':
      return agent.flag!.at;
    case 'turn':
      return agent.finishedAt ?? agent.createdAt;
  }
}

/**
 * The needs-you inbox, oldest first (`needsYouKind`): what agents asked for (permission prompts, questions, plans and
 * flags to the user) and, with `turns`, every live agent waiting at its prompt too.
 */
export function needsYouEntries(agents: readonly Agent[], shows: NeedsYouShows): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = [];
  for (const agent of agents) {
    const kind = needsYouKind(agent, shows);
    if (kind !== null) entries.push({ agent, kind, since: askedSince(agent, kind) });
  }
  return entries.sort((a, b) => a.since.localeCompare(b.since));
}

/** Why a row is in the Simplified design's list: a needs-you request, changes ready to accept, or a problem. */
export type NeedsYouRowKind = NeedsYouKind | 'accept' | 'problem';

/** A row of the Simplified design's list: one agent, why it is there, and since when. */
export interface NeedsYouRow {
  agent: Agent;
  kind: NeedsYouRowKind;
  since: string;
}

/** One section of the Simplified design's list, with its rows oldest first. */
export interface NeedsYouSection {
  id: 'continues' | 'reaching-out' | 'accept' | 'problems';
  title: string;
  rows: NeedsYouRow[];
}

/** The sections in their order, and the kinds each holds: what unblocks an agent's work, then what an agent asks of you. */
const SECTIONS: readonly (Omit<NeedsYouSection, 'rows'> & { kinds: readonly NeedsYouRowKind[] })[] = [
  { id: 'continues', title: 'Continues the work', kinds: ['permission', 'plan', 'todo'] },
  { id: 'reaching-out', title: 'Reaching out to you', kinds: ['asks', 'steps', 'flagged', 'turn'] },
  { id: 'accept', title: 'Ready for you to accept', kinds: ['accept'] },
  { id: 'problems', title: 'Problems', kinds: ['problem'] },
];

/** A crashed or stuck agent: one that failed, one a restart stopped, or one at its usage limit. */
export function isProblem(agent: Pick<Agent, 'state' | 'endedAt'>): boolean {
  return (agent.state === 'failed' && agent.endedAt !== null) || agent.state === 'stopped-by-restart' || agent.state === 'rate-limited';
}

/**
 * The key a failed agent's problem is dismissed by: the agent and when it ended, so a later failure of the same agent
 * is listed again. Undefined for a problem that can't be dismissed: one a restart stopped or at its usage limit stays
 * listed until it is got going again.
 */
export function problemKey(agent: Pick<Agent, 'sessionId' | 'state' | 'endedAt'>): string | undefined {
  return agent.state === 'failed' && agent.endedAt !== null ? `${agent.sessionId}@${agent.endedAt}` : undefined;
}

/**
 * Whether an agent's changes wait for the user to accept: an open pull request of a branch it owns, while it sits at
 * its prompt or has ended, asking for nothing. A crew member's go to its orchestrator, which takes its changes.
 */
export function readyToAccept(agent: Agent, shows: NeedsYouShows): boolean {
  if (needsYouKind(agent, shows) !== null || isProblem(agent) || agent.ledBy !== null) return false;
  if (!agent.ownsWorktree || agent.plainFolder || agent.branch === '') return false;
  const between = agent.endedAt !== null || agent.state === 'idle' || agent.state === 'waiting';
  return between && agent.pullRequests.some(isOpenPullRequest);
}

/**
 * Whether an accept clicked on `clicked` still stands when its moment comes, read from `now`, the agent as it is then:
 * still ready to accept, and no turn finished since. A reply sent meanwhile means the user wants more, not the merge.
 */
export function stillReadyToAccept(clicked: Pick<Agent, 'finishedAt'>, now: Agent | undefined, shows: NeedsYouShows): boolean {
  return now !== undefined && readyToAccept(now, shows) && now.finishedAt === clicked.finishedAt;
}

/**
 * The Simplified design's list: what continues the work (permission prompts and plans), what reaches out (questions,
 * flags and, with `turns`, finished turns), changes ready to accept, and problems, in that order, each oldest first,
 * with no empty section. An agent is listed once, under what it asks for first. A failed agent's problem the user
 * dismissed (`dismissed`, by `problemKey`) isn't listed. The requests are `needsYouEntries`
 * exactly; the changes and problems aren't requests, so they count toward no badge and raise no notification.
 */
export function needsYouSections(agents: readonly Agent[], shows: NeedsYouShows, dismissed: ReadonlySet<string> = new Set()): NeedsYouSection[] {
  const rows: NeedsYouRow[] = [...needsYouEntries(agents, shows)];
  for (const agent of agents) {
    if (readyToAccept(agent, shows)) rows.push({ agent, kind: 'accept', since: agent.workFinishedAt ?? agent.finishedAt ?? agent.createdAt });
    else if (needsYouKind(agent, shows) === null && isProblem(agent) && !dismissed.has(problemKey(agent) ?? '')) rows.push({ agent, kind: 'problem', since: agent.endedAt ?? agent.finishedAt ?? agent.createdAt });
  }
  rows.sort((a, b) => a.since.localeCompare(b.since));
  return SECTIONS.map(({ kinds, ...section }) => ({ ...section, rows: rows.filter((row) => kinds.includes(row.kind)) })).filter((section) => section.rows.length > 0);
}

/** The agents in the needs-you inbox, oldest first. */
export function needsYou(agents: readonly Agent[], shows: NeedsYouShows): Agent[] {
  return needsYouEntries(agents, shows).map((entry) => entry.agent);
}

/** How many agents need the user now: those in the inbox whose ask they haven't opened the session of yet. */
export function unseenCount(agents: readonly Agent[], shows: NeedsYouShows): number {
  return agents.filter((agent) => needsYouNow(agent, shows)).length;
}

/** The agent's prompts the inbox can still answer: the daemon holds their hooks. */
export function heldPrompts(agent: Agent): PermissionPrompt[] {
  return agent.permissions.filter((prompt) => prompt.heldUntil !== null);
}

/** Whole seconds, rounded up, until a held prompt's hold lapses to the terminal; 0 once it has. */
export function secondsLeft(prompt: PermissionPrompt, now: number): number {
  return prompt.heldUntil === null ? 0 : Math.max(0, Math.ceil((Date.parse(prompt.heldUntil) - now) / 1000));
}

/** How many of a set's questions are left for the user, in a few words. */
export function stepsLeftWords(wait: Pick<AgentStepsWait, 'open'>): string {
  return wait.open === 0 ? 'every answer in, ready to send' : wait.open === 1 ? '1 question for you' : `${wait.open} questions for you`;
}

/**
 * Names an agent's steps wait across updates: its card, and a to-do's step. The user's answers moving a set on keep
 * it, so a row, the strip and a notification stay as they were; another card, or another to-do, is new.
 */
export const stepsWaitKey = (wait: Pick<AgentStepsWait, 'kind' | 'itemId' | 'stepId'>): string => `${wait.kind}:${wait.itemId}:${wait.kind === 'todo' ? wait.stepId : ''}`;

/** What an agent waiting on a steps card asks, in a line: its set's questions left, or the user's to-do it waits on. */
export function stepsWaitLine(wait: AgentStepsWait): string {
  if (wait.kind === 'todo') return `Waits on your to-do: ${wait.text}`;
  const left = stepsLeftWords(wait);
  // The count first, so it survives a tile cutting the line short.
  return `${left[0]!.toUpperCase()}${left.slice(1)} · “${wait.title}”`;
}

/**
 * Where an ask is answered, if not by a click on its first question's options: on its steps card, once put on the
 * board, or from the chip on its agent's tile, for several questions. Undefined for one question, answered anywhere.
 */
export function askAnsweredElsewhere(ask: Pick<AgentAsk, 'card' | 'questions'>): string | undefined {
  if (ask.card !== null) return 'Answer it on its steps card on the board.';
  if (ask.questions.length > 1) return `${ask.questions.length} questions: answer them in Needs you or from the chip on its tile.`;
  return undefined;
}

/** What a permission prompt asks to do, in a line: a shell call's command, a file tool's path, or else its input. */
export function toolSummary(prompt: PermissionPrompt): string {
  const input = prompt.toolInput;
  let summary: string;
  if (prompt.questions !== null) summary = questionsLine(prompt.questions);
  else if (input === null || input === undefined) summary = '';
  else if (typeof input === 'object' && 'command' in input && typeof input.command === 'string') summary = input.command;
  else if (typeof input === 'object' && 'file_path' in input && typeof input.file_path === 'string') summary = input.file_path;
  else summary = JSON.stringify(input);
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

/** A question tool's questions in a line: each question with its options after it, "Which cache? (Redis · In memory)". */
function questionsLine(questions: readonly PromptQuestion[]): string {
  return questions.map(({ question, options }) => (options.length === 0 ? question : `${question} (${options.map((option) => option.label).join(' · ')})`)).join(' ');
}

/**
 * A held permission prompt's one timer line in the Simplified list: how long it has before the agent asks in its own
 * window instead, or that it does now, or, where the harness asks in its terminal while the hold lasts, that it asks
 * there too. It says no seconds countdown but the last minute's.
 */
export function permissionWaitLine(prompt: PermissionPrompt, agentName: string, now: number): string {
  if (prompt.asksInTerminal) return 'Its terminal asks too.';
  const seconds = secondsLeft(prompt, now);
  if (seconds <= 0) return `It waits for you in ${agentName}.`;
  const minutes = Math.ceil(seconds / 60);
  const span = seconds < 60 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `If you don't answer within ${span}, it waits for you in ${agentName}.`;
}

/** How long ago `at` was, roughly: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function sinceText(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * How long until `sinceText(at, …)` reads differently from what it reads at `now`, ms: the next whole minute since
 * `at`, at which its minutes, hours or days can turn over (and never between two). From before `at`, as a clock behind
 * the daemon's sees it, that is a minute after `at`.
 */
export function sinceTextChangesIn(at: string, now: number): number {
  const elapsed = now - Date.parse(at);
  // A time that doesn't parse reads the same ever after: look again in a minute, never at once.
  if (!Number.isFinite(elapsed)) return 60_000;
  return elapsed < 0 ? 60_000 - elapsed : 60_000 - (elapsed % 60_000);
}

/**
 * Calls `onTick` with the time now at once, and again each time `sinceText(at, …)` would read differently, until the
 * returned stop is called: the clock behind a line that says how long ago `at` was.
 */
export function startSinceClock(at: string, onTick: (now: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    const now = Date.now();
    onTick(now);
    timer = setTimeout(tick, sinceTextChangesIn(at, now));
  };
  tick();
  return () => clearTimeout(timer);
}

/**
 * How much longer a question or plan waits for the user, until `expiresAt`: "28 more minutes", rounded up,
 * then the seconds of its last minute.
 */
export function waitLeft(expiresAt: string, now: number): string {
  const seconds = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (seconds <= 0) return 'no longer';
  if (seconds < 60) return `${seconds} more second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} more minute${minutes === 1 ? '' : 's'}`;
}
