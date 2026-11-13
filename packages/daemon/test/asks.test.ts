import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAskHost } from '../src/asks.ts';
import { readPlanSource } from '../src/board-ops.ts';
import { migrate } from '../src/migrate.ts';
import {
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_PLAN_WAIT_MS,
  MAX_ASK_OPTIONS,
  isMidTurn,
  pauseRefusal,
  planPending,
  waitsOnUser,
  type AgentAsk,
  type BoardItem,
  type StepsAskEnd,
} from '../src/protocol.ts';
import { createFakeClock } from './fake-clock.ts';
import { tempDataDir } from './helpers.ts';

const START = new Date('2026-10-14T14:00:00.000Z');

/** A host over a fresh database, with the changes it reports, on a fake clock, and the steps cards its asks become. */
function asks(db = memoryDb(), worktree?: string) {
  const clock = createFakeClock(START);
  const changes: [string, boolean][] = [];
  const placed: string[] = [];
  const told: [string, string][] = [];
  const cards: { sessionId: string; ask: AgentAsk; ended: { at: string; how: StepsAskEnd } | null }[] = [];
  const ended: [string, StepsAskEnd][] = [];
  const host = createAskHost({
    db,
    clock,
    changed: (sessionId, began) => changes.push([sessionId, began]),
    touched: (sessionId) => placed.push(sessionId),
    worktree: () => worktree,
    told: (sessionId, text) => told.push([sessionId, text]),
    toCard: (sessionId, ask, end) => {
      cards.push({ sessionId, ask, ended: end });
      return Promise.resolve({ id: `card-${cards.length}` } as BoardItem);
    },
    cardEnded: (cardId, end) => ended.push([cardId, end.how]),
  });
  return { db, clock, changes, placed, told, cards, ended, host };
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

  it('puts a question on the board at once, as a steps card it waits on, only when the agent asks for that', async () => {
    const { host, cards } = asks();
    void host.ask('s1', { question: 'Which cache?' }, never());
    expect(host.pendingAsk('s1')).toMatchObject({ onBoard: false, card: null });

    const answered = host.ask('s2', { question: 'Which cache?', options: ['Redis', 'SQLite'], onBoard: true }, never());
    const { id } = host.pendingAsk('s2')!;
    await Promise.resolve();
    expect(cards.map((card) => card.sessionId)).toEqual(['s2']);
    expect(host.pendingAsk('s2')).toMatchObject({ onBoard: true, card: 'card-1' });
    expect(() => host.answer('s2', id, { option: 0 })).toThrow(/answer it on its card/);

    expect(host.sendFromCard('s2', id, 'card-1', [{ option: 1 }])).toBe(true);
    expect(await answered).toEqual({ outcome: 'answered', answer: 'SQLite', card: 'card-1' });
  });
});

