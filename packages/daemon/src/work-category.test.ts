import { describe, expect, it } from 'vitest';
import { WORK_CATEGORIES, type Agent } from './protocol.ts';
import { WORK_CATEGORY_GROUP, WORK_CATEGORY_LABELS, WORK_GROUPS, workCategory, type ReviewerFacts } from './work-category.ts';

const agent = (patch: Partial<Agent>): Agent =>
  ({
    name: 'impl',
    harness: 'claude',
    state: 'idle',
    endedAt: null,
    exitCode: null,
    permissions: [],
    ask: null,
    plan: null,
    stepsWait: null,
    flag: null,
    ledBy: null,
    reviewOf: null,
    lastMessage: null,
    pullRequests: [],
    hibernated: null,
    workFinishedAt: null,
    workCategory: null,
    ...patch,
  }) as Agent;

const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '2026-11-11T07:12:00.000Z', expiresAt: '', onBoard: false, questions: [{ question: 'Which cache?', options: [], freeText: true }], answers: [null], card: null };
const permission = { id: 'p', toolName: 'Bash', toolInput: {}, subagent: null, requestedAt: '2026-11-11T07:40:00.000Z', heldUntil: null, asksInTerminal: true, sessionGrant: null, questions: null } as Agent['permissions'][number];
const pr = (state: 'open' | 'draft' | 'merged' | 'closed', checks = 'passing', number = 231) => ({ number, title: 'Fix', url: '', state, checks }) as Agent['pullRequests'][number];
const own = (patch: Partial<NonNullable<Agent['workCategory']>> = {}): Agent['workCategory'] => ({
  category: 'waiting-on-others',
  label: null,
  waitingOn: { who: 'Northwind Pay support', ref: '#48213' },
  setAt: '2026-11-09T16:05:00.000Z',
  setBy: null,
  ...patch,
});
const reviewer = (patch: Partial<ReviewerFacts> = {}): ReviewerFacts => ({ name: 'reviewer', state: 'running', endedAt: null, ...patch });

const read = (patch: Partial<Agent>, reviewers: ReviewerFacts[] = []) => workCategory(agent(patch), { shows: 'explicit', reviewers });

describe('the seven work categories', () => {
  it('are ordered by who acts next, each in one of four groups', () => {
    expect(WORK_CATEGORIES).toEqual(['needs-help', 'ready-for-review', 'blocked', 'waiting-on-others', 'in-review', 'working', 'done']);
    expect(WORK_GROUPS).toEqual(['on-you', 'stuck', 'on-others', 'on-its-own']);
    expect(WORK_CATEGORY_GROUP).toEqual({
      'needs-help': 'on-you',
      'ready-for-review': 'on-you',
      blocked: 'stuck',
      'waiting-on-others': 'on-others',
      'in-review': 'on-others',
      working: 'on-its-own',
      done: 'on-its-own',
    });
    expect(WORK_CATEGORY_LABELS['waiting-on-others']).toBe('Waiting on others');
  });
});

describe('workCategory: the agent sets its own', () => {
  it('reads what it set, with its label, who it waits on and since when', () => {
    expect(read({ state: 'idle', workCategory: own({ label: 'With Legal' }) })).toEqual({
      category: 'waiting-on-others',
      label: 'With Legal',
      source: 'agent',
      setBy: null,
      why: null,
      waitingOn: { who: 'Northwind Pay support', ref: '#48213' },
      since: '2026-11-09T16:05:00.000Z',
    });
  });

  it('names the orchestrator that set it for its crew member', () => {
    expect(read({ workCategory: own({ setBy: 'Captain' }) })).toMatchObject({ source: 'agent', setBy: 'Captain' });
  });

  it('stands over what the board would guess: its open PR, a running reviewer, its usage limit', () => {
    expect(read({ pullRequests: [pr('open')], workCategory: own() }, [reviewer()]).category).toBe('waiting-on-others');
    expect(read({ state: 'rate-limited', workCategory: own({ category: 'in-review' }) }).category).toBe('in-review');
  });

  it('gives way to Needs help while a question or a permission prompt waits on the user', () => {
    expect(read({ ask, workCategory: own() })).toMatchObject({ category: 'needs-help', source: 'board', why: 'a question in Needs you', since: ask.askedAt });
    expect(read({ state: 'needs-permission', permissions: [permission], workCategory: own() })).toMatchObject({
      category: 'needs-help',
      source: 'board',
      why: 'a permission prompt',
      since: permission.requestedAt,
    });
  });

  it('gives way to how its session ended, which it can no longer change', () => {
    expect(read({ state: 'failed', endedAt: '2026-11-11T03:20:00.000Z', exitCode: 1, workCategory: own() })).toMatchObject({ category: 'blocked', source: 'board' });
    expect(read({ state: 'done', endedAt: '2026-11-11T03:20:00.000Z', workCategory: own() })).toMatchObject({ category: 'done', source: 'board' });
  });
});

