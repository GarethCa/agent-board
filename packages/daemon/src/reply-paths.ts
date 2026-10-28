// Reply paths (ADR-0011): an agent that got a message from another agent may send back to it for a while, whatever its
// scope says. One way only: the receiver answers the sender, and its answer opens nothing back.
import type { OrchestrateScope } from './protocol.ts';

/** How long a receiver may answer a message: an hour by default, from the sender's latest message to it. */
const DEFAULT_REPLY_WINDOW_MS = 60 * 60 * 1000;

/** How far each scope reaches, to compare two; an agent that doesn't orchestrate reaches least. */
const RANK: Record<OrchestrateScope, number> = { zone: 0, repo: 1, board: 2 };
const rank = (scope: OrchestrateScope | null): number => (scope === null ? -1 : RANK[scope]);

export interface ReplyPathOptions {
  /** How long a path lasts from the message that opened it. */
  windowMs?: number;
  /** The time now, in ms: `Date.now` by default. */
  now?: () => number;
  /** The scope the agent orchestrates at now, null if none; undefined for one no longer on the board. */
  scopeOf(sessionId: string): OrchestrateScope | null | undefined;
}

export interface ReplyPaths {
  /** `sender` messaged `receiver` while orchestrating at `scope`: the receiver may answer it until the window ends. */
  open(receiver: string, sender: string, scope: OrchestrateScope): void;
  /**
   * Whether `receiver` may send to `to` as an answer: `to` messaged it within the window, and hasn't been let reach
   * wider since, so no answer goes to an orchestrator wider than the one that asked (G14).
   */
  has(receiver: string, to: unknown): boolean;
  /** Forgets every path to or from a removed agent. */
  forget(sessionId: string): void;
  /** How many paths are kept, expired ones included until they are next looked at: for tests. */
  size(): number;
}

export function createReplyPaths(options: ReplyPathOptions): ReplyPaths {
  const windowMs = options.windowMs ?? DEFAULT_REPLY_WINDOW_MS;
  const now = options.now ?? Date.now;
  /** Per receiver, per sender: when its path ends, and how far the sender reached as it asked. */
  const paths = new Map<string, Map<string, { until: number; rank: number }>>();

  const drop = (receiver: string, sender: string) => {
    const senders = paths.get(receiver);
    senders?.delete(sender);
    if (senders?.size === 0) paths.delete(receiver);
  };

  return {
    open(receiver, sender, scope) {
      const senders = paths.get(receiver) ?? new Map<string, { until: number; rank: number }>();
      paths.set(receiver, senders.set(sender, { until: now() + windowMs, rank: rank(scope) }));
    },

    has(receiver, to) {
      if (typeof to !== 'string') return false;
      const path = paths.get(receiver)?.get(to);
      if (path === undefined) return false;
      const scope = options.scopeOf(to);
      if (now() >= path.until || scope === undefined || rank(scope) > path.rank) {
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
