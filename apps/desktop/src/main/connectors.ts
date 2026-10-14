import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { CreateConnectorParams, UpdateConnectorParams } from '@agent-board/daemon/protocol';
import { CONNECTOR_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The connector IPC the preload's `connectors` API calls. Every window hears every change, so boards stay in step. */
export function registerConnectorIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['connector.updated', 'connector.removed'], CONNECTOR_IPC.changed);

  ipcMain.handle(CONNECTOR_IPC.list, () => daemon.call('connector.list'));
  ipcMain.handle(CONNECTOR_IPC.create, (_event, params: CreateConnectorParams) => daemon.call('connector.create', params));
  ipcMain.handle(CONNECTOR_IPC.update, (_event, params: UpdateConnectorParams) => daemon.call('connector.update', params));
  ipcMain.handle(CONNECTOR_IPC.delete, async (_event, id: string) => {
    await daemon.call('connector.delete', { id });
  });
}
