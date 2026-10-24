// The plans the user has changed in a Plan tab and not saved. A draft is its tab's own, in its window (the board's or a
// popped-out one), but every decision bar on that plan in every window (the tab's, the inbox's and the plan card's) is
// held while it stands, so a decision never drops it unseen. Each window marks its own drafts with main, which tells
// every window the plans held in any of them.
import { useSyncExternalStore } from 'react';
import { planEditKey } from '../../../shared/plan-edits';

/** The plans held in any window, as main last said, with this window's own marks applied at once. */
let held = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Takes main's word for every plan held now. */
export function heardUnsavedEdits(keys: readonly string[]): void {
  held = new Set(keys);
  notify();
}

/** The app's bridge to main, absent outside a window. */
const asks = () => (typeof window === 'undefined' ? undefined : window.agentBoard?.asks);

let following = false;
/** Starts following main's marks, once: every window's, and those already standing as this window opens. */
function follow(): void {
  const api = asks();
  if (following || api === undefined) return;
  following = true;
  api.onUnsavedEditsChanged(heardUnsavedEdits);
  api.unsavedEdits().then(heardUnsavedEdits, () => {});
}

/** Says whether this window's Plan tab holds a changed, unsaved draft of the agent's plan `planId`. */
export function markUnsavedEdit(sessionId: string, planId: string, changed: boolean): void {
  const key = planEditKey(sessionId, planId);
  if (held.has(key) !== changed) {
    held = new Set(held);
    if (changed) held.add(key);
    else held.delete(key);
    notify();
  }
  void asks()?.markUnsavedEdit(sessionId, planId, changed).catch(() => {});
}

export const hasUnsavedEdit = (sessionId: string, planId: string): boolean => held.has(planEditKey(sessionId, planId));

export function subscribeUnsavedEdits(listener: () => void): () => void {
  follow();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the agent's plan `planId` has an unsaved edit in a Plan tab of any window, followed as it changes. */
export const useUnsavedEdit = (sessionId: string, planId: string): boolean =>
  useSyncExternalStore(subscribeUnsavedEdits, () => hasUnsavedEdit(sessionId, planId));
