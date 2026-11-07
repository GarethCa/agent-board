import { describe, expect, it } from 'vitest';
import { claimDip, poseChangeDelay } from './character-change';

describe('a change of pose', () => {
  it('waits out the three seconds since the last change', () => {
    expect(poseChangeDelay('thinking', 'running', 1000, 2000)).toBe(2000);
    expect(poseChangeDelay('thinking', 'running', 1000, 4000)).toBe(0);
  });

  it('never holds up a tile coming to rest, so the character never contradicts its word', () => {
    expect(poseChangeDelay('thinking', 'idle', 1000, 1001)).toBe(0);
    expect(poseChangeDelay('running', 'done', 1000, 1001)).toBe(0);
    expect(poseChangeDelay('idle', 'thinking', 1000, 1001)).toBe(0);
  });

  it('never holds off what the board must show, or holds it up as it goes', () => {
    expect(poseChangeDelay('thinking', 'waiting', 1000, 1001)).toBe(0);
    expect(poseChangeDelay('failed', 'running', 1000, 1001)).toBe(0);
  });
});

describe('a dip', () => {
  it('stays still under Still, reduced motion and below half zoom', () => {
    expect(claimDip(1, false, 'still')).toBeUndefined();
    expect(claimDip(1, true, 'move')).toBeUndefined();
    expect(claimDip(0.49, false, 'move')).toBeUndefined();
  });

  it('lets four dip at once, and another once one is over', () => {
    const dips = [1, 2, 3, 4].map(() => claimDip(0.5, false, 'move'));
    expect(dips.every((release) => release !== undefined)).toBe(true);
    expect(claimDip(1, false, 'move')).toBeUndefined();
    dips[0]!();
    dips[0]!();
    const next = claimDip(1, false, 'move');
    expect(next).toBeDefined();
    expect(claimDip(1, false, 'move')).toBeUndefined();
    next!();
    for (const release of dips) release!();
  });
});
