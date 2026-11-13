import { useSyncExternalStore } from 'react';
import { planPending, type Agent, type AgentAsk, type PermissionPrompt, type PlanSummary } from '@agent-board/daemon/protocol';
import { dialogStatus } from '../board/quick-ask';

/** A decision the agent waits on the user for, shown above the pane's composer under the Simplified design. */
export type PaneDecision = { kind: 'permission'; prompt: PermissionPrompt } | { kind: 'ask'; ask: AgentAsk } | { kind: 'plan'; plan: PlanSummary };

/** What the pane reads of an agent: its question, plan and permission prompts. */
type Waiting = Pick<Agent, 'ask' | 'plan'> & { permissions?: readonly PermissionPrompt[] };

/** Names a decision across updates: its question's or its plan version's id, so a new one is never taken for an old. */
export const decisionId = (decision: PaneDecision): string => (decision.kind === 'permission' ? decision.prompt.id : decision.kind === 'ask' ? decision.ask.id : decision.plan.id);

/**
 * What `agent` waits on the user for: the permission prompts the board still holds the harness for (oldest first, as
 * their hold runs out and the terminal asks instead; one asking there already is the banner's), with Claude's question
 * dialog the board answers, until its call runs (what became of the answers shows there), then, as the Needs you inbox
 * lists them, its question and its plan still to be decided.
 */
function pendingDecisions(agent: Waiting): PaneDecision[] {
  const held = (agent.permissions ?? []).filter((prompt) => prompt.heldUntil !== null || dialogStatus(prompt) !== 'terminal').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  return [
    ...held.map((prompt): PaneDecision => ({ kind: 'permission', prompt })),
    ...(agent.ask !== null ? [{ kind: 'ask', ask: agent.ask } as const] : []), ...(planPending(agent) ? [{ kind: 'plan', plan: agent.plan } as const] : [])];
}

/**
 * The decision the pane shows for `agent`: the first it waits on that the user hasn't put off ("Decide later", `deferred`
 * has its id). One put off stays pending, in Needs you and on its tile, and a new question or plan version shows again.
 */
export function paneDecision(agent: Waiting, deferred: ReadonlySet<string> = new Set()): PaneDecision | undefined {
  return pendingDecisions(agent).find((decision) => !deferred.has(decisionId(decision)));
}

/**
 * Whether the agent's window shows the strip of the steps card it waits on, above its composer: whenever it waits on
 * one, but under the Simplified design's chat, where the pane shows one decision at a time, not while that shows one.
 */
export function showsStepsStrip(agent: Waiting & Pick<Agent, 'stepsWait'>, look: { simplified: boolean; chat: boolean }, deferred: ReadonlySet<string> = new Set()): boolean {
  if (agent.stepsWait === null) return false;
  return !(look.simplified && look.chat && paneDecision(agent, deferred) !== undefined);
}

/** The first decision `agent` waits on that the user put off, for the pane's line that brings it back. */
export function deferredDecision(agent: Waiting, deferred: ReadonlySet<string>): PaneDecision | undefined {
  return pendingDecisions(agent).find((decision) => deferred.has(decisionId(decision)));
}

// The decisions put off in this window, by id, kept while it runs: closing an agent's window or switching its view keeps
// them put off.
let deferred: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** Puts the decision `id` off, or (`off` false) brings it back. */
export function deferDecision(id: string, off = true): void {
  if (deferred.has(id) === off) return;
  const next = new Set(deferred);
  if (off) next.add(id);
  else next.delete(id);
  deferred = next;
  for (const listener of listeners) listener();
}

/** The decisions put off in this window now. */
export const deferredDecisions = (): ReadonlySet<string> => deferred;

export function subscribeDeferred(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The decisions put off in this window, followed as they change. */
export const useDeferredDecisions = (): ReadonlySet<string> => useSyncExternalStore(subscribeDeferred, deferredDecisions, deferredDecisions);
