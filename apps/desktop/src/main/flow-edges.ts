import { ipcMain } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import type { CreateFlowEdgeParams, DaemonSettings, UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import { FLOW_EDGE_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';

/** The flow edge IPC the preload's `flowEdges` API calls. Every window hears every change, so boards stay in step. */
export function registerFlowEdgeIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['flowEdge.updated', 'flowEdge.removed'], FLOW_EDGE_IPC.changed);

  ipcMain.handle(FLOW_EDGE_IPC.list, () => daemon.call('flowEdge.list'));
  ipcMain.handle(FLOW_EDGE_IPC.create, (_event, params: CreateFlowEdgeParams) => daemon.call('flowEdge.create', params));
  ipcMain.handle(FLOW_EDGE_IPC.update, (_event, params: UpdateFlowEdgeParams) => daemon.call('flowEdge.update', params));
  ipcMain.handle(FLOW_EDGE_IPC.preview, (_event, id: string) => daemon.call('flowEdge.preview', { id }));
  ipcMain.handle(FLOW_EDGE_IPC.commands, (_event, id: string) => daemon.call('flowEdge.commands', { id }));
  ipcMain.handle(FLOW_EDGE_IPC.approve, (_event, id: string, command: string, fingerprint: string) =>
    daemon.call('flowEdge.approve', { id, command, fingerprint }),
  );
  ipcMain.handle(FLOW_EDGE_IPC.drop, (_event, id: string) => daemon.call('flowEdge.drop', { id }));
  ipcMain.handle(FLOW_EDGE_IPC.settings, () => daemon.call('settings.get'));
  ipcMain.handle(FLOW_EDGE_IPC.setSettings, (_event, settings: Partial<DaemonSettings>) => daemon.call('settings.set', settings));
  ipcMain.handle(FLOW_EDGE_IPC.send, (_event, id: string) => daemon.call('flowEdge.send', { id }));
  ipcMain.handle(FLOW_EDGE_IPC.delete, async (_event, id: string) => {
    await daemon.call('flowEdge.delete', { id });
  });
}
