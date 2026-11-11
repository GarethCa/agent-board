import { useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../../../shared/errors';
import { ContextMenu, MENU_FOCUS_RETURN_MS, useToast } from '../ui';
import { AgentContextMenu, type TileMenuBoard } from './agent-tile-menu';
import { endOfNode } from './connectors/endpoints';
import { boardEntries, selectionEntries, type ContextActions } from './editing/context-menu';
import type { useEditing } from './editing/use-editing';
import type { TileNodeType } from './tile';
import { isSessionTile, tileNodeId, type BoardNode } from './tiles';

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
  /** The node `nodeId` on the board as it is now. */
  nodeOf(nodeId: string): BoardNode | undefined;
  /** Puts a new clock at `at`, on the screen, and opens its editor. */
  addClock(at: { x: number; y: number }): void;
  /** Puts a new steps card of the user's at `at`, on the screen, ready to type its steps into. */
  addSteps(at: { x: number; y: number }): void;
  /** Adds a memory centred at `at`, a point on the screen. */
  addMemory(at: { x: number; y: number }): void;
  /** Adds a queue centred at `at`, a point on the screen. */
  addQueue(at: { x: number; y: number }): void;
  /** Opens the prompt box of a crew from the prefab named, its Zone on the one nearest `at`, a point on the screen. */
  startCrew(prefab: string, at: { x: number; y: number }): void;
  /** Opens the crew library, a crew from it starting on the zone nearest `at`. */
  crewLibrary(at: { x: number; y: number }): void;
  /** Whether the tile `nodeId` is a lead pinned top-left in its shelved zone; undefined for any other tile. */
  leadPinned(nodeId: string): boolean | undefined;
  /** Pins the lead tile `nodeId` top-left in its shelved zone again, or frees it to be a stack like any other. */
  setLeadPinned(nodeId: string, pinned: boolean): void;
}

/** Where a right-click was, on the screen. */
type MenuEvent = Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault'>;

/** The agent of an agent's tile, or undefined for any other node. */
const agentOf = (node: BoardNode | undefined) => (node !== undefined && isSessionTile(node) ? node.data.agent : undefined);

/**
 * Which menu a right-click on the selection `nodes`, with `connectors` connectors selected too, opens: the agent's own
 * when it is one agent's tile alone, else the selection's.
 */
export function menuFor(nodes: readonly BoardNode[], connectors: number): 'agent' | 'selection' {
  const [first, second] = nodes;
  return first !== undefined && second === undefined && connectors === 0 && agentOf(first) !== undefined ? 'agent' : 'selection';
}

