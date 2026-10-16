import { memo, useContext, useRef } from 'react';
import { NodeResizeControl, ResizeControlVariant, type ControlPosition, type NodeProps } from '@xyflow/react';
import { ExpandedTile } from './ExpandedTile';
import { FoldedChip } from './FoldedChip';
import { parentKindOf, resizeAllowed } from './expanded';
import { RepresentationContext, tileComponentFor } from './representations';
import { useOnlySelected } from './items/items';
import { TileActionsContext, type TileNodeType } from './tile';
import { TILE_MAX_SIZE, TILE_MIN_SIZE } from './tile-size';

/** Where a tile can be resized from: each corner by a handle, each edge along its length (as an expanded tile). */
const CORNERS: readonly ControlPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES: readonly ControlPosition[] = ['top', 'right', 'bottom', 'left'];
const RESIZE_HANDLE = '.tile-resize';

/**
 * The board's `tile` node: an expanded tile, or the tile drawn with its own representation, or the board-wide one. Its
 * round connector handles are where an arrow or a hand-off between agents leaves and arrives.
 */
export const TileNode = memo(function TileNode({ id, data, parentId, selected: picked }: NodeProps<TileNodeType>) {
  const { style, registry } = useContext(RepresentationContext);
  const { resizeTile } = useContext(TileActionsContext);
  // Resizable once it is the one thing selected, as a note is; an expanded tile has its own resizer.
  /** Where its top-left was as the resize under way began, relative to its parent. */
  const resizeStart = useRef({ x: 0, y: 0 });
  const resizable = useOnlySelected(picked) && data.expanded !== true && data.folded !== true;
  const Tile = tileComponentFor(data.style ?? style, registry);
  return (
    <>
      {data.expanded ? (
        <ExpandedTile id={id} tile={data} parent={parentKindOf(parentId)} />
      ) : data.folded && data.agent !== undefined ? (
        <FoldedChip id={id} agent={data.agent} />
      ) : (
        <Tile id={id} tile={data} />
      )}
      {resizable && (
        // A double-click on any handle puts the tile back to its default size, and opens nothing.
        <span
          style={{ display: 'contents' }}
          onDoubleClick={(event) => {
            if (!(event.target as Element).closest(RESIZE_HANDLE)) return;
            event.stopPropagation();
            resizeTile(id, undefined);
          }}
        >
          {[...EDGES, ...CORNERS].map((position) => {
            const corner = CORNERS.includes(position);
            return (
              <NodeResizeControl
                key={position}
                position={position}
                variant={corner ? ResizeControlVariant.Handle : ResizeControlVariant.Line}
                minWidth={TILE_MIN_SIZE.width}
                minHeight={TILE_MIN_SIZE.height}
                maxWidth={TILE_MAX_SIZE.width}
                maxHeight={TILE_MAX_SIZE.height}
                className={corner ? 'item-resize-handle tile-resize' : 'item-resize-line tile-resize'}
                onResizeStart={(_event, { x, y }) => {
                  resizeStart.current = { x, y };
                }}
                // In a zone, not past its padding on the left or top, where the zone can't grow to hold it.
                shouldResize={(_event, next) => resizeAllowed(next, resizeStart.current, parentKindOf(parentId))}
                // Where it is drawn as it is let go, relative to its parent: saved if resized from the left or top.
                onResizeEnd={(_event, { x, y, width, height }) => resizeTile(id, { width, height }, { x, y })}
              />
            );
          })}
        </span>
      )}
    </>
  );
});
