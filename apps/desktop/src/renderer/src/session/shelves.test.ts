import { describe, expect, it } from 'vitest';
import type { Agent, AgentPage, AgentRecord, GateRun, NeedsYouShows, PullRequest } from '@agent-board/daemon/protocol';
import { clockMeta, crewNeedingYou, crewStatus, folderMeta, gateWords, madeCount, pageProgress, startedBy, statusLine, nowCard, planMeta, foldCue, pullRequestsToWatch, shelfShown, shelfTabs, shortFolder, subagentStatus } from './shelves';

const agent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    sessionId: 'a',
    name: 'Export invoices',
    state: 'running',
    endedAt: null,
    spawnedBy: null,
    orphanedFrom: null,
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
    issue: null,
    status: null,
    lastMessage: null,
    ...overrides,
  }) as unknown as Agent;

const pr = (number: number, overrides: Partial<PullRequest> = {}): PullRequest =>
  ({ url: `https://github.com/o/r/pull/${number}`, number, title: `PR ${number}`, state: 'open', checks: 'passing', ...overrides }) as PullRequest;

const record = (overrides: Partial<AgentRecord>): AgentRecord => ({ recordedAt: '2026-10-30T09:00:00Z', deletedAt: null, from: null, ...overrides }) as AgentRecord;

