import { ipcMain } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { AGENT_ERROR, type ExternalResumeWhere, type TileMove } from '@agent-board/daemon/protocol';
import { EXTERNAL_IPC, type ResumeExternalOptions, type ResumeExternalResult } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The external session IPC the preload's `external` API calls. Every window hears every change, so tiles stay live. */
export function registerExternalIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['external.updated', 'external.removed'], EXTERNAL_IPC.changed);

  ipcMain.handle(EXTERNAL_IPC.list, () => daemon.call('external.list'));
  ipcMain.handle(EXTERNAL_IPC.dismiss, async (_event, id: string) => {
    await daemon.call('external.dismiss', { id });
  });
  ipcMain.handle(EXTERNAL_IPC.move, (_event, id: string, move: TileMove) => daemon.call('external.move', { ...move, id }));
  ipcMain.handle(EXTERNAL_IPC.resumePlan, (_event, id: string) => daemon.call('external.resumePlan', { id }));
  ipcMain.handle(
    EXTERNAL_IPC.resume,
    async (_event, id: string, where: ExternalResumeWhere, options: ResumeExternalOptions): Promise<ResumeExternalResult> => {
      const { force, position, cols, rows } = options;
      try {
        return { status: 'resumed', agent: await daemon.call('external.resume', { id, where, force, position, cols, rows }) };
      } catch (error) {
        if (error instanceof DaemonRpcError && error.code === AGENT_ERROR.liveElsewhere) return { status: 'live-elsewhere', message: error.message };
        throw error;
      }
    },
  );
  ipcMain.handle(EXTERNAL_IPC.hooksStatus, () => daemon.call('externalHooks.status'));
  ipcMain.handle(EXTERNAL_IPC.setHooksEnabled, (_event, enabled: boolean) =>
    daemon.call('externalHooks.setEnabled', { enabled }),
  );
}
