import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';

/** What the rest of the window can ask the board to do: the board menu's session list. */
export interface BoardCommands {
  /** Brings the tile the session belongs to into view and selects it. */
  focusSession(sessionId: string): void;
  /** Opens the window of the tile the session belongs to; false if it belongs to none the board has. */
  openSession(sessionId: string): boolean;
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
      openSession: (sessionId) => commands.current?.openSession(sessionId) ?? false,
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
