import { describe, expect, it } from 'vitest';
import type { Agent, AgentRecord, PullRequest } from '@agent-board/daemon/protocol';
import { moreDetailsCounts, moreDetailsLabel, pullRequestRows, startedBy, statusLine } from './inspector';

const agent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    sessionId: 'a',
    name: 'fix-login',
    spawnedBy: null,
    master: false,
    records: [],
    pullRequests: [],
    pushedPullRequests: [],
    recordedPullRequests: [],
    guessedDoc: null,
    docs: [],
    plan: null,
    subagents: [],
    schedule: null,
    ...overrides,
  }) as unknown as Agent;

const pr = (number: number, overrides: Partial<PullRequest> = {}): PullRequest =>
  ({ url: `https://github.com/o/r/pull/${number}`, number, title: `PR ${number}`, state: 'open', checks: 'passing', ...overrides }) as PullRequest;

const record = (overrides: Partial<AgentRecord>): AgentRecord => ({ recordedAt: '2026-10-30T09:00:00Z', deletedAt: null, ...overrides }) as AgentRecord;

describe('startedBy', () => {
  it('reads "you" for an agent the user started', () => {
    expect(startedBy(agent(), [])).toBe('you');
  });

  it('names the Captain, or the orchestrator, that started it', () => {
    const captain = agent({ sessionId: 'c', name: 'Captain', master: true });
    const lead = agent({ sessionId: 'l', name: 'lead' });
    expect(startedBy(agent({ spawnedBy: 'c' }), [captain, lead])).toBe('the Captain');
    expect(startedBy(agent({ spawnedBy: 'l' }), [captain, lead])).toBe('lead');
  });

  it('reads "an agent" while the one that started it is not listed', () => {
    expect(startedBy(agent({ spawnedBy: 'gone' }), [])).toBe('an agent');
  });
});

describe('statusLine', () => {
  it('leads with what the status word leaves out, then who started it and when', () => {
    expect(statusLine('Changes ready to review', 'the Captain', '9:02')).toBe('Changes ready to review · started by the Captain, 9:02');
    expect(statusLine(null, 'you', '9:14')).toBe('started by you, 9:14');
  });
});

describe('pullRequestRows', () => {
  it('lists each pull request it has, recorded or found, with its checks', () => {
    const rows = pullRequestRows(agent({ pullRequests: [pr(214)], pushedPullRequests: [pr(215, { checks: 'none' })] }));
    expect(rows.map((row) => [row.name, row.checks])).toEqual([
      ['Pull request #214', 'checks passing'],
      ['Pull request #215', 'no checks'],
    ]);
  });

  it('leaves out one deleted from its sidebar', () => {
    const url = 'https://github.com/o/r/pull/9';
    const rows = pullRequestRows(agent({ records: [record({ kind: 'pr', key: 'github.com/o/r#9', url, title: null, deletedAt: '2026-10-30T10:00:00Z' } as Partial<AgentRecord>)] }));
    expect(rows).toEqual([]);
  });
});

describe('More details', () => {
  it('counts what the fold holds, and has no label when it holds nothing', () => {
    expect(moreDetailsLabel(moreDetailsCounts(agent(), []))).toBeUndefined();
  });

  it('names its agents, documents, pins, subagents and schedule, each counted', () => {
    const crew = [agent({ sessionId: 'x', name: 'x', spawnedBy: 'a' }), agent({ sessionId: 'y', name: 'y', spawnedBy: 'a' })];
    const counts = moreDetailsCounts(
      agent({
        guessedDoc: '/wt/.agent-board/handover.md',
        docs: [{ id: 'd', title: 'Notes', version: 1, shownAt: '2026-10-30T09:00:00Z', path: '/wt/notes.md' }] as unknown as Agent['docs'],
        records: [record({ kind: 'pin', key: 'p', target: { kind: 'note', text: 'hi' }, label: 'Read me', from: null } as Partial<AgentRecord>)],
        schedule: { cron: '0 9 * * 1-5' } as Agent['schedule'],
      }),
      crew,
    );
    expect(counts).toEqual({ agents: 2, documents: 2, pins: 1, subagents: 0, schedules: 1 });
    expect(moreDetailsLabel(counts)).toBe('2 agents, 2 documents, 1 pin, 1 schedule');
  });
});
