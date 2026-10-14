import { describe, expect, it } from 'vitest';
import type { ReviewRound } from '@agent-board/daemon/protocol';
import { roundsOf, showsReviewTab, withReviewChange } from './reviews';

const round = (fields: Partial<ReviewRound> & Pick<ReviewRound, 'id' | 'round'>): ReviewRound => ({
  implementer: 'coder',
  reviewer: null,
  head: null,
  status: 'ready',
  doc: '# Done\n\nVerdict: Approve\n\n## Blocker\n- ~~**Fixed**~~',
  failedBecause: null,
  createdAt: '2026-10-11T10:00:00.000Z',
  finishedAt: '2026-10-11T10:05:00.000Z',
  sentAt: null,
  dismissedAt: null,
  ...fields,
});

describe('withReviewChange', () => {
  it('adds a new round and replaces a known one', () => {
    const first = round({ id: 'r1', round: 1, status: 'reviewing', doc: null });
    const added = withReviewChange([], { type: 'review.updated', round: first });
    expect(added).toEqual([first]);
    const ready = round({ id: 'r1', round: 1 });
    expect(withReviewChange(added, { type: 'review.updated', round: ready })).toEqual([ready]);
  });
});

describe('roundsOf', () => {
  it("is the implementer's rounds, in order", () => {
    const rounds = [round({ id: 'b', round: 2 }), round({ id: 'x', round: 1, implementer: 'other' }), round({ id: 'a', round: 1 })];
    expect(roundsOf(rounds, 'coder').map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('showsReviewTab', () => {
  it('shows while the latest round is not dismissed, or once asked for while there is a round', () => {
    const dismissed = [round({ id: 'a', round: 1, dismissedAt: '2026-10-11T11:00:00.000Z' })];
    expect(showsReviewTab([], false)).toBe(false);
    expect(showsReviewTab([], true)).toBe(false);
    expect(showsReviewTab([round({ id: 'a', round: 1 })], false)).toBe(true);
    expect(showsReviewTab(dismissed, false)).toBe(false);
    expect(showsReviewTab(dismissed, true)).toBe(true);
  });
});
