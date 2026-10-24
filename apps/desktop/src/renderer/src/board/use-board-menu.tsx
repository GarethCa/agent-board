import { useState, type ReactNode } from 'react';
import { ContextMenu, MENU_FOCUS_RETURN_MS } from '../ui';
import { boardEntries, selectionEntries, type ContextActions } from './editing/context-menu';
import type { useEditing } from './editing/use-editing';
import type { BoardNode } from './tiles';

interface BoardMenuOptions {
  /** Opens Ask Claude about the selection. */
  askClaude(): void;
  editing: ReturnType<typeof useEditing>;
  /** Deletes what is selected, asking first where it needs to. */
  deleteSelected(): void;
  /** The connectors selected, by id. */
  selectedConnectors: ReadonlySet<string>;
  /** Asks the tile `nodeId` to open its name field. */
  requestRename(nodeId: string): void;
  /** Waits for a click on the object to join `nodeId` to ("Connect to…"). */
  connectFrom(nodeId: string): void;
  /** Joins two nodes with a connector. */
  connectNodes(fromId: string, toId: string): void;
  grid: boolean;
  toggleGrid(): void;
  tidyLoose(): void;
  arrangeBoard(): void;
  /** Selects these nodes alone. */
  selectOnly(nodeIds: ReadonlySet<string>): void;
  /** Puts a new clock at `at`, on the screen, and opens its editor. */
  addClock(at: { x: number; y: number }): void;
}

/** Where a right-click was, on the screen. */
type MenuEvent = Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>;

/**
 * The board's context menu (WbTools): on the selection, or on empty board. Gives React Flow its three right-click
 * handlers, and `menu` to draw while one is open.
 */
export function useBoardMenu({
  askClaude,
  editing,
  deleteSelected,
  selectedConnectors,
  requestRename,
  connectFrom,
  connectNodes,
  grid,
  toggleGrid,
  tidyLoose,
  arrangeBoard,
  selectOnly,
  addClock,
}: BoardMenuOptions) {
  /** The context menu open, where it was asked for and on what: the selection, or empty board. */
  const [contextMenu, setContextMenu] = useState<{ at: { x: number; y: number }; on: 'selection' | 'board' }>();

  const contextActions: ContextActions = {
    ...editing,
    // After the menu has handed the focus back, or the popover's field would lose it at once.
    askClaude: () => setTimeout(askClaude, MENU_FOCUS_RETURN_MS),
    deleteSelection: deleteSelected,
    // After the menu has handed the focus back to where it was opened, or the field would lose it at once.
    rename: () => {
      const [node] = editing.selection().nodes;
      if (node !== undefined) setTimeout(() => requestRename(node.id), MENU_FOCUS_RETURN_MS);
    },
    // Two selected join at once; one waits for its other end.
    connect: () => {
      const [first, second] = editing.selection().nodes;
      if (first === undefined) return;
      if (second === undefined) connectFrom(first.id);
      else connectNodes(first.id, second.id);
    },
    grid,
    toggleGrid,
    tidyLoose,
    arrangeBoard,
    // Where the menu was opened, once it has handed the focus back.
    addClock: () => {
      const at = contextMenu?.at;
      if (at !== undefined) setTimeout(() => addClock(at), MENU_FOCUS_RETURN_MS);
    },
  };

  const menu: ReactNode = contextMenu !== undefined && (
    <ContextMenu
      at={contextMenu.at}
      label={contextMenu.on === 'board' ? 'Board' : 'Selection'}
      entries={
        contextMenu.on === 'board' ? boardEntries(contextActions) : selectionEntries(editing.selection(), selectedConnectors.size, contextActions)
      }
      onClose={() => setContextMenu(undefined)}
    />
  );

  return {
    menu,
    onNodeContextMenu: (event: MenuEvent, node: BoardNode) => {
      event.preventDefault();
      // On something not selected, the menu is for it alone.
      if (node.selected !== true) selectOnly(new Set([node.id]));
      setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'selection' });
    },
    onSelectionContextMenu: (event: MenuEvent) => {
      event.preventDefault();
      setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'selection' });
    },
    onPaneContextMenu: (event: MenuEvent) => {
      event.preventDefault();
      setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'board' });
    },
  };
}
