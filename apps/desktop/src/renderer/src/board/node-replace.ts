import type { Node, NodeChange } from '@xyflow/react';

/**
 * React Flow's `updateNode`, `updateNodeData` and `setNodes` make each changed node whole, as a replace, from React Flow's
 * own copy of the board's nodes. That copy is the last one drawn, so it runs behind the board's while a change from the
 * daemon waits to be drawn, and the replace would put the older node back: a step just ticked shown unticked again.
 * Each replace is laid over the board's node as it is now with only what it changed from the copy it was made from
 * (`bases`, by node id); one made from the node as the board holds it is taken as it is.
 *
 * A field counts as changed when it is a different value, compared by reference, as React Flow's own calls keep each
 * field they don't change. A `setNodes` updater that copies a field it leaves as it was (`position: {...n.position}`)
 * makes that field count as changed, and the older copy's value is laid over the newer one.
 */
export function rebasedReplaces<N extends Node>(changes: NodeChange<N>[], bases: ReadonlyMap<string, N>, nodes: readonly N[]): NodeChange<N>[] {
  if (!changes.some((change) => change.type === 'replace' && bases.has(change.id))) return changes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return changes.map((change) => {
    if (change.type !== 'replace') return change;
    const base = bases.get(change.id);
    const now = byId.get(change.id);
    return base === undefined || now === undefined || now === base ? change : { ...change, item: rebased(change.item, base, now) };
  });
}

/** `now`, with what `made` changed from `base`: its fields, and its data's, set or dropped. */
function rebased<N extends Node>(made: N, base: N, now: N): N {
  const node = changedOver(made, base, now, 'data');
  if (made.data !== base.data) node.data = changedOver(made.data, base.data, now.data);
  return node as N;
}

function changedOver(made: object, base: object, now: object, skip?: string): Record<string, unknown> {
  const from = base as Record<string, unknown>;
  const to = made as Record<string, unknown>;
  const result: Record<string, unknown> = { ...now };
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (key === skip || to[key] === from[key]) continue;
    if (key in to) result[key] = to[key];
    else delete result[key];
  }
  return result;
}
