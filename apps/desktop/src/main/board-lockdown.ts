// What the board's own windows (the board, popped-out session windows, Settings) may ask the browser for. They share
// Electron's default session, which grants every permission unless told otherwise.
import type { Session } from 'electron';
import { denyEverything } from './web-lockdown';

/** The one permission the board's windows use: writing text to the clipboard (`navigator.clipboard.writeText`). */
const BOARD_PERMISSIONS = ['clipboard-sanitized-write'] as const;

/** Denies the board's session every permission but `BOARD_PERMISSIONS`, every device and every download. */
export function lockDownBoardSession(session: Session): void {
  denyEverything(session, BOARD_PERMISSIONS);
}
