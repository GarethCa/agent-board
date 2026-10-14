import type { DaemonLink } from '@agent-board/daemon/client';
import type { CreateFlowEdgeParams, DaemonSettings, UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import { FLOW_EDGE_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough, passthroughVoid } from './passthrough';

/** The flow edge IPC the preload's `flowEdges` API calls. Every window hears every change, so boards stay in step. */
export function registerFlowEdgeIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['flowEdge.updated', 'flowEdge.removed'], FLOW_EDGE_IPC.changed);

  passthrough(daemon, FLOW_EDGE_IPC.list, 'flowEdge.list');
  passthrough(daemon, FLOW_EDGE_IPC.create, 'flowEdge.create', (params: CreateFlowEdgeParams) => params);
  passthrough(daemon, FLOW_EDGE_IPC.update, 'flowEdge.update', (params: UpdateFlowEdgeParams) => params);
  passthrough(daemon, FLOW_EDGE_IPC.preview, 'flowEdge.preview', (id: string) => ({ id }));
  passthrough(daemon, FLOW_EDGE_IPC.lastPayload, 'flowEdge.lastPayload', (id: string) => ({ id }));
  passthrough(daemon, FLOW_EDGE_IPC.commands, 'flowEdge.commands', (id: string) => ({ id }));
  passthrough(daemon, FLOW_EDGE_IPC.approve, 'flowEdge.approve', (id: string, command: string, fingerprint: string) => ({ id, command, fingerprint }));
  passthrough(daemon, FLOW_EDGE_IPC.drop, 'flowEdge.drop', (id: string) => ({ id }));
  passthrough(daemon, FLOW_EDGE_IPC.settings, 'settings.get');
  passthrough(daemon, FLOW_EDGE_IPC.setSettings, 'settings.set', (settings: Partial<DaemonSettings>) => settings);
  passthrough(daemon, FLOW_EDGE_IPC.send, 'flowEdge.send', (id: string) => ({ id }));
  passthroughVoid(daemon, FLOW_EDGE_IPC.delete, 'flowEdge.delete', (id: string) => ({ id }));
}
