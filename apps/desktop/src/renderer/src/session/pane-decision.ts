import { useSyncExternalStore } from 'react';
import { planPending, type Agent, type AgentAsk, type PlanSummary } from '@agent-board/daemon/protocol';

/** A decision the agent waits on the user for, shown above the pane's composer under the Simplified design. */
export type PaneDecision = { kind: 'ask'; ask: AgentAsk } | { kind: 'plan'; plan: PlanSummary };

/** Names a decision across updates: its question's or its plan version's id, so a new one is never taken for an old. */
export const decisionId = (decision: PaneDecision): string => (decision.kind === 'ask' ? decision.ask.id : decision.plan.id);

/** What `agent` waits on the user for, as the Needs you inbox lists it: its question, then its plan still to be decided. */
function pendingDecisions(agent: Pick<Agent, 'ask' | 'plan'>): PaneDecision[] {
  return [...(agent.ask !== null ? [{ kind: 'ask', ask: agent.ask } as const] : []), ...(planPending(agent) ? [{ kind: 'plan', plan: agent.plan } as const] : [])];
}

/**
 * The decision the pane shows for `agent`: the first it waits on that the user hasn't put off ("Decide later", `deferred`
 * has its id). One put off stays pending, in Needs you and on its tile, and a new question or plan version shows again.
 */
export function paneDecision(agent: Pick<Agent, 'ask' | 'plan'>, deferred: ReadonlySet<string> = new Set()): PaneDecision | undefined {
  return pendingDecisions(agent).find((decision) => !deferred.has(decisionId(decision)));
}

/** The first decision `agent` waits on that the user put off, for the pane's line that brings it back. */
export function deferredDecision(agent: Pick<Agent, 'ask' | 'plan'>, deferred: ReadonlySet<string>): PaneDecision | undefined {
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
export const useDeferredDecisions = (): ReadonlySet<string> => useSyncExternalStore(subscribeDeferred, deferredDecisions);
