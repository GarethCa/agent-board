import { planPending, type Agent, type AgentAsk, type ChatEntry, type PermissionPrompt, type PlanSummary } from '@agent-board/daemon/protocol';
import { agentAtWork, msBetween, toolKind, type ChatItem, type ToolCall } from './chat';

/**
 * What the agent is doing now, as the end of its chat shows it, from its hooks (on the agent) and its transcript (the
 * items): what it waits on you for first (a permission prompt, a question, a plan), then its usage limit, compacting,
 * a failed turn, a call running, thinking; between turns, how its last turn ended (interrupted, or done and how long
 * it took). `since` is when it began, for a live count.
 */
export type LiveState =
  | { kind: 'permission'; prompt: PermissionPrompt; call?: ToolCall }
  | { kind: 'ask'; ask: AgentAsk; call?: ToolCall }
  | { kind: 'plan'; plan: PlanSummary; call?: ToolCall }
  | { kind: 'rate-limited' }
  | { kind: 'compacting'; since: string }
  | { kind: 'failed'; text: string }
  | { kind: 'tool'; call: ToolCall; since?: string }
  | { kind: 'thinking'; since?: string }
  | { kind: 'interrupted' }
  | { kind: 'done'; ms?: number };

/** The agent fields the live state reads. */
export type LiveFacts = Pick<Agent, 'state' | 'endedAt' | 'permissions' | 'ask' | 'plan' | 'compactingSince' | 'notice'>;

/**
 * The live state of the agent at the end of `items`, its chat, drawn from `entries`; undefined when there is nothing to
 * say (no turn yet). The times come from the entries, as the lines that start a turn aren't all items.
 */
export function liveState(agent: LiveFacts, items: readonly ChatItem[], entries: readonly ChatEntry[]): LiveState | undefined {
  const pending = pendingCalls(items);
  const prompt = agent.permissions[0];
  // A prompt's call is the latest one waiting with its tool; a subagent's call isn't in this transcript.
  if (prompt !== undefined) return { kind: 'permission', prompt, ...callOf(prompt.subagent === null ? pending.findLast((call) => call.name === prompt.toolName) : undefined) };
  if (agent.ask !== null) return { kind: 'ask', ask: agent.ask, ...callOf(pending.findLast((call) => toolKind(call.name) === 'ask')) };
  if (planPending(agent) && !agent.plan.left) return { kind: 'plan', plan: agent.plan, ...callOf(pending.findLast((call) => toolKind(call.name) === 'plan')) };
  if (agent.endedAt === null && agent.state === 'rate-limited') return { kind: 'rate-limited' };
  if (agent.endedAt === null && agent.compactingSince !== null) return { kind: 'compacting', since: agent.compactingSince };
  if (agent.state === 'failed') return { kind: 'failed', text: agent.notice ?? 'The turn failed.' };
  const last = items.at(-1);
  if (agentAtWork(agent)) {
    const running = pending.at(-1);
    if (running !== undefined) return { kind: 'tool', call: running, ...sinceOf(running.at) };
    // Thinking since the transcript last heard from it: a prompt, a tool's result, a background task's notification.
    return { kind: 'thinking', ...sinceOf(latestAt(entries)) };
  }
  if (last === undefined) return undefined;
  if (last.kind === 'interrupted') return { kind: 'interrupted' };
  if (last.kind !== 'assistant') return undefined;
  const ms = turnMs(entries);
  return { kind: 'done', ...(ms === undefined ? {} : { ms }) };
}

/** The latest time an entry was written: Claude stamps a message queued during a turn with when it was queued. */
function latestAt(entries: readonly ChatEntry[]): string | undefined {
  let latest: string | undefined;
  for (const { at } of entries) if (at !== undefined && (latest === undefined || Date.parse(at) > Date.parse(latest))) latest = at;
  return latest;
}

/**
 * How long the last turn took: as Claude counts it, when it wrote the turn's end after its last reply; otherwise from
 * the prompt or background task's notification that started it to that reply.
 */
function turnMs(entries: readonly ChatEntry[]): number | undefined {
  const reply = entries.findLastIndex((entry) => entry.kind === 'assistant');
  if (reply < 0) return undefined;
  const ended = entries.slice(reply + 1).findLast((entry): entry is Extract<ChatEntry, { kind: 'turn-ended' }> => entry.kind === 'turn-ended');
  if (ended !== undefined) return ended.ms;
  const start = entries.slice(0, reply).findLast((entry) => entry.kind === 'user' || entry.kind === 'notified');
  return msBetween(start?.at, entries[reply]!.at);
}

/** The key of the call a live state stands for, drawn as that state in its place rather than again at the end. */
export function liveCallId(live: LiveState | undefined): string | undefined {
  if (live === undefined) return undefined;
  if (live.kind === 'permission' || live.kind === 'ask' || live.kind === 'plan') return live.call?.id;
  return undefined;
}

/** The calls of the conversation's latest run of calls with no result yet: those that can still be running. */
function pendingCalls(items: readonly ChatItem[]): ToolCall[] {
  const last = items.at(-1);
  if (last?.kind !== 'tools') return [];
  return last.rows.filter((row): row is ToolCall => row.kind === 'call' && row.result === undefined);
}

function callOf(call: ToolCall | undefined): { call?: ToolCall } {
  return call === undefined ? {} : { call };
}

function sinceOf(at: string | undefined): { since?: string } {
  return at === undefined ? {} : { since: at };
}
