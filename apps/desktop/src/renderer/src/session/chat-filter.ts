// Whether a chat shows the messages other agents sent, or only the user's own: chosen per chat from its toolbar, kept
// for this run. Every chat includes agents until it is told not to, and has the choice on its toolbar once it holds
// a message from one.

import { useSyncExternalStore } from 'react';

/** The sessions whose chat shows only the user's own messages. */
let onlyMine: ReadonlySet<string> = new Set();
/**
 * How many chats of each session hold a message another agent sent: a session can have its chat open twice (the
 * Captain's panel and its session window), and one closing must not take the choice from the other.
 */
let withAgents: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** `current` with `sessionId` in it or not, as `on` says; the same set when it already was. */
const setIn = (current: ReadonlySet<string>, sessionId: string, on: boolean): ReadonlySet<string> => {
  if (current.has(sessionId) === on) return current;
  const next = new Set(current);
  if (on) next.add(sessionId);
  else next.delete(sessionId);
  return next;
};

const tell = () => {
  for (const listener of listeners) listener();
};

/** Shows or hides the messages other agents sent in `sessionId`'s chat. */
export function setIncludeAgents(sessionId: string, include: boolean): void {
  onlyMine = setIn(onlyMine, sessionId, !include);
  tell();
}

/**
 * A chat of `sessionId` holds a message another agent sent, which is when its toolbar offers the choice. Returns how
 * to say it no longer does (it was closed, or the message is gone).
 */
export function holdAgentMessages(sessionId: string): () => void {
  const count = (by: number) => {
    const next = new Map(withAgents);
    const now = (next.get(sessionId) ?? 0) + by;
    if (now > 0) next.set(sessionId, now);
    else next.delete(sessionId);
    withAgents = next;
    tell();
  };
  count(1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    count(-1);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Whether `sessionId`'s chat shows the messages other agents sent, kept current as its toolbar changes. */
export function useIncludeAgents(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => !onlyMine.has(sessionId), () => true);
}

/** Whether a chat of `sessionId` holds a message another agent sent, or hides them: its toolbar then has the choice. */
export const hasAgentMessages = (sessionId: string): boolean => withAgents.has(sessionId) || onlyMine.has(sessionId);

/** `hasAgentMessages`, kept current as chats hold and drop messages. */
export function useHasAgentMessages(sessionId: string): boolean {
  return useSyncExternalStore(subscribe, () => hasAgentMessages(sessionId), () => false);
}
