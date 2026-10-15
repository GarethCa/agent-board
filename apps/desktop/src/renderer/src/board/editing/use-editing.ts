import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { BoardItem, BoardItemKind, Connector, TileMove, UpdateItemParams, ZoneLayout } from '@agent-board/daemon/protocol';
import { commandKey, historyStep, inOverlay } from '../../keys';
import { boundsOnBoard, isItemNode, ITEM_NODE_PREFIX, placeOnBoard, type ItemNodeType } from '../items/items';
import type { TileData, TileNodeType } from '../tile';
import { compactSizeOf, isSessionTile, isZone, subjectOf, type BoardNode } from '../tiles';
import { isTyping } from '../use-tile-moves';
import type { Rect } from '../../geometry';
import { align, distribute, reorder, type Alignment, type Reorder } from './arrange';
import { BOARD_CLIPBOARD_TYPE, centreOf, copied, parseCopied, placed, plainText, serialiseCopied, type Copied } from './clipboard';
import { selectedNodes } from './selection';
import type { BoardHistory } from './use-history';

interface EditingOptions {
  loaded: boolean;
  /** The board's nodes and connectors as last rendered, and the connectors selected. */
  nodesRef: RefObject<BoardNode[]>;
  connectorsRef: RefObject<Connector[]>;
  selectedConnectorsRef: RefObject<ReadonlySet<string>>;
  history: BoardHistory;
  /** Where the node is on the board, at its measured size. */
  rectOf(nodeId: string): Rect | undefined;
  /** The zones as laid out now, bottom one first. */
  zoneLayouts(): (ZoneLayout & { id: string })[];
  /** The `z` above every item's. */
  topZ(): number;
  putItem(item: BoardItem): void;
  putConnector(connector: Connector): void;
  updateItem(params: UpdateItemParams): void;
  removeItem(id: string): void;
  removeConnector(id: string): void;
  moveTile(nodeId: string, tile: TileData, move: TileMove): void;
  /** Moves the zone's top-left corner to `at` on the board, and saves it. */
  moveZone(id: string, at: { x: number; y: number }): void;
  /** Selects the nodes `ids`, and nothing else; then the connectors `connectorIds`, if given. */
  select(ids: ReadonlySet<string>, connectorIds?: ReadonlySet<string>): void;
  /** Where a paste goes on the board: the pointer, or the middle of the view. */
  pasteAt(): { x: number; y: number };
  /** How far a duplicate is from what it copies, on each axis. */
  duplicateOffset: number;
  /** Shows why something failed. */
  report(action: string): (error: unknown) => void;
}

/** What the selection holds, for the context menu and the selection box. */
export interface SelectionSummary {
  /** The nodes selected, zones' contents left out when their zone is selected too (they go with it). */
  nodes: BoardNode[];
  items: ItemNodeType[];
  /** Whether it is one agent or shell tile, which can be renamed. */
  renamable: boolean;
  /** Whether a session tile is in it: deleted with a confirmation, but never copied or duplicated from here. */
  hasSessions: boolean;
  /** Whether a zone is in it: deleted with a confirmation, its tiles staying on the board. */
  hasZones: boolean;
  /** The item kinds in it. */
  kinds: Set<BoardItemKind>;
}

/** The nodes selected, with the ones whose zone is selected too left out: they move with it. */
function summarise(nodes: readonly BoardNode[]): SelectionSummary {
  const { all: selected, top } = selectedNodes(nodes);
  const items = selected.filter(isItemNode);
  return {
    nodes: top,
    items,
    renamable: top.length === 1 && isSessionTile(top[0]!) && (top[0].data.agent !== undefined || top[0].data.shell !== undefined),
    hasSessions: selected.some(isSessionTile),
    hasZones: selected.some(isZone),
    kinds: new Set(items.map((node) => node.data.item.kind)),
  };
}

/**
 * Editing the selection: select all, duplicate, copy, cut and paste, undo and redo, z-order, align and
 * distribute, colour, resetting rotation and delete, from the keyboard and the context menu. Sessions are moved, aligned and
 * reordered with the rest, but never copied or duplicated here; the board deletes them, after asking.
 */