const shows: NeedsYouShows = 'explicit';
const SETUP = { technical: true };

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

  it('leave its pins out of Made, on its page now, and leave out of its count a record the user deleted', () => {
    const url = 'https://github.com/o/r/pull/9';
    const pinned = agent({ records: [record({ kind: 'pin', key: 'note:Logins', target: { kind: 'note', text: 'ann' }, label: 'Logins' } as Partial<AgentRecord>)] });
    expect(shelfTabs(pinned, [], shows, SETUP).map((tab) => tab.id)).toEqual(['page', 'setup']);
    expect(madeCount(agent({ records: [record({ kind: 'pr', key: 'o/r#9', url, title: null, deletedAt: '2026-10-30T10:00:00Z' } as Partial<AgentRecord>)] }))).toBe(0);
  });

  it('keep Made while all it holds is deleted, so its Show can bring them back', () => {
    const url = 'https://github.com/o/r/pull/9';
    const deleted = agent({ records: [record({ kind: 'pr', key: 'o/r#9', url, title: null, deletedAt: '2026-10-30T10:00:00Z' } as Partial<AgentRecord>)] });
    expect(shelfTabs(deleted, [], shows, SETUP)).toContainEqual({ id: 'made', label: 'Made', count: 0 });
  });

  it('give Setup a tab with the technical layer, or for a linked issue or a schedule, which are no technical detail', () => {
    const off = { technical: false };
    expect(shelfTabs(agent(), [], shows, off)).toEqual([{ id: 'page', label: 'Now' }]);
    expect(shelfTabs(agent({ issue: { provider: 'linear', id: 'A-1', title: 'T', url: '' } }), [], shows, off).map((tab) => tab.id)).toEqual(['page', 'setup']);
    expect(shelfTabs(agent({ schedule: { cron: '0 9 * * *' } as Agent['schedule'] }), [], shows, off).map((tab) => tab.id)).toEqual(['page', 'setup']);
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

describe('a crew member’s status', () => {
  const ended = (overrides: Partial<Agent>) => agent({ sessionId: 'm', spawnedBy: 'a', endedAt: '2026-10-30T10:00:00Z', exitCode: 0, reviewOf: null, ledBy: null, ...overrides });

  it('says what its own window says of an ended one, never Done for one that failed, is paused or was stopped', () => {
    expect(crewStatus(ended({ state: 'failed', exitCode: 1 }), shows)).toBe('problem');
    expect(crewStatus(ended({ state: 'hibernated' }), shows)).toBe('paused');
    expect(crewStatus(ended({ state: 'stopped-by-restart' }), shows)).toBe('needs-you');
    expect(crewStatus(ended({ state: 'done', pullRequests: [pr(1)] }), shows)).toBe('needs-you');
    expect(crewStatus(ended({ state: 'done' }), shows)).toBe('done');
  });

  it('puts one that needs you in Crew’s dot and From the board as its row says, ended or not', () => {
    const lead = agent();
    const stopped = ended({ name: 'Stopped', state: 'stopped-by-restart' });
    expect(crewNeedingYou(lead, [lead, stopped], shows).map((each) => each.name)).toEqual(['Stopped']);
    expect(shelfTabs(lead, [lead, stopped], shows, SETUP)).toContainEqual({ id: 'crew', label: 'Crew', count: 1, needsYou: true });
  });
});

describe('Setup’s rows', () => {
  it('say when its folder has left its worktree', () => {
    expect(folderMeta('/wt/a/src', '/wt/a')).toBe('folder (live)');
    expect(folderMeta('/tmp/elsewhere', '/wt/a')).toBe('outside its worktree · live');
  });

  it('say when its clock next runs, or that it is paused', () => {
    expect(clockMeta('tomorrow 09:00')).toBe('its clock · next tomorrow 09:00');
    expect(clockMeta('paused')).toBe('its clock · paused');
  });
});

describe('the shelves’ words', () => {
  const run = (fields: Partial<GateRun>): GateRun =>
    ({ sessionId: 'a', command: 'c', commit: 'abc', dirty: false, startedAt: '', endedAt: null, status: 'running', exitCode: null, steps: [], ...fields }) as GateRun;

  it('put a gate run in words, saying when it failed, whatever its icon', () => {
    const steps = [{ name: 'lint', status: 'failed', startedAt: null, endedAt: null }] as GateRun['steps'];
    expect(gateWords(run({ status: 'passed', steps }))).toBe('gate passed');
    expect(gateWords(run({ status: 'failed', steps }))).toBe('gate failed · lint');
    expect(gateWords(run({ status: 'failed', exitCode: 1 }))).toBe('gate failed · exit 1');
    expect(gateWords(run({ status: 'stopped' }))).toBe('gate stopped');
  });

  it('say a subagent’s state as a crew member’s status', () => {
    expect(subagentStatus('running')).toBe('working');
    expect(subagentStatus('thinking')).toBe('working');
    expect(subagentStatus('idle')).toBe('done');
    expect(subagentStatus('rate-limited')).toBe('paused');
    expect(subagentStatus('needs-permission')).toBe('needs-you');
    expect(subagentStatus('done')).toBe('done');
    expect(subagentStatus('failed')).toBe('problem');
  });

  it('keep the part of a worktree’s path that differs', () => {
    expect(shortFolder('~/.agent-board/worktrees/billing-api/export-csv')).toBe('…/billing-api/export-csv');
    expect(shortFolder('/tmp/elsewhere')).toBe('/tmp/elsewhere');
  });

  it('say a plan’s decision, else when it was shown', () => {
    const when = (at: string) => at;
    expect(planMeta({ decision: null, presentedAt: '09:31' }, when)).toBe('shown 09:31');
    expect(planMeta({ decision: { outcome: 'approved', comments: '', decidedAt: '09:40' }, presentedAt: '09:31' }, when)).toBe('approved · 09:40');
    expect(planMeta({ decision: { outcome: 'timed-out', comments: '', decidedAt: '09:40' }, presentedAt: '09:31' }, when)).toBe('timed out · 09:40');
  });
});

describe('the rail’s progress ring', () => {
  it('reads the page’s first heading with a progress bar, else the status line’s', () => {
    expect(pageProgress(agent({ page }))).toBe(60);
    expect(pageProgress(agent({ status: { summary: 's', progress: 30, updatedAt: '', setBy: null } }))).toBe(30);
    expect(pageProgress(agent())).toBeNull();
  });
});

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

describe('foldCue', () => {
  const lead = agent();
  const asking = agent({ sessionId: 'q', name: 'Review', spawnedBy: 'a', state: 'needs-permission', permissions: [{ id: 'p' }] as unknown as Agent['permissions'] });
  const working = agent({ sessionId: 'w', name: 'Docs', spawnedBy: 'a' });
  const none = { agent: lead, agents: [lead, working], shows, gate: null };

  it('says nothing for a section that holds nothing urgent, whatever it holds', () => {
    for (const group of ['made-shown', 'made-handoff', 'crew-agents', 'crew-subagents', 'setup-where', 'setup-around'] as const) expect(foldCue(group, none)).toBeUndefined();
  });

  it('cues Crew while one of the agents it started needs you', () => {
    expect(foldCue('crew-agents', { ...none, agents: [lead, working, asking] })).toBe('needs-you');
  });

  it('cues Subagents while one needs you', () => {
    const blocked = agent({ subagents: [{ id: 's', type: 'Explore', state: 'needs-permission' }] as unknown as Agent['subagents'] });
    expect(foldCue('crew-subagents', { ...none, agent: blocked })).toBe('needs-you');
    const running = agent({ subagents: [{ id: 's', type: 'Explore', state: 'running' }] as unknown as Agent['subagents'] });
    expect(foldCue('crew-subagents', { ...none, agent: running })).toBeUndefined();
  });

  it('cues Shown to you while a plan waits for a decision, and no longer once decided', () => {
    const plan = { id: 'p', version: 1, title: 'Plan', presentedAt: '2026-10-30T09:00:00Z', decision: null } as unknown as Agent['plan'];
    expect(foldCue('made-shown', { ...none, agent: agent({ plan }) })).toBe('needs-you');
    const decided = { ...plan, decision: { outcome: 'approved', decidedAt: '2026-10-30T09:30:00Z' } } as unknown as Agent['plan'];
    expect(foldCue('made-shown', { ...none, agent: agent({ plan: decided }) })).toBeUndefined();
  });

  it('cues Around it as failing while its gate has failed, and not while it passed or has not run', () => {
    expect(foldCue('setup-around', { ...none, gate: { status: 'failed' } as GateRun })).toBe('failing');
    expect(foldCue('setup-around', { ...none, gate: { status: 'passed' } as GateRun })).toBeUndefined();
    expect(foldCue('setup-around', { ...none, gate: undefined })).toBeUndefined();
  });
});
