import type { DaemonLink } from '@agent-board/daemon/client';
import type { CreateConnectorParams, UpdateConnectorParams } from '@agent-board/daemon/protocol';
import { CONNECTOR_IPC } from '../preload/api';
import { forwardEvents } from './broadcast';
import { passthrough, passthroughVoid } from './passthrough';

/** The connector IPC the preload's `connectors` API calls. Every window hears every change, so boards stay in step. */
export function registerConnectorIpc(daemon: DaemonLink): void {
  forwardEvents(daemon, ['connector.updated', 'connector.removed'], CONNECTOR_IPC.changed);

  passthrough(daemon, CONNECTOR_IPC.list, 'connector.list');
  passthrough(daemon, CONNECTOR_IPC.create, 'connector.create', (params: CreateConnectorParams) => params);
  passthrough(daemon, CONNECTOR_IPC.update, 'connector.update', (params: UpdateConnectorParams) => params);
  passthroughVoid(daemon, CONNECTOR_IPC.delete, 'connector.delete', (id: string) => ({ id }));
}
