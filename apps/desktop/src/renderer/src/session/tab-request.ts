import { useEffect, useRef, useSyncExternalStore } from 'react';

/** Per agent, the tab its session window was last asked to show and hasn't yet: a shell's id, or the agent's own. */
let pending: ReadonlyMap<string, string> = new Map();
/** Per agent, how many tabs were asked for: its window shows its Terminal tab, over Review or Activity, as this grows. */
let counts: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Asks the agent's session window, open or about to open, to show the tab (a row of its tile's shells chip). */
export function requestTab(agentId: string, tabId: string): void {
  pending = new Map(pending).set(agentId, tabId);
  counts = new Map(counts).set(agentId, (counts.get(agentId) ?? 0) + 1);
  notify();
}

/** The tab the agent's window was asked to show and hasn't yet, if any. */
export const pendingTab = (agentId: string | undefined): string | undefined => (agentId === undefined ? undefined : pending.get(agentId));

/** How many tabs the agent's window has been asked for: 0 until it first is. */
export function useTabRequestCount(agentId: string | undefined): number {
  return useSyncExternalStore(subscribe, () => (agentId === undefined ? 0 : (counts.get(agentId) ?? 0)));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Hears the tabs the agent's window is asked to show: one asked for before it opened as it opens, and each later one as
 * it is asked. Each is heard once, by the first window to take it, so a window opened later shows its first tab.
 */
export function useTabRequest(agentId: string | undefined, onRequest: (tabId: string) => void): void {
  const requested = useSyncExternalStore(subscribe, () => (agentId === undefined ? undefined : pending.get(agentId)));
  const latest = useRef(onRequest);
  latest.current = onRequest;
  useEffect(() => {
    if (agentId === undefined || requested === undefined || pending.get(agentId) !== requested) return;
    const rest = new Map(pending);
    rest.delete(agentId);
    pending = rest;
    latest.current(requested);
    notify();
  }, [agentId, requested]);
}
