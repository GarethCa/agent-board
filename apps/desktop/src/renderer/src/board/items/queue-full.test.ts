import { describe, expect, it } from 'vitest';
import { QUEUE_LATER, type HistoryVersion, type QueueJob } from '@agent-board/daemon/protocol';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { fullAction, fullGroups, fullKey, headCount, lookPlace, nextRow, NO_FILTER, rowBy, rowsOf, shownGroups, standing, whoWhen } from './queue-full';

const NOW = new Date(2026, 10, 5, 15, 0);
const at = (hour: number, day = 5) => new Date(2026, 10, day, hour).toISOString();
const lead = { kind: 'agent', sessionId: 'lead', name: 'lead' } as const;
const impl = { kind: 'agent', sessionId: 'impl', name: 'impl' } as const;

function job(id: string, more: Partial<QueueJob> = {}): QueueJob {
  return { id, queueId: 'q', kind: 'task', text: id, link: null, state: 'queued', result: null, hiddenUntil: null, takenBy: null, takenAt: null, drops: 0, doneBy: null, doneAt: null, madeBy: lead, changedBy: lead, lastChange: 'add', createdAt: at(9), updatedAt: at(9), ...more };
}

const asking = { agent: { sessionId: 's1', name: 'Fixer', zoneId: null }, kind: 'asks', since: at(11) } as unknown as NeedsYouEntry;

describe('fullGroups', () => {
  it("lists an agents' queue as taken, waiting in order with its jobs numbered, later and done", () => {
    const jobs = [job('t', { state: 'taken', takenBy: impl }), job('a'), job('note', { kind: 'info' }), job('b'), job('l', { hiddenUntil: QUEUE_LATER }), job('d', { state: 'done' })];
    const groups = fullGroups(jobs, [], 'agents', NOW);
    expect(groups.map((group) => [group.id, group.rows.map((row) => row.key)])).toEqual([
      ['taken', ['t']],
      ['waiting', ['a', 'note', 'b']],
      ['later', ['l']],
      ['done', ['d']],
    ]);
    expect(groups[1]!.rows.map((row) => (row.kind === 'job' ? row.place : undefined))).toEqual([1, undefined, 2]);
  });

  it("lists the user's queue as what agents ask, one group a kind, later, and only what was done today", () => {
    const jobs = [job('r', { kind: 'review' }), job('b', { kind: 'backlog' }), job('q', { kind: 'questions' }), job('i', { kind: 'info' }), job('today', { kind: 'review', state: 'done', doneAt: at(10) }), job('old', { kind: 'review', state: 'done', doneAt: at(10, 3) })];
    const groups = fullGroups(jobs, [asking], 'user', NOW);
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.key)])).toEqual([
      ['Agents ask you', ['needs:s1:asks']],
      ['Review', ['r']],
      ['Questions', ['q']],
      ['Read', ['i']],
      ['Backlog', ['b']],
      ['Done today', ['today']],
    ]);
  });
});

describe('shownGroups', () => {
  const groups = fullGroups([job('Fix login'), job('Paginate orders'), job('x', { state: 'taken', text: 'Fix cart' })], [], 'agents', NOW);
  it('keeps the rows matching every word of the search', () => {
    expect(rowsOf(shownGroups(groups, { search: 'fix', group: null })).map((row) => row.key)).toEqual(['x', 'Fix login']);
  });
  it("keeps the chip's group alone", () => {
    expect(rowsOf(shownGroups(groups, { ...NO_FILTER, group: 'taken' })).map((row) => row.key)).toEqual(['x']);
  });
  it("shows every row when the chip's group has emptied", () => {
    expect(rowsOf(shownGroups(groups, { ...NO_FILTER, group: 'later' })).map((row) => row.key)).toEqual(['x', 'Fix login', 'Paginate orders']);
  });
});

