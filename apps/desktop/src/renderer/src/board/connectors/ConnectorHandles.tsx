import { memo, useContext, type ComponentType } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CONNECTOR_SIDES, type ConnectorSide } from '@agent-board/daemon/protocol';
import { ConnectionCountsContext } from '../connections-view';
import { useNear } from './near';

const POSITIONS: Record<ConnectorSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * The four round handles of an object, one at the middle of each side, shown while it is hovered or selected, and
 * grown while an arrow being drawn, or an end being dragged, is near it (`near`). Dragging from one draws a connector.
 * They are round, and flow edges' ports (M2) are square: see "Connector handle" in CONTEXT.md.
 */
const ConnectorHandles = memo(function ConnectorHandles({ id }: { id: string }) {
  const near = useNear(id);
  return CONNECTOR_SIDES.map((side) => (
    <Handle
      key={side}
      id={side}
      type="source"
      position={POSITIONS[side]}
      className="connector-handle"
      data-side={side}
      data-near={near !== false || undefined}
      data-target={near === side || undefined}
    />
  ));
});

/** "↔ n" at a node's bottom-left corner while some of its n connections are hidden. */
const ConnectionsBadge = memo(function ConnectionsBadge({ id }: { id: string }) {
  const hidden = useContext(ConnectionCountsContext).get(id) ?? 0;
  if (hidden === 0) return null;
  return (
    <span className="connections-badge" data-testid="connections-count" title={`${hidden} hidden connection${hidden === 1 ? '' : 's'}`}>
      ↔ {hidden}
    </span>
  );
});

/** `Node` with its connector handles, for a node type a connector can join. */
export function withConnectorHandles<P extends NodeProps>(Node: ComponentType<P>): ComponentType<P> {
  const Joinable = memo(function Joinable(props: P) {
    return (
      <>
        <Node {...props} />
        <ConnectorHandles id={props.id} />
        <ConnectionsBadge id={props.id} />
      </>
    );
  });
  Joinable.displayName = `Joinable(${Node.displayName ?? Node.name})`;
  return Joinable as unknown as ComponentType<P>;
}