/**
 * The board's context menu (WbTools): on the selection, on one agent's tile (its own menu, as its ⋯ has it), or on
 * empty board. Gives React Flow its three right-click handlers, `menu` to draw while one is open, and `tileBoard`,
 * what a tile's own menu does to it on the board.
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
  nodeOf,
  addClock,
  addSteps,
  addMemory,
  addQueue,
  startCrew,
  crewLibrary,
  leadPinned,
  setLeadPinned,
}: BoardMenuOptions) {
  const toasts = useToast();
  /** The context menu open, where it was asked for and on what: the selection, one agent's tile, or empty board. */
  const [contextMenu, setContextMenu] = useState<{ at: { x: number; y: number }; on: 'selection' | 'board' } | { at: { x: number; y: number }; on: 'agent'; nodeId: string }>();

  const [only, second] = editing.selection().nodes;
  const pinned = only === undefined || second !== undefined ? undefined : leadPinned(only.id);
  const contextActions: ContextActions = {
    ...editing,
    ...(pinned === undefined || only === undefined ? {} : { leadPin: { pinned, toggle: () => setLeadPinned(only.id, !pinned) } }),
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
    addSteps: () => {
      const at = contextMenu?.at;
      if (at !== undefined) setTimeout(() => addSteps(at), MENU_FOCUS_RETURN_MS);
    },
    addMemory: () => {
      const at = contextMenu?.at;
      if (at !== undefined) setTimeout(() => addMemory(at), MENU_FOCUS_RETURN_MS);
    },
    addQueue: () => {
      const at = contextMenu?.at;
      if (at !== undefined) setTimeout(() => addQueue(at), MENU_FOCUS_RETURN_MS);
    },
    startCrew: (prefab) => {
      const at = contextMenu?.at;
      if (at !== undefined) setTimeout(() => startCrew(prefab, at), MENU_FOCUS_RETURN_MS);
    },
    crewLibrary: () => {
      const at = contextMenu?.at;
      if (at !== undefined) setTimeout(() => crewLibrary(at), MENU_FOCUS_RETURN_MS);
    },
  };

  // A tile's own menu acts on that tile alone, whether or not it is selected.
  const tileBoardNow: TileMenuBoard = {
    askClaude: (nodeId) => {
      selectOnly(new Set([nodeId]));
      setTimeout(askClaude, MENU_FOCUS_RETURN_MS);
    },
    restack: (nodeId, how) => editing.restack(how, new Set([nodeId])),
    joinable: (nodeId) => {
      const node = nodeOf(nodeId);
      return node !== undefined && endOfNode(node, 'right') !== undefined;
    },
    onBoard: (sessionId) => nodeOf(tileNodeId('agent', sessionId)) !== undefined,
    connectFrom,
    leadPinned,
    setLeadPinned,
    copy: (text, what) =>
      void navigator.clipboard.writeText(text).then(
        () => toasts.show({ tone: 'info', message: `${what} copied` }),
        (error: unknown) => toasts.show({ tone: 'error', message: `Could not copy it: ${errorMessage(error)}` }),
      ),
  };
  // One object for the board's life, calling the latest of each, so the context round every tile never changes.
  const tileBoardRef = useRef(tileBoardNow);
  tileBoardRef.current = tileBoardNow;
  const tileBoard = useMemo<TileMenuBoard>(
    () => ({
      askClaude: (nodeId) => tileBoardRef.current.askClaude(nodeId),
      restack: (nodeId, how) => tileBoardRef.current.restack(nodeId, how),
      joinable: (nodeId) => tileBoardRef.current.joinable(nodeId),
      onBoard: (sessionId) => tileBoardRef.current.onBoard(sessionId),
      connectFrom: (nodeId) => tileBoardRef.current.connectFrom(nodeId),
      leadPinned: (nodeId) => tileBoardRef.current.leadPinned(nodeId),
      setLeadPinned: (nodeId, pinned) => tileBoardRef.current.setLeadPinned(nodeId, pinned),
      copy: (text, what) => tileBoardRef.current.copy(text, what),
    }),
    [],
  );

  const close = () => setContextMenu(undefined);
  // The agent as it is now, so its rows follow it while the menu is open; gone with its tile, the menu closes.
  const menuAgent = contextMenu?.on === 'agent' ? agentOf(nodeOf(contextMenu.nodeId)) : undefined;
  const menu: ReactNode =
    contextMenu === undefined ? null : contextMenu.on === 'agent' ? (
      menuAgent !== undefined && (
        <AgentContextMenu
          nodeId={contextMenu.nodeId}
          agent={menuAgent}
          links={(nodeOf(contextMenu.nodeId) as TileNodeType).data}
          at={contextMenu.at}
          rename={() => setTimeout(() => requestRename(contextMenu.nodeId), MENU_FOCUS_RETURN_MS)}
          onClose={close}
        />
      )
    ) : (
      <ContextMenu
        at={contextMenu.at}
        label={contextMenu.on === 'board' ? 'Board' : 'Selection'}
        entries={
          contextMenu.on === 'board' ? boardEntries(contextActions) : selectionEntries(editing.selection(), selectedConnectors.size, contextActions)
        }
        onClose={close}
      />
    );

  /** The menu for the selection where it was right-clicked: an agent's own, when it is one agent's tile alone. */
  const openOnSelection = (at: { x: number; y: number }, nodes: readonly BoardNode[], connectors: number) => {
    const [first] = nodes;
    if (first !== undefined && menuFor(nodes, connectors) === 'agent') setContextMenu({ at, on: 'agent', nodeId: first.id });
    else setContextMenu({ at, on: 'selection' });
  };

  return {
    menu,
    tileBoard,
    onNodeContextMenu: (event: MenuEvent, node: BoardNode) => {
      event.preventDefault();
      const at = { x: event.clientX, y: event.clientY };
      if (node.selected === true) return openOnSelection(at, editing.selection().nodes, selectedConnectors.size);
      // On something not selected, the menu is for it alone: selecting it drops any connector selected before.
      selectOnly(new Set([node.id]));
      openOnSelection(at, [node], 0);
    },
    onSelectionContextMenu: (event: MenuEvent) => {
      event.preventDefault();
      openOnSelection({ x: event.clientX, y: event.clientY }, editing.selection().nodes, selectedConnectors.size);
    },
    onPaneContextMenu: (event: MenuEvent) => {
      event.preventDefault();
      setContextMenu({ at: { x: event.clientX, y: event.clientY }, on: 'board' });
    },
  };
}