describe('moving through the rows', () => {
  const rows = rowsOf(fullGroups([job('a'), job('b'), job('d', { state: 'done' }), job('e', { state: 'done' })], [], 'agents', NOW));
  it('↑↓ stay at either end, and start at the first row', () => {
    expect(rowBy(rows, undefined, 1)?.key).toBe('a');
    expect(rowBy(rows, 'a', -1)?.key).toBe('a');
    expect(rowBy(rows, 'a', 1)?.key).toBe('b');
    expect(rowBy(rows, 'e', 1)?.key).toBe('e');
  });
  it('Next steps to the next row still to do, and to none after the last', () => {
    expect(nextRow(rows, 'a')?.key).toBe('b');
    expect(nextRow(rows, 'b')).toBeUndefined();
  });
});

describe('fullKey', () => {
  const press = (key: string, more: { altKey?: boolean; metaKey?: boolean } = {}) => fullKey({ key, altKey: false, metaKey: false, ctrlKey: false, ...more });
  it('reads the keys at the foot', () => {
    expect(['ArrowUp', 'ArrowDown', 'd', 'L', 'h', 'e', 'n', '/'].map((key) => press(key))).toEqual(['up', 'down', 'done', 'later', 'hand', 'edit', 'add', 'search']);
    expect(press('ArrowUp', { altKey: true })).toBe('raise');
    expect(press('ArrowDown', { altKey: true })).toBe('lower');
  });
  it('leaves chords and other keys alone', () => {
    expect(press('d', { metaKey: true })).toBeUndefined();
    expect(press('x')).toBeUndefined();
  });
});

describe('whoWhen', () => {
  it('says what its history holds, oldest first', () => {
    const versions: HistoryVersion<QueueJob>[] = [
      { version: 3, action: 'done', value: job('a', { state: 'done' }), by: impl, at: at(12) },
      { version: 2, action: 'take', value: job('a', { state: 'taken' }), by: impl, at: at(11) },
      { version: 1, action: 'add', value: job('a'), by: { kind: 'user' }, at: at(10) },
    ];
    expect(whoWhen(job('a'), versions).map(({ who, what }) => `${who} ${what}`)).toEqual(['you queued it', 'impl took it', 'impl finished it']);
  });
  it('falls back on what the job holds before its history is read', () => {
    const done = job('a', { takenBy: impl, takenAt: at(10), state: 'done', doneBy: impl, doneAt: at(11), lastChange: 'done', updatedAt: at(11) });
    expect(whoWhen(done).map(({ who, what }) => `${who} ${what}`)).toEqual(['lead queued it', 'impl took it', 'impl finished it']);
  });
});

describe('standing', () => {
  it('says where a job stands', () => {
    expect(standing(job('a'), 1, 'agents', NOW)).toBe('next: the first an agent takes');
    expect(standing(job('a'), 3, 'agents', NOW)).toBe('3rd in line');
    expect(standing(job('a', { kind: 'review' }), undefined, 'user', NOW)).toBe('yours: no agent takes it');
    expect(standing(job('a', { hiddenUntil: QUEUE_LATER }), undefined, 'agents', NOW)).toBe('waits till you move it up');
    expect(standing(job('a', { state: 'taken', takenBy: impl, takenAt: at(10) }), undefined, 'agents', NOW)).toBe('impl took it · 10:00');
    expect(standing(job('a', { kind: 'info' }), undefined, 'agents', NOW)).toBe('a note: read, never taken');
  });
});

describe('the head', () => {
  it("counts what is left to do on an agents' queue: waiting and taken, never notes, Later or done", () => {
    expect(headCount([job('a'), job('b'), job('n', { kind: 'info' }), job('l', { hiddenUntil: QUEUE_LATER }), job('t', { state: 'taken' }), job('d', { state: 'done' })], NOW)).toBe('2 waiting · 1 taken');
    expect(headCount([job('d', { state: 'done' })], NOW)).toBe('Nothing waiting');
    expect(headCount([], NOW)).toBe('No jobs yet');
  });
  it("says how far through the user's queue a row is", () => {
    const groups = fullGroups([job('r', { kind: 'review' }), job('i', { kind: 'info' }), job('d', { kind: 'review', state: 'done', doneAt: at(10) })], [asking], 'user', NOW);
    expect(lookPlace(groups, 'i', 3)).toBe('3 of 3 to look at');
    expect(lookPlace(groups, 'd', 3)).toBeUndefined();
  });
});

