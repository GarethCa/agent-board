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

/** What a ticket's pop-up keeps its one pick under: its chat's id, after this. */
const POP_UP_PREFIX = 'ticket:';

/**
 * What a pop-up's one Chat | Terminal pick is kept under, for every agent in it: a lone agent's is its session's own, so
 * its pop-out and expanded tile follow it; a ticket's is its own, its chat's pick moved into it as it first opens
 * (`adoptChatView`) and standing in until then.
 */
export function popUpViewKey(chat: { sessionId: string }, ticket: boolean): string {
  return ticket ? `${POP_UP_PREFIX}${chat.sessionId}` : chat.sessionId;
}

/** The key a body's agent pane reads its pick from: a pop-up's own, given one, else its session's. */
export function bodyViewKey(viewKey: string | undefined, sessionId: string | undefined): string | undefined {
  return viewKey ?? sessionId;
}

/** What a body's pane shows of a pick: the agent's own pane shows the pick, a shell (or a body with no agent) its terminal. */
export function paneShows(pick: SessionView, pane: { own: boolean; agent: boolean }): SessionView {
  return pane.own && pane.agent ? pick : 'terminal';
}

/** The session a key is of: its own, or a ticket pop-up's chat. */
const sessionOfKey = (key: string): string => (key.startsWith(POP_UP_PREFIX) ? key.slice(POP_UP_PREFIX.length) : key);

/** The view picked for a session (or a ticket's pop-up, its chat's until then): `opensOn`, the terminal unless given, until one is. */
export function chosenView(sessionId: string | undefined, opensOn: SessionView = 'terminal'): SessionView {
  if (sessionId === undefined) return opensOn;
  const picks = read();
  return picks.get(sessionId) ?? picks.get(sessionOfKey(sessionId)) ?? opensOn;
}

/** Picks a session's view and tells every pane showing it. */
export function setChosenView(sessionId: string, view: SessionView): void {
  const picks = read();
  if (picks.get(sessionId) === view) return;
  write(new Map(picks).set(sessionId, view));
}

/**
 * Moves a chat's own pick into its ticket's pop-up's key the first time that pop-up opens with none of its own, so
 * nobody's choice flips on the change: after that the pop-up's pick is its own. Nothing for any other key.
 */
export function adoptChatView(key: string): void {
  if (!key.startsWith(POP_UP_PREFIX)) return;
  const picks = read();
  const chat = picks.get(sessionOfKey(key));
  if (picks.has(key) || chat === undefined) return;
  write(new Map(picks).set(key, chat));
}

/** Forgets the choice of every session that is not in `live`, and of the ticket pop-ups of its chat: its agent has been deleted. */
export function forgetViewsExcept(live: readonly string[]): void {
  const keep = new Set(live);
  const picks = read();
  const kept = [...picks].filter(([id]) => keep.has(sessionOfKey(id)));
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
