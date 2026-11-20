// A page's chat views that outlive their panes, with the same setting as its terminals (`kept-terminals.ts`). A chat view
// that leaves its pane (an expanded tile panned off screen) is parked whole, its conversation drawn and its scroll
// position held, so a pane mounted again for its session shows it at once rather than reading and drawing the
// transcript again. A parked one reads none of its transcript, though it still hears the board's stores (its sent
// messages, the chat settings, the agents that wrote to it). They follow the terminals' rules: past a limit the longest unseen is let
// go, a folded zone's are let go, and so are all of them when the setting is turned off. So is one whose agent is gone.
import { keptTerminals, type LetGoReason } from './kept-terminals';

/** A kept chat view, as far as keeping it goes. */
export interface KeptChat {
  /** Lets it go: unmounts it. */
  dispose(reason: LetGoReason): void;
}

export interface KeptChats<Chat extends KeptChat> {
  /**
   * The chat view to show in a pane of this session now: its parked one, or a new one, kept from here on. Undefined
   * while one already shows in another pane of the page: that pane builds one of its own, not kept.
   */
  show(sessionId: string): { chat: Chat; reused: boolean } | undefined;
  /** Parks the one that left its pane, as the most recently seen; one forgotten while it showed is let go instead. */
  park(sessionId: string): void;
  /** These are the sessions in folded zones now, all of them: their chat views are let go, as their terminals are. */
  fold(sessionIds: Iterable<string>): void;
  /** Its agent is gone: lets go of its chat view now if parked, or as it leaves its pane. */
  forget(sessionId: string, reason: LetGoReason): void;
  /** The setting was turned off: lets go of every parked chat view now, and of each that shows as it leaves its pane. */
  forgetAll(reason: LetGoReason): void;
  /** How many are parked. */
  parked(): number;
}

export function keptChats<Chat extends KeptChat>({ limit, make }: { limit: number; make(sessionId: string): Chat }): KeptChats<Chat> {
  /** Each kept chat view counts for one against the limit, as a terminal counts its bytes against its budget. */
  interface Held {
    chat: Chat;
    bytes(): number;
    dispose(reason: LetGoReason): void;
  }
  const store = keptTerminals<Held>({ budget: limit });

  return {
    show(sessionId) {
      const parked = store.take(sessionId);
      if (parked !== undefined) return { chat: parked.chat, reused: true };
      if (store.has(sessionId)) return undefined;
      const chat = make(sessionId);
      store.add(sessionId, { chat, bytes: () => 1, dispose: (reason) => chat.dispose(reason) });
      return { chat, reused: false };
    },
    park: (sessionId) => store.park(sessionId),
    fold: (sessionIds) => store.fold(sessionIds),
    forget: (sessionId, reason) => store.forget(sessionId, reason),
    forgetAll: (reason) => store.forgetAll(reason),
    parked: () => store.parked().count,
  };
}
