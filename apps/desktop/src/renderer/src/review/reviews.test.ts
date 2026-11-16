import { describe, expect, it } from 'vitest';
import type { Agent, ReviewRound } from '@agent-board/daemon/protocol';
import { reviewedPullRequests, roundsOf, showsReviewTab, withReviewChange } from './reviews';

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

describe('reviewedPullRequests', () => {
  const agent = (sessionId: string, urls: string[] = []): Agent => ({ sessionId, pullRequests: urls.map((url) => ({ url })) }) as Agent;
  const coder = agent('coder', ['https://github.com/acme/app/pull/418', 'https://github.com/acme/app/pull/400']);
  const doc = '# Review\n\nVerdict: Request changes\n\n## Major\n- Retries 4xx too\n\n## Minor\n- No cap on the wait\n- Stale numbers';

  it("is each reviewer's implementer's newest pull request, with its latest round's findings", () => {
    const found = reviewedPullRequests([round({ id: 'a', round: 1, reviewer: 'r1', doc: '# Done\n\nVerdict: Approve' }), round({ id: 'b', round: 2, reviewer: 'r2', doc })], [coder]);
    expect(found.get('r2')).toEqual({ surface: { kind: 'pr', repo: 'acme/app', number: 418 }, status: 'ready', findings: 3 });
    expect(found.get('r1')).toEqual({ surface: { kind: 'pr', repo: 'acme/app', number: 418 }, status: 'ready', findings: 0 });
  });

  it('counts no findings while the review is still being written', () => {
    expect(reviewedPullRequests([round({ id: 'a', round: 1, reviewer: 'r1', status: 'reviewing', doc: null })], [coder]).get('r1')).toEqual({
      surface: { kind: 'pr', repo: 'acme/app', number: 418 },
      status: 'reviewing',
    });
  });

  it('says a round failed rather than that it is still being written', () => {
    const failed = round({ id: 'a', round: 1, reviewer: 'r1', status: 'failed', doc: null, failedBecause: 'The reviewer stopped' });
    expect(reviewedPullRequests([failed], [coder]).get('r1')).toEqual({ surface: { kind: 'pr', repo: 'acme/app', number: 418 }, status: 'failed' });
  });

  it('leaves out a dismissed reviewer and one whose implementer has no pull request', () => {
    const found = reviewedPullRequests([round({ id: 'a', round: 1, reviewer: null }), round({ id: 'b', round: 1, reviewer: 'r2', implementer: 'bare' })], [coder, agent('bare')]);
    expect(found.size).toBe(0);
  });
});
