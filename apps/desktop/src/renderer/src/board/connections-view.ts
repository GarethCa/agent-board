// Whether the board draws its connections: all of them, only the hand-off edges between agents, or none. A
// view setting only: a hidden edge still delivers and its conditions still run. Kept in the daemon's view state.
import { createContext } from 'react';
import type { Edge } from '@xyflow/react';
import { isTyping } from '../keys/typing';
import { isFlowEdge } from './flow-edges';
import { isTether } from './items/agent-note-tethers';

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
 * An edge at a tile in `revealed` (the hovered one, `revealedBy`) is drawn whatever the mode, and so is a selected edge,
 * so its Edge rules are never open over a line that isn't there.
 */
export function shownEdges(edges: readonly Edge[], mode: ConnectionsView, revealed: ReadonlySet<string>): Edge[] {
  if (mode === 'all') return [...edges];
  return edges.filter((edge) => edge.selected === true || revealed.has(edge.source) || revealed.has(edge.target) || (mode === 'handoffs' && isFlowEdge(edge)));
}

/**
 * The tiles whose own edges show while some are hidden: the one under the pointer, unless it is the one being typed in
 * (`typing`). Selecting a tile or clicking into it shows none of them, so typing in an expanded tile keeps the board calm.
 */
export function revealedBy(hovered: string | undefined, typing: string | undefined): ReadonlySet<string> {
  return new Set(hovered !== undefined && hovered !== typing ? [hovered] : []);
}

/**
 * The board node (by id) that keys typed at `target` go into: a field or editable text in a tile, or a web page shown
 * in one (a webview or frame, whose own fields the board can't see); else undefined.
 */
export function typingInTile(target: EventTarget | null): string | undefined {
  if (target === null || !(isTyping({ target }) || ['WEBVIEW', 'IFRAME'].includes((target as Element).tagName))) return undefined;
  return (target as Element).closest('.react-flow__node')?.getAttribute('data-id') ?? undefined;
}

/**
 * Whether the board draws its tethers (as saved): the lines from the Captain to the orchestrators it watches, and the
 * dashed lines from clocks, agent notes, documents, plans and to-do lists to their agents. Off unless turned on: each
 * of those says whose it is on its own face (a badge, "→ agent"), so the lines are only clutter on a busy zone.
 */
export function tethersShownFrom(saved: unknown): boolean {
  return saved === true;
}

/** `edges` without the tethers, unless `tethers` is on. The link a tether draws stays whether or not it is drawn. */
export function withTethers(edges: readonly Edge[], tethers: boolean): Edge[] {
  return tethers ? [...edges] : edges.filter((edge) => !isTether(edge));
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
