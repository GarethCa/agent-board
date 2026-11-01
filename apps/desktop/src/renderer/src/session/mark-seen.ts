import { useEffect, useState } from 'react';
import { storedValue, type StoredValue } from '../stored-value';

const TOUCH_INTERVAL_MS = 1000;

/**
 * Calls `run` at once, then at most once per `interval`: a call inside the interval is held and runs when it ends, so
 * the last touch is never dropped.
 */
export function throttleTrailing(run: () => void, interval: number): { call(): void; cancel(): void } {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    last = Date.now();
    run();
  };
  return {
    call() {
      if (timer !== undefined) return;
      const wait = last + interval - Date.now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Opening or focusing an agent's session counts as seeing what it asks: the daemon stops it needing the user until it
 * asks again. Best effort: with the daemon down there is nothing to mark, and the user sees the ask as before.
 */
export function markSeen(sessionId: string): void {
  window.agentBoard.agents.markSeen(sessionId).catch(() => {});
}

/**
 * Marks the agent seen whenever its own pane becomes visible to the user in a window of the app that has the focus, and
 * whenever the app regains the focus while it is. The one place for "a session became visible": every way into a
 * session (a tile, ⌘K, the inbox, ‹ ›, the dock, a restored window) ends up showing it here, so none can forget.
 * An ask that comes while it stays open is a new one, which needs the user again: until the user next touches it (a
 * click in the window, which is looking at it; typing is answering, so a key does not), so a long session they keep open doesn't pile up asks.
 */
export function useSeenWhileShown(sessionId: string | undefined, visible: boolean): void {
  useEffect(() => {
    if (sessionId === undefined || !visible) return;
    if (document.hasFocus()) markSeen(sessionId);
    const onFocus = () => markSeen(sessionId);
    // Touching the open window: the daemon ignores it unless the agent is asking.
    const touch = throttleTrailing(() => markSeen(sessionId), TOUCH_INTERVAL_MS);
    const onTouch = () => touch.call();
    window.addEventListener('focus', onFocus);
    document.addEventListener('pointerdown', onTouch, true);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('pointerdown', onTouch, true);
      touch.cancel();
    };
  }, [sessionId, visible]);
}

/** The user's last look at the Needs-you list, kept in `store` as epoch ms. */
export function lastLookClock(store: StoredValue, now: () => number = Date.now): { since(): number; stamp(): void } {
  return {
    /** The last look, or now for the first look ever, when there is nothing to have missed. */
    since() {
      const stored = Number(store.get());
      return Number.isFinite(stored) && stored > 0 ? stored : now();
    },
    stamp: () => store.set(String(now())),
  };
}

const lastLook = lastLookClock(storedValue('agent-board.pane-last-looked'));

/**
 * The other half of "seen": for the whole Needs-you list, not one agent's ask. While the list is on screen it is the
 * user's last look. `since` is the look before this one, fixed for as long as the list stays up, so "since you last
 * looked" holds still while it is read; the look is stamped when the list opens, when it goes and when the window
 * unloads (a quit or reload runs no cleanup), so what happened while it was open is not shown to the user again.
 * `markSeen` moves `since` to now (Mark as seen).
 */
export function useSinceLastLooked(): { since: number; markSeen(): void } {
  const [since, setSince] = useState(lastLook.since);
  useEffect(() => {
    lastLook.stamp();
    window.addEventListener('pagehide', lastLook.stamp);
    return () => {
      window.removeEventListener('pagehide', lastLook.stamp);
      lastLook.stamp();
    };
  }, []);
  return {
    since,
    markSeen() {
      lastLook.stamp();
      setSince(lastLook.since());
    },
  };
}
