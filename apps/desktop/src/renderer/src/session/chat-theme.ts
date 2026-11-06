// Whether an agent's chat view matches the app or is always dark or light, one choice for the app: picked in Settings › Agents › Chat and heard by
// every window. A terminal stays dark whatever this says, and the Captain's panel follows the app's theme instead.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

export const CHAT_THEMES = ['match', 'dark', 'light'] as const;
export type ChatTheme = (typeof CHAT_THEMES)[number];

export const DEFAULT_CHAT_THEME: ChatTheme = 'match';

export const CHAT_THEME_LABELS: Record<ChatTheme, string> = { match: 'Match app', dark: 'Dark', light: 'Light' };

/** What each choice means, as Settings says it. */
export const CHAT_THEME_DETAILS: Record<ChatTheme, string> = {
  match: "An agent's chat in the app's own theme: light when the app is light, dark when it is dark. Terminals stay dark.",
  dark: "An agent's chat on the dark page a terminal has.",
  light: "An agent's chat on a light page, in Agent Board's own light colours whatever the app theme. Terminals stay dark.",
};

const stored = storedValue('agent-board.chat-theme');

/** The stored theme, or the default for none or one this version doesn't know. */
export function chatThemeOf(value: string | undefined): ChatTheme {
  return CHAT_THEMES.find((theme) => theme === value) ?? DEFAULT_CHAT_THEME;
}

/** Picks the theme for every agent's chat, in every window. */
export function setChatTheme(theme: ChatTheme): void {
  stored.set(theme);
}

/** The chosen theme, kept current as it is picked here or in another window. */
export function useChatTheme(): ChatTheme {
  return useSyncExternalStore(stored.subscribe, () => chatThemeOf(stored.get()), () => DEFAULT_CHAT_THEME);
}
