import { needsYouKind, needsYouNow, type Agent, type NeedsYouKind, type NeedsYouShows, type PermissionPrompt } from '@agent-board/daemon/protocol';

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
      return agent.ask!.askedAt;
    case 'plan':
      return agent.plan!.presentedAt;
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

/** What a permission prompt asks to do, in a line: a shell call's command, a file tool's path, or else its input. */
export function toolSummary(prompt: PermissionPrompt): string {
  const input = prompt.toolInput;
  let summary: string;
  if (input === null || input === undefined) summary = '';
  else if (typeof input === 'object' && 'command' in input && typeof input.command === 'string') summary = input.command;
  else if (typeof input === 'object' && 'file_path' in input && typeof input.file_path === 'string') summary = input.file_path;
  else summary = JSON.stringify(input);
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
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
