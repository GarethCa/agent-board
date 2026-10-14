import { useSyncExternalStore } from 'react';

/** Per implementer, how many times its Review tab was asked for: a session window opens on it when this grows. */
let requests: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** Asks the implementer's session window, open or about to open, to show its Review tab. */
export function requestReviewTab(sessionId: string): void {
  requests = new Map(requests).set(sessionId, (requests.get(sessionId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** How many times the implementer's Review tab has been asked for: 0 until it first is. */
export function useReviewTabRequests(sessionId: string | undefined): number {
  return useSyncExternalStore(subscribe, () => (sessionId === undefined ? 0 : (requests.get(sessionId) ?? 0)));
}
