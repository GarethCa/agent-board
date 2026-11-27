import { randomUUID } from 'node:crypto';
import { invalidParams, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import type { DaemonMethods, RemoveAsk, RemoveAskLeft, RemoveAskResult, RemoveAskTile } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { removeAskEndedText, removeAskFailedText, removeAskToldText } from './remove-ask-told.ts';

/**
 * The remove asks orchestrators put to the user: one per orchestrator at a time, held until the user decides
 * in the needs-you inbox or the wait times out. A call may wait on it; once none does (the orchestrator asked without
 * waiting, the call ended, or its next turn began), it is left, and how it ends is told to the orchestrator as a
 * message. It ends unanswered when the orchestrator's session ends (it is told so), the orchestrator is removed, or the
 * daemon stops (no one is told: asks are held in memory). The store only holds them: the
 * orchestrator host checks what may be asked and removes what the user allows (`orchestrators.ts`).
 */

/** How a remove ask ended: the user's decision, the timer, or nothing (the orchestrator, or the daemon, is going). */
export type RemoveAskEnd = { allow: boolean; include: readonly string[] } | 'timed-out' | null;

export interface RemoveAskStoreOptions {
  /** The orchestrator's tile changed: it began asking (`began`), or its ask was left or ended. */
  changed(sessionId: string, began: boolean): void;
  /** How an ask no call waits on ended, `text` to type at the orchestrator's prompt once it is there. */
  told(sessionId: string, text: string): void;
  /** The time now, in ms: `Date.now` by default. */
  now?(): number;
}

export interface RemoveAskStore {
  /**
   * Holds `tiles` as `sessionId`'s remove ask until it ends, as long as `ms`. `finish` turns how it ended into what
   * the orchestrator is told, removing what the user allowed. With `signal`, the call waits on the answer until the
   * signal aborts or `leave` is called; without it, or once it stops waiting, it resolves with the ask left. Refused
   * while it already asks.
   */
  ask(
    sessionId: string,
    tiles: RemoveAskTile[],
    ms: number,
    finish: (end: RemoveAskEnd) => Promise<RemoveAskResult>,
    signal?: AbortSignal,
    /** It asks to delete board items (each tile an item, by id), not tiles: withdrawn, not left, once its call stops. */
    items?: boolean,
  ): Promise<RemoveAskResult | RemoveAskLeft>;
  /** The remove ask `sessionId` has up, or null. */
  pending(sessionId: string): RemoveAsk | null;
  /**
   * The user's decision on `sessionId`'s ask `askId`: resolves with what the orchestrator is told, once what was allowed
   * is removed. Fails with `invalidParams` when that ask is no longer waiting, or `include` names a tile not in it.
   */
  decide(sessionId: string, askId: string, allow: boolean, include: readonly string[]): Promise<RemoveAskResult>;
  /** No call of `sessionId`'s waits on its ask now (its next turn began): the ask stays up, its answer told later. */
  leave(sessionId: string): void;
  /**
   * Ends `sessionId`'s ask with nothing removed, as its session ended: the user can't answer an ask whose orchestrator
   * isn't live. It is told so, for when it is resumed; a call still waiting on the ask returns with it left.
   */
  ended(sessionId: string): void;
  /** Ends `sessionId`'s ask with nothing removed, telling no one: it is going. */
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
  /** Stops the call waiting on it, if one does: it resolves with the ask left, and the answer is told later. */
  leave(): void;
  /** Ends the ask; the first call wins, and every call gets the same result. */
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
    ask(sessionId, tiles, ms, finish, signal, items = false) {
      if (held.has(sessionId)) throw invalidParams(`you already ask the user to ${held.get(sessionId)!.ask.items ? 'delete board items' : 'remove tiles'}: wait for that answer first`);
      const at = now();
      const ask: RemoveAsk = {
        id: randomUUID(),
        askedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ms).toISOString(),
        tiles,
        left: signal === undefined,
        ...(items ? { items: true as const } : {}),
      };
      return new Promise<RemoveAskResult | RemoveAskLeft>((resolve, reject) => {
        let result: Promise<RemoveAskResult> | undefined;
        // The call waiting on the answer, until it stops: then the answer is told.
        let waiting = signal !== undefined;
        const entry: Held = {
          ask,
          leave() {
            if (!waiting || result !== undefined) return;
            // An ask to delete board items is withdrawn with its call, as it always was: the call hears it ended.
            if (items) return void entry.settle(null).catch(() => undefined);
            waiting = false;
            signal?.removeEventListener('abort', leave);
            entry.ask = { ...entry.ask, left: true };
            options.changed(sessionId, false);
            resolve({ left: entry.ask });
          },
          settle(end) {
            if (result !== undefined) return result;
            clearTimeout(timer);
            signal?.removeEventListener('abort', leave);
            result = (async () => {
              try {
                return await finish(end);
              } finally {
                // Its tile stops asking once what was allowed is gone, so the inbox never shows a half-done ask.
                if (held.get(sessionId) === entry) held.delete(sessionId);
                options.changed(sessionId, false);
              }
            })();
            if (waiting) result.then(resolve, reject);
            // No call hears it: an answer or the timer is typed at its prompt; one that is going is told nothing.
            else if (end !== null) {
              result.then(
                (told) => options.told(sessionId, removeAskToldText(entry.ask, told)),
                (error: unknown) => options.told(sessionId, removeAskFailedText(entry.ask, error)),
              );
            }
            return result;
          },
        };
        const leave = () => entry.leave();
        const timer = setTimeout(() => void entry.settle('timed-out').catch(() => undefined), ms);
        held.set(sessionId, entry);
        options.changed(sessionId, true);
        if (signal === undefined) resolve({ left: ask });
        else if (signal.aborted) leave();
        else signal.addEventListener('abort', leave, { once: true });
      });
    },

    pending: (sessionId) => held.get(sessionId)?.ask ?? null,

    decide(sessionId, askId, allow, include) {
      const entry = held.get(sessionId);
      if (entry === undefined || entry.ask.id !== askId) return Promise.reject(invalidParams('that remove ask is no longer waiting: it was answered or timed out, or its orchestrator is gone'));
      const asked = new Set(entry.ask.tiles.map((tile) => tile.sessionId));
      const stray = include.find((sessionId) => !asked.has(sessionId));
      if (stray !== undefined) return Promise.reject(invalidParams(`${stray} is not in that remove ask`));
      return entry.settle({ allow, include });
    },

    leave(sessionId) {
      held.get(sessionId)?.leave();
    },

    ended(sessionId) {
      const entry = held.get(sessionId);
      if (entry === undefined) return;
      entry.leave();
      if (entry.ask.items !== true) options.told(sessionId, removeAskEndedText(entry.ask));
      void entry.settle(null).catch(() => undefined);
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
