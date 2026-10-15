import { createContext, useContext } from 'react';
import { getBezierPath, useStore, type ConnectionLineComponentProps } from '@xyflow/react';
import { Waypoints } from 'lucide-react';
import { NEW_EDGE_LABEL } from './flow-edges';
import type { TileNodeType } from './tile';
import { tileSubject } from './tiles';

/** Whether ⌥ is held while a connector is dragged from an agent's tile (BP8): let go on another, a hand-off. */
export const HandingOffContext = createContext(false);

/**
 * The line a drag from a handle draws, to the pointer. From one agent's tile over another's it says ⌥ makes it a
 * hand-off; with ⌥ held there it is the flow's ghost, ends in the flow's arrow, says what it carries on its middle, and
 * says it hands off to that agent when let go. Anywhere else it is an arrow's line, ⌥ or not.
 */
export function ConnectionLine({ fromNode, fromX, fromY, fromPosition, toX, toY, toPosition, pointer }: ConnectionLineComponentProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition });
  const handingOff = useContext(HandingOffContext);
  const fromAgent = tileSubject(fromNode.id)?.kind === 'agent';
  // Just its name, so the line draws again only when the tile under the pointer changes.
  const target = useStore((state) => {
    if (!fromAgent) return undefined;
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
  // Only over another agent is it a hand-off: let go anywhere else it is an arrow, so it looks like one.
  const ghost = handingOff && target !== undefined;
  return (
    <g>
      <path
        className={ghost ? 'react-flow__connection-path flow-connection-ghost' : 'react-flow__connection-path'}
        d={path}
        markerEnd={ghost ? 'url(#flow-arrow)' : undefined}
      />
      {ghost && (
        <foreignObject x={labelX} y={labelY} width={1} height={1} overflow="visible">
          <div className="flow-drag-payload" data-testid="flow-drag-payload">
            ▶ {NEW_EDGE_LABEL}
          </div>
        </foreignObject>
      )}
      {target !== undefined && (
        // Under the pointer, clear of the tile's text.
        <foreignObject x={pointer.x} y={pointer.y + DROP_HINT_BELOW} width={1} height={1} overflow="visible">
          <div className="flow-drop-hint" data-testid="flow-drop-hint" data-handing-off={ghost || undefined}>
            {ghost ? (
              <>
                <Waypoints aria-hidden />
                Hand off to {target}
              </>
            ) : (
              'Hold ⌥ to hand off'
            )}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

/** How far below the pointer the drop hint sits, on the board: past the cursor's arrow. */
const DROP_HINT_BELOW = 28;
