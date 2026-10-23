// Whether an agent's pane shows its terminal or its chat, remembered per session: one choice for its session window,
// pop-out and expanded tile, so switching in one carries to the others. Only a chat is stored; the terminal is the default.
//
// The one place it lives is the app's local storage, shared by every window of the app. It is read each time and never
// held between reads, so a window with no session open still sees what a pop-out picked, and a write changes only its
// own session's entry in what is stored now.

import { useCallback, useSyncExternalStore } from 'react';

/** What an agent's session shows of it: its terminal (the harness's own TUI) or its conversation as a chat. */
export type SessionView = 'terminal' | 'chat';

const STORAGE_KEY = 'agent-board.chat-sessions';

/** The ids stored, parsed again only when the stored text changes. */
let parsed: { text: string | null; ids: ReadonlySet<string> } = { text: null, ids: new Set() };
/** What this run keeps when storage can't be read or written: the choice then lasts as long as the app does. */
let unstored: ReadonlySet<string> | undefined;
const listeners = new Set<() => void>();

function read(): ReadonlySet<string> {
  if (unstored !== undefined) return unstored;
  let text: string | null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    unstored = parsed.ids;
    return unstored;
  }
  if (text === parsed.text) return parsed.ids;
  let ids = new Set<string>();
  try {
    const stored: unknown = JSON.parse(text ?? '[]');
    if (Array.isArray(stored)) ids = new Set(stored.filter((id): id is string => typeof id === 'string'));
  } catch {
    // Unreadable text is no choices.
  }
  parsed = { text, ids };
  return ids;
}

function write(ids: ReadonlySet<string>): void {
  const text = JSON.stringify([...ids]);
  try {
    localStorage.setItem(STORAGE_KEY, text);
    parsed = { text, ids };
  } catch {
    unstored = ids;
  }
  for (const listener of listeners) listener();
}

/** The view picked for a session: the terminal until its chat is. */
export function chosenView(sessionId: string | undefined): SessionView {
  return sessionId !== undefined && read().has(sessionId) ? 'chat' : 'terminal';
}

/** Picks a session's view and tells every pane showing it. */
export function setChosenView(sessionId: string, view: SessionView): void {
  const ids = read();
  if (ids.has(sessionId) === (view === 'chat')) return;
  const next = new Set(ids);
  if (view === 'chat') next.add(sessionId);
  else next.delete(sessionId);
  write(next);
}

/** Forgets the choice of every session that is not in `live`: its agent has been deleted. */
export function forgetViewsExcept(live: readonly string[]): void {
  const keep = new Set(live);
  const ids = read();
  const kept = [...ids].filter((id) => keep.has(id));
  if (kept.length !== ids.size) write(new Set(kept));
}

/** Hears every change of any session's view, here or in another window of the app; returns how to stop. */
export function onSessionViews(listener: () => void): () => void {
  const fromOtherWindow = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', fromOtherWindow);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', fromOtherWindow);
  };
}

/** A session's view and how to pick it, live across the windows of the app. */
export function useSessionView(sessionId: string | undefined): [SessionView, (view: SessionView) => void] {
  const view = useSyncExternalStore(onSessionViews, () => chosenView(sessionId), () => 'terminal' as const);
  const pick = useCallback((next: SessionView) => sessionId !== undefined && setChosenView(sessionId, next), [sessionId]);
  return [view, pick];
}
