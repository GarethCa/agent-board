import { describe, expect, it } from 'vitest';
import { planBadge, planStamp, shownPlan } from './plan-view';

describe('the Plan tab’s words', () => {
  it('stamps each version with its decision, or as still to review', () => {
    expect(planStamp({ decision: null })).toEqual({ label: 'To review', tone: 'pending' });
    expect(planStamp({ decision: { outcome: 'approved', comments: '', decidedAt: '' } })).toEqual({ label: 'Approved', tone: 'approve' });
    expect(planStamp({ decision: { outcome: 'changes-requested', comments: 'x', decidedAt: '' } }).tone).toBe('changes');
    expect(planStamp({ decision: { outcome: 'timed-out', comments: '', decidedAt: '' } }).label).toBe('Not decided in time');
  });

  it('shows the version picked while it is there, else the latest', () => {
    const plans = [{ id: 'a' }, { id: 'b' }];
    expect(shownPlan(plans, undefined)).toEqual({ id: 'b' });
    expect(shownPlan(plans, 'a')).toEqual({ id: 'a' });
    expect(shownPlan(plans, 'gone')).toEqual({ id: 'b' });
    expect(shownPlan([], undefined)).toBeUndefined();
    expect(planBadge({ version: 2 })).toBe('plan v2');
  });
});
