// Which view an agent's window opens on under the Simplified design, until the agent has one picked: one choice for
// the app, picked in Settings › Agents › Chat, and heard by every window. Classic always opens on the terminal.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';
import type { SessionView } from './session-view';

/** The views a window can open on: the chat, or the terminal for those who live in it. */
export const OPENS_ON = ['chat', 'terminal'] as const satisfies readonly SessionView[];
export type OpensOn = (typeof OPENS_ON)[number];

const DEFAULT_OPENS_ON: OpensOn = 'chat';

/** Each choice's name, as Settings shows it. */
export const OPENS_ON_LABELS: Record<OpensOn, string> = { chat: 'Chat', terminal: 'Terminal' };

const stored = storedValue('agent-board.agent-windows-open-on');

/** The stored choice, or the default for none or one this version doesn't know. */
export function opensOnOf(value: string | undefined): OpensOn {
  return OPENS_ON.find((view) => view === value) ?? DEFAULT_OPENS_ON;
}

/** Picks the view every agent's window opens on, in every window. */
export function setOpensOn(view: OpensOn): void {
  stored.set(view);
}

/** The chosen view, kept current as it is picked here or in another window. */
export function useOpensOn(): OpensOn {
  return useSyncExternalStore(stored.subscribe, () => opensOnOf(stored.get()), () => DEFAULT_OPENS_ON);
}
