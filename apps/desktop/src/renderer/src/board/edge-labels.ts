// What a flow edge's labels say of its state: what it waits for, why it is held, when it last delivered. The rails
// that draw an edge and the edge's own rules both read them.
import type { FlowCondition, FlowEdge } from '@agent-board/daemon/protocol';
import { whenLabel } from './schedule';

/** What a condition waits for, as a held edge says it. */
export function waitsFor(condition: FlowCondition): string {
  switch (condition.kind) {
    case 'gate-green':
      return 'gate green';
    case 'pr-checks':
      return 'CI green';
    case 'issue-label':
      return `label ${condition.label}`;
    case 'script':
      return 'script passes';
  }
}

/**
 * What a held edge's mark says it waits for (FlowRules: "held until CI green"), or why it is held before its
 * conditions have been checked again since a restart; undefined when it holds nothing.
 */
export function heldLabel(edge: Pick<FlowEdge, 'held' | 'conditions' | 'checks'>): string | undefined {
  if (edge.held === null) return undefined;
  const failed = edge.checks.find((check) => check?.passed === false);
  if (failed?.needsApproval === true) return 'held until you approve';
  const condition = failed === undefined ? undefined : edge.conditions[edge.checks.indexOf(failed)];
  return condition === undefined ? `held: ${edge.held.reason}` : `held until ${waitsFor(condition)}`;
}

/** When the edge last delivered, for the chip under its label (`delivered 14:02`); nothing before then, or after a skip. */
export function deliveredLabel(edge: Pick<FlowEdge, 'lastDelivery'>, now: Date): string | undefined {
  if (edge.lastDelivery?.delivered !== true) return undefined;
  return `delivered ${whenLabel(new Date(edge.lastDelivery.at), now)}`;
}
