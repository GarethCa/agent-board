import { memo } from 'react';
import { BaseEdge, useInternalNode, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { ConnectorSide } from '@agent-board/daemon/protocol';
import { autoSides } from '../connectors/endpoints';

const rectOf = (node: InternalNode | undefined) =>
  node === undefined
    ? undefined
    : { ...node.internals.positionAbsolute, width: node.measured.width ?? node.width ?? 0, height: node.measured.height ?? node.height ?? 0 };

type Rect = { x: number; y: number; width: number; height: number };

/** The middle of `side` of `rect`. */
function sideMiddle(rect: Rect, side: ConnectorSide): { x: number; y: number } {
  if (side === 'top' || side === 'bottom') return { x: rect.x + rect.width / 2, y: side === 'top' ? rect.y : rect.y + rect.height };
  return { x: side === 'left' ? rect.x : rect.x + rect.width, y: rect.y + rect.height / 2 };
}

/**
 * The dashed tether from an agent note to its agent's tile (CPa): straight, from the middle of the note's side that
 * faces the tile to the middle of the tile's side that faces the note.
 */
export const TetherEdge = memo(function TetherEdge({ id, source, target }: EdgeProps) {
  const from = rectOf(useInternalNode(source));
  const to = rectOf(useInternalNode(target));
  if (from === undefined || to === undefined) return null;
  const { fromSide, toSide } = autoSides('auto', 'auto', from, to);
  const a = sideMiddle(from, fromSide);
  const b = sideMiddle(to, toSide);
  return <BaseEdge id={id} path={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} className="agent-note-tether" data-testid="agent-note-tether" />;
});
