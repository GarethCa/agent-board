import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAskHost } from '../src/asks.ts';
import { readPlanSource } from '../src/board-ops.ts';
import { migrate } from '../src/migrate.ts';
import { DEFAULT_ASK_WAIT_MS, DEFAULT_PLAN_WAIT_MS, MAX_ASK_OPTIONS, isMidTurn, pauseRefusal, planPending, waitsOnUser } from '../src/protocol.ts';
import { createFakeClock } from './fake-clock.ts';
import { tempDataDir } from './helpers.ts';

const START = new Date('2026-10-14T14:00:00.000Z');

/** A host over a fresh database, with the changes it reports, on a fake clock. */
function asks(db = memoryDb(), worktree?: string) {
  const clock = createFakeClock(START);
  const changes: [string, boolean][] = [];
  const placed: string[] = [];
  const told: [string, string][] = [];
  const host = createAskHost({
    db,
    clock,
    changed: (sessionId, began) => changes.push([sessionId, began]),
    touched: (sessionId) => placed.push(sessionId),
    worktree: () => worktree,
    told: (sessionId, text) => told.push([sessionId, text]),
  });
  return { db, clock, changes, placed, told, host };
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
    expect(Date.parse(plan.expiresAt!) - START.getTime()).toBe(DEFAULT_PLAN_WAIT_MS);
    expect(changes).toEqual([['s1', true]]);

    host.decide('s1', plan.id, 'changes-requested', 'Also bust on the nightly import');
    expect(await first).toEqual({
      version: 1,
      decision: { outcome: 'changes-requested', comments: 'Also bust on the nightly import', decidedAt: START.toISOString() },
      edits: null,
    });
    expect(() => host.decide('s1', plan.id, 'approved', '')).toThrow(/decided already/);

    const second = host.presentPlan('s1', { title: 'Cache product pages', body: '<h1>v2</h1>', format: 'html' }, never());
    host.decide('s1', host.latestPlan('s1')!.id, 'approved', '');
    expect((await second).version).toBe(2);

    // The history outlives the host: a restarted daemon reads it back.
    const again = createAskHost({ db, changed: () => {}, touched: () => {}, worktree: () => undefined });
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
    expect(createAskHost({ db, changed: () => {}, touched: () => {}, worktree: () => undefined }).latestPlan('s1')).toMatchObject({ version: 3, decision: { outcome: 'withdrawn' } });
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

describe('a plan the user edits before deciding', () => {
  const steps = '## Steps\n\n- Add zone_id\n- Backfill from the board file\n- Make it NOT NULL\n';
  const edited = '## Steps\n\n- Add zone_id\n- Backfill from the board file, with a down step\n- Make it NOT NULL\n';

  it('keeps the edit as a version by the user, which the decision then applies to, with the diff from the agent’s', async () => {
    const { host, placed } = asks();
    const waited = host.presentPlan('s1', { title: 'Zone id migration', body: steps, format: 'markdown' }, never());
    const agents = host.latestPlan('s1')!;
    expect(agents.author).toBe('agent');

    const mine = host.edit('s1', agents.id, edited);
    expect(mine).toMatchObject({ version: 2, author: 'user', title: 'Zone id migration', decision: null, expiresAt: agents.expiresAt });
    expect(host.latestPlan('s1')).toEqual(mine);
    expect(placed).toEqual(['s1']);
    // The agent's text is fixed: only the user's version is decided now.
    expect(() => host.decide('s1', agents.id, 'approved', '')).toThrow(/you edited it: decide v2/);

    // Edited again, it is the next version, and the diff is still from the agent's.
    const again = host.edit('s1', mine.id, edited.replace('NOT NULL', 'NOT NULL, then index it'));
    host.decide('s1', again.id, 'approved', '');
    const result = await waited;
    expect(result).toMatchObject({ version: 3, decision: { outcome: 'approved' } });
    expect(result.edits).toEqual({
      from: 1,
      diff: [
        '  - Add zone_id',
        '- - Backfill from the board file',
        '- - Make it NOT NULL',
        '+ - Backfill from the board file, with a down step',
        '+ - Make it NOT NULL, then index it',
      ].join('\n'),
      written: false,
      problem: null,
    });
    expect(host.plans('s1').map((each) => [each.version, each.author, each.decision?.outcome])).toEqual([
      [1, 'agent', 'edited'],
      [2, 'user', 'edited'],
      [3, 'user', 'approved'],
    ]);
  });

  it('says nothing of edits when the user decided the agent’s own text', async () => {
    const { host } = asks();
    const waited = host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown' }, never());
    host.decide('s1', host.latestPlan('s1')!.id, 'approved', '');
    expect((await waited).edits).toBeNull();
  });

  it('edits only the Markdown plan the agent waits on now, and only to something new', async () => {
    const { host } = asks();
    void host.presentPlan('s1', { title: 'Plan', body: '<h1>Plan</h1>', format: 'html' }, never());
    expect(() => host.edit('s1', host.latestPlan('s1')!.id, '<h1>Mine</h1>')).toThrow(/HTML plan is view-only/);
    host.decide('s1', host.latestPlan('s1')!.id, 'rejected', '');

    void host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown' }, never());
    const { id } = host.latestPlan('s1')!;
    expect(() => host.edit('s1', id, steps)).toThrow(/nothing changed/);
    expect(() => host.edit('s1', id, '  ')).toThrow(/must not be empty/);
    host.decide('s1', id, 'rejected', '');
    expect(() => host.edit('s1', id, edited)).toThrow(/decided already/);
  });

  it('writes the approved version to the plan’s file inside the agent’s worktree, and only on approval', async () => {
    const worktree = tempDataDir();
    const file = join(worktree, 'migration.md');
    writeFileSync(file, steps);
    const { host } = asks(memoryDb(), worktree);

    const sent = host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown', path: file }, never());
    host.decide('s1', host.edit('s1', host.latestPlan('s1')!.id, edited).id, 'changes-requested', 'And test it on a copy');
    expect((await sent).edits).toMatchObject({ written: false, problem: null });
    expect(readFileSync(file, 'utf8')).toBe(steps);
    expect(host.latestPlan('s1')!.path).toBe(file);

    const approved = host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown', path: file }, never());
    host.decide('s1', host.edit('s1', host.latestPlan('s1')!.id, edited).id, 'approved', '');
    expect((await approved).edits).toMatchObject({ written: true, problem: null });
    expect(readFileSync(file, 'utf8')).toBe(edited);
  });

  it('never writes over a file that changed while the plan waited: the agent applies the edit itself', async () => {
    const worktree = tempDataDir();
    const file = join(worktree, 'migration.md');
    writeFileSync(file, steps);
    const { host } = asks(memoryDb(), worktree);

    const waited = host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown', path: file }, never());
    const mine = host.edit('s1', host.latestPlan('s1')!.id, edited);
    // Something else writes the file meanwhile: a background job of the agent's, or the user's own editor.
    writeFileSync(file, `${steps}\n## Risks\n\n- The backfill is slow\n`);
    host.decide('s1', mine.id, 'approved', '');

    expect((await waited).edits).toMatchObject({ written: false, problem: expect.stringMatching(/changed since you showed it/) });
    expect(readFileSync(file, 'utf8')).toBe(`${steps}\n## Risks\n\n- The backfill is slow\n`);
  });

  it('leaves a file it may not write for the agent to change, and says why', async () => {
    const worktree = tempDataDir();
    const elsewhere = tempDataDir();
    writeFileSync(join(elsewhere, 'plan.md'), steps);
    mkdirSync(join(worktree, 'docs'));
    symlinkSync(join(elsewhere, 'plan.md'), join(worktree, 'docs', 'plan.md'));
    const { host } = asks(memoryDb(), worktree);

    const outside = host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown', path: join(elsewhere, 'plan.md') }, never());
    host.decide('s1', host.edit('s1', host.latestPlan('s1')!.id, edited).id, 'approved', '');
    expect((await outside).edits).toMatchObject({ written: false, problem: expect.stringMatching(/outside your worktree/) });

    const linked = host.presentPlan('s1', { title: 'Plan', body: steps, format: 'markdown', path: join(worktree, 'docs', 'plan.md') }, never());
    host.decide('s1', host.edit('s1', host.latestPlan('s1')!.id, edited).id, 'approved', '');
    expect((await linked).edits).toMatchObject({ written: false, problem: expect.stringMatching(/link/) });
    expect(readFileSync(join(elsewhere, 'plan.md'), 'utf8')).toBe(steps);
  });
});

describe('a plan’s source, as the present_plan tool takes it', () => {
  it('reads inline Markdown or HTML, or a file by its extension, and exactly one of them', () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, 'plan.html'), '<h1>Plan</h1>');
    writeFileSync(join(dir, 'plan.md'), '# Plan');
    expect(readPlanSource({ markdown: '# Plan' }, dir)).toEqual({ body: '# Plan', format: 'markdown' });
    expect(readPlanSource({ html: '<h1>Plan</h1>' }, dir)).toEqual({ body: '<h1>Plan</h1>', format: 'html' });
    expect(readPlanSource({ path: 'plan.html' }, dir)).toEqual({ body: '<h1>Plan</h1>', format: 'html', path: join(dir, 'plan.html') });
    expect(readPlanSource({ path: join(dir, 'plan.md') }, '/')).toEqual({ body: '# Plan', format: 'markdown', path: join(dir, 'plan.md') });
    expect(() => readPlanSource({}, dir)).toThrow(/exactly one of markdown, html or path/);
    expect(() => readPlanSource({ markdown: '# Plan', html: '<h1>Plan</h1>' }, dir)).toThrow(/exactly one/);
    expect(() => readPlanSource({ path: 'missing.md' }, dir)).toThrow(/can't read the plan/);
  });
});

