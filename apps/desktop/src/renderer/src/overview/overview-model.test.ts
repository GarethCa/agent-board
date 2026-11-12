import { describe, expect, it } from 'vitest';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { ageText, filterCounts, initials, overviewColumns, overviewThreads, when, type OverviewThread } from './overview-model';

const SEEN = '2026-11-11T18:40:00.000Z';

let next = 0;
const agent = (patch: Partial<Agent>): Agent =>
  ({
    sessionId: `s${++next}`,
    zoneId: null,
    name: `agent-${next}`,
    harness: 'claude',
    state: 'running',
    stateSince: '2026-11-12T07:00:00.000Z',
    endedAt: null,
    exitCode: null,
    permissions: [],
    ask: null,
    plan: null,
    stepsWait: null,
    flag: null,
    ledBy: null,
    reviewOf: null,
    master: false,
    status: null,
    lastMessage: null,
    pullRequests: [],
    hibernated: null,
    workFinishedAt: null,
    workCategory: null,
    ...patch,
  }) as Agent;

const zone = (id: string, name: string, x: number, y: number): Zone => ({ id, name, color: '#1c7ed6', x, y }) as Zone;
const pr = (number: number, state: 'open' | 'merged', title = 'Fix') => ({ number, title, url: '', state, checks: 'passing' }) as Agent['pullRequests'][number];
const waiting = (who: string, ref: string | null, setAt = '2026-11-08T10:00:00.000Z'): Agent['workCategory'] => ({
  category: 'waiting-on-others',
  label: null,
  waitingOn: { who, ref },
  setAt,
  setBy: null,
});

const threads = (agents: Agent[]) => overviewThreads(agents, { shows: 'explicit', seenAt: SEEN });
const columns = (agents: Agent[], zones: Zone[], options: Partial<Parameters<typeof overviewColumns>[2]> = {}) =>
  overviewColumns(threads(agents), zones, { filter: 'all', query: '', groups: 'waiting', projects: 'board', ...options });
const names = (list: readonly OverviewThread[]) => list.map((thread) => thread.name);

describe('the overview’s threads', () => {
  it('reads each agent’s category, its line, and whether the agent set it or the board guessed', () => {
    const [own, guessed] = threads([
      agent({ name: 'pay-790', state: 'idle', workCategory: waiting('Security team', 'scope sign-off'), status: { summary: 'Scope doc drafted', progress: null, updatedAt: '2026-11-08T10:00:00.000Z', setBy: null } }),
      agent({ name: 'pay-806', state: 'idle', pullRequests: [pr(231, 'open')], lastMessage: 'PR #231 is up.\nChecks are green.' }),
    ]);
    expect(own).toMatchObject({ name: 'pay-790', category: 'waiting-on-others', chip: 'Waiting on others', source: 'agent', line: 'Scope doc drafted', waitingOn: { who: 'Security team', ref: 'scope sign-off' }, since: '2026-11-08T10:00:00.000Z' });
    expect(guessed).toMatchObject({ category: 'ready-for-review', source: 'board', line: 'PR #231 is up.', why: 'PR #231 open, no reviewer yet', pr: '#231' });
  });

  it('leaves the line empty rather than use the board’s reason, which stays for the tooltip', () => {
    const [thread] = threads([agent({ state: 'rate-limited' })]);
    expect(thread).toMatchObject({ category: 'blocked', line: '', why: 'its usage limit' });
  });

  it('reads each reviewer once, by whom it reviews', () => {
    const impl = agent({ name: 'impl', state: 'idle', pullRequests: [pr(5, 'open')] });
    const [thread] = threads([impl, agent({ reviewOf: impl.sessionId, state: 'running' })]);
    expect(thread).toMatchObject({ name: 'impl', category: 'in-review' });
  });

  it('shows the agent’s own label on the chip in place of the category’s name', () => {
    const [thread] = threads([agent({ state: 'idle', workCategory: { ...waiting('Legal', null)!, label: 'With Legal' } })]);
    expect(thread).toMatchObject({ category: 'waiting-on-others', chip: 'With Legal' });
  });

  it('leaves out the master, and a reviewer unless it needs the user or is stuck', () => {
    const impl = agent({ name: 'impl', state: 'idle', pullRequests: [pr(9, 'open')] });
    const list = threads([
      impl,
      agent({ name: 'captain', master: true }),
      agent({ name: 'rev', reviewOf: impl.sessionId }),
      agent({ name: 'rev-asks', state: 'idle', reviewOf: impl.sessionId, flag: { id: 1, reason: 'Which way?', at: '2026-11-12T07:00:00.000Z', to: 'user', via: null } }),
    ]);
    expect(names(list)).toEqual(['impl', 'rev-asks']);
    expect(list[0]).toMatchObject({ category: 'in-review', waitingOn: { who: 'rev', ref: null } });
  });

  it('marks a thread changed since the last look as fresh', () => {
    const [old, fresh] = threads([
      agent({ stateSince: '2026-11-11T17:00:00.000Z' }),
      agent({ stateSince: '2026-11-11T17:00:00.000Z', status: { summary: 'Now', progress: null, updatedAt: '2026-11-12T06:00:00.000Z', setBy: null } }),
    ]);
    expect([old!.fresh, fresh!.fresh]).toEqual([false, true]);
  });
});

