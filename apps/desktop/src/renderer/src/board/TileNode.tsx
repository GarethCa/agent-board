import { memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ExpandedTile } from './ExpandedTile';
import { parentKindOf } from './expanded';
import { FLOW_PORTS } from './flow-edges';
import { RepresentationContext, tileComponentFor } from './representations';
import type { TileNodeType } from './tile';
import { AGENT_NODE_PREFIX } from './tiles';

/**
 * The board's `tile` node: an expanded tile, or the tile drawn with its own representation, or the board-wide one. An
 * agent's has its two square flow ports, a flow edge leaving from the right one and arriving at the left.
 */
export const TileNode = memo(function TileNode({ id, data, parentId }: NodeProps<TileNodeType>) {
  const { style, registry } = useContext(RepresentationContext);
  const Tile = tileComponentFor(data.style ?? style, registry);
  return (
    <>
      {data.expanded ? (
        <ExpandedTile id={id} tile={data} parent={parentKindOf(parentId)} />
      ) : <Tile id={id} tile={data} />}
      {id.startsWith(AGENT_NODE_PREFIX) && (
        <>
          <Handle id={FLOW_PORTS.in} type="source" position={Position.Left} className="flow-port" data-testid="flow-port-in" />
          <Handle id={FLOW_PORTS.out} type="source" position={Position.Right} className="flow-port" data-testid="flow-port-out" />
        </>
      )}
    </>
  );
});
