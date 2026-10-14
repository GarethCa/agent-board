import { createContext } from 'react';
import type { UpdateConnectorParams } from '@agent-board/daemon/protocol';

/** What a connector's line can ask the board to do. */
export interface ConnectorActions {
  /** Saves a change to a connector, showing it at once. */
  update(params: UpdateConnectorParams): void;
  /** Deletes the connector. */
  remove(id: string): void;
  /** Selects the connector, and nothing else. */
  select(id: string): void;
  /** The connector whose label is being typed, if any. */
  editing: string | undefined;
  /** Starts typing a connector's label, or (undefined) stops. */
  edit(id: string | undefined): void;
}

export const ConnectorActionsContext = createContext<ConnectorActions>({
  update: () => {},
  remove: () => {},
  select: () => {},
  editing: undefined,
  edit: () => {},
});