describe('the overview’s columns', () => {
  const pay = zone('pay', 'Payments', 0, 0);
  const web = zone('web', 'Web', 900, 0);

  it('is a column per project with agents, then On the board for the loose ones, each grouped in the seven’s order', () => {
    const list = columns(
      [
        agent({ name: 'w1', zoneId: 'web' }),
        agent({ name: 'p-done', zoneId: 'pay', state: 'idle' }),
        agent({ name: 'p-wait', zoneId: 'pay', state: 'idle', workCategory: waiting('Ops', null) }),
        agent({ name: 'p-help', zoneId: 'pay', state: 'idle', ask: { id: 'q', askedAt: '2026-11-12T07:12:00.000Z' } as Agent['ask'] }),
        agent({ name: 'loose' }),
      ],
      [zone('empty', 'Empty', -900, 0), web, pay],
    );
    expect(list.map((column) => column.name)).toEqual(['Payments', 'Web', 'On the board']);
    expect(list[0]!.groups.map((group) => group.category)).toEqual(['needs-help', 'waiting-on-others', 'done']);
    expect(list[0]).toMatchObject({ count: 3, onYou: 1, onOthers: 1, color: '#1c7ed6' });
    expect(list[2]).toMatchObject({ id: null, color: null });
  });

  it('keeps the board’s order, or puts the project with most on you first', () => {
    const agents = [agent({ zoneId: 'pay' }), agent({ zoneId: 'web', state: 'idle', pullRequests: [pr(4, 'open')] })];
    expect(columns(agents, [web, pay]).map((column) => column.name)).toEqual(['Payments', 'Web']);
    expect(columns(agents, [pay, web], { projects: 'on-you' }).map((column) => column.name)).toEqual(['Web', 'Payments']);
  });

  it('sorts each group by longest waiting, newest change or name', () => {
    const agents = [
      agent({ name: 'b', zoneId: 'pay', state: 'idle', workCategory: waiting('X', null, '2026-11-10T00:00:00.000Z') }),
      agent({ name: 'c', zoneId: 'pay', state: 'idle', workCategory: waiting('X', null, '2026-11-05T00:00:00.000Z') }),
      agent({ name: 'a', zoneId: 'pay', state: 'idle', workCategory: waiting('X', null, '2026-11-11T00:00:00.000Z') }),
    ];
    const order = (groups: 'waiting' | 'newest' | 'name') => names(columns(agents, [pay], { groups })[0]!.groups[0]!.threads);
    expect(order('waiting')).toEqual(['c', 'b', 'a']);
    expect(order('newest')).toEqual(['a', 'b', 'c']);
    expect(order('name')).toEqual(['a', 'b', 'c']);
  });

  it('filters to a group, dropping the columns left empty', () => {
    const agents = [agent({ zoneId: 'pay' }), agent({ zoneId: 'web', state: 'idle', workCategory: waiting('Ops', null) })];
    const list = columns(agents, [pay, web], { filter: 'on-others' });
    expect(list.map((column) => column.name)).toEqual(['Web']);
    expect(list[0]!.count).toBe(1);
  });

  it('searches the name, the line, who it waits on and the PR', () => {
    const agents = [
      agent({ name: 'pay-799', zoneId: 'pay', state: 'idle', workCategory: waiting('Northwind Pay support', '#48213') }),
      agent({ name: 'web-1', zoneId: 'web', status: { summary: 'Apple Pay sheet', progress: null, updatedAt: '', setBy: null } }),
      agent({ name: 'web-2', zoneId: 'web', state: 'idle', pullRequests: [pr(97, 'open', 'Gift cards')] }),
    ];
    const found = (query: string) => columns(agents, [pay, web], { query }).flatMap((column) => column.groups.flatMap((group) => names(group.threads)));
    expect(found('northwind')).toEqual(['pay-799']);
    expect(found('48213')).toEqual(['pay-799']);
    expect(found('apple')).toEqual(['web-1']);
    expect(found('#97')).toEqual(['web-2']);
    expect(found('gift')).toEqual(['web-2']);
    expect(found('WEB-')).toEqual(['web-2', 'web-1']);
  });

  it('counts each filter over every thread', () => {
    const list = threads([
      agent({}),
      agent({ state: 'idle' }),
      agent({ state: 'idle', pullRequests: [pr(1, 'open')] }),
      agent({ state: 'idle', workCategory: waiting('Ops', null) }),
      agent({ state: 'rate-limited' }),
    ]);
    expect(filterCounts(list)).toEqual({ all: 5, 'on-you': 1, stuck: 1, 'on-others': 1, working: 1, done: 1 });
  });

  it('counts the done threads that finished since the last look', () => {
    const list = columns(
      [agent({ zoneId: 'pay', state: 'idle', stateSince: '2026-11-11T12:00:00.000Z' }), agent({ zoneId: 'pay', state: 'idle', stateSince: '2026-11-12T01:00:00.000Z' })],
      [pay],
    );
    expect(list[0]!.groups[0]).toMatchObject({ category: 'done', freshCount: 1 });
  });
});