describe('a plan an agent leaves instead of waiting on', () => {
  const plan = { title: 'Cache pages', body: '# Cache\n\n1. Redis.\n', format: 'markdown' as const };

  it('waits for the user past the end of the agent’s turn, then types the decision once', async () => {
    const { host, told } = asks();
    const left = host.leavePlan('s1', plan);
    expect(left).toMatchObject({ version: 1, title: 'Cache pages', decision: null, left: true, expiresAt: null });

    // The turn ended, which withdraws a plan a call waits on, not one the agent left.
    host.drop('s1');
    expect(host.latestPlan('s1')!.decision).toBeNull();

    host.decide('s1', left.id, 'changes-requested', 'Use the CDN');
    await Promise.resolve();
    expect(told).toEqual([['s1', '[agent-board] The user asked for changes to plan v1.\n\nTheir comments:\nUse the CDN\n\nRevise the plan and present it again.']]);
    expect(host.latestPlan('s1')).toMatchObject({ left: false, decision: { outcome: 'changes-requested' } });
  });

  it('has no timer: it waits however long the user takes, and the agent is never nudged', async () => {
    const { host, clock, told } = asks();
    host.leavePlan('s1', plan);
    clock.advance(30 * 24 * 60 * 60_000);
    await Promise.resolve();
    expect(host.latestPlan('s1')!.decision).toBeNull();
    expect(told).toEqual([]);
  });

  it('is replaced by the agent’s next version, with no one told, and an ask still works beside it', async () => {
    const { host, told } = asks();
    const first = host.leavePlan('s1', plan);
    const second = host.leavePlan('s1', { ...plan, body: '# Cache\n\n1. CDN.\n' });
    await Promise.resolve();
    expect(second.version).toBe(2);
    expect(host.plans('s1').map((each) => [each.version, each.decision?.outcome ?? null])).toEqual([[1, 'withdrawn'], [2, null]]);
    expect(() => host.decide('s1', first.id, 'approved', '')).toThrow(/decided already/);
    expect(told).toEqual([]);

    const asked = host.ask('s1', { question: 'Which region?', options: ['eu', 'us'] }, never());
    expect(host.pendingAsk('s1')).toMatchObject({ question: 'Which region?' });
    host.answer('s1', host.pendingAsk('s1')!.id, { option: 1 });
    await expect(asked).resolves.toMatchObject({ outcome: 'answered', answer: 'us' });
    // It still waits, and the user decides it.
    host.decide('s1', second.id, 'approved', '');
    await Promise.resolve();
    expect(told).toHaveLength(1);
    expect(told[0]![1]).toContain('The user approved plan v2.');
  });

  it('is not a call waiting on the user: its agent is not mid-turn for it, yet its plan still waits for review', () => {
    const { host } = asks();
    host.leavePlan('s1', plan);
    const agent = { ask: null, plan: host.latestPlan('s1')!, state: 'idle' as const, endedAt: null, permissions: [] };
    expect(waitsOnUser(agent)).toBe(false);
    expect(isMidTurn(agent)).toBe(false);
    expect(planPending(agent)).toBe(true);
    expect(pauseRefusal(agent)).toBe('it is waiting on you');
  });

  it('ends with the agent’s session, which it is told once resumed', async () => {
    const { host, told } = asks();
    host.leavePlan('s1', plan);
    host.end('s1');
    await Promise.resolve();
    expect(host.latestPlan('s1')).toMatchObject({ left: false, decision: { outcome: 'withdrawn' } });
    expect(told).toEqual([['s1', '[agent-board] Plan v1 was withdrawn before the user decided: your session ended. Present it again.']]);
  });

  it('logs what goes wrong in telling the agent instead of dropping it', async () => {
    const logs: string[] = [];
    const db = memoryDb();
    const host = createAskHost({
      db,
      clock: createFakeClock(START),
      changed: () => undefined,
      touched: () => undefined,
      worktree: () => undefined,
      told: () => {
        throw new Error('the queue is gone');
      },
      log: (message) => logs.push(message),
    });
    const left = host.leavePlan('s1', plan);
    host.decide('s1', left.id, 'rejected', '');
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs).toEqual(['could not tell s1 how its plan ended: the queue is gone']);
  });
});
