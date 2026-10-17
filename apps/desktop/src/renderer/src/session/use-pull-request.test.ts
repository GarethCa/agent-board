import { describe, expect, it } from 'vitest';
import type { PullRequestDetails } from '@agent-board/daemon/protocol';
import { afterAction, NO_RUNS, REFRESH_GAP_MS, refreshDue, settleRun, startRun } from './use-pull-request';

describe('when a PR tab reads its pull request again: no polling', () => {
  const ended = (lastAt: number) => ({ ...NO_RUNS, lastAt });

  it('reads it the first time it shows, and again on a manual refresh at any time', () => {
    expect(refreshDue('shown', NO_RUNS, 0)).toBe(true);
    expect(refreshDue('manual', ended(1000), 1001)).toBe(true);
  });

  it('reads it again as it shows or the app is focused, once a little while has passed', () => {
    expect(refreshDue('shown', ended(1000), 1000 + REFRESH_GAP_MS - 1)).toBe(false);
    expect(refreshDue('focus', ended(1000), 1000 + REFRESH_GAP_MS - 1)).toBe(false);
    expect(refreshDue('focus', ended(1000), 1000 + REFRESH_GAP_MS)).toBe(true);
  });

  it('counts a read that failed, such as one GitHub rate-limited, towards the gap', () => {
    const { runs, id } = startRun(NO_RUNS, 'read');
    const failed = settleRun(runs, id, 1000).runs;
    expect(refreshDue('focus', failed, 1000 + REFRESH_GAP_MS - 1)).toBe(false);
    expect(refreshDue('manual', failed, 1001)).toBe(true);
  });

  it('never reads it while a call is under way', () => {
    expect(refreshDue('manual', startRun(NO_RUNS, 'read').runs, 0)).toBe(false);
  });
});

describe("a PR tab's calls", () => {
  it('drop a read under way as a merge starts, whichever answers first, and stay busy until both have', () => {
    const read = startRun(NO_RUNS, 'read');
    const merge = startRun(read.runs, 'action');
    // The read lands first: dropped, and the tab is still busy with the merge.
    const readLands = settleRun(merge.runs, read.id, 1);
    expect(readLands.take).toBe(false);
    expect(readLands.runs.running).toBe(1);
    const mergeLands = settleRun(readLands.runs, merge.id, 2);
    expect(mergeLands.take).toBe(true);
    expect(mergeLands.runs.running).toBe(0);
    // Or the merge lands first, and the read after it is still dropped.
    const first = settleRun(merge.runs, merge.id, 1);
    expect(first.take).toBe(true);
    expect(settleRun(first.runs, read.id, 2).take).toBe(false);
  });

  it('take a read started after an action', () => {
    const merge = startRun(NO_RUNS, 'action');
    const done = settleRun(merge.runs, merge.id, 1).runs;
    const read = startRun(done, 'read');
    expect(settleRun(read.runs, read.id, 2).take).toBe(true);
  });
});

describe('after an approve or merge', () => {
  const before = { title: 'Fix', merge: { allowed: true }, approve: { allowed: true } } as PullRequestDetails;

  it('shows the pull request as it is now', () => {
    const now = { ...before, state: 'merged' } as PullRequestDetails;
    expect(afterAction(before, { details: now }, 'Merged')).toEqual({ details: now });
  });

  it("says it was done though it couldn't be read again, offering nothing more until it is", () => {
    const { details, error } = afterAction(before, { readError: 'rate limit' }, 'Merged');
    expect(error).toBe('Merged, but could not read it again: rate limit');
    expect(details.merge).toEqual({ allowed: false, why: 'Refresh to see it as it is now.' });
    expect(details.approve.allowed).toBe(false);
  });
});
