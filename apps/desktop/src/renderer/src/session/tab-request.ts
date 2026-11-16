import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Surface } from '@agent-board/daemon/window-layout';

/**
 * A tab a window is asked to show: `beside` in a pane of its own right of the focused one (⇧↵ in ⌘K), or of
 * `besideOf` once that is shown; else where it is or in the focused pane.
 */
export interface TabRequest {
  surface: Surface;
  beside: boolean;
  besideOf?: Surface;
}

/** Per agent, the tab its session window was last asked to show and hasn't yet: a shell tab, its own, or a pull request. */
let pending: ReadonlyMap<string, TabRequest> = new Map();
/** Per agent, how many tabs were asked for: its window shows its Terminal tab, over Review or Activity, as this grows. */
let counts: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * Asks the agent's session window, open or about to open, to show the tab (a row of its tile's shells chip),
 * or a pull request's, opening it in the focused pane if it isn't open (its tile's PR chip).
 */
export function requestTab(agentId: string, surface: Surface, options?: { beside?: boolean; besideOf?: Surface }): void {
  const besideOf = options?.besideOf;
  pending = new Map(pending).set(agentId, { surface, beside: options?.beside === true || besideOf !== undefined, ...(besideOf === undefined ? {} : { besideOf }) });
  counts = new Map(counts).set(agentId, (counts.get(agentId) ?? 0) + 1);
  notify();
}

/** The tab the agent's window was asked to show and hasn't yet, if any. */
export const pendingTab = (agentId: string | undefined): Surface | undefined => (agentId === undefined ? undefined : pending.get(agentId)?.surface);

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
export function useTabRequest(agentId: string | undefined, onRequest: (request: TabRequest) => void): void {
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
