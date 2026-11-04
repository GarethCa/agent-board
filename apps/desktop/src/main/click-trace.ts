import { appendFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

/** What the board's window is doing, as a word for the log: where a notification's click finds it. */
export function describeBoard(window: BrowserWindow | undefined): string {
  if (window === undefined || window.isDestroyed()) return 'closed';
  if (window.isMinimized()) return 'minimised';
  if (!window.isVisible()) return 'hidden';
  return window.isFullScreen() ? 'full-screen' : 'visible';
}

/**
 * Notes in the daemon's log (`logPath`) that a notification was clicked, and the state of the board's window it found
 * and the count of windows open, so a second window that turns up leaves a trace. Never throws: a log that can't be
 * written must not stop the click from opening the agent.
 */
export function traceNotificationClick(logPath: string, sessionId: string, board: BrowserWindow | undefined, windows: number): void {
  try {
    appendFileSync(logPath, `[agent-board app] notification clicked: session ${sessionId}, board window ${describeBoard(board)}, ${windows} windows open\n`);
  } catch {
    // Nothing to do about it.
  }
}
