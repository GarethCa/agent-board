import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { InternalNode, NodeChange } from '@xyflow/react';
import { commandKey } from '../../keys';
import { boundsOnBoard } from '../items/items';
import { isZone, type BoardNode } from '../tiles';
import { overlaps, type Rect } from '../../geometry';
import { boundsOf, snapToGrid, snapToGuides, type Guide } from './snap';

/** How near, on the screen, an edge or centre must come to another's to snap to it, px. */
const SNAP_DISTANCE_PX = 6;

interface SnappingOptions {
  /** What applies the node changes once snapped. */
  applyNodeChanges(changes: NodeChange<BoardNode>[]): void;
  /** The board's nodes as last rendered. */
  nodesRef: RefObject<BoardNode[]>;
  getInternalNode(id: string): InternalNode<BoardNode> | undefined;
  getZoom(): number;
  /** The part of the board in view: only what is there is snapped to, as on Miro. */
  viewRect(): Rect;
  /** Whether to snap to the grid, rather than to what is near. */
  grid: boolean;
  /** The grid's spacing, on the board. */
  gap: number;
}

/**
 * Snapping a drag: the dragged nodes move together so that the edge or centre of the box round them lines up
 * with one near it, drawing the guides they share, as on Miro; or, with the grid on, so the box's corner is on the
 * grid. Holding the command key drags freely.
 */
export function useSnapping({ applyNodeChanges, nodesRef, getInternalNode, getZoom, viewRect, grid, gap }: SnappingOptions) {
  /** The nodes being dragged, while a drag lasts. */
  const dragged = useRef<ReadonlySet<string>>(undefined);
  /** Whether the command key is held: the drag goes unsnapped. */
  const free = useRef(false);
  const [guides, setGuides] = useState<Guide[]>([]);

  useEffect(() => {
    const hear = (event: KeyboardEvent | PointerEvent) => {
      free.current = commandKey(event);
    };
    for (const type of ['keydown', 'keyup', 'pointermove'] as const) window.addEventListener(type, hear, true);
    return () => {
      for (const type of ['keydown', 'keyup', 'pointermove'] as const) window.removeEventListener(type, hear, true);
    };
  }, []);

  /**
   * What the node takes up on the board, at its measured size (a rotated item, the box round it), were its own top-left
   * at `position` in its parent.
   */
  const rectAt = useCallback(
    (id: string, position?: { x: number; y: number }): Rect | undefined => {
      const node = getInternalNode(id);
      if (node === undefined) return undefined;
      const parent = node.parentId === undefined ? undefined : getInternalNode(node.parentId);
      const origin = parent?.internals.positionAbsolute ?? { x: 0, y: 0 };
      const at = position === undefined ? node.internals.positionAbsolute : { x: origin.x + position.x, y: origin.y + position.y };
      return boundsOnBoard(node, { ...at, width: node.measured.width ?? node.width ?? 0, height: node.measured.height ?? node.height ?? 0 });
    },
    [getInternalNode],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<BoardNode>[]) => {
      const ids = dragged.current;
      const moves = ids === undefined ? [] : changes.filter((change) => change.type === 'position' && change.position !== undefined && ids.has(change.id));
      if (ids === undefined || moves.length === 0) return applyNodeChanges(changes);
      const rects = moves.flatMap((change) => {
        const rect = change.type === 'position' ? rectAt(change.id, change.position) : undefined;
        return rect === undefined ? [] : [rect];
      });
      const box = boundsOf(rects);
      let shift = { dx: 0, dy: 0 };
      let shown: Guide[] = [];
      if (box !== undefined && !free.current) {
        if (grid) shift = snapToGrid(box, gap);
        else {
          // What is in view, but not what moves with the drag: the dragged nodes, what is in a dragged zone, and a zone
          // drawn grown round an expanded tile, whose edges follow that tile.
          const view = viewRect();
          const others = nodesRef.current.flatMap((node) => {
            if (ids.has(node.id) || (node.parentId !== undefined && ids.has(node.parentId))) return [];
            const drawn = getInternalNode(node.id);
            if (drawn !== undefined && isZone(drawn) && drawn.data.grown === true) return [];
            const rect = rectAt(node.id);
            return rect === undefined || rect.width === 0 || !overlaps(rect, view) ? [] : [rect];
          });
          const snapped = snapToGuides(box, others, SNAP_DISTANCE_PX / getZoom());
          shift = snapped;
          shown = snapped.guides;
        }
      }
      setGuides((current) => (JSON.stringify(current) === JSON.stringify(shown) ? current : shown));
      if (shift.dx === 0 && shift.dy === 0) return applyNodeChanges(changes);
      applyNodeChanges(
        changes.map((change) =>
          change.type === 'position' && change.position !== undefined && ids.has(change.id)
            ? { ...change, position: { x: change.position.x + shift.dx, y: change.position.y + shift.dy } }
            : change,
        ),
      );
    },
    [applyNodeChanges, nodesRef, rectAt, getInternalNode, getZoom, viewRect, grid, gap],
  );

  const onDragStart = useCallback((nodes: readonly BoardNode[]) => {
    dragged.current = new Set(nodes.map((node) => node.id));
  }, []);

  /** Ends the drag, once its last change has been snapped too. */
  const onDragStop = useCallback(() => {
    dragged.current = undefined;
    setGuides([]);
  }, []);

  return { onNodesChange, onDragStart, onDragStop, guides };
}
