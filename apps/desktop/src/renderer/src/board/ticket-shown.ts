// Which helper each ticket tile shows in place of its chat, by node id: picked by a click on the helper, put back by the
// tile's breadcrumb. Held for this window only, as what a pane shows is: a restart opens each tile on its chat, and so
// does a tile collapsed or gone.
import { useCallback, useSyncExternalStore } from 'react';

let shown: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the helper `sessionId` in the ticket tile `nodeId`, or its chat again for undefined. */
export function showInTicket(nodeId: string, sessionId: string | undefined): void {
  if (shown.get(nodeId) === sessionId) return;
  const next = new Map(shown);
  if (sessionId === undefined) next.delete(nodeId);
  else next.set(nodeId, sessionId);
  shown = next;
  for (const listener of listeners) listener();
}

/** Forgets what the tiles `nodeIds` show: each opens on its chat again. */
export function forgetTicketsShown(nodeIds: readonly string[]): void {
  if (!nodeIds.some((id) => shown.has(id))) return;
  shown = new Map([...shown].filter(([id]) => !nodeIds.includes(id)));
  for (const listener of listeners) listener();
}

/** The helper the ticket tile `nodeId` was asked to show, if any, and how to show another or the chat again. */
export function useTicketShown(nodeId: string): [string | undefined, (sessionId: string | undefined) => void] {
  const picked = useSyncExternalStore(subscribe, () => shown.get(nodeId), () => undefined);
  return [picked, useCallback((sessionId: string | undefined) => showInTicket(nodeId, sessionId), [nodeId])];
}
