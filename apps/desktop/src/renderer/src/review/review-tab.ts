import { useEffect, useRef, useSyncExternalStore } from 'react';

/** Per implementer, how many times its Review was asked for, and who is told when one is. */
function askCounts() {
  let counts: ReadonlyMap<string, number> = new Map();
  const listeners = new Set<() => void>();
  return {
    ask(sessionId: string) {
      counts = new Map(counts).set(sessionId, (counts.get(sessionId) ?? 0) + 1);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    now: () => counts,
  };
}

/** Asks of a session window: it opens on its Review tab when its count grows. */
const windowAsks = askCounts();
/** Asks of a pop-up already open, the board's or a popped-out window's: it goes to its Review view. */
const popUpAsks = askCounts();

/** Asks the implementer's session window, about to open, to show its Review tab. */
export function requestReviewTab(sessionId: string): void {
  windowAsks.ask(sessionId);
}

/** Asks the open pop-up that shows the implementer to open its Review view, or go to it. */
export function requestPopUpReview(sessionId: string): void {
  popUpAsks.ask(sessionId);
}

/** How many times the implementer's session window was asked for its Review tab: 0 until it first is. */
export function useReviewTabRequests(sessionId: string | undefined): number {
  return useSyncExternalStore(windowAsks.subscribe, () => (sessionId === undefined ? 0 : (windowAsks.now().get(sessionId) ?? 0)));
}

/** Where a tile's Open review goes: the window the implementer is popped out in, the board's pop-up that holds it, or its session window. */
export function reviewRoute(sessionId: string, popUpHolds: readonly string[], poppedOut: boolean): 'pop-out' | 'pop-up' | 'window' {
  if (poppedOut) return 'pop-out';
  return popUpHolds.includes(sessionId) ? 'pop-up' : 'window';
}

/** Which of `ids` was asked for since `seen`: the last of them whose count grew, or undefined. */
export function newlyAsked(seen: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>, ids: readonly string[]): string | undefined {
  return ids.findLast((id) => (now.get(id) ?? 0) > (seen.get(id) ?? 0));
}

/**
 * Calls `onAsked` with the one of `ids` whose Review a pop-up is asked for, each time one is after the pop-up mounts:
 * what was asked before it opened is left to the window it was asked of.
 */
export function useReviewTabAsked(ids: readonly string[], onAsked: (sessionId: string) => void): void {
  const now = useSyncExternalStore(popUpAsks.subscribe, popUpAsks.now, popUpAsks.now);
  const seen = useRef(now);
  const latest = useRef(onAsked);
  latest.current = onAsked;
  const key = ids.join(' ');
  useEffect(() => {
    const asked = newlyAsked(seen.current, now, key.split(' '));
    seen.current = now;
    if (asked !== undefined) latest.current(asked);
  }, [now, key]);
}
