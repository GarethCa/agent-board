import { getBezierPath, useStore, type ConnectionLineComponentProps } from '@xyflow/react';
import { ArrowRight } from 'lucide-react';
import { isFlowPort } from './flow-edges';
import type { TileNodeType } from './tile';
import { tileSubject } from './tiles';

/**
 * The line a drag from a handle draws, to the pointer. From a flow port it ends in the flow's arrow, and over another
 * agent's tile it says it will join them when let go (FlowDraw); `.board-drawing-flow` makes it the dashed flow ghost.
 */
export function ConnectionLine({ fromNode, fromHandle, fromX, fromY, fromPosition, toX, toY, toPosition, pointer }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition });
  const fromFlowPort = isFlowPort(fromHandle.id);
  // Just its name, so the line draws again only when the tile under the pointer changes.
  const target = useStore((state) => {
    if (!fromFlowPort) return undefined;
    for (const node of state.nodeLookup.values()) {
      if (node.id === fromNode.id || tileSubject(node.id)?.kind !== 'agent') continue;
      const { x, y } = node.internals.positionAbsolute;
      const { width = 0, height = 0 } = node.measured;
      if (pointer.x >= x && pointer.x <= x + width && pointer.y >= y && pointer.y <= y + height) {
        return (node as unknown as TileNodeType).data.agent?.name;
      }
    }
    return undefined;
  });
  return (
    <g>
      <path className="react-flow__connection-path" d={path} markerEnd={fromFlowPort ? 'url(#flow-arrow)' : undefined} />
      {target !== undefined && (
        // Under the pointer, clear of the tile's text.
        <foreignObject x={pointer.x} y={pointer.y + DROP_HINT_BELOW} width={1} height={1} overflow="visible">
          <div className="flow-drop-hint" data-testid="flow-drop-hint">
            <ArrowRight aria-hidden />
            Release to connect to {target}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

/** How far below the pointer the drop hint sits, on the board: past the cursor's arrow. */
const DROP_HINT_BELOW = 28;
