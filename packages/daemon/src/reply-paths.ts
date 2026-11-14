// Reply paths (ADR-0011): an agent that got a message from another agent may send back to it for a while, even one it
// may not otherwise send to (one the user started by hand). One way only: the receiver answers the sender, and its
// answer opens nothing back.

/** How long a receiver may answer a message: an hour by default, from the sender's latest message to it. */
const DEFAULT_REPLY_WINDOW_MS = 60 * 60 * 1000;

export interface ReplyPathOptions {
  /** How long a path lasts from the message that opened it. */
  windowMs?: number;
  /** The time now, in ms: `Date.now` by default. */
  now?: () => number;
  /** Whether the agent is still on the board. */
  onBoard(sessionId: string): boolean;
}

export interface ReplyPaths {
  /** `sender` messaged `receiver`: the receiver may answer it until the window ends. */
  open(receiver: string, sender: string): void;
  /** Whether `receiver` may send to `to` as an answer: `to` messaged it within the window, and is still on the board. */
  has(receiver: string, to: unknown): boolean;
  /** Forgets every path to or from a removed agent. */
  forget(sessionId: string): void;
  /** How many paths are kept, expired ones included until they are next looked at: for tests. */
  size(): number;
}

export function createReplyPaths(options: ReplyPathOptions): ReplyPaths {
  const windowMs = options.windowMs ?? DEFAULT_REPLY_WINDOW_MS;
  const now = options.now ?? Date.now;
  /** Per receiver, per sender: when its path ends. */
  const paths = new Map<string, Map<string, number>>();

  const drop = (receiver: string, sender: string) => {
    const senders = paths.get(receiver);
    senders?.delete(sender);
    if (senders?.size === 0) paths.delete(receiver);
  };

  return {
    open(receiver, sender) {
      const senders = paths.get(receiver) ?? new Map<string, number>();
      paths.set(receiver, senders.set(sender, now() + windowMs));
    },

    has(receiver, to) {
      if (typeof to !== 'string') return false;
      const until = paths.get(receiver)?.get(to);
      if (until === undefined) return false;
      if (now() >= until || !options.onBoard(to)) {
        drop(receiver, to);
        return false;
      }
      return true;
    },

    forget(sessionId) {
      paths.delete(sessionId);
      for (const receiver of [...paths.keys()]) drop(receiver, sessionId);
    },

    size: () => [...paths.values()].reduce((total, senders) => total + senders.size, 0),
  };
}
