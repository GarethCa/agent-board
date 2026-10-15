// What the Plan tab (BO2) and the inbox say of a plan: pure, so the words are unit-tested.
import type { PlanDecision, PlanSummary } from '@agent-board/daemon/protocol';

/** How a version's outcome reads in the rail, and its tone. */
export interface PlanStamp {
  label: string;
  tone: 'approve' | 'changes' | 'failed' | 'pending';
}

const STAMPS: Record<PlanDecision['outcome'], PlanStamp> = {
  approved: { label: 'Approved', tone: 'approve' },
  'changes-requested': { label: 'Changes requested', tone: 'changes' },
  rejected: { label: 'Rejected', tone: 'failed' },
  'timed-out': { label: 'Not decided in time', tone: 'pending' },
  withdrawn: { label: 'Withdrawn', tone: 'pending' },
};

/** A plan's stamp: its decision, or "To review" while the agent waits on it. */
export const planStamp = (plan: Pick<PlanSummary, 'decision'>): PlanStamp => (plan.decision === null ? { label: 'To review', tone: 'pending' } : STAMPS[plan.decision.outcome]);

/** The version the tab shows: the one picked, while it is still there; else the latest. */
export function shownPlan<T extends Pick<PlanSummary, 'id'>>(plans: readonly T[], picked: string | undefined): T | undefined {
  return plans.find((plan) => plan.id === picked) ?? plans.at(-1);
}

/** The badge a tile shows for its latest plan: `plan v2`. */
export const planBadge = (plan: Pick<PlanSummary, 'version'>): string => `plan v${plan.version}`;
