// How every chat view shows an agent's states, one choice for the app: picked in Settings › Agents › Chat or from the switch
// over a chat, and heard by every window.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/**
 * The chat's styles: each call, permission, plan or limit a card in the stream; a timeline rail with a dot per
 * event; or the messages alone, finished calls as chips and one live line over the message box.
 */
export const CHAT_STYLES = ['cards', 'timeline', 'status-line'] as const;
export type ChatStyle = (typeof CHAT_STYLES)[number];

export const DEFAULT_CHAT_STYLE: ChatStyle = 'cards';

/** Each style's name, as Settings and the switch show it. */
export const CHAT_STYLE_LABELS: Record<ChatStyle, string> = { cards: 'Cards', timeline: 'Timeline', 'status-line': 'Status line' };

const stored = storedValue('agent-board.chat-style');

/** The stored style, or the default for none or one this version doesn't know. */
export function chatStyleOf(value: string | undefined): ChatStyle {
  return CHAT_STYLES.find((style) => style === value) ?? DEFAULT_CHAT_STYLE;
}

/** Picks the style for every chat, in every window. */
export function setChatStyle(style: ChatStyle): void {
  stored.set(style);
}

/** The chosen style, kept current as it is picked here or in another window. */
export function useChatStyle(): ChatStyle {
  return useSyncExternalStore(stored.subscribe, () => chatStyleOf(stored.get()), () => DEFAULT_CHAT_STYLE);
}
