import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { NodeChange } from '@xyflow/react';
import type { TileMove } from '@agent-board/daemon/protocol';
import { isItemNode, type ItemNodeType } from './items/items';
import type { TileData, TileNodeType } from './tile';
import { isSessionTile, subjectOf, type BoardNode } from './tiles';

/** How far a pointer must move before a press on a node drags it, rather than clicks it, px. */
export const DRAG_THRESHOLD = 4;
/** How far an arrow key nudges a tile, and with Shift, px. */
const NUDGE = { step: 1, shifted: 10 };
/** How long nudging pauses before the tile's place is saved, ms. */
const NUDGE_SAVE_PAUSE_MS = 300;

/** The x and y an arrow key moves by. */
const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** Whether a key press or paste is typing into a field, rather than a board shortcut. */
export function isTyping(event: Event): boolean {
  const target = event.target as HTMLElement | null;
  return target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

interface TileMovesOptions {
  loaded: boolean;
  /** The board's nodes as rendered. */
  nodes: BoardNode[];
  /**
   * The nodes as last drawn, for listeners: moved clear of expanded tiles, so a nudge starts where a tile or
   * item is drawn, as a drag does.
   */
  shownRef: RefObject<BoardNode[]>;
  /** Moves made here the daemon hasn't saved yet, by node id: the board lays tiles out with them. */
  pending: RefObject<Map<string, TileMove>>;
  /** Lays the tiles out again. */
  relayout(): void;
  /** Asks the daemon to save the move of `tile`'s session, and takes in what it answers. */
  save(tile: TileData, move: TileMove): Promise<void>;
  report(action: string): (error: unknown) => void;
  /** React Flow's own handling of node changes. */
  applyNodeChanges(changes: NodeChange<BoardNode>[]): void;
  getZoom(): number;
  /** Records a nudge of the tile `nodeId` to `move`, for undoing it. */
  recordNudge(nodeId: string, tile: TileData, move: TileMove): void;
  /** Nudges a selected item to `to`, relative to its zone, and saves it. */
  nudgeItem(node: ItemNodeType, to: { x: number; y: number }): void;
  /** Hears of every move of the tile `nodeId`, however made: dropped, nudged, undone or put somewhere from a menu. */
  onMove(nodeId: string): void;
}

/**
 * Moving session tiles: by dragging, kept 1:1 under the pointer; by arrow keys; and saving where they land, at once
 * or once nudging pauses (saved anyway when the window goes). A tile the board slotted in has that place saved, so it
 * stays put as others move. A move shows at once; one the daemon refuses goes back.
 */
export function useTileMoves({
  loaded,
  nodes,
  shownRef,
  pending,
  relayout,
  save,
  report,
  applyNodeChanges,
  getZoom,
  recordNudge,
  nudgeItem,
  onMove,
}: TileMovesOptions) {
  const nudgers = useRef({ recordNudge, nudgeItem, onMove });
  nudgers.current = { recordNudge, nudgeItem, onMove };
  /** Per tile being nudged, its save waiting for the nudges to pause. */
  const nudgeSaves = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run(): void }>());
  /** Where the last press on the board was, in screen coordinates. */
  const pressedAt = useRef<{ x: number; y: number }>(undefined);
  /**
   * The nodes being dragged, and how far the pointer went before the drag began, in board units. React Flow takes the
   * grip from where the pointer crossed the drag threshold, so it would trail the pointer by that much.
   */
  const dragLag = useRef<{ ids: Set<string>; x: number; y: number }>(undefined);

  /**
   * Moves the tile `nodeId` (standing for `tile`'s session) to `move`, showing it there at once, and saves it:
   * straight away, or once `pauseMs` passes with no other move of it.
   */
  const moveTile = useCallback(
    (nodeId: string, tile: TileData, move: TileMove, pauseMs?: number) => {
      nudgers.current.onMove(nodeId);
      pending.current.set(nodeId, move);
      relayout();
      const run = async () => {
        nudgeSaves.current.delete(nodeId);
        try {
          await save(tile, move);
          // Unless it has moved again since. Laid out again by the state change the save made, once the board has it.
          if (pending.current.get(nodeId) === move) pending.current.delete(nodeId);
        } catch (error) {
          report(`move ${tile.label}`)(error);
          if (pending.current.get(nodeId) === move) {
            pending.current.delete(nodeId);
            relayout();
          }
        }
      };
      clearTimeout(nudgeSaves.current.get(nodeId)?.timer);
      if (pauseMs === undefined) void run();
      else nudgeSaves.current.set(nodeId, { timer: setTimeout(() => void run(), pauseMs), run: () => void run() });
    },
    [pending, relayout, save, report],
  );

  // Nudges still waiting are saved when the window goes (closed, reloaded, the app quits) or the board does.
  useEffect(() => {
    const flush = () => {
      for (const { timer, run } of [...nudgeSaves.current.values()]) {
        clearTimeout(timer);
        run();
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // A tile with no place yet was slotted in by the board: save that place, so it stays put as other tiles move.
  useEffect(() => {
    if (!loaded) return;
    for (const node of nodes) {
      if (!isSessionTile(node) || node.dragging === true) continue;
      if (subjectOf(node.data).position !== null || pending.current.has(node.id)) continue;
      moveTile(node.id, node.data, { zoneId: node.parentId ?? null, x: node.position.x, y: node.position.y });
    }
  }, [loaded, nodes, pending, moveTile]);

  // Arrow keys nudge the selected (or focused) tiles and items, 1px or with Shift 10px, but never while typing (a
  // terminal's input is a textarea). Caught before React Flow's own, which moves 5px and saves nothing.
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = ARROWS[event.key];
      if (direction === undefined || event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return;
      // Only with the board (or nothing) focused: a menu, dialog or the sidebar has its own use for arrows.
      const active = document.activeElement;
      if (active !== null && active !== document.body && active.closest('.react-flow') === null) return;
      const focused = active?.closest('.react-flow__node')?.getAttribute('data-id');
      const tiles = shownRef.current.filter(
        (node): node is TileNodeType =>
          isSessionTile(node) && node.draggable !== false && (node.selected === true || node.id === focused),
      );
      const items = shownRef.current.filter((node) => isItemNode(node) && (node.selected === true || node.id === focused)) as ItemNodeType[];
      if (tiles.length === 0 && items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? NUDGE.shifted : NUDGE.step;
      for (const tile of tiles) {
        const move = { zoneId: tile.parentId ?? null, x: tile.position.x + direction.x * step, y: tile.position.y + direction.y * step };
        nudgers.current.recordNudge(tile.id, tile.data, move);
        moveTile(tile.id, tile.data, move, NUDGE_SAVE_PAUSE_MS);
      }
      for (const item of items) {
        nudgers.current.nudgeItem(item, { x: item.position.x + direction.x * step, y: item.position.y + direction.y * step });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [loaded, shownRef, moveTile]);

  /** React Flow's node changes, with a drag's positions kept under the pointer, where it was pressed. */
  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      const lag = dragLag.current;
      if (lag === undefined) return applyNodeChanges(changes);
      applyNodeChanges(
        changes.map((change) =>
          change.type === 'position' && change.position !== undefined && lag.ids.has(change.id)
            ? { ...change, position: { x: change.position.x + lag.x, y: change.position.y + lag.y } }
            : change,
        ),
      );
    },
    [applyNodeChanges],
  );

  /** Hears a press on the board, where a drag may start. */
  const onPressed = useCallback((at: { x: number; y: number }) => {
    pressedAt.current = at;
    // A drag React Flow aborted (its node went) never stops: its lag mustn't outlive it. Not cleared on pointerup,
    // which comes before the mouseup that ends a drag.
    dragLag.current = undefined;
  }, []);

  /** Hears a drag of `dragged` begin, with the pointer at `at` (screen coordinates). */
  const onDragStart = useCallback(
    (at: { clientX: number; clientY: number } | undefined, dragged: readonly BoardNode[]) => {
      const from = pressedAt.current;
      if (from === undefined || at === undefined) return;
      const zoom = getZoom();
      dragLag.current = { ids: new Set(dragged.map((node) => node.id)), x: (at.clientX - from.x) / zoom, y: (at.clientY - from.y) / zoom };
    },
    [getZoom],
  );

  const onDragStop = useCallback(() => {
    dragLag.current = undefined;
  }, []);

  return { moveTile, onNodesChange, onPressed, onDragStart, onDragStop };
}
