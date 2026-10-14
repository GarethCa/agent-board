import { describe, expect, it } from 'vitest';
import type { Agent, AgentSchedule, LinkedIssue, PullRequest } from '@agent-board/daemon/protocol';
import { tileFooter } from './tile-footer';

const issue = { provider: 'linear', id: 'ACME-58', title: 'Movable sessions', url: 'https://linear.app/x' } as LinkedIssue;
const pr = (number: number, state: PullRequest['state'] = 'open', checks: PullRequest['checks'] = 'passing') =>
  ({ number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state, checks }) as PullRequest;
const schedule = { cron: '0 9 * * 2', prompt: 'Go', enabled: true, nextRunAt: null, lastRun: null } as AgentSchedule;
const agent = (fields: Partial<Agent> = {}) =>
  ({ issue: null, pullRequests: [], schedule: null, muted: false, notice: null, ...fields }) as Agent;

describe('a tile’s footer', () => {
  it('is empty for an agent with nothing to show', () => {
    expect(tileFooter(agent())).toEqual({ shown: [], folded: [] });
  });

  it('shows the issue, the pull requests and the schedule, in that order', () => {
    const footer = tileFooter(agent({ issue, pullRequests: [pr(214), pr(215)], schedule }));

    expect(footer.shown).toEqual([
      { kind: 'issue', issue },
      { kind: 'pr', pr: pr(214) },
      { kind: 'pr', pr: pr(215) },
      { kind: 'schedule', schedule },
    ]);
    expect(footer.folded).toEqual([]);
  });

  it('shows a mute as a bell, never folded on its own into a cryptic +1', () => {
    expect(tileFooter(agent({ muted: true }))).toEqual({ shown: [{ kind: 'muted' }], folded: [] });
  });

  it('folds pull requests past the second into a +N, each with a line for its tooltip', () => {
    const footer = tileFooter(
      agent({ issue, pullRequests: [pr(214), pr(215), pr(216, 'merged', 'none')], schedule, muted: true, notice: 'Worktree is 3 commits behind main' }),
    );

    expect(footer.shown.map((badge) => badge.kind)).toEqual(['issue', 'pr', 'pr', 'schedule', 'muted']);
    expect(footer.folded).toEqual(['#216 PR 216: merged, no checks']);
  });
});
