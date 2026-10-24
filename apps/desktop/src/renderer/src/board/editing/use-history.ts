import { useCallback, useMemo, useRef } from 'react';
import type { ArrangeSpacing, BoardItem, Connector, FlowEdge, PaneLayout, ShellPlace, TileMove, UpdateItemParams, WindowOwner, Zone, ZoneLayout, ZoneSnapshot } from '@agent-board/daemon/protocol';
import type { Placement, Surface } from '@agent-board/daemon/window-layout';
import type { RenameTarget } from '../rename';
import { emptyHistory, merged, record, redo, undo, withoutLastCreation, type History, type States, type Step } from './history';

/**
 * What one board object was or became, for the undo history: an item, a connector or a flow edge whole, a zone's
 * layout or look, a zone as it was before it was deleted, a tile's place or size or whether it is unfolded from its chip, a tile's or pane's name, or where a shell or a pane of one is: a tab of
 * whose, at what order, or a tile on the board; a pane in a split as laid out, or alone in a shell; a pull request,
 * web or session tab in which window and where, or in none, with the window it is in at the other end of the
 * step, which it leaves when put back (`from`). Sessions
 * themselves are never in it: undo never starts, stops or sends to one, and moving a shell leaves its processes be.
 */
export type BoardState =
  | { type: 'item'; item: BoardItem }
  | { type: 'connector'; connector: Connector }
  | { type: 'flowEdge'; edge: FlowEdge }
  | { type: 'zone'; layout: ZoneLayout }
  | { type: 'zoneLook'; look: ZoneLook }
  | { type: 'zoneSpacing'; spacing: ArrangeSpacing }
  | { type: 'zoneGroup'; group: DissolvedGroup }
  | { type: 'tile'; move: TileMove }
  | { type: 'tileSize'; size: { width: number; height: number } }
  | { type: 'unfolded'; open: boolean }
  | { type: 'name'; target: RenameTarget; name: string }
  | { type: 'shellPlace'; to: ShellPlace; order: number | null }
  | { type: 'panePlace'; in: { shellId: string; layout: PaneLayout } }
  | { type: 'panePlace'; alone: { shellId: string; to: ShellPlace } }
  | { type: 'surfacePlace'; surface: Surface; in: { owner: WindowOwner; placement?: Placement } | null; from: WindowOwner | null };

/** What a zone's colour and fill opacity (null for the theme's own) were or became. */
export type ZoneLook = Pick<Zone, 'color' | 'fillOpacity'>;

/**
 * A zone before it was deleted: the zone itself, and where each of its tiles and items stood in it, so
 * that undoing the dissolve makes it again, under its own id, and puts them back, with the connectors it had. Nothing in it is a session: the tiles
 * are only moved.
 */
export interface DissolvedGroup {
  zone: ZoneSnapshot;
  tiles: { nodeId: string; at: { x: number; y: number } }[];
  items: { id: string; x: number; y: number }[];
  /** The connectors on the group itself, which go with it (the daemon deletes them with the zone). */
  connectors: Connector[];
}

/** The history's key for each kind of object. */
export const historyKey = {
  item: (id: string) => `item:${id}`,
  connector: (id: string) => `connector:${id}`,
  flowEdge: (id: string) => `flow-edge:${id}`,
  zone: (id: string) => `zone:${id}`,
  zoneLook: (id: string) => `zone-look:${id}`,
  zoneSpacing: (id: string) => `zone-spacing:${id}`,
  zoneGroup: (id: string) => `zone-group:${id}`,
  tile: (nodeId: string) => `tile:${nodeId}`,
  tileSize: (nodeId: string) => `tile-size:${nodeId}`,
  unfolded: (nodeId: string) => `unfolded:${nodeId}`,
  shell: (id: string) => `shell:${id}`,
  pane: (sessionId: string) => `pane:${sessionId}`,
  surface: (key: string) => `surface:${key}`,
};

/** One object's change: its key, and what it was and became. */
export type Change = [key: string, before: BoardState | null, after: BoardState | null];

/** `item` with the change in `patch` made, as the daemon will make it: its data merged, not replaced. */
export function patched(item: BoardItem, patch: UpdateItemParams): BoardItem {
  return { ...item, ...patch, data: patch.data === undefined ? item.data : { ...item.data, ...patch.data } };
}

/** An item's change by `patch`, such as a restyle or a new kind of shape, for the undo history. */
export const itemChange = (item: BoardItem, patch: UpdateItemParams): Change => [
  historyKey.item(item.id),
  { type: 'item', item },
  { type: 'item', item: patched(item, patch) },
];

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
