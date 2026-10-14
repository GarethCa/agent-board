import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { CreateShellTileParams, SplitDirection, TileMove } from '@agent-board/daemon/protocol';
import { SHELL_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The shell tile IPC the preload's `shells` API calls. Every window hears every change, so tiles stay live. */
export function registerShellIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['shell.updated', 'shell.removed'], SHELL_IPC.changed);

  ipcMain.handle(SHELL_IPC.list, () => daemon.call('shell.list'));
  ipcMain.handle(SHELL_IPC.create, (_event, params: CreateShellTileParams) => daemon.call('shell.create', params));
  ipcMain.handle(SHELL_IPC.move, (_event, shellId: string, move: TileMove) => daemon.call('shell.move', { ...move, shellId }));
  ipcMain.handle(SHELL_IPC.split, (_event, shellId: string, sessionId: string, direction: SplitDirection, cwd?: string) =>
    daemon.call('shell.split', { shellId, sessionId, direction, ...(typeof cwd === 'string' ? { cwd } : {}) }),
  );
  ipcMain.handle(SHELL_IPC.resizeSplit, (_event, shellId: string, splitId: string, ratio: number) =>
    daemon.call('shell.resizeSplit', { shellId, splitId, ratio }),
  );
  ipcMain.handle(SHELL_IPC.closePane, (_event, shellId: string, sessionId: string) =>
    daemon.call('shell.closePane', { shellId, sessionId }),
  );
  ipcMain.handle(SHELL_IPC.resumePane, (_event, shellId: string, sessionId: string) =>
    daemon.call('shell.resumePane', { shellId, sessionId }),
  );
  ipcMain.handle(SHELL_IPC.setName, (_event, shellId: string, name: string) => daemon.call('shell.setName', { shellId, name }));
  ipcMain.handle(SHELL_IPC.setPaneName, (_event, shellId: string, sessionId: string, name: string | null) =>
    daemon.call('shell.setPaneName', { shellId, sessionId, name }),
  );
  ipcMain.handle(SHELL_IPC.delete, async (_event, shellId: string) => {
    await daemon.call('shell.delete', { shellId });
  });
}
