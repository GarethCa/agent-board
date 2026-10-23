import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAskHost } from '../src/asks.ts';
import { readPlanSource } from '../src/board-ops.ts';
import { migrate } from '../src/migrate.ts';
import { DEFAULT_ASK_WAIT_MS, DEFAULT_PLAN_WAIT_MS, MAX_ASK_OPTIONS } from '../src/protocol.ts';
import { createFakeClock } from './fake-clock.ts';
import { tempDataDir } from './helpers.ts';

const START = new Date('2026-10-14T14:00:00.000Z');

/** A host over a fresh database, with the changes it reports, on a fake clock. */
function asks(db = memoryDb()) {
  const clock = createFakeClock(START);
  const changes: [string, boolean][] = [];
  const placed: string[] = [];
  const host = createAskHost({ db, clock, changed: (sessionId, began) => changes.push([sessionId, began]), placed: (sessionId) => placed.push(sessionId) });
  return { db, clock, changes, placed, host };
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  // No agents rows for the stand-in agents: their plans stand alone.
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

const never = () => new AbortController().signal;

describe('questions an agent asks the user', () => {
  it('waits for the user to pick an option, and says which', async () => {
    const { host, changes } = asks();
    const answered = host.ask('s1', { question: 'Which cache?', options: ['Redis', 'In-memory LRU', 'CDN only'] }, never());

    const ask = host.pendingAsk('s1')!;
    expect(ask).toMatchObject({ question: 'Which cache?', options: ['Redis', 'In-memory LRU', 'CDN only'], freeText: false, askedAt: START.toISOString() });
    expect(Date.parse(ask.expiresAt) - START.getTime()).toBe(DEFAULT_ASK_WAIT_MS);
    expect(changes).toEqual([['s1', true]]);

    host.answer('s1', ask.id, { option: 0 });
    expect(await answered).toEqual({ outcome: 'answered', answer: 'Redis' });
    expect(host.pendingAsk('s1')).toBeNull();
    expect(changes).toEqual([['s1', true], ['s1', false]]);
  });

  it('takes the user’s own words only for a question that allows them, and always for one with no options', async () => {
    const { host } = asks();
    void host.ask('s1', { question: 'Which cache?', options: ['Redis'] }, never());
    const { id } = host.pendingAsk('s1')!;
    expect(() => host.answer('s1', id, { text: 'Memcached' })).toThrow(/only its options/);
    expect(() => host.answer('s1', id, { option: 1 })).toThrow(/no option 2/);

    const open = host.ask('s2', { question: 'What should the banner say?' }, never());
    expect(host.pendingAsk('s2')!.freeText).toBe(true);
    host.answer('s2', host.pendingAsk('s2')!.id, { text: '  Free shipping  ' });
    expect(await open).toEqual({ outcome: 'answered', answer: 'Free shipping' });
  });

  it('tells the agent the user skipped it, or that the time ran out, never answering for them', async () => {
    const { host, clock } = asks();
    const skipped = host.ask('s1', { question: 'Which cache?', options: ['Redis'] }, never());
    host.answer('s1', host.pendingAsk('s1')!.id, { skip: true });
    expect(await skipped).toEqual({ outcome: 'skipped', answer: null });

    const late = host.ask('s1', { question: 'Which cache?', options: ['Redis'], timeoutMs: 60_000 }, never());
    const { id } = host.pendingAsk('s1')!;
    clock.advance(60_000);
    expect(await late).toEqual({ outcome: 'timed-out', answer: null });
    expect(host.pendingAsk('s1')).toBeNull();
    expect(() => host.answer('s1', id, { option: 0 })).toThrow(/no longer asks/);
  });

  it('goes, unanswered, once the agent stops waiting: its call cancelled, or its turn over', async () => {
    const { host, changes } = asks();
    const controller = new AbortController();
    const cancelled = host.ask('s1', { question: 'Which cache?' }, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/stopped waiting/);
    expect(host.pendingAsk('s1')).toBeNull();

    const dropped = host.ask('s1', { question: 'Which cache?' }, never());
    host.drop('s1');
    await expect(dropped).rejects.toThrow(/stopped waiting/);
    expect(host.pendingAsk('s1')).toBeNull();
    expect(changes).toEqual([['s1', true], ['s1', false], ['s1', true], ['s1', false]]);
  });

  it('asks one thing at a time, and refuses a question it can’t show', () => {
    const { host } = asks();
    void host.ask('s1', { question: 'Which cache?' }, never());
    expect(() => host.ask('s1', { question: 'And the TTL?' }, never())).toThrow(/already ask the user/);
    expect(() => host.ask('s2', { question: '  ' }, never())).toThrow(/question must not be empty/);
    expect(() => host.ask('s2', { question: 'Which?', options: Array.from({ length: MAX_ASK_OPTIONS + 1 }, (_, i) => `${i}`) }, never())).toThrow(/at most 9 options/);
    expect(() => host.ask('s2', { question: 'Which?', options: ['Redis', ''] }, never())).toThrow(/option 2 must not be empty/);
  });

  it('shows a question on the board only when the agent asks for its card, beside its tile until the user moves it', async () => {
    const { host, changes, placed } = asks();
    void host.ask('s1', { question: 'Which cache?' }, never());
    expect(host.pendingAsk('s1')).toMatchObject({ onBoard: false, at: null });

    const answered = host.ask('s2', { question: 'Which cache?', options: ['Redis'], onBoard: true }, never());
    const { id } = host.pendingAsk('s2')!;
    expect(host.pendingAsk('s2')).toMatchObject({ onBoard: true, at: null });

    host.place('s2', id, { x: 420, y: -80 });
    expect(host.pendingAsk('s2')).toMatchObject({ id, onBoard: true, at: { x: 420, y: -80 } });
    // A move is no new question: the agent's tile and the inbox follow, and what the user saw of it stays seen.
    expect(placed).toEqual(['s2']);
    expect(changes).toEqual([['s1', true], ['s2', true]]);

    expect(() => host.place('s2', 'another', { x: 0, y: 0 })).toThrow(/no longer asks/);
    expect(() => host.place('s1', host.pendingAsk('s1')!.id, { x: 0, y: 0 })).toThrow(/not on the board/);
    expect(() => host.place('s2', id, { x: Number.NaN, y: 0 })).toThrow(/point/);

    host.answer('s2', id, { option: 0 });
    expect(await answered).toEqual({ outcome: 'answered', answer: 'Redis' });
    expect(() => host.place('s2', id, { x: 0, y: 0 })).toThrow(/no longer asks/);
  });
});

describe('plans an agent presents', () => {
  it('keeps each plan as the next version, and returns the user’s decision and comments', async () => {
    const { host, db, changes } = asks();
    const first = host.presentPlan('s1', { title: 'Cache product pages', body: '# Goal\n\nFast pages', format: 'markdown' }, never());

    const plan = host.latestPlan('s1')!;
    expect(plan).toMatchObject({ version: 1, title: 'Cache product pages', format: 'markdown', decision: null, presentedAt: START.toISOString() });
    expect(Date.parse(plan.expiresAt) - START.getTime()).toBe(DEFAULT_PLAN_WAIT_MS);
    expect(changes).toEqual([['s1', true]]);

    host.decide('s1', plan.id, 'changes-requested', 'Also bust on the nightly import');
    expect(await first).toEqual({
      version: 1,
      decision: { outcome: 'changes-requested', comments: 'Also bust on the nightly import', decidedAt: START.toISOString() },
    });
    expect(() => host.decide('s1', plan.id, 'approved', '')).toThrow(/decided already/);

    const second = host.presentPlan('s1', { title: 'Cache product pages', body: '<h1>v2</h1>', format: 'html' }, never());
    host.decide('s1', host.latestPlan('s1')!.id, 'approved', '');
    expect((await second).version).toBe(2);

    // The history outlives the host: a restarted daemon reads it back.
    const again = createAskHost({ db, changed: () => {}, placed: () => {} });
    expect(again.plans('s1').map((each) => [each.version, each.format, each.body, each.decision?.outcome])).toEqual([
      [1, 'markdown', '# Goal\n\nFast pages', 'changes-requested'],
      [2, 'html', '<h1>v2</h1>', 'approved'],
    ]);
    expect(again.latestPlan('s1')?.version).toBe(2);
    expect(again.plans('s2')).toEqual([]);
  });

  it('records a plan nobody decided on: timed out, or withdrawn as its agent stopped waiting or the daemon went', async () => {
    const { host, clock, db } = asks();
    const late = host.presentPlan('s1', { title: 'Plan', body: 'Steps', format: 'markdown', timeoutMs: 1_000 }, never());
    clock.advance(1_000);
    expect((await late).decision.outcome).toBe('timed-out');

    const controller = new AbortController();
    const cancelled = host.presentPlan('s1', { title: 'Plan', body: 'Steps', format: 'markdown' }, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/stopped waiting/);
    expect(host.latestPlan('s1')?.decision?.outcome).toBe('withdrawn');

    // A plan still waiting as the daemon goes has no one to tell: it is withdrawn as the next one starts.
    void host.presentPlan('s1', { title: 'Plan', body: 'Steps', format: 'markdown' }, never());
    expect(createAskHost({ db, changed: () => {}, placed: () => {} }).latestPlan('s1')).toMatchObject({ version: 3, decision: { outcome: 'withdrawn' } });
  });

  it('waits on one thing at a time, and refuses an empty plan', () => {
    const { host } = asks();
    void host.presentPlan('s1', { title: 'Plan', body: 'Steps', format: 'markdown' }, never());
    expect(() => host.ask('s1', { question: 'Which cache?' }, never())).toThrow(/wait on your plan/);
    expect(() => host.presentPlan('s1', { title: 'Plan', body: 'Steps', format: 'markdown' }, never())).toThrow(/wait on your plan/);
    expect(() => host.presentPlan('s2', { title: 'Plan', body: ' ', format: 'markdown' }, never())).toThrow(/plan must not be empty/);
    expect(() => host.presentPlan('s2', { title: '', body: 'Steps', format: 'markdown' }, never())).toThrow(/title must not be empty/);
  });

  it('forgets an agent’s questions and plans as it is deleted', () => {
    const { host } = asks();
    void host.presentPlan('s1', { title: 'Plan', body: 'Steps', format: 'markdown' }, never()).catch(() => {});
    host.forget('s1');
    expect(host.latestPlan('s1')).toBeNull();
    expect(host.plans('s1')).toEqual([]);
  });
});

describe('a plan’s source, as the present_plan tool takes it', () => {
  it('reads inline Markdown or HTML, or a file by its extension, and exactly one of them', () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, 'plan.html'), '<h1>Plan</h1>');
    writeFileSync(join(dir, 'plan.md'), '# Plan');
    expect(readPlanSource({ markdown: '# Plan' }, dir)).toEqual({ body: '# Plan', format: 'markdown' });
    expect(readPlanSource({ html: '<h1>Plan</h1>' }, dir)).toEqual({ body: '<h1>Plan</h1>', format: 'html' });
    expect(readPlanSource({ path: 'plan.html' }, dir)).toEqual({ body: '<h1>Plan</h1>', format: 'html' });
    expect(readPlanSource({ path: join(dir, 'plan.md') }, '/')).toEqual({ body: '# Plan', format: 'markdown' });
    expect(() => readPlanSource({}, dir)).toThrow(/exactly one of markdown, html or path/);
    expect(() => readPlanSource({ markdown: '# Plan', html: '<h1>Plan</h1>' }, dir)).toThrow(/exactly one/);
    expect(() => readPlanSource({ path: 'missing.md' }, dir)).toThrow(/can't read the plan/);
  });
});
