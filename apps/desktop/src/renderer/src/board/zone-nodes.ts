// Keeping the board's zone nodes in step with the daemon's zone events: zones now change by themselves, as a
// clone runs, finishes or fails.
import type { Node } from '@xyflow/react';
import type { Zone, ZoneLayout } from '@agent-board/daemon/protocol';
import { isZone } from './tiles';
import { zoneNode, type ZoneNodeType } from './ZoneNode';

/**
 * `nodes` with `zone`'s node added (first, so it draws under everything) or updated. An update keeps what React Flow
 * and the board added to the node, and keeps its place and size while it is being dragged or resized.
 */
export function withZone<N extends Node>(nodes: N[], zone: Zone): N[] {
  const index = nodes.findIndex((node) => node.id === zone.id);
  if (index < 0) return [zoneNode(zone) as unknown as N, ...nodes];
  const known = nodes[index]!;
  if (!isZone(known)) return nodes;
  const moving = known.dragging === true || known.resizing === true;
  const node: ZoneNodeType = {
    ...known,
    data: { ...known.data, zone },
    ...(moving ? {} : { position: { x: zone.x, y: zone.y }, width: zone.width, height: zone.height }),
  };
  return nodes.with(index, node as unknown as N);
}

/**
 * `node` at a layout this window has just saved, ahead of the daemon's echo of it: drawn at it, and with it as its saved
 * size too, which the board never draws a zone smaller than (`withTiles`), so the next layout pass keeps it. Its place
 * stays as React Flow has it with `move` off: a resize has moved it already.
 */
export function withSavedLayout(node: ZoneNodeType, layout: ZoneLayout, { move = true }: { move?: boolean } = {}): ZoneNodeType {
  return {
    ...node,
    ...(move ? { position: { x: layout.x, y: layout.y } } : {}),
    width: layout.width,
    height: layout.height,
    data: { ...node.data, zone: { ...node.data.zone, ...layout } },
  };
}

/**
 * `nodes` without the zone's node, nor the items drawn in it: the daemon moves those onto the board, and announces
 * them, once the zone has gone. React Flow can't draw a child without its parent meanwhile.
 */
export function withoutZone<N extends Node>(nodes: N[], id: string): N[] {
  return nodes.filter((node) => node.id !== id && node.parentId !== id);
}
