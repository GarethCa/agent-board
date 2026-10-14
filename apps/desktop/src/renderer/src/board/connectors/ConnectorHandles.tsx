import { memo, type ComponentType } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CONNECTOR_SIDES, type ConnectorSide } from '@agent-board/daemon/protocol';

const POSITIONS: Record<ConnectorSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

/**
 * The four round handles of an object, one at the middle of each side, shown while it is hovered or selected. Dragging
 * from one draws a connector. They are round, and flow edges' ports (M2) are square: see "Connector handle" in
 * CONTEXT.md.
 */
const ConnectorHandles = memo(function ConnectorHandles() {
  return CONNECTOR_SIDES.map((side) => (
    <Handle key={side} id={side} type="source" position={POSITIONS[side]} className="connector-handle" data-side={side} />
  ));
});

/** `Node` with its connector handles, for a node type a connector can join. */
export function withConnectorHandles<P extends NodeProps>(Node: ComponentType<P>): ComponentType<P> {
  const Joinable = memo(function Joinable(props: P) {
    return (
      <>
        <Node {...props} />
        <ConnectorHandles />
      </>
    );
  });
  Joinable.displayName = `Joinable(${Node.displayName ?? Node.name})`;
  return Joinable as unknown as ComponentType<P>;
}
