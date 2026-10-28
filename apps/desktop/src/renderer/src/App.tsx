import { Board } from './board/Board';
import { BoardCommandsProvider } from './board/commands';
import { DemoCursor } from './demo/DemoCursor';
import { SessionWindowsProvider } from './windows/SessionWindows';

/** The board, full-bleed, with the app's chrome floating over it (chrome C). */
export function App() {
  return (
    <SessionWindowsProvider>
      <BoardCommandsProvider>
        <Board />
        <DemoCursor />
      </BoardCommandsProvider>
    </SessionWindowsProvider>
  );
}
