import { describe, expect, it } from 'vitest';
import type { Agent, AgentSchedule, LinkedIssue, PullRequest } from '@agent-board/daemon/protocol';
import { badgeLine, foldCount, foldRanking, tileFooter, type FooterItem } from './tile-footer';

const issue = { provider: 'linear', id: 'ACME-58', title: 'Movable sessions', url: 'https://linear.app/x' } as LinkedIssue;
const pr = (number: number, state: PullRequest['state'] = 'open', checks: PullRequest['checks'] = 'passing') =>
  ({ number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state, checks }) as PullRequest;
const schedule = { cron: '0 9 * * 2', prompt: 'Go', enabled: true, nextRunAt: null, lastRun: null } as AgentSchedule;
const agent = (fields: Partial<Agent> = {}) =>
  ({ model: null, role: null, roleName: null, issue: null, pullRequests: [], pushedPullRequests: [], schedule: null, muted: false, seen: false, notice: null, workFinishedAt: null, ...fields }) as Agent;

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

  it('shows the pull requests of branches it pushed to, marked so, folding past the second as its own do', () => {
    const footer = tileFooter(agent({ issue, pushedPullRequests: [pr(174, 'merged'), pr(175), pr(176)] }));

    expect(footer.shown).toEqual([
      { kind: 'issue', issue },
      { kind: 'pr', pr: pr(174, 'merged'), pushed: true },
      { kind: 'pr', pr: pr(175), pushed: true },
    ]);
    expect(footer.folded).toEqual(['Pushed to #176 PR 176: open, checks passing']);
    expect(badgeLine({ kind: 'pr', pr: pr(174, 'merged'), pushed: true }, 0)).toBe('Pushed to #174 PR 174: merged, checks passing');
  });

  it('shows the model and the role first, and neither for the default model and no role', () => {
    expect(tileFooter(agent({ model: 'opus', role: 'reviewer', issue })).shown).toEqual([
      { kind: 'model', model: 'opus' },
      { kind: 'role', role: 'reviewer', name: null },
      { kind: 'issue', issue },
    ]);
    expect(tileFooter(agent({ role: 'implementer' })).shown).toEqual([{ kind: 'role', role: 'implementer', name: null }]);
  });

  it('names a custom role by its own name, and an unnamed one Custom', () => {
    const named = tileFooter(agent({ role: 'custom', roleName: 'designer' })).shown;
    expect(named).toEqual([{ kind: 'role', role: 'custom', name: 'designer' }]);
    expect(badgeLine(named[0]!, 0)).toBe('Role: designer');
    expect(badgeLine(tileFooter(agent({ role: 'custom' })).shown[0]!, 0)).toBe('Role: Custom');
  });

  it('shows that it says its work is finished after its issue, never folding it', () => {
    const workFinishedAt = '2026-10-16T10:00:00.000Z';
    const footer = tileFooter(agent({ issue, workFinishedAt, pullRequests: [pr(214)] }));
    expect(footer.shown).toEqual([{ kind: 'issue', issue }, { kind: 'finished', at: workFinishedAt }, { kind: 'pr', pr: pr(214) }]);
    expect(foldRanking(footer.shown)).not.toContain(1);
    expect(badgeLine({ kind: 'finished', at: workFinishedAt }, 0)).toBe('Says its work is finished');
    expect(tileFooter(agent({ workFinishedAt: null })).shown).toEqual([]);
  });

  it('shows one shells chip after the rest when the agent has shells, however many, and none without', () => {
    expect(tileFooter(agent({ issue, muted: true }), 3).shown).toEqual([{ kind: 'issue', issue }, { kind: 'muted' }, { kind: 'shells' }]);
    expect(tileFooter(agent(), 0).shown).toEqual([]);
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

describe('which badges fold first', () => {
  it('folds the role before the model, and never the issue', () => {
    const { shown } = tileFooter(agent({ model: 'opus', role: 'reviewer', issue, schedule, muted: true, pullRequests: [pr(1), pr(2)] }), 2);
    const order = foldRanking(shown).map((index) => shown[index]!.kind);

    expect(order.indexOf('role')).toBeLessThan(order.indexOf('model'));
    expect(order).toEqual(['shells', 'schedule', 'role', 'model', 'muted', 'pr', 'pr']);
    expect(order).not.toContain('issue');
  });

  it('folds the later pull request first', () => {
    const { shown } = tileFooter(agent({ pullRequests: [pr(1), pr(2)] }));

    expect(foldRanking(shown)).toEqual([1, 0]);
  });

  it('says what a folded badge was, for the +N chip’s tooltip', () => {
    const base = agent({ model: 'claude-opus-5-5-20261001-experimental', role: 'follow-up-reviewer', issue, schedule, muted: true, pullRequests: [pr(7)] });
    const lines = tileFooter(base, 2).shown.map((badge) => badgeLine(badge, 2));

    expect(lines).toEqual([
      'Model: claude-opus-5-5-20261001-experimental',
      'Role: Follow-up reviewer',
      'ACME-58 Movable sessions',
      '#7 PR 7: open, checks passing',
      'Schedule: 0 9 * * 2',
      'Notifications muted',
      '2 shells',
    ]);
  });
});

describe('how many badges fold to keep the footer to two lines', () => {
  const badge = (width: number, rank: number): FooterItem => ({ kind: 'badge', width, rank });
  const fixed = (width: number): FooterItem => ({ kind: 'fixed', width });
  const plus = (width: number): FooterItem => ({ kind: 'plus', width });

  it('folds nothing when it all fits in two lines', () => {
    const items = [badge(60, 0), badge(60, 1), badge(60, 2), plus(20), fixed(50)];

    expect(foldCount({ items, available: 130, gap: 5, maxLines: 2, plusShown: false })).toBe(0);
  });

  it('folds the lowest ranks until the rest, and the +N, fit', () => {
    // 100 wide: [60 60] [60 60] [60 +N pill] is three lines; folding one leaves badges 60,60 | 60 +20 | pill.
    const items = [badge(60, 3), badge(60, 2), badge(60, 1), badge(60, 0), plus(20), fixed(50)];

    expect(foldCount({ items, available: 125, gap: 5, maxLines: 2, plusShown: false })).toBe(2);
  });

  it('counts a badge wider than the footer as the footer’s width, as it shrinks to it', () => {
    const items = [badge(500, 0), fixed(50)];

    expect(foldCount({ items, available: 100, gap: 5, maxLines: 2, plusShown: false })).toBe(0);
  });

  it('keeps the +N’s room when pull requests already fold into it', () => {
    const items = [badge(60, 0), plus(30), fixed(50)];

    expect(foldCount({ items, available: 100, gap: 5, maxLines: 1, plusShown: true })).toBe(1);
  });

  it('stops at every badge folded when even the fixed items need more than two lines', () => {
    const items = [badge(60, 0), plus(30), fixed(90), fixed(90), fixed(90)];

    expect(foldCount({ items, available: 100, gap: 5, maxLines: 2, plusShown: false })).toBe(1);
  });
});
