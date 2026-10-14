import { webContents } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { DaemonEvent } from '@agent-board/daemon/protocol';

/** Sends a message on `channel` to every window: the board, session windows and popped-out ones. */
export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(channel, ...args);
  }
}

/**
 * Forwards each daemon event of one of `types` to every window on `channel`. Every window hears every change, so
 * boards stay in step.
 */
export function forwardEvents(
  daemon: Pick<DaemonLink, 'onEvent'>,
  types: readonly DaemonEvent['type'][],
  channel: string,
  send: (channel: string, event: DaemonEvent) => void = sendToAllWindows,
): void {
  daemon.onEvent((event) => {
    if (types.includes(event.type)) send(channel, event);
  });
}