export function useEditing(options: EditingOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** Whether the context menu's Copy is copying: the focus is still on its row then, which must not stop it. */
  const copyingFromMenu = useRef(false);

  const selection = useCallback(() => summarise(optionsRef.current.nodesRef.current), [optionsRef]);

  const selectAll = useCallback(() => {
    const { nodesRef, connectorsRef, select } = optionsRef.current;
    select(
      new Set(nodesRef.current.map((node) => node.id)),
      new Set(connectorsRef.current.map((connector) => connector.id)),
    );
  }, [optionsRef]);

  /** A copy of the selected items, where they are on the board, with the connectors between them. */
  const copySelection = useCallback((): Copied | undefined => {
    const { rectOf, connectorsRef } = optionsRef.current;
    const items = selection().items.flatMap((node) => {
      const rect = rectOf(node.id);
      return rect === undefined ? [] : [{ item: node.data.item, at: { x: rect.x, y: rect.y } }];
    });
    return items.length === 0 ? undefined : copied(items, connectorsRef.current);
  }, [optionsRef, selection]);

  /** Makes the copies, shifted by `shift`, on top of everything, each in the zone it lands in, and selects them. */
  const putCopies = useCallback(
    (copy: Copied, shift: { dx: number; dy: number }) => {
      const { zoneLayouts, topZ, putItem, putConnector, select } = optionsRef.current;
      const made = placed(copy, shift, () => crypto.randomUUID());
      const zones = zoneLayouts();
      const top = topZ();
      made.items.forEach(({ id, kind, x, y, width, height, rotation, data }, index) => {
        putItem({ id, kind, ...placeOnBoard({ x, y }, { width, height }, zones), width, height, rotation, data, z: top + index + 1, createdAt: '', updatedAt: '' });
      });
      for (const connector of made.connectors) putConnector({ ...connector, createdAt: '', updatedAt: '' });
      select(new Set(made.items.map((item) => `${ITEM_NODE_PREFIX}${item.id}`)));
    },
    [optionsRef],
  );

  const duplicate = useCallback(() => {
    const copy = copySelection();
    const offset = optionsRef.current.duplicateOffset;
    if (copy !== undefined) putCopies(copy, { dx: offset, dy: offset });
  }, [optionsRef, copySelection, putCopies]);

  /** Pastes `text` if it is a copy of board items, centred on where a paste goes; false if it isn't one. */
  const paste = useCallback(
    (text: string) => {
      const copy = parseCopied(text);
      if (copy === undefined || copy.items.length === 0) return false;
      const at = optionsRef.current.pasteAt();
      const centre = centreOf(copy);
      putCopies(copy, { dx: at.x - centre.x, dy: at.y - centre.y });
      return true;
    },
    [optionsRef, putCopies],
  );

  /** The ids of the selected items and connectors now, for a delete that is confirmed, or waits, later. */
  const selectedForDelete = useCallback(
    () => ({ items: selection().items.map((node) => node.data.item.id), connectors: [...optionsRef.current.selectedConnectorsRef.current] }),
    [optionsRef, selection],
  );

  /** Deletes the selected items and connectors, or those of `picked` (`selectedForDelete`); sessions and zones (the board's to ask about) stay. */
  const deleteSelection = useCallback(
    (picked = selectedForDelete()) => {
      const { removeItem, removeConnector } = optionsRef.current;
      const going = new Set(picked.items);
      for (const id of picked.items) removeItem(id);
      // One joined to a deleted item goes with it.
      const connectors = optionsRef.current.connectorsRef.current.filter(
        (connector) => picked.connectors.includes(connector.id) && ![connector.from, connector.to].some((end) => end.type === 'item' && going.has(end.id)),
      );
      for (const connector of connectors) removeConnector(connector.id);
    },
    [optionsRef, selectedForDelete],
  );

  /** Brings the selected items and tiles forward or to the front, or sends them back, each among its own kind. */
  const restack = useCallback(
    (how: Reorder) => {
      const { nodesRef, updateItem, moveTile } = optionsRef.current;
      const picked = new Set(selection().nodes.map((node) => node.id));
      const items = nodesRef.current.filter(isItemNode);
      for (const [id, z] of reorder(
        items.map((node) => ({ id: node.id, z: node.data.item.z })),
        picked,
        how,
      )) {
        updateItem({ id: id.slice(ITEM_NODE_PREFIX.length), z });
      }
      const tiles = nodesRef.current.filter((node): node is TileNodeType => isSessionTile(node));
      const changes = reorder(
        tiles.map((node) => ({ id: node.id, z: subjectOf(node.data).position?.z ?? null })),
        picked,
        how,
      );
      for (const tile of tiles) {
        const z = changes.get(tile.id);
        if (z !== undefined) moveTile(tile.id, tile.data, { zoneId: tile.parentId ?? null, x: tile.position.x, y: tile.position.y, z });
      }
    },
    [optionsRef, selection],
  );

  /** Moves the node's top-left to `at` on the board, into the zone there for a tile or an item. */
  const moveNodeTo = useCallback(
    (node: BoardNode, at: { x: number; y: number }) => {
      const { zoneLayouts, updateItem, moveTile, moveZone } = optionsRef.current;
      if (isZone(node)) moveZone(node.id, at);
      else if (isItemNode(node)) {
        const size = { width: node.width ?? node.data.item.width, height: node.height ?? node.data.item.height };
        updateItem({ id: node.data.item.id, ...placeOnBoard(at, size, zoneLayouts()) });
      } else if (isSessionTile(node)) moveTile(node.id, node.data, placeOnBoard(at, compactSizeOf(node), zoneLayouts()));
    },
    [optionsRef],
  );

  /**
   * Moves the selection as `arrange` places it, from what each node takes up on the board: a rotated item lines up by
   * the box round it.
   */
  const arrange = useCallback(
    (arrangement: (boxes: (Rect & { id: string })[]) => Map<string, { x: number; y: number }>) => {
      const { rectOf } = optionsRef.current;
      const movable = selection().nodes;
      const rects = new Map(
        movable.flatMap((node) => {
          const rect = rectOf(node.id);
          return rect === undefined ? [] : [[node.id, { rect, bounds: boundsOnBoard(node, rect) }] as const];
        }),
      );
      const moves = arrangement([...rects].map(([id, { bounds }]) => ({ id, ...bounds })));
      for (const node of movable) {
        const at = moves.get(node.id);
        const { rect, bounds } = rects.get(node.id) ?? {};
        if (at !== undefined && rect !== undefined && bounds !== undefined) moveNodeTo(node, { x: at.x + rect.x - bounds.x, y: at.y + rect.y - bounds.y });
      }
    },
    [optionsRef, selection, moveNodeTo],
  );

  const alignSelection = useCallback((how: Alignment) => arrange((boxes) => align(boxes, how)), [arrange]);
  const distributeSelection = useCallback((axis: 'x' | 'y') => arrange((boxes) => distribute(boxes, axis)), [arrange]);

  /** Gives the selected items of `kind` the colour `value`. */
  const setColor = useCallback(
    (patch: (value: string) => Record<string, unknown>, kind: BoardItemKind, value: string) => {
      for (const node of selection().items) {
        if (node.data.item.kind === kind) optionsRef.current.updateItem({ id: node.data.item.id, data: patch(value) });
      }
    },
    [optionsRef, selection],
  );

  /** Turns the selected items back straight, as one undo step. */
  const resetRotation = useCallback(() => {
    for (const node of selection().items) {
      if (node.data.item.rotation !== 0) optionsRef.current.updateItem({ id: node.data.item.id, rotation: 0 });
    }
  }, [optionsRef, selection]);

  // The keyboard: undo and redo, select all, duplicate, z-order, and ⇧R to turn the selected items back straight. Never while typing (in a note, a field or a
  // terminal), nor in a dialog or menu, which have their own keys.
  useEffect(() => {
    if (!options.loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = commandKey(event);
      const key = event.key.toLowerCase();
      // A select has no undo of its own, and keeps focus after a pick: ⌘Z still undoes the pick.
      const undoingInSelect = (key === 'z' || key === 'y') && command && (event.target as HTMLElement | null)?.tagName === 'SELECT';
      if (event.altKey || (isTyping(event) && !undoingInSelect) || inOverlay()) return;
      const { history } = optionsRef.current;
      const run = (action: () => unknown) => {
        event.preventDefault();
        action();
      };
      const step = historyStep(event);
      if (step !== undefined) run(() => history[step]());
      else if (command && key === 'a' && !event.shiftKey) run(selectAll);
      else if (command && key === 'd' && !event.shiftKey) run(duplicate);
      else if (event.key === ']' && !event.shiftKey) run(() => restack(command ? 'forward' : 'front'));
      else if (event.key === '[' && !event.shiftKey) run(() => restack(command ? 'backward' : 'back'));
      else if (key === 'r' && event.shiftKey && !command && selection().items.some((node) => node.data.item.rotation !== 0)) run(resetRotation);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [options.loaded, optionsRef, selectAll, duplicate, restack, selection, resetRotation]);

  // Copy and cut put the selected items on the clipboard, for this board or another window's, and their text for
  // other apps; not while typing, or with text selected, which is copied as usual.
  useEffect(() => {
    if (!options.loaded) return;
    const copying = (event: ClipboardEvent) =>
      (copyingFromMenu.current || (!isTyping(event) && !inOverlay() && window.getSelection()?.isCollapsed !== false)) && selection().items.length > 0;
    // Copy and cut are only offered with something selectable; a handler that cancels this says there is.
    const offer = (event: ClipboardEvent) => {
      if (copying(event)) event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => {
      if (!copying(event) || event.clipboardData === null) return;
      const copy = copySelection();
      if (copy === undefined) return;
      event.preventDefault();
      event.clipboardData.setData(BOARD_CLIPBOARD_TYPE, serialiseCopied(copy));
      event.clipboardData.setData('text/plain', plainText(copy));
      if (event.type === 'cut') deleteSelection();
    };
    for (const type of ['beforecopy', 'beforecut']) document.addEventListener(type, offer as EventListener);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    return () => {
      for (const type of ['beforecopy', 'beforecut']) document.removeEventListener(type, offer as EventListener);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
    };
  }, [options.loaded, selection, copySelection, deleteSelection]);

  return {
    selection,
    selectAll,
    duplicate,
    paste,
    deleteSelection,
    selectedForDelete,
    restack,
    align: alignSelection,
    distribute: distributeSelection,
    setColor,
    resetRotation,
    /** Copies the selection as the keyboard does, for the context menu. */
    copy: () => {
      copyingFromMenu.current = true;
      try {
        document.execCommand('copy');
      } finally {
        copyingFromMenu.current = false;
      }
    },
  };
}