describe('workCategory: the board guesses', () => {
  it('Needs help for whatever the inbox holds for the user, a question in its last words, or a restart that stopped it', () => {
    expect(read({ flag: { id: 1, reason: 'Ready', at: '2026-11-11T05:00:00.000Z', to: 'user', via: null } })).toMatchObject({ category: 'needs-help', why: 'it flagged you' });
    expect(read({ state: 'idle', lastMessage: 'Retry 3× or 5× on a 502?' })).toMatchObject({ category: 'needs-help', why: 'its last message asks you' });
    expect(read({ state: 'stopped-by-restart' })).toMatchObject({ category: 'needs-help', why: 'the app restarted under it' });
  });

  it('not Needs help for a finished turn the inbox lists, nor a crew member asking its orchestrator', () => {
    expect(workCategory(agent({ state: 'waiting' }), { shows: 'turns' }).category).toBe('done');
    expect(read({ state: 'idle', ledBy: 'Captain', lastMessage: 'Shall I?' })).toMatchObject({ category: 'working', why: 'with Captain' });
  });

  it('Ready for review for an open PR at its prompt with no reviewer running', () => {
    expect(read({ pullRequests: [pr('open')] })).toEqual({
      category: 'ready-for-review',
      label: null,
      source: 'board',
      setBy: null,
      why: 'PR #231 open, no reviewer yet',
      waitingOn: null,
      since: null,
    });
  });

  it('Waiting on others, labelled CI, while its open PR\'s checks run', () => {
    expect(read({ pullRequests: [pr('open', 'pending')] })).toMatchObject({ category: 'waiting-on-others', label: 'CI', why: 'PR #231 checks running' });
  });

  it('In review while a reviewer of its work runs, waiting on that reviewer', () => {
    expect(read({ pullRequests: [pr('open')] }, [reviewer({ name: 'pay-815 reviewer' })])).toMatchObject({
      category: 'in-review',
      why: 'its reviewer is running',
      waitingOn: { who: 'pay-815 reviewer', ref: null },
    });
    // One that ended, or sits at its prompt, reviews no more.
    expect(read({ pullRequests: [pr('open')] }, [reviewer({ endedAt: '2026-11-11T01:00:00.000Z' }), reviewer({ state: 'idle' })]).category).toBe('ready-for-review');
  });

  it('Blocked, not Ready for review, while its open PR\'s checks fail', () => {
    expect(read({ pullRequests: [pr('open', 'failing')] })).toMatchObject({ category: 'blocked', why: 'PR #231 checks failing' });
  });

  it('Working, not Done, while its PR is a draft', () => {
    expect(read({ pullRequests: [pr('draft')] })).toMatchObject({ category: 'working', why: 'PR #231 draft' });
  });

  it('reads a crew member by its PR and its reviewer as any agent, and Working with its orchestrator only when nothing else says', () => {
    const crew = { state: 'idle' as const, ledBy: 'Captain' };
    expect(read({ ...crew, pullRequests: [pr('open')] }, [reviewer()]).category).toBe('in-review');
    expect(read({ ...crew, pullRequests: [pr('open', 'pending')] })).toMatchObject({ category: 'waiting-on-others', label: 'CI' });
    expect(read({ ...crew, pullRequests: [pr('open')] }).category).toBe('ready-for-review');
    expect(read({ ...crew, pullRequests: [pr('merged')] })).toMatchObject({ category: 'done', why: 'PR #231 merged' });
    expect(read({ ...crew, workFinishedAt: '2026-11-11T02:10:00.000Z' })).toMatchObject({ category: 'done', why: 'it said its work is finished' });
    expect(read(crew)).toMatchObject({ category: 'working', why: 'with Captain' });
  });

  it('Blocked when it failed or hit its usage limit', () => {
    expect(read({ state: 'failed', endedAt: '2026-11-11T03:20:00.000Z', exitCode: 2 })).toMatchObject({ category: 'blocked', why: 'it failed · exit 2' });
    expect(read({ state: 'rate-limited' })).toMatchObject({ category: 'blocked', why: 'its usage limit' });
  });

  it('Working while it runs, even with an open PR, and while paused or scheduled', () => {
    for (const state of ['running', 'thinking', 'starting', 'handing-off', 'on-command'] as const) {
      expect(read({ state, pullRequests: [pr('open')] }).category, state).toBe('working');
    }
    expect(read({ state: 'hibernated', hibernated: { at: '', by: null, byId: null } })).toMatchObject({ category: 'working', why: 'paused' });
    expect(read({ state: 'scheduled' })).toMatchObject({ category: 'working', why: 'scheduled' });
  });

  it('Done when its PR merged, it said its work is finished, its turn ended, or its session ended', () => {
    expect(read({ pullRequests: [pr('merged', 'passing', 224)] })).toMatchObject({ category: 'done', why: 'PR #224 merged' });
    expect(read({ workFinishedAt: '2026-11-11T02:10:00.000Z' })).toMatchObject({ category: 'done', why: 'it said its work is finished', since: '2026-11-11T02:10:00.000Z' });
    expect(read({ state: 'idle' })).toMatchObject({ category: 'done', why: 'its turn ended' });
    expect(read({ state: 'done', endedAt: '2026-11-11T03:00:00.000Z' })).toMatchObject({ category: 'done', why: 'its session ended' });
  });

  it('reads an ended session\'s open PR as waiting on review still', () => {
    expect(read({ state: 'done', endedAt: '2026-11-11T03:00:00.000Z', pullRequests: [pr('open')] }).category).toBe('ready-for-review');
  });
});
