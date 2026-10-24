import { describe, expect, it } from 'vitest';
import { approveLabel, planBadge, planCardMeta, planCardStamp, planStamp, shownPlan, versionAuthor } from './plan-view';

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

  it('says whose each version is, and that one the user edited was edited', () => {
    expect(versionAuthor({ author: 'agent' })).toBe('agent');
    expect(versionAuthor({ author: 'user' })).toBe('by you');
    expect(planStamp({ decision: { outcome: 'edited', comments: '', decidedAt: '' } })).toEqual({ label: 'Edited', tone: 'pending' });
  });

  it('approves the user’s own version as their edits', () => {
    expect(approveLabel({ author: 'agent' })).toBe('Approve');
    expect(approveLabel({ author: 'user' })).toBe('Approve with my edits');
  });
});

describe('a plan card’s words', () => {
  const decided = (outcome: 'approved' | 'changes-requested' | 'rejected' | 'timed-out' | 'withdrawn') => ({ outcome, comments: '', decidedAt: '2026-10-23T14:20:00' });

  it('says it waits on the user, then stamps the decision', () => {
    expect(planCardStamp({ decision: null })).toEqual({ label: 'waiting on you', tone: 'pending' });
    expect(planCardStamp({ decision: decided('approved') })).toEqual({ label: '✓ approved', tone: 'approve' });
    expect(planCardStamp({ decision: decided('changes-requested') })).toEqual({ label: '↺ changes asked', tone: 'changes' });
    expect(planCardStamp({ decision: decided('rejected') })).toEqual({ label: '✕ rejected', tone: 'failed' });
    expect(planCardStamp({ decision: decided('timed-out') })).toEqual({ label: 'not decided in time', tone: 'pending' });
  });

  it('says the version, whose it is, and what comes next', () => {
    expect(planCardMeta({ version: 2, author: 'agent', decision: null })).toBe('v2');
    expect(planCardMeta({ version: 3, author: 'user', decision: null })).toBe('v3 · by you');
    expect(planCardMeta({ version: 2, author: 'agent', decision: decided('changes-requested') })).toBe('v2 · waiting for v3');
    expect(planCardMeta({ version: 3, author: 'user', decision: decided('approved') })).toMatch(/^v3 by you · decided /);
    expect(planCardMeta({ version: 2, author: 'agent', decision: decided('rejected') })).toMatch(/^v2 · decided /);
  });
});
