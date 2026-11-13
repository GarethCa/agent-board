import { randomUUID } from 'node:crypto';
import { invalidParams, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import type { DaemonMethods, RemoveAsk, RemoveAskResult, RemoveAskTile } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

/**
 * The remove asks orchestrators wait on: one per orchestrator at a time, held until the user decides in the
 * needs-you inbox, the wait times out, or the orchestrator stops waiting. The store only holds them: the orchestrator
 * host checks what may be asked and removes what the user allows (`orchestrators.ts`).
 */

/** How a remove ask ended: the user's decision, the timer, or nothing (the orchestrator stopped waiting: the call
 * waiting on it ended, or its next turn began). */
export type RemoveAskEnd = { allow: boolean; include: readonly string[] } | 'timed-out' | null;

export interface RemoveAskStoreOptions {
  /** The orchestrator's tile changed: it began asking (`began`), or stopped. */
  changed(sessionId: string, began: boolean): void;
  /** The time now, in ms: `Date.now` by default. */
  now?(): number;
}

export interface RemoveAskStore {
  /**
   * Holds `tiles` as `sessionId`'s remove ask until it ends, as long as `ms` or until `signal` aborts. `finish` turns how
   * it ended into what the orchestrator is told, removing what the user allowed. Refused while it already asks.
   */
  ask(sessionId: string, tiles: RemoveAskTile[], ms: number, signal: AbortSignal, finish: (end: RemoveAskEnd) => Promise<RemoveAskResult>): Promise<RemoveAskResult>;
  /** The remove ask `sessionId` waits on, or null. */
  pending(sessionId: string): RemoveAsk | null;
  /**
   * The user's decision on `sessionId`'s ask `askId`: resolves with what the orchestrator is told, once what was allowed
   * is removed. Fails with `invalidParams` when that ask is no longer waiting, or `include` names a tile not in it.
   */
  decide(sessionId: string, askId: string, allow: boolean, include: readonly string[]): Promise<RemoveAskResult>;
  /** Ends `sessionId`'s ask with nothing removed: its next turn began (a prompt typed or sent to it), or it is going. */
  drop(sessionId: string): void;
  /** Ends every ask with nothing removed: the daemon is going. */
  close(): void;
  /**
   * `removeAsk.decide`, the user's answer from the app. In no board list, so the guard refuses it to every board token
   * (`guardBoardCallers`): an orchestrator never answers its own ask.
   */
  handlers<Context>(): RpcHandlers<Pick<DaemonMethods, 'removeAsk.decide'>, Context>;
}

interface Held {
  ask: RemoveAsk;
  /** Ends the wait; the first call wins, and every call gets the same result. */
  settle(end: RemoveAskEnd): Promise<RemoveAskResult>;
}

/** What the orchestrator is told when the ask ends with no decision: nothing removed. */
export const keptAll = (tiles: readonly RemoveAskTile[], outcome: RemoveAskResult['outcome'], why: string): RemoveAskResult => ({
  outcome,
  removed: [],
  kept: tiles.map(({ sessionId, name }) => ({ sessionId, name, why })),
});

export function createRemoveAskStore(options: RemoveAskStoreOptions): RemoveAskStore {
  const now = options.now ?? Date.now;
  const held = new Map<string, Held>();

  const store: RemoveAskStore = {
    ask(sessionId, tiles, ms, signal, finish) {
      if (held.has(sessionId)) throw invalidParams('you already ask the user to remove tiles: wait for that answer first');
      const at = now();
      const ask: RemoveAsk = { id: randomUUID(), askedAt: new Date(at).toISOString(), expiresAt: new Date(at + ms).toISOString(), tiles };
      return new Promise<RemoveAskResult>((resolve, reject) => {
        let result: Promise<RemoveAskResult> | undefined;
        const entry: Held = {
          ask,
          settle(end) {
            if (result !== undefined) return result;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            result = (async () => {
              try {
                return await finish(end);
              } finally {
                // Its tile stops asking once what was allowed is gone, so the inbox never shows a half-done ask.
                if (held.get(sessionId) === entry) held.delete(sessionId);
                options.changed(sessionId, false);
              }
            })();
            result.then(resolve, reject);
            return result;
          },
        };
        const abort = () => void entry.settle(null).catch(() => undefined);
        const timer = setTimeout(() => void entry.settle('timed-out').catch(() => undefined), ms);
        held.set(sessionId, entry);
        options.changed(sessionId, true);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    },

    pending: (sessionId) => held.get(sessionId)?.ask ?? null,

    decide(sessionId, askId, allow, include) {
      const entry = held.get(sessionId);
      if (entry === undefined || entry.ask.id !== askId) return Promise.reject(invalidParams('that remove ask is no longer waiting: it was answered, timed out, or the orchestrator stopped waiting on it'));
      const asked = new Set(entry.ask.tiles.map((tile) => tile.sessionId));
      const stray = include.find((sessionId) => !asked.has(sessionId));
      if (stray !== undefined) return Promise.reject(invalidParams(`${stray} is not in that remove ask`));
      return entry.settle({ allow, include });
    },

    drop(sessionId) {
      void held.get(sessionId)?.settle(null).catch(() => undefined);
    },

    close() {
      for (const sessionId of [...held.keys()]) store.drop(sessionId);
    },

    handlers() {
      return {
        'removeAsk.decide': (params) => {
          const p = paramsObject(params);
          const allow = optionalBooleanParam(p, 'allow');
          if (allow === undefined) throw invalidParams('allow must be true or false');
          const include = p.include ?? [];
          if (!Array.isArray(include) || !include.every((id) => typeof id === 'string')) throw invalidParams('include must be a list of agent session ids');
          return store.decide(stringParam(p, 'sessionId'), stringParam(p, 'askId'), allow, include as string[]);
        },
      };
    },
  };
  return store;
}
