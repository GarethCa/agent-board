import { describe, expect, it } from 'vitest';
import type { PullRequest } from '@agent-board/tracker';
import { watchPullRequests, type AgentPullRequests } from '../src/pull-requests.ts';

const pr: PullRequest = { number: 35, title: 'Fix', url: 'https://github.com/acme/app/pull/35', state: 'open', checks: 'none' };
const agent = { sessionId: 's1', branch: 'fix', worktree: '/tmp', ended: false };

describe('watchPullRequests', () => {
  it("keeps a newer ask's answer over an older one that answers after it", async () => {
    const answers: ((found: AgentPullRequests) => void)[] = [];
    const watcher = watchPullRequests({
      agents: () => [agent],
      pullRequests: () => new Promise((resolve) => answers.push(resolve)),
      intervalMs: 60_000,
      onChange: () => {},
      log: () => {},
    });
    try {
      // The first round asks before the pull request is opened; a refresh, after, answers first.
      await expect.poll(() => answers.length).toBe(1);
      const refreshed = watcher.refresh('s1');
      answers[1]!({ own: [pr], pushed: [] });
      await refreshed;
      answers[0]!({ own: [], pushed: [] });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(watcher.get('s1')).toEqual([pr]);
    } finally {
      watcher.stop();
    }
  });

  it('asks nothing until started, when made to start later, then tells of every read and whether it was the first', async () => {
    let asked = 0;
    const reads: [string, PullRequest[], boolean][] = [];
    const watcher = watchPullRequests({
      agents: () => [agent],
      pullRequests: async () => {
        asked += 1;
        return { own: [pr], pushed: [] };
      },
      intervalMs: 60_000,
      startLater: true,
      onChange: () => {},
      onRead: (sessionId, own, first) => reads.push([sessionId, [...own], first]),
      log: () => {},
    });
    try {
      await watcher.refresh('s1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(asked).toBe(0);

      watcher.start();
      await expect.poll(() => reads.length).toBe(1);
      await watcher.refresh('s1');
      expect(reads).toEqual([
        ['s1', [pr], true],
        ['s1', [pr], false],
      ]);
    } finally {
      watcher.stop();
    }
  });
});