describe('the overview’s words', () => {
  it('writes an age under a day as the clock time it began, and a longer one in days, turned old', () => {
    const now = new Date('2026-11-12T08:00:00');
    expect(ageText(new Date('2026-11-12T07:12:00').toISOString(), now)).toEqual({ text: '07:12', old: false });
    expect(ageText(new Date('2026-11-08T08:00:00').toISOString(), now)).toEqual({ text: '4 d', old: true });
    expect(ageText(new Date('2026-11-11T23:00:00').toISOString(), now)).toEqual({ text: 'yesterday 23:00', old: false });
  });

  it('writes a time with its day unless it is today', () => {
    const now = new Date('2026-11-12T08:00:00');
    expect(when(new Date('2026-11-12T07:12:00'), now)).toBe('07:12');
    expect(when(new Date('2026-11-11T18:40:00'), now)).toBe('yesterday 18:40');
    expect(when(new Date('2026-11-09T18:40:00'), now)).toBe('Mon 18:40');
    expect(when(new Date('2026-10-30T18:40:00'), now)).toBe('30 Oct');
  });

  it('writes who it waits on as initials', () => {
    expect([initials('Security team'), initials('Northwind Pay support'), initials('Legal'), initials('ci')]).toEqual(['ST', 'NPS', 'LEG', 'CI']);
  });
});
