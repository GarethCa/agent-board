import { useEffect } from 'react';

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
 * Only the moment it appears counts: an ask that comes while it stays open is a new one, which needs the user again.
 */
export function useSeenWhileShown(sessionId: string | undefined, visible: boolean): void {
  useEffect(() => {
    if (sessionId === undefined || !visible) return;
    if (document.hasFocus()) markSeen(sessionId);
    const onFocus = () => markSeen(sessionId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [sessionId, visible]);
}
