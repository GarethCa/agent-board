// Whether an agent's pane shows its terminal, its chat or its timeline, remembered per session: one choice for its
// session window, pop-out and expanded tile, so switching in one carries to the others. A session with no pick shows
// the view windows open on: the terminal, or under the Simplified design the one its setting names.
//
// The one place it lives is the app's local storage, shared by every window of the app. It is read each time and never
// held between reads, so a window with no session open still sees what a pop-out picked, and a write changes only its
// own session's entry in what is stored now. Until the first pick is stored, the chats picked before there were three
// views are read from where they were kept, which is never written, so an older build still finds them.

import { useCallback, useSyncExternalStore } from 'react';

/**
 * What an agent's session shows of it: its terminal (the harness's own TUI), its conversation as a chat, or (under the
 * Simplified design) its conversation as a timeline rail.
 */
export const SESSION_VIEWS = ['chat', 'timeline', 'terminal'] as const;
export type SessionView = (typeof SESSION_VIEWS)[number];

const STORAGE_KEY = 'agent-board.session-views';
/** The ids of the chats picked, as kept before there were three views. */
const OLD_KEY = 'agent-board.chat-sessions';

type Picks = ReadonlyMap<string, SessionView>;

/** The picks stored, parsed again only when the stored text changes. */
let parsed: { text: string | null; picks: Picks } = { text: null, picks: new Map() };
/** What this run keeps when storage can't be read or written: the choice then lasts as long as the app does. */
let unstored: Picks | undefined;
const listeners = new Set<() => void>();

const isView = (value: unknown): value is SessionView => SESSION_VIEWS.includes(value as SessionView);

/** The stored text's picks: a session id to its view, or, as kept before there were three views, the ids of chats. */
function parse(text: string | null): Picks {
  const picks = new Map<string, SessionView>();
  try {
    const stored: unknown = JSON.parse(text ?? '{}');
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string') picks.set(id, 'chat');
    if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [id, view] of Object.entries(stored)) if (isView(view)) picks.set(id, view);
    }
  } catch {
    // Unreadable text is no choices.
  }
  return picks;
}

function read(): Picks {
  if (unstored !== undefined) return unstored;
  let text: string | null;
  try {
    // The old list, until there is anything of its own.
    text = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_KEY);
  } catch {
    unstored = parsed.picks;
    return unstored;
  }
  if (text !== parsed.text) parsed = { text, picks: parse(text) };
  return parsed.picks;
}

function write(picks: Picks): void {
  const text = JSON.stringify(Object.fromEntries(picks));
  try {
    localStorage.setItem(STORAGE_KEY, text);
    parsed = { text, picks };
  } catch {
    unstored = picks;
  }
  for (const listener of listeners) listener();
}

/** The view picked for a session: `opensOn`, the terminal unless given, until one is. */
export function chosenView(sessionId: string | undefined, opensOn: SessionView = 'terminal'): SessionView {
  return (sessionId === undefined ? undefined : read().get(sessionId)) ?? opensOn;
}

/** Picks a session's view and tells every pane showing it. */
export function setChosenView(sessionId: string, view: SessionView): void {
  const picks = read();
  if (picks.get(sessionId) === view) return;
  write(new Map(picks).set(sessionId, view));
}

/** Forgets the choice of every session that is not in `live`: its agent has been deleted. */
export function forgetViewsExcept(live: readonly string[]): void {
  const keep = new Set(live);
  const picks = read();
  const kept = [...picks].filter(([id]) => keep.has(id));
  if (kept.length !== picks.size) write(new Map(kept));
}

/** Hears every change of any session's view, here or in another window of the app; returns how to stop. */
export function onSessionViews(listener: () => void): () => void {
  const fromOtherWindow = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === OLD_KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', fromOtherWindow);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', fromOtherWindow);
  };
}

/** A session's view and how to pick it, live across the windows of the app; `opensOn` until one is picked. */
export function useSessionView(sessionId: string | undefined, opensOn: SessionView = 'terminal'): [SessionView, (view: SessionView) => void] {
  const view = useSyncExternalStore(onSessionViews, () => chosenView(sessionId, opensOn), () => opensOn);
  const pick = useCallback((next: SessionView) => sessionId !== undefined && setChosenView(sessionId, next), [sessionId]);
  return [view, pick];
}
