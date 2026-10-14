import { ipcMain } from 'electron';
import { DaemonRpcError, type DaemonLink } from '@agent-board/daemon/client';
import { AGENT_ERROR, type ExternalResumeWhere, type TileMove } from '@agent-board/daemon/protocol';
import { EXTERNAL_IPC, type ResumeExternalOptions, type ResumeExternalResult } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough, passthroughVoid } from './passthrough';

/** The external session IPC the preload's `external` API calls. Every window hears every change, so tiles stay live. */
export function registerExternalIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['external.updated', 'external.removed'], EXTERNAL_IPC.changed);

  passthrough(daemon, EXTERNAL_IPC.list, 'external.list');
  passthroughVoid(daemon, EXTERNAL_IPC.dismiss, 'external.dismiss', (id: string) => ({ id }));
  passthrough(daemon, EXTERNAL_IPC.move, 'external.move', (id: string, move: TileMove) => ({ ...move, id }));
  passthrough(daemon, EXTERNAL_IPC.resumePlan, 'external.resumePlan', (id: string) => ({ id }));
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
  passthrough(daemon, EXTERNAL_IPC.hooksStatus, 'externalHooks.status');
  passthrough(daemon, EXTERNAL_IPC.setHooksEnabled, 'externalHooks.setEnabled', (enabled: boolean) => ({ enabled }));
}
