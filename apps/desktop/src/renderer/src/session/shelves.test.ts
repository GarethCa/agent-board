import { describe, expect, it } from 'vitest';
import type { Agent, AgentPage, AgentRecord, NeedsYouShows, PullRequest } from '@agent-board/daemon/protocol';
import { crewNeedingYou, madeCount, nowCard, pullRequestsToWatch, shelfShown, shelfTabs } from './shelves';

const agent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    sessionId: 'a',
    name: 'Export invoices',
    state: 'running',
    endedAt: null,
    spawnedBy: null,
    master: false,
    flag: null,
    permissions: [],
    ask: null,
    plan: null,
    records: [],
    pullRequests: [],
    pushedPullRequests: [],
    recordedPullRequests: [],
    guessedDoc: null,
    page: null,
    docs: [],
    subagents: [],
    schedule: null,
    status: null,
    lastMessage: null,
    ...overrides,
  }) as unknown as Agent;

const pr = (number: number, overrides: Partial<PullRequest> = {}): PullRequest =>
  ({ url: `https://github.com/o/r/pull/${number}`, number, title: `PR ${number}`, state: 'open', checks: 'passing', ...overrides }) as PullRequest;

const record = (overrides: Partial<AgentRecord>): AgentRecord => ({ recordedAt: '2026-10-30T09:00:00Z', deletedAt: null, from: null, ...overrides }) as AgentRecord;

const shows: NeedsYouShows = 'explicit';
const SETUP = { setup: true };

const page: AgentPage = {
  name: 'Export',
  icon: 'route',
  writtenAt: '2026-10-30T09:00:00Z',
  blocks: [
    { kind: 'callout', text: 'Note', title: null, icon: null, tone: 'neutral' },
    { kind: 'heading', title: "Where I'm up to", text: null, progress: 60, icon: null, tone: 'neutral' },
  ],
};

describe('the shelves that have a tab', () => {
  it('are the board’s Now and Setup for an agent that has made nothing and started no one', () => {
    expect(shelfTabs(agent(), [], shows, SETUP)).toEqual([
      { id: 'page', label: 'Now' },
      { id: 'setup', label: 'Setup' },
    ]);
  });

  it('name the page’s tab with the name and icon the agent picked', () => {
    expect(shelfTabs(agent({ page }), [], shows, SETUP)[0]).toEqual({ id: 'page', label: 'Export', icon: 'route' });
  });

  it('add Made with its count once it has a pull request, a document or a hand-off doc, whatever its checks say', () => {
    const made = agent({
      pullRequests: [pr(482, { checks: 'pending' }), pr(477, { state: 'merged' })],
      docs: [{ id: 'd', title: 'Spec', version: 2, shownAt: '2026-10-30T09:48:00Z', path: '/wt/spec.md' }] as unknown as Agent['docs'],
      guessedDoc: '/wt/.agent-board/handover.md',
    });
    expect(shelfTabs(made, [], shows, SETUP)).toContainEqual({ id: 'made', label: 'Made', count: 4 });
    expect(madeCount(made)).toBe(4);
  });

  it('count its pins in Made until they move onto its page, and leave out a record the user deleted', () => {
    const url = 'https://github.com/o/r/pull/9';
    const pinned = agent({
      records: [
        record({ kind: 'pin', key: 'note:Logins', target: { kind: 'note', text: 'ann' }, label: 'Logins' } as Partial<AgentRecord>),
        record({ kind: 'pr', key: 'o/r#9', url, title: null, deletedAt: '2026-10-30T10:00:00Z' } as Partial<AgentRecord>),
      ],
    });
    expect(shelfTabs(pinned, [], shows, SETUP)).toContainEqual({ id: 'made', label: 'Made', count: 1 });
    expect(madeCount(agent({ records: [record({ kind: 'pr', key: 'o/r#9', url, title: null, deletedAt: '2026-10-30T10:00:00Z' } as Partial<AgentRecord>)] }))).toBe(0);
  });

  it('give Setup a tab only while the window has something for it', () => {
    expect(shelfTabs(agent(), [], shows, { setup: false })).toEqual([{ id: 'page', label: 'Now' }]);
  });

  it('add Crew once it starts an agent or has a subagent, an orange dot while one of its crew needs you', () => {
    const lead = agent();
    const working = agent({ sessionId: 'w', name: 'Docs', spawnedBy: 'a' });
    const asking = agent({ sessionId: 'q', name: 'Review', spawnedBy: 'a', state: 'needs-permission', permissions: [{ id: 'p' }] as unknown as Agent['permissions'] });
    expect(shelfTabs(lead, [lead, working], shows, SETUP)).toContainEqual({ id: 'crew', label: 'Crew', count: 1 });
    expect(shelfTabs(lead, [lead, working, asking], shows, SETUP)).toContainEqual({ id: 'crew', label: 'Crew', count: 2, needsYou: true });
    expect(crewNeedingYou(lead, [lead, working, asking], shows).map((each) => each.name)).toEqual(['Review']);
    const subagents = agent({ subagents: [{ id: 's', type: 'Explore', state: 'running' }] as unknown as Agent['subagents'] });
    expect(shelfTabs(subagents, [], shows, SETUP).map((tab) => tab.id)).toEqual(['page', 'crew', 'setup']);
  });
});

describe('the shelf shown', () => {
  it('is the one asked for while it has a tab, else the page', () => {
    const tabs = shelfTabs(agent({ pullRequests: [pr(1)] }), [], shows, SETUP);
    expect(shelfShown('made', tabs)).toBe('made');
    expect(shelfShown('crew', tabs)).toBe('page');
  });
});

describe('the pull requests "From the board" names', () => {
  it('are the open ones whose checks are failing or pending, failing first; never merged, passing or deleted ones', () => {
    const url = 'https://github.com/o/r/pull/5';
    const watched = pullRequestsToWatch(
      agent({
        pullRequests: [pr(1, { checks: 'pending' }), pr(2, { checks: 'failing' }), pr(3, { checks: 'passing' }), pr(4, { state: 'merged', checks: 'failing' }), pr(5, { checks: 'failing' })],
        records: [record({ kind: 'pr', key: 'o/r#5', url, title: null, deletedAt: '2026-10-30T10:00:00Z' } as Partial<AgentRecord>)],
      }),
    );
    expect(watched.map((each) => [each.number, each.checks])).toEqual([
      [2, 'failing'],
      [1, 'pending'],
    ]);
  });
});

describe('the board’s Now', () => {
  it('says what it is doing, else its last message', () => {
    expect(nowCard(agent({ status: { summary: 'Streaming rows', progress: 60, updatedAt: '', setBy: null }, lastMessage: 'Hi' }))).toEqual({ kind: 'status', summary: 'Streaming rows', progress: 60 });
    expect(nowCard(agent({ lastMessage: 'Postgres or SQLite?' }))).toEqual({ kind: 'message', text: 'Postgres or SQLite?' });
    expect(nowCard(agent())).toEqual({ kind: 'none' });
  });

});
