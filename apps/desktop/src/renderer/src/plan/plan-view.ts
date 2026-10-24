// What the Plan tab, the inbox and a plan card say of a plan: pure, so the words are unit-tested.
import type { PlanDecision, PlanSummary } from '@agent-board/daemon/protocol';
import { shortWhen } from '../when';

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
  edited: { label: 'Edited', tone: 'pending' },
};

/** A plan's stamp: its decision, or "To review" while the agent waits on it. */
export const planStamp = (plan: Pick<PlanSummary, 'decision'>): PlanStamp => (plan.decision === null ? { label: 'To review', tone: 'pending' } : STAMPS[plan.decision.outcome]);

/** The version the tab shows: the one picked, while it is still there; else the latest. */
export function shownPlan<T extends Pick<PlanSummary, 'id'>>(plans: readonly T[], picked: string | undefined): T | undefined {
  return plans.find((plan) => plan.id === picked) ?? plans.at(-1);
}

/** The badge a tile shows for its latest plan: `plan v2`. */
export const planBadge = (plan: Pick<PlanSummary, 'version'>): string => `plan v${plan.version}`;

/** Whose a version is, in the rail: its agent's, or the user's own edit. */
export const versionAuthor = (plan: Pick<PlanSummary, 'author'>): string => (plan.author === 'user' ? 'by you' : 'agent');

/** The Approve button's words: approving the user's own version approves their edits. */
export const approveLabel = (plan: Pick<PlanSummary, 'author'>): string => (plan.author === 'user' ? 'Approve with my edits' : 'Approve');

const CARD_STAMPS: Record<PlanDecision['outcome'], PlanStamp> = {
  approved: { label: '✓ approved', tone: 'approve' },
  'changes-requested': { label: '↺ changes asked', tone: 'changes' },
  rejected: { label: '✕ rejected', tone: 'failed' },
  'timed-out': { label: 'not decided in time', tone: 'pending' },
  withdrawn: { label: 'withdrawn', tone: 'pending' },
  edited: { label: 'edited', tone: 'pending' },
};

/** A plan card's stamp: that it waits on the user, then its decision. */
export const planCardStamp = (plan: Pick<PlanSummary, 'decision'>): PlanStamp =>
  plan.decision === null ? { label: 'waiting on you', tone: 'pending' } : CARD_STAMPS[plan.decision.outcome];

/** The line under a plan card's title: its version and whose it is, then what comes next, or when it was decided. */
export function planCardMeta(plan: Pick<PlanSummary, 'version' | 'author' | 'decision'>): string {
  const version = `v${plan.version}${plan.author === 'user' ? ' by you' : ''}`;
  if (plan.decision === null) return plan.author === 'user' ? `v${plan.version} · by you` : version;
  if (plan.decision.outcome === 'changes-requested') return `${version} · waiting for v${plan.version + 1}`;
  return `${version} · decided ${shortWhen(plan.decision.decidedAt)}`;
}
