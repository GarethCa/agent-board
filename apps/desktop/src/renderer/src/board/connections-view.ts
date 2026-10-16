// Whether the board draws its connections: all of them, only the hand-off edges between agents, or none. A
// view setting only: a hidden edge still delivers and its conditions still run. Kept in the daemon's view state.
import { createContext } from 'react';
import type { Edge } from '@xyflow/react';
import { isFlowEdge } from './flow-edges';

export type ConnectionsView = 'all' | 'handoffs' | 'none';

/** The setting as saved (view state, read back untyped): all of them unless another was saved. */
export function connectionsViewFrom(saved: unknown): ConnectionsView {
  return saved === 'handoffs' || saved === 'none' ? saved : 'all';
}

/** The mode ⇧E picks next: all, hand-offs only, none, and round again. */
export function nextConnectionsView(mode: ConnectionsView): ConnectionsView {
  return mode === 'all' ? 'handoffs' : mode === 'handoffs' ? 'none' : 'all';
}

/**
 * The edges to draw in `mode`: hand-off (flow) edges stay with hand-offs only; the rest (connectors, issue briefs) go.
 * An edge at a tile in `revealed` (the selected and the hovered) is drawn whatever the mode, and so is a selected edge,
 * so its Edge rules are never open over a line that isn't there.
 */
export function shownEdges(edges: readonly Edge[], mode: ConnectionsView, revealed: ReadonlySet<string>): Edge[] {
  if (mode === 'all') return [...edges];
  return edges.filter((edge) => edge.selected === true || revealed.has(edge.source) || revealed.has(edge.target) || (mode === 'handoffs' && isFlowEdge(edge)));
}

/** How many of `edges` end at each node, by node id. */
export function edgeCounts(edges: readonly Edge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { source, target } of edges) {
    counts.set(source, (counts.get(source) ?? 0) + 1);
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/** What a tile needs to show the edges it has while some are hidden: how many, by node id; none with all drawn. */
export const ConnectionCountsContext = createContext<ReadonlyMap<string, number>>(new Map());
