// The pop-up's split (AgentPopup.tsx): two agents side by side, one in each pane, under the one row of tabs. The left
// pane is the row's own (the agent its tab shows); the right pane's agent is kept here, with which pane a tab picks into
// and where the divider rests. Pure, so it is unit-tested; nothing of it is kept once the pop-up closes.

import type { Agent } from '@agent-board/daemon/protocol';

export type SplitSide = 'left' | 'right';

export interface PopupSplit {
  /** The agent the right pane shows. */
  right: string;
  /** The pane a plain click on a tab shows it in. */
  focused: SplitSide;
  /** The left pane's share of the width. */
  ratio: number;
}

/** What a step in the split leaves: the split, or none once it ends, and the agent the left pane is to show, if it changes. */
export interface SplitStep {
  split: PopupSplit | undefined;
  left?: string;
}

/** The split as it opens: `beside` on the right, the agent shown staying on the left, which keeps the focus. None beside itself. */
export function openSplit(left: string, beside: string): PopupSplit | undefined {
  return beside === left ? undefined : { right: beside, focused: 'left', ratio: 0.5 };
}

/**
 * A plain click on an agent's tab: either side's agent gets the focus; any other agent shows in the pane with the focus.
 * Only a member of the row (`members`) can show on the left, the row's own pane; another's click goes to the right.
 */
export function pickInSplit(split: PopupSplit, left: string, key: string, members: ReadonlySet<string>): SplitStep {
  if (key === left) return { split: { ...split, focused: 'left' } };
  if (key === split.right) return { split: { ...split, focused: 'right' } };
  if (split.focused === 'left' && members.has(key)) return { split, left: key };
  return { split: { ...split, right: key, focused: 'right' } };
}

/**
 * A tab picked while split, by a click or a key: an agent's goes as `pickInSplit` says; a view's or a shell's, which
 * only ever show in the row's own pane, shows on the left, and the left takes the focus.
 */
export function selectInSplit(split: PopupSplit, left: string, key: string, members: ReadonlySet<string>, isAgent: boolean): SplitStep {
  return isAgent ? pickInSplit(split, left, key, members) : { split: { ...split, focused: 'left' }, left: key };
}

/** The row's tab on while split: the right's agent while the right has the focus, else the tab the left pane shows. */
export const tabOnInSplit = (split: PopupSplit, leftTab: string): string => (split.focused === 'right' ? split.right : leftTab);

/**
 * Whether a tab dragged over the body can drop where it is (`side`): only an agent's (`isAgent`). Not split, only at the
 * right edge, and never the agent shown itself; split, on either pane, the left taking only a member of the row.
 */
export function canDropInSplit(split: PopupSplit | undefined, left: string, side: SplitSide | 'edge', key: string, members: ReadonlySet<string>, isAgent: boolean): boolean {
  if (!isAgent) return false;
  if (split === undefined) return side === 'edge' && key !== left;
  if (side === 'edge') return false;
  return side === 'right' || members.has(key);
}

/**
 * An agent's tab dropped on a pane: it shows there, and the pane takes the focus. The other side's agent dropped on a
 * pane swaps the two, unless that would put one that isn't a member of the row on the left.
 */
export function dropInSplit(split: PopupSplit, left: string, side: SplitSide, key: string, members: ReadonlySet<string>): SplitStep {
  if (side === 'right') {
    if (key === split.right) return { split: { ...split, focused: 'right' } };
    if (key === left) return members.has(split.right) ? { split: { ...split, right: left, focused: 'right' }, left: split.right } : { split };
    return { split: { ...split, right: key, focused: 'right' } };
  }
  if (key === left) return { split: { ...split, focused: 'left' } };
  if (!members.has(key)) return { split };
  if (key === split.right) return { split: { ...split, right: left, focused: 'left' }, left: key };
  return { split: { ...split, focused: 'left' }, left: key };
}

/** A tab dropped at the right edge of a pop-up not split: it opens beside the agent shown. */
export const dropAtEdge = (left: string, key: string): PopupSplit | undefined => openSplit(left, key);

/** Whether a drop at `x` across a body `width` wide is at its right edge, where a tab dropped opens beside. */
export const atRightEdge = (x: number, width: number): boolean => width > 0 && x >= width * (1 - EDGE_SHARE);

/** The share of the body's width, at its right, that a tab is dropped in to open beside. */
const EDGE_SHARE = 0.2;

/**
 * What Open beside… lists for the agent shown on the left: the ticket's helpers first, in the row's order, then the other
 * agents still running in its zone (none for an agent outside every zone). Never the agent itself, the one beside it
 * already, nor a helper popped out into a window of its own.
 */
export function besideCandidates({
  shown,
  row,
  agents,
  popped = [],
  right,
}: {
  shown: Agent;
  /** The agents of the row, in its order: a ticket's chat and helpers, or the one agent alone. */
  row: readonly Agent[];
  agents: readonly Agent[];
  popped?: readonly string[];
  right?: string | undefined;
}): Agent[] {
  const skip = new Set([shown.sessionId, ...popped, ...(right === undefined ? [] : [right])]);
  const members = new Set(row.map((agent) => agent.sessionId));
  const helpers = row.filter((agent) => !skip.has(agent.sessionId));
  const zone = row[0]?.zoneId ?? shown.zoneId;
  const others = zone === null ? [] : agents.filter((agent) => agent.zoneId === zone && agent.endedAt === null && !members.has(agent.sessionId) && !skip.has(agent.sessionId));
  return [...helpers, ...others];
}
