import { memo } from 'react';
import { BaseEdge, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { ConnectorSide } from '@agent-board/daemon/protocol';
import { autoSides } from '../connectors/endpoints';
import { lineShape, type LineEnds, type RoutePoint } from '../connectors/geometry';
import { useRoute } from '../connectors/line';

const rectOf = (node: InternalNode | undefined) =>
  node === undefined
    ? undefined
    : { ...node.internals.positionAbsolute, width: node.measured.width ?? node.width ?? 0, height: node.measured.height ?? node.height ?? 0 };

/** The height of a note's tab (`--agent-note-tab-height`): the strip above its card, where the tether must not end. */
const NOTE_TAB_HEIGHT = 21;

const NO_ENDS: LineEnds = { source: { x: 0, y: 0 }, sourceSide: 'top', target: { x: 0, y: 0 }, targetSide: 'top' };

type Rect = { x: number; y: number; width: number; height: number };

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
 * The dashed tether from an agent note, or a question card, to its agent's tile: from the middle of the source's side
 * that faces the tile to the middle of the tile's side that faces it, straight, or, when that would cross another
 * object, square round them as an arrow does (`useRoute`). `data.tab` false: a source with no tab, as a question card
 * has; `data.look` `clock`, a clock's, to the agent it runs; `master`, the board master's rail to a lead it watches.
 */
export const TetherEdge = memo(function TetherEdge({ id, source, target, data }: EdgeProps) {
  const sourceRect = rectOf(useInternalNode(source));
  // The note's card starts under its tab, and the tether ends on the card.
  const tab = data?.tab === false ? 0 : NOTE_TAB_HEIGHT;
  const from = sourceRect && { ...sourceRect, y: sourceRect.y + tab, height: Math.max(0, sourceRect.height - tab) };
  const to = rectOf(useInternalNode(target));
  const ends = from && to && endsOf(from, to);
  const straight = ends && tetherPath(ends);
  // Always routable: it has no bends of its own and no end to drag.
  const route = useRoute(ends !== undefined, ends ?? NO_ENDS, straight ?? '', source, target);
  if (ends === undefined) return null;
  const path = tetherPath(ends, route);
  // A clock's tether leads to the agent it runs; the board master's rail to a lead it watches is drawn in its teal.
  const look = data?.look === 'clock' ? 'clock-tether' : data?.look === 'master' ? 'master-rail' : 'agent-note-tether';
  return <BaseEdge id={id} path={path} className={look} data-testid={look} data-routed={route !== undefined || undefined} />;
});
