import { createContext } from 'react';
import type { UpdateConnectorParams } from '@agent-board/daemon/protocol';

/** Which of a connector's labels: the one on its middle, or the one by its `from` or its `to` end. */
export const CONNECTOR_LABEL_PLACES = ['label', 'startLabel', 'endLabel'] as const;
export type ConnectorLabelPlace = (typeof CONNECTOR_LABEL_PLACES)[number];

/** What a connector's line can ask the board to do. */
export interface ConnectorActions {
  /** Saves a change to a connector, showing it at once. */
  update(params: UpdateConnectorParams): void;
  /** Deletes the connector. */
  remove(id: string): void;
  /** Selects the connector, and nothing else. */
  select(id: string): void;
  /** The connector label being typed, if any. */
  editing: { id: string; place: ConnectorLabelPlace } | undefined;
  /** Starts typing one of a connector's labels (its middle one by default), or (undefined) stops. */
  edit(id: string | undefined, place?: ConnectorLabelPlace): void;
}

export const ConnectorActionsContext = createContext<ConnectorActions>({
  update: () => {},
  remove: () => {},
  select: () => {},
  editing: undefined,
  edit: () => {},
});
