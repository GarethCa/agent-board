// React Flow draws an edge only between nodes whose handles it has measured, and it can lose them for good.
// It takes the board's nodes in an effect, after the render that made them; a node measured in between (its resize
// observer fires before the effect) is then taken from the older object, which has no `measured` yet, and that resets
// its handles. The measurement then arrives with no handles, and React Flow, which only looks again when a node goes
// from measured to not, never does: no edge to or from it is drawn. The board looks for such nodes and has them
// measured again.
import type { InternalNode } from '@xyflow/react';

/** The ids of the nodes measured but without their handles, which no edge can be drawn to. */
export function handlesLost(nodes: Iterable<InternalNode>): string[] {
  return [...nodes]
    .filter((node) => node.hidden !== true && node.measured.width !== undefined && node.internals.handleBounds === undefined)
    .map((node) => node.id);
}
