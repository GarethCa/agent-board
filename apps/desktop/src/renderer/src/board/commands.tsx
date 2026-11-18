import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { Surface } from '@agent-board/daemon/window-layout';

/** An agent's or a shell's tile, by its agent's session id or its shell's id. */
export interface TileRef {
  kind: 'agent' | 'shell';
  id: string;
}

/** What the rest of the window can ask the board to do: the board menu's session list, and ⌘K. */
export interface BoardCommands {
  /** Brings the tile the session belongs to into view and selects it. */
  focusSession(sessionId: string): void;
  /** Brings the board item (a clock, a queue) into view and selects it. */
  showItem(itemId: string): void;
  /** Opens the window of the tile the session belongs to; false if it belongs to none the board has. */
  openSession(sessionId: string): boolean;
  /**
   * Flies the board to the tile, centred at a size to read (jumps, with reduced motion), pulses it and selects it. Each
   * of these returns false when the board has no such tile or zone, and nothing happened.
   */
  showTile(tile: TileRef): boolean;
  /** Opens the tile as Enter on it does once selected: its session window, or expanded in place, as the setting says. */
  openTile(tile: TileRef): boolean;
  /**
   * Opens a pull request, page or session picked in ⌘K on the board, with nothing open: in the window of the agent whose
   * pull request it is, or `beside` (⇧↵) the agent selected, in a pane of its own there; else a pull request or page in
   * a window of its own. False for a session with nothing to be beside, for the caller to open as ↵ does.
   */
  openSurface(surface: Surface, beside: boolean): boolean;
  /** Whether ⇧↵ on the board opens the surface beside an agent's session, in a pane of its own, rather than as ↵ does. */
  opensBeside(surface: Surface): boolean;
  /** Shows the tile expanded in place of the expanded tile `fromNodeId`, which collapses, the focus in its terminal. */
  switchExpanded(fromNodeId: string, tile: TileRef): boolean;
  /** Brings the zone into view, collapsing the expanded tile `collapseNodeId` first, if given. */
  showZone(zoneId: string, collapseNodeId?: string): boolean;
  /** Opens the ticket's own board and shows the item on it. */
  showTicketItem(ticket: string, itemId: string): void;
  /** Whether there is a zone a new agent can start in from ⌘K. */
  canStartAgent(): boolean;
  /** Opens New agent with the name filled in: in the zone, if it can start there, else the one the board picks. */
  newAgentNamed(name: string, zoneId: string | null): void;
  /** Opens the prompt box of a crew from the prefab named, in the zone or the one in view; with no name, the library; with `describe`, Describe a crew. */
  startCrew(prefab: string | null, zoneId: string | null, describe?: boolean): void;
}

const BoardCommandsContext = createContext<RefObject<BoardCommands | undefined>>({ current: undefined });

/** Holds the board's commands for the components beside it. */
export function BoardCommandsProvider({ children }: { children: ReactNode }) {
  const commands = useRef<BoardCommands>(undefined);
  return <BoardCommandsContext value={commands}>{children}</BoardCommandsContext>;
}

/** The board's commands; each does nothing until the board has loaded. */
export function useBoardCommands(): BoardCommands {
  const commands = useContext(BoardCommandsContext);
  return useMemo(
    () => ({
      focusSession: (sessionId) => commands.current?.focusSession(sessionId),
      showItem: (itemId) => commands.current?.showItem(itemId),
      openSession: (sessionId) => commands.current?.openSession(sessionId) ?? false,
      showTile: (tile) => commands.current?.showTile(tile) ?? false,
      openTile: (tile) => commands.current?.openTile(tile) ?? false,
      openSurface: (surface, beside) => commands.current?.openSurface(surface, beside) ?? false,
      opensBeside: (surface) => commands.current?.opensBeside(surface) ?? false,
      switchExpanded: (fromNodeId, tile) => commands.current?.switchExpanded(fromNodeId, tile) ?? false,
      showZone: (zoneId, collapseNodeId) => commands.current?.showZone(zoneId, collapseNodeId) ?? false,
      showTicketItem: (ticket, itemId) => commands.current?.showTicketItem(ticket, itemId),
      canStartAgent: () => commands.current?.canStartAgent() ?? false,
      newAgentNamed: (name, zoneId) => commands.current?.newAgentNamed(name, zoneId),
      startCrew: (prefab, zoneId, describe) => commands.current?.startCrew(prefab, zoneId, describe),
    }),
    [commands],
  );
}

/** Makes `commands` the board's, while the calling component is mounted. */
export function useProvideBoardCommands(commands: BoardCommands | undefined): void {
  const holder = useContext(BoardCommandsContext);
  useEffect(() => {
    holder.current = commands;
    return () => {
      holder.current = undefined;
    };
  }, [holder, commands]);
}
