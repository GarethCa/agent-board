// The object near the pointer while an arrow is drawn or one of its ends dragged: only its connector handles show,
// grown, so the board isn't covered in dots.
import { useCallback, useSyncExternalStore } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { ConnectorSide, EdgePoint } from '@agent-board/daemon/protocol';
import type { Rect } from '../../geometry';

/** A board object an arrow can end on: a zone is near only by its outline, since its body holds other objects. */
export interface NearCandidate {
  id: string;
  rect: Rect;
  zone: boolean;
}

/** How far `point` is from `rect`'s outside, or 0 inside it. */
function distanceOutside(rect: Rect, point: EdgePoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/** How far `point` is from `rect`'s outline, inside or out. */
function distanceToOutline(rect: Rect, point: EdgePoint): number {
  const outside = distanceOutside(rect, point);
  if (outside > 0) return outside;
  return Math.min(point.x - rect.x, rect.x + rect.width - point.x, point.y - rect.y, rect.y + rect.height - point.y);
}

/**
 * The object `point` is over or within `margin` of, leaving out `skip`: the nearest one that isn't a zone (of those it
 * is over, the smallest, which sits on the others), else a zone whose outline is within `margin`.
 */
export function nearestObject(objects: readonly NearCandidate[], point: EdgePoint, margin: number, skip?: ReadonlySet<string>): string | undefined {
  let best: { id: string; distance: number; area: number } | undefined;
  for (const { id, rect, zone } of objects) {
    if (zone || skip?.has(id)) continue;
    const distance = distanceOutside(rect, point);
    const area = rect.width * rect.height;
    if (distance > margin) continue;
    if (best === undefined || distance < best.distance || (distance === best.distance && area < best.area)) best = { id, distance, area };
  }
  if (best !== undefined) return best.id;
  let zone: { id: string; distance: number } | undefined;
  for (const { id, rect, zone: isZone } of objects) {
    if (!isZone || skip?.has(id)) continue;
    const distance = distanceToOutline(rect, point);
    if (distance <= margin && (zone === undefined || distance < zone.distance)) zone = { id, distance };
  }
  return zone?.id;
}

/** How near, on screen, the pointer must come to an object for its handles to show. */
const NEAR_MARGIN = 40;

// The node near the pointer, if any, and the side of it a dragged end would land on: one value for the whole board,
// which each node's handles watch for their own id, so a pointer move draws again only those whose answer changed.
let near: { id: string; side?: ConnectorSide } | undefined;
const listeners = new Set<() => void>();

/** Says which node the pointer is near now, or none, and which of its sides a dragged end would land on. */
export function setNearNode(id: string | undefined, side?: ConnectorSide): void {
  if (id === near?.id && side === near?.side) return;
  near = id === undefined ? undefined : { id, ...(side !== undefined && { side }) };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Whether the pointer is near node `id` while an arrow is drawn or an end dragged: false, or true, or the side of it
 * a dragged end would land on.
 */
export const useNear = (id: string): boolean | ConnectorSide =>
  useSyncExternalStore(subscribe, () => (near?.id !== id ? false : (near.side ?? true)));

/**
 * Finds the node near a point on the screen, of those `accept` takes (every node on the board, without), and shows its
 * handles (none when it is near nothing); its id.
 */
export function useFindNear(): (client: EdgePoint, accept?: (nodeId: string) => boolean) => string | undefined {
  const { getNodes, getInternalNode, getZoom, screenToFlowPosition } = useReactFlow();
  return useCallback(
    (client, accept) => {
      const point = screenToFlowPosition(client);
      const candidates = getNodes().flatMap((node): NearCandidate[] => {
        const internal = node.hidden === true || accept?.(node.id) === false ? undefined : getInternalNode(node.id);
        if (internal === undefined) return [];
        const { width = 0, height = 0 } = internal.measured;
        return [{ id: node.id, rect: { ...internal.internals.positionAbsolute, width, height }, zone: node.type === 'zone' }];
      });
      const id = nearestObject(candidates, point, NEAR_MARGIN / getZoom());
      setNearNode(id);
      return id;
    },
    [getNodes, getInternalNode, getZoom, screenToFlowPosition],
  );
}
