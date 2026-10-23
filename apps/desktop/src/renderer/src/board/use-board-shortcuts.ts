import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { BoardItemKind } from '@agent-board/daemon/protocol';
import type { PointerMode } from '../chrome/CreateToolbar';
import { inOverlay } from '../keys';
import { pressed } from '../keys/registry';
import { boardKey, CONTROLS } from './board-shortcuts';
import { tileOpenAction, type ClickOpens } from './click-opens';
import type { SelectionSummary } from './editing/use-editing';
import { isItemNode } from './items/items';
import { isSessionTile } from './tiles';
import type { TileActions } from './tile';
import type { ArmedTool } from './ToolOverlay';
import { isTyping } from './use-tile-moves';

interface BoardShortcutsOptions {
  loaded: boolean;
  /** The tool armed for the next click or drag, which Escape puts down. */
  tool: ArmedTool | undefined;
  setTool: Dispatch<SetStateAction<ArmedTool | undefined>>;
  pickMode(mode: PointerMode): void;
  createItem(kind: BoardItemKind, centre: { x: number; y: number }): string;
  /** Where the pointer is on the screen, while it is over the board. */
  pointer: RefObject<{ x: number; y: number } | undefined>;
  boardCentre(): { x: number; y: number };
  screenToFlowPosition(point: { x: number; y: number }): { x: number; y: number };
  /** Collapses the expanded tile in front, if any. */
  collapseFrontTile(): void;
  selection(): SelectionSummary;
  clickOpens: ClickOpens;
  tileActions: TileActions;
  /** The tile F2 or the context menu asked to rename, until it opens its field: the keys are its name's meanwhile. */
  renameRequest: string | undefined;
  requestRename(nodeId: string): void;
  /** Cycles which connections are drawn. */
  cycleConnections(): void;
  /** Cycles how an orchestrator's crew is shown: frames, chips, off. */
  cycleCrewLook(): void;
  /** Opens the shape palette at `at` on the screen: where the pointer is, or undefined when it is off the board. */
  openQuickInsert(at: { x: number; y: number } | undefined): void;
  /** Opens the keyboard cheat sheet. */
  openCheatSheet(): void;
  /** Starts typing in the shape with `nodeId`. */
  typeInShape(nodeId: string): void;
}

/** The board's own keys: N, the tool keys, V, B, H, ⇧E, / and Escape; F2 to rename the one tile selected; and Enter to open it, or to type in a shape. */
export function useBoardShortcuts({
  loaded,
  tool,
  setTool,
  pickMode,
  createItem,
  pointer,
  boardCentre,
  screenToFlowPosition,
  collapseFrontTile,
  selection,
  clickOpens,
  tileActions,
  renameRequest,
  requestRename,
  cycleConnections,
  cycleCrewLook,
  openQuickInsert,
  openCheatSheet,
  typeInShape,
}: BoardShortcutsOptions) {
  // N adds a note at the pointer, or in the middle of the board when the pointer is off it. T, S, Z, A and ` arm the
  // text, shape, zone, agent and shell tools; Escape puts the armed one down. V selects and moves, B box-selects, H pans.
  // / puts any tool down and opens the shape palette at the pointer. ? opens the cheat sheet.
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = boardKey(event);
      if (shortcut === undefined) return;
      if (shortcut.kind === 'escape') {
        if (tool !== undefined) return setTool(undefined);
        // With the board (or nothing) focused, not a menu or dialog, which close on their own Escape.
        const active = document.activeElement;
        if (event.defaultPrevented || (active !== null && active !== document.body && active.closest('.react-flow') === null)) return;
        return collapseFrontTile();
      }
      // A popover or menu has the keyboard (a Needs-you button, say): its keys are its own, not the board's.
      if (inOverlay()) return;
      // F2 has asked a tile to open its name field, which is yet to take the keys: they are the name's, not a shortcut.
      if (renameRequest !== undefined) return;
      event.preventDefault();
      if (shortcut.kind === 'note') createItem('sticky', pointer.current === undefined ? boardCentre() : screenToFlowPosition(pointer.current));
      else if (shortcut.kind === 'tool') setTool((current) => (current === shortcut.tool ? undefined : shortcut.tool));
      else if (shortcut.kind === 'connections') cycleConnections();
      else if (shortcut.kind === 'crews') cycleCrewLook();
      else if (shortcut.kind === 'cheatSheet') openCheatSheet();
      else if (shortcut.kind === 'insert') {
        setTool(undefined);
        openQuickInsert(pointer.current);
      }
      else pickMode(shortcut.mode);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, tool, setTool, renameRequest, createItem, pointer, boardCentre, screenToFlowPosition, pickMode, collapseFrontTile, cycleConnections, cycleCrewLook, openQuickInsert, openCheatSheet]);

  // F2 renames the one agent or shell tile selected; its field opens where it is drawn (compact or expanded).
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('tile.rename', event) || event.metaKey || event.ctrlKey || isTyping(event)) return;
      const { nodes, renamable } = selection();
      if (!renamable) return;
      event.preventDefault();
      requestRename(nodes[0]!.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, selection, requestRename]);

  // Enter opens the one agent or shell tile selected, as a double-click does, or starts typing in the one shape.
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('tile.open', event) || event.metaKey || event.ctrlKey || isTyping(event)) return;
      // A focused control (a tile's button, a menu item) takes its own Enter, and so does anything in a window or dialog
      // open over the board (the selected tile is behind it). Only the board itself, or a tile on it, opens a tile.
      const target = event.target as HTMLElement;
      if (target.closest(CONTROLS) !== null || document.querySelector('[role="dialog"]') !== null) return;
      if (target !== document.body && target.closest('.react-flow') === null) return;
      const [node, ...rest] = selection().nodes;
      if (node !== undefined && rest.length === 0 && isItemNode(node) && node.data.item.kind === 'shape') {
        event.preventDefault();
        return typeInShape(node.id);
      }
      if (node === undefined || rest.length > 0 || !isSessionTile(node) || node.data.expanded === true) return;
      event.preventDefault();
      if (tileOpenAction(clickOpens, { hasWindow: node.data.external === undefined }) === 'window') tileActions.maximise(node.data);
      else tileActions.expand(node.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loaded, selection, clickOpens, tileActions, typeInShape]);
}