describe('an ask of several questions', () => {
  const QUESTIONS = [
    { question: 'Which store?', options: ['Redis', 'SQLite'] },
    { question: 'Keep the old limit?', options: ['Yes', 'No'] },
    { question: 'Anything else?' },
  ];

  it('keeps each answer until the user sends them, then gives every one, a question left unanswered as skipped', async () => {
    const { host, placed } = asks();
    const answered = host.ask('s1', { questions: QUESTIONS }, never());
    const ask = host.pendingAsk('s1')!;
    // Its first question is the ask's own, for what reads one question.
    expect(ask).toMatchObject({ question: 'Which store?', options: ['Redis', 'SQLite'], answers: [null, null, null], card: null });
    expect(ask.questions.map((each) => each.freeText)).toEqual([false, false, true]);

    host.answer('s1', ask.id, { option: 1 }, 0);
    host.answer('s1', ask.id, { text: ' Ship it Friday ' }, 2);
    // An answer changed before it is sent is the one sent.
    host.answer('s1', ask.id, { option: 0 }, 0);
    expect(host.pendingAsk('s1')!.answers).toEqual([{ option: 0 }, null, { text: ' Ship it Friday ' }]);
    expect(placed).toEqual(['s1', 's1', 's1']);
    expect(() => host.answer('s1', ask.id, { option: 5 }, 1)).toThrow(/no option 6/);
    expect(() => host.answer('s1', ask.id, { option: 0 }, 3)).toThrow(/no question 4: it asks 3/);

    host.send('s1', ask.id);
    expect(await answered).toEqual({
      outcome: 'answered',
      answer: 'Redis',
      answers: [
        { question: 'Which store?', answer: 'Redis' },
        { question: 'Keep the old limit?', answer: null },
        { question: 'Anything else?', answer: 'Ship it Friday' },
      ],
    });
  });

  it('skips as a whole, and sent with nothing answered it is skipped', async () => {
    const { host } = asks();
    const skipped = host.ask('s1', { questions: QUESTIONS }, never());
    host.answer('s1', host.pendingAsk('s1')!.id, { skip: true });
    expect(await skipped).toMatchObject({ outcome: 'skipped', answer: null });

    const empty = host.ask('s1', { questions: QUESTIONS }, never());
    host.send('s1', host.pendingAsk('s1')!.id);
    expect(await empty).toMatchObject({ outcome: 'skipped' });
  });

  it('holds 1 to 4 questions: more is a steps card', () => {
    const { host } = asks();
    const five = Array.from({ length: 5 }, (_, at) => ({ question: `Question ${at + 1}?` }));
    expect(() => host.ask('s1', { questions: five }, never())).toThrow(/That's a steps card: use steps_new/);
    expect(() => host.ask('s1', { questions: [] }, never())).toThrow(/at least one question/);
    expect(() => host.ask('s1', { question: 'Which?', questions: QUESTIONS }, never())).toThrow(/exactly one of question or questions/);
    expect(() => host.ask('s1', { questions: [{ question: ' ' }] }, never())).toThrow(/question must not be empty/);
    expect(host.pendingAsk('s1')).toBeNull();
  });

  it('is put on the board while the agent still waits, and then answered only on its card, whose Send answers the call', async () => {
    const { host, cards } = asks();
    const answered = host.ask('s1', { questions: QUESTIONS }, never());
    const { id } = host.pendingAsk('s1')!;
    host.answer('s1', id, { option: 1 }, 0);

    const card = await host.toCard('s1', id);
    expect(card.id).toBe('card-1');
    expect(cards).toEqual([{ sessionId: 's1', ask: expect.objectContaining({ answers: [{ option: 1 }, null, null] }), ended: null }]);
    expect(host.pendingAsk('s1')!.card).toBe('card-1');
    await expect(host.toCard('s1', id)).rejects.toThrow(/on the board already/);
    expect(() => host.answer('s1', id, { option: 0 }, 1)).toThrow(/answer it on its card \(item:card-1\)/);
    expect(() => host.send('s1', id)).toThrow(/answer it on its card/);

    // Only the card it waits on answers it.
    expect(host.sendFromCard('s1', 'another ask', 'card-1', [])).toBe(false);
    expect(host.sendFromCard('s1', id, 'an old card', [])).toBe(false);
    expect(host.waitsOnCard('s1', id, 'card-1')).toBe(true);
    expect(host.sendFromCard('s1', id, 'card-1', [{ option: 1 }, { option: 0 }, null])).toBe(true);
    expect(await answered).toMatchObject({ outcome: 'answered', answer: 'SQLite', card: 'card-1', answers: [{ answer: 'SQLite' }, { answer: 'Yes' }, { answer: null }] });
    expect(host.sendFromCard('s1', id, 'card-1', [])).toBe(false);
  });

  it('makes one card for a double Put on the board, and takes no answer while it is made', async () => {
    const { host, cards } = asks();
    void host.ask('s1', { questions: QUESTIONS }, never());
    const { id } = host.pendingAsk('s1')!;
    const first = host.toCard('s1', id);
    const second = host.toCard('s1', id);
    expect(() => host.answer('s1', id, { option: 0 }, 1)).toThrow(/being put on the board/);
    expect(() => host.send('s1', id)).toThrow(/being put on the board/);
    expect((await first).id).toBe('card-1');
    expect((await second).id).toBe('card-1');
    expect(cards).toHaveLength(1);
  });

  it('takes back a card put back on the board while it waits with none, and only its own', async () => {
    const { host, placed } = asks();
    void host.ask('s1', { questions: QUESTIONS }, never());
    const { id } = host.pendingAsk('s1')!;
    await host.toCard('s1', id);
    expect(host.cardBack('card-1', 's1', id)).toBe(true);
    // Taken off, then put back by an undo: it waits on it again, and the tile no longer answers it.
    host.cardGone('card-1');
    expect(host.cardBack('card-1', 's1', id)).toBe(true);
    expect(host.pendingAsk('s1')!.card).toBe('card-1');
    expect(placed.at(-1)).toBe('s1');
    // Another card of it, or one of an ask that no longer waits, answers nothing.
    expect(host.cardBack('card-9', 's1', id)).toBe(false);
    expect(host.cardBack('card-1', 's1', 'an old ask')).toBe(false);
  });

  it('keeps answers in words a card can hold, for several questions', () => {
    const { host } = asks();
    void host.ask('s1', { questions: QUESTIONS }, never());
    expect(() => host.answer('s1', host.pendingAsk('s1')!.id, { text: 'x'.repeat(2_001) }, 2)).toThrow(/at most 2000 characters/);
  });

  it('keeps no card for an agent whose session ends with an ask half-answered', async () => {
    const { host, cards } = asks();
    const ended = host.ask('s1', { questions: QUESTIONS }, never());
    host.answer('s1', host.pendingAsk('s1')!.id, { option: 0 }, 0);
    host.end('s1');
    await expect(ended).rejects.toThrow(/stopped waiting/);
    expect(cards).toEqual([]);
  });

  it('comes back to its tile once its card is taken off the board, and is skipped wherever it is', async () => {
    const { host, placed, ended } = asks();
    const answered = host.ask('s1', { questions: QUESTIONS }, never());
    const { id } = host.pendingAsk('s1')!;
    host.answer('s1', id, { option: 1 }, 0);
    await host.toCard('s1', id);
    host.cardGone('another card');
    expect(host.pendingAsk('s1')!.card).toBe('card-1');

    host.cardGone('card-1');
    expect(host.pendingAsk('s1')).toMatchObject({ card: null, answers: [{ option: 1 }, null, null] });
    expect(placed.at(-1)).toBe('s1');
    host.answer('s1', id, { option: 0 }, 1);

    await host.toCard('s1', id);
    host.answer('s1', id, { skip: true });
    expect(await answered).toMatchObject({ outcome: 'skipped', card: 'card-2' });
    expect(ended).toEqual([['card-2', 'stopped']]);
  });

  it('kept on a card as it ends half-answered, its card stamped; with no answer it just goes', async () => {
    const { host, clock, cards, ended } = asks();
    const late = host.ask('s1', { questions: QUESTIONS, timeoutMs: 60_000 }, never());
    host.answer('s1', host.pendingAsk('s1')!.id, { option: 0 }, 1);
    clock.advance(60_000);
    expect(await late).toEqual({ outcome: 'timed-out', answer: null, card: 'card-1' });
    expect(cards[0]!.ended).toEqual({ at: expect.any(String), how: 'timed-out' });

    const stopped = new AbortController();
    const dropped = host.ask('s1', { questions: QUESTIONS }, stopped.signal);
    const { id } = host.pendingAsk('s1')!;
    await host.toCard('s1', id);
    stopped.abort();
    await expect(dropped).rejects.toThrow(/stopped waiting/);
    expect(ended).toEqual([['card-2', 'stopped']]);

    const unanswered = host.ask('s1', { questions: QUESTIONS, timeoutMs: 60_000 }, never());
    clock.advance(60_000);
    expect(await unanswered).toEqual({ outcome: 'timed-out', answer: null });
    expect(cards).toHaveLength(2);
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
    const agent = { ask: null, removeAsk: null, plan: host.latestPlan('s1')!, state: 'idle' as const, endedAt: null, permissions: [] };
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
