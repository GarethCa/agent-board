// How an agent's conversation is shown under the Simplified design, until the agent has a view picked: as the chat, or
// in terminal style, the Timeline view's rail. One choice for the app, picked in Settings › Agents › Chat, and heard by
// every window.

import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';
import type { OpensOn } from './opens-on';
import type { SessionView } from './session-view';

/** The views the conversation can be shown as: the chat, or the timeline rail. */
export const CONVERSATION_AS = ['chat', 'timeline'] as const satisfies readonly SessionView[];
export type ConversationAs = (typeof CONVERSATION_AS)[number];

const DEFAULT_CONVERSATION_AS: ConversationAs = 'chat';

/** Each choice's name, as Settings shows it. */
export const CONVERSATION_AS_LABELS: Record<ConversationAs, string> = { chat: 'Chat', timeline: 'Terminal style' };

const stored = storedValue('agent-board.show-conversation-as');

/** The stored choice, or the default for none or one this version doesn't know. */
export function conversationAsOf(value: string | undefined): ConversationAs {
  return CONVERSATION_AS.find((view) => view === value) ?? DEFAULT_CONVERSATION_AS;
}

/** Picks how every agent's conversation is shown, in every window. */
export function setConversationAs(view: ConversationAs): void {
  stored.set(view);
}

/** The chosen way, kept current as it is picked here or in another window. */
export function useConversationAs(): ConversationAs {
  return useSyncExternalStore(stored.subscribe, () => conversationAsOf(stored.get()), () => DEFAULT_CONVERSATION_AS);
}

/** The view an agent's window opens on until one is picked: the terminal, or the conversation as it is shown. */
export function openingView(opensOn: OpensOn, conversationAs: ConversationAs): SessionView {
  return opensOn === 'terminal' ? 'terminal' : conversationAs;
}
