import { useSyncExternalStore } from 'react';
import { ACCEPT_AFTER_MS } from '../../../shared/accept';


/** Each agent's accept still to run: when it runs, and its timer. Kept outside React, so closing the list keeps it. */
const pending = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/**
 * Runs `accept` for the agent `afterMs` from now (`ACCEPT_AFTER_MS`, unless a test shortens it), unless it is undone
 * first. One already waiting for the agent stands: a second click doesn't accept twice, or put the first off.
 */
export function acceptLater(sessionId: string, accept: () => void, afterMs = ACCEPT_AFTER_MS): void {
  if (pending.has(sessionId)) return;
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    changed();
    accept();
  }, afterMs);
  pending.set(sessionId, { at: Date.now() + afterMs, timer });
  changed();
}

/** Cancels the agent's waiting accept, so nothing is merged; false when there was none. */
export function undoAccept(sessionId: string): boolean {
  const waiting = pending.get(sessionId);
  if (waiting === undefined) return false;
  clearTimeout(waiting.timer);
  pending.delete(sessionId);
  changed();
  return true;
}

/** When the agent's waiting accept runs, or undefined for none. */
export function pendingAccept(sessionId: string): number | undefined {
  return pending.get(sessionId)?.at;
}

/** Calls `listener` whenever an accept starts waiting, is undone or runs. Returns the unsubscribe function. */
export function onAcceptChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** When the agent's waiting accept runs, kept current. */
export function usePendingAccept(sessionId: string): number | undefined {
  return useSyncExternalStore(onAcceptChange, () => pendingAccept(sessionId));
}
