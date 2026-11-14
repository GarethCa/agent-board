import { memo } from 'react';
import { BaseEdge, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react';
import { AGENT_NOTE_FACE_WIDTH, type ConnectorSide } from '@agent-board/daemon/protocol';
import { autoSides } from '../connectors/endpoints';
import { lineShape, type LineEnds, type RoutePoint } from '../connectors/geometry';
import { useRoute } from '../connectors/line';

const rectOf = (node: InternalNode | undefined) =>
  node === undefined
    ? undefined
    : { ...node.internals.positionAbsolute, width: node.measured.width ?? node.width ?? 0, height: node.measured.height ?? node.height ?? 0 };

const NO_ENDS: LineEnds = { source: { x: 0, y: 0 }, sourceSide: 'top', target: { x: 0, y: 0 }, targetSide: 'top' };

type Rect = { x: number; y: number; width: number; height: number };

/** An agent note's bubble: its node less the face and the gap beside it, so a tether meets the bubble, not the room under the face. */
export const bubbleOf = (rect: Rect): Rect => ({ ...rect, x: rect.x + AGENT_NOTE_FACE_WIDTH, width: Math.max(0, rect.width - AGENT_NOTE_FACE_WIDTH) });

/** The middle of `side` of `rect`. */
function sideMiddle(rect: Rect, side: ConnectorSide): { x: number; y: number } {
  if (side === 'top' || side === 'bottom') return { x: rect.x + rect.width / 2, y: side === 'top' ? rect.y : rect.y + rect.height };
  return { x: side === 'left' ? rect.x : rect.x + rect.width, y: rect.y + rect.height / 2 };
}

/** Where a tether meets `from` and `to`: the middles of the two sides that face each other. */
export function endsOf(from: Rect, to: Rect): LineEnds {
  const { fromSide, toSide } = autoSides('auto', 'auto', from, to);
  return { source: sideMiddle(from, fromSide), sourceSide: fromSide, target: sideMiddle(to, toSide), targetSide: toSide };
}

/** The line of a tether between `ends`: straight, or through the corners of `route` (`useRoute`) as an elbow. */
export function tetherPath(ends: LineEnds, route?: readonly RoutePoint[]): string {
  if (route === undefined) return `M ${ends.source.x} ${ends.source.y} L ${ends.target.x} ${ends.target.y}`;
  return lineShape('elbow', ends, route.slice(1, -1), undefined, true).path;
}

/**
 * The dashed tether from an agent note to its agent's tile: from the middle of the side of the note's bubble
 * that faces the tile to the middle of the tile's side that faces it, straight, or, when that would cross another
 * object, square round them as an arrow does (`useRoute`). `data.look` `clock`, a clock's, to the agent it runs; `master`, the Captain's rail to a lead it watches.
 */
export const TetherEdge = memo(function TetherEdge({ id, source, target, data }: EdgeProps) {
  const node = rectOf(useInternalNode(source));
  // A clock's tether leads to the agent it runs; the Captain's rail to a lead it watches is drawn in its teal.
  const look = data?.look === 'clock' ? 'clock-tether' : data?.look === 'master' ? 'master-rail' : 'agent-note-tether';
  // A note's tether leaves from its bubble.
  const from = node && look === 'agent-note-tether' ? bubbleOf(node) : node;
  const to = rectOf(useInternalNode(target));
  const ends = from && to && endsOf(from, to);
  const straight = ends && tetherPath(ends);
  // Always routable: it has no bends of its own and no end to drag.
  const route = useRoute(ends !== undefined, ends ?? NO_ENDS, straight ?? '', source, target);
  if (ends === undefined) return null;
  const path = tetherPath(ends, route);
  return <BaseEdge id={id} path={path} className={look} data-testid={look} data-routed={route !== undefined || undefined} />;
});