describe('fullAction', () => {
  const all = { hand: true, later: true };
  const rowOf = (groups: ReturnType<typeof fullGroups>, key: string) => rowsOf(groups).find((row) => row.key === key);
  it('moves a waiting job among its own group, never past a taken one or out of its group', () => {
    const groups = fullGroups([job('t', { state: 'taken' }), job('a'), job('b'), job('c')], [], 'agents', NOW);
    expect(fullAction('raise', rowOf(groups, 'a'), groups, 'agents', all)).toBeUndefined();
    expect(fullAction('raise', rowOf(groups, 'b'), groups, 'agents', all)).toMatchObject({ op: 'move', job: { id: 'b' }, before: { id: 'a' } });
    expect(fullAction('lower', rowOf(groups, 'a'), groups, 'agents', all)).toMatchObject({ op: 'move', job: { id: 'a' }, before: { id: 'c' } });
    expect(fullAction('lower', rowOf(groups, 'b'), groups, 'agents', all)).toMatchObject({ op: 'move', before: null });
    expect(fullAction('lower', rowOf(groups, 'c'), groups, 'agents', all)).toBeUndefined();
  });
  it("moves a row of the user's queue within its kind, not into another", () => {
    const groups = fullGroups([job('r1', { kind: 'review' }), job('b', { kind: 'backlog' }), job('r2', { kind: 'review' })], [], 'user', NOW);
    expect(fullAction('lower', rowOf(groups, 'r1'), groups, 'user', all)).toMatchObject({ op: 'move', job: { id: 'r1' }, before: null });
    expect(fullAction('raise', rowOf(groups, 'b'), groups, 'user', all)).toBeUndefined();
  });
  it('finishes, marks Later, moves up, hands on and edits the picked job, where it can', () => {
    const groups = fullGroups([job('a'), job('n', { kind: 'info' }), job('l', { hiddenUntil: QUEUE_LATER }), job('d', { state: 'done' })], [], 'agents', NOW);
    expect(fullAction('done', rowOf(groups, 'a'), groups, 'agents', all)).toMatchObject({ op: 'done', job: { id: 'a' } });
    expect(fullAction('done', rowOf(groups, 'n'), groups, 'agents', all)).toBeUndefined();
    expect(fullAction('done', rowOf(groups, 'd'), groups, 'agents', all)).toBeUndefined();
    expect(fullAction('later', rowOf(groups, 'a'), groups, 'agents', all)).toMatchObject({ op: 'later', job: { id: 'a' } });
    expect(fullAction('later', rowOf(groups, 'l'), groups, 'agents', all)).toMatchObject({ op: 'back', job: { id: 'l' } });
    expect(fullAction('later', rowOf(groups, 'a'), groups, 'agents', { ...all, later: false })).toBeUndefined();
    expect(fullAction('hand', rowOf(groups, 'a'), groups, 'agents', all)).toMatchObject({ op: 'hand' });
    expect(fullAction('hand', rowOf(groups, 'l'), groups, 'agents', all)).toBeUndefined();
    expect(fullAction('hand', rowOf(groups, 'a'), groups, 'user', all)).toBeUndefined();
    expect(fullAction('edit', rowOf(groups, 'd'), groups, 'agents', all)).toMatchObject({ op: 'edit', job: { id: 'd' } });
  });
  it('does nothing on a request from an agent, or with no row', () => {
    const groups = fullGroups([], [asking], 'user', NOW);
    expect(fullAction('done', rowsOf(groups)[0], groups, 'user', all)).toBeUndefined();
    expect(fullAction('done', undefined, groups, 'user', all)).toBeUndefined();
  });
});
