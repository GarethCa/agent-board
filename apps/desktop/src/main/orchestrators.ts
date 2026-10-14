import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { DEFAULT_ACTIVITY_LIMIT } from '@agent-board/daemon/protocol';
import { ORCHESTRATOR_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The orchestrator IPC the preload's `orchestrators` API calls: the activity log, read and heard as it grows. */
export function registerOrchestratorIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['orchestrator.activity'], ORCHESTRATOR_IPC.logged);

  ipcMain.handle(ORCHESTRATOR_IPC.activity, (_event, orchestratorId: string, before?: number) =>
    daemon.call('orchestrator.activity', { orchestratorId, limit: DEFAULT_ACTIVITY_LIMIT, ...(before === undefined ? {} : { before }) }),
  );
}
