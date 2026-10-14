import { useCallback, useMemo, useRef } from 'react';
import type { BoardItem, Connector, FlowEdge, TileMove, ZoneLayout } from '@agent-board/daemon/protocol';
import type { RenameTarget } from '../rename';
import { emptyHistory, merged, record, redo, undo, withoutLastCreation, type History, type States, type Step } from './history';

/**
 * What one board object was or became, for the undo history: an item, a connector or a flow edge whole, a zone's
 * layout, a tile's place, or a tile's or pane's name. Sessions themselves are never in it: undo never starts, stops or
 * sends to one.
 */
export type BoardState =
  | { type: 'item'; item: BoardItem }
  | { type: 'connector'; connector: Connector }
  | { type: 'flowEdge'; edge: FlowEdge }
  | { type: 'zone'; layout: ZoneLayout }
  | { type: 'tile'; move: TileMove }
  | { type: 'name'; target: RenameTarget; name: string };

/** The history's key for each kind of object. */
export const historyKey = {
  item: (id: string) => `item:${id}`,
  connector: (id: string) => `connector:${id}`,
  flowEdge: (id: string) => `flow-edge:${id}`,
  zone: (id: string) => `zone:${id}`,
  tile: (nodeId: string) => `tile:${nodeId}`,
};

/** One object's change: its key, and what it was and became. */
export type Change = [key: string, before: BoardState | null, after: BoardState | null];

export interface BoardHistory {
  /**
   * Records changes the user made. Everything recorded in one task (one drop, one delete of a selection) is one step;
   * with `coalesce`, it merges into the last step with the same key made a moment before (the saves of one typing).
   * Changes made while undoing or redoing are not recorded.
   */
  record(changes: readonly Change[], coalesce?: string): void;
  /** Takes back the last step, or does the last undone one again; false if there was none. */
  undo(): boolean;
  redo(): boolean;
  /** Forgets the last step if all it did was make `key`'s object, for one made and at once taken away; true if it did. */
  forgetCreation(key: string): boolean;
}

/**
 * The board's undo history: in this window only, kept in memory. `apply` puts the objects back as given, by
 * calling the board's own actions, whose records are ignored meanwhile.
 */
export function useHistory(apply: (states: States<BoardState>) => void): BoardHistory {
  const history = useRef<History<BoardState>>(emptyHistory());
  /** What this task has recorded so far, recorded as one step once the task is over. */
  const pending = useRef<Step<BoardState>>(undefined);
  const replaying = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const flush = useCallback(() => {
    if (pending.current === undefined) return;
    history.current = record(history.current, pending.current);
    pending.current = undefined;
  }, []);

  return useMemo<BoardHistory>(() => {
    const replay = (result: ReturnType<typeof undo<BoardState>>) => {
      if (result === undefined) return false;
      history.current = result.history;
      replaying.current = true;
      try {
        applyRef.current(result.apply);
      } finally {
        replaying.current = false;
      }
      return true;
    };
    return {
      record(changes, coalesce) {
        if (replaying.current || changes.length === 0) return;
        const step: Step<BoardState> = {
          before: new Map(changes.map(([key, before]) => [key, before])),
          after: new Map(changes.map(([key, , after]) => [key, after])),
          coalesce,
          at: performance.now(),
        };
        if (pending.current === undefined) queueMicrotask(flush);
        pending.current = pending.current === undefined ? step : merged(pending.current, step);
      },
      undo() {
        flush();
        return replay(undo(history.current));
      },
      redo() {
        flush();
        return replay(redo(history.current));
      },
      forgetCreation(key) {
        flush();
        const before = history.current;
        history.current = withoutLastCreation(before, key);
        return history.current !== before;
      },
    };
  }, [flush]);
}
