import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, emptyHistory, HISTORY_LIMIT, record, redo, undo, withoutLastCreation, type Step } from './history';

const step = (before: Record<string, number | null>, after: Record<string, number | null>, extra: Partial<Step<number>> = {}): Step<number> => ({
  before: new Map(Object.entries(before)),
  after: new Map(Object.entries(after)),
  at: 0,
  ...extra,
});

describe('the undo history', () => {
  it('undoes to what was before, then redoes to what was after', () => {
    const history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }));
    const undone = undo(history)!;
    expect(Object.fromEntries(undone.apply)).toEqual({ a: 1 });
    const redone = redo(undone.history)!;
    expect(Object.fromEntries(redone.apply)).toEqual({ a: 2 });
    expect(canUndo(redone.history)).toBe(true);
    expect(canRedo(redone.history)).toBe(false);
  });

  it('has nothing to undo or redo when empty', () => {
    expect(undo(emptyHistory())).toBeUndefined();
    expect(redo(emptyHistory())).toBeUndefined();
  });

  it('undoes steps last first', () => {
    let history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }));
    history = record(history, step({ b: 5 }, { b: null }));
    const first = undo(history)!;
    expect(Object.fromEntries(first.apply)).toEqual({ b: 5 });
    const second = undo(first.history)!;
    expect(Object.fromEntries(second.apply)).toEqual({ a: 1 });
    expect(canUndo(second.history)).toBe(false);
  });

  it('forgets what was undone once something new is done', () => {
    let history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }));
    history = undo(history)!.history;
    history = record(history, step({ a: 1 }, { a: 3 }));
    expect(canRedo(history)).toBe(false);
  });

  it('keeps at least 100 steps, dropping the oldest past its limit', () => {
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(100);
    let history = emptyHistory<number>();
    for (let n = 0; n < HISTORY_LIMIT + 5; n++) history = record(history, step({ a: n }, { a: n + 1 }));
    let undone = 0;
    let last: number | null | undefined;
    for (let result = undo(history); result !== undefined; result = undo(result.history)) {
      undone++;
      last = result.apply.get('a');
    }
    expect(undone).toBe(HISTORY_LIMIT);
    expect(last).toBe(5);
  });

  it('records nothing for a step that changes nothing', () => {
    expect(canUndo(record(emptyHistory<number>(), step({ a: 1 }, { a: 1 })))).toBe(false);
  });

  it('compares objects by value', () => {
    const history = record(emptyHistory<{ x: number }>(), {
      before: new Map([['a', { x: 1 }]]),
      after: new Map([['a', { x: 1 }]]),
      at: 0,
    });
    expect(canUndo(history)).toBe(false);
  });

  it('merges a step into the last one with the same coalescing key soon after', () => {
    let history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }, { coalesce: 'typing', at: 0 }));
    history = record(history, step({ a: 2 }, { a: 3 }, { coalesce: 'typing', at: 500 }));
    const undone = undo(history)!;
    expect(Object.fromEntries(undone.apply)).toEqual({ a: 1 });
    expect(canUndo(undone.history)).toBe(false);
    expect(Object.fromEntries(redo(undone.history)!.apply)).toEqual({ a: 3 });
  });

  it('keeps steps apart when the key differs or too long has passed', () => {
    let history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }, { coalesce: 'typing', at: 0 }));
    history = record(history, step({ a: 2 }, { a: 3 }, { coalesce: 'typing', at: 60_000 }));
    history = record(history, step({ a: 3 }, { a: 4 }, { coalesce: 'other', at: 60_001 }));
    let count = 0;
    for (let result = undo(history); result !== undefined; result = undo(result.history)) count++;
    expect(count).toBe(3);
  });

  it('merges keys either step touched, keeping the first before and the last after', () => {
    let history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }, { coalesce: 'k', at: 0 }));
    history = record(history, step({ a: 2, b: 7 }, { a: 3, b: 8 }, { coalesce: 'k', at: 1 }));
    const undone = undo(history)!;
    expect(Object.fromEntries(undone.apply)).toEqual({ a: 1, b: 7 });
    expect(Object.fromEntries(redo(undone.history)!.apply)).toEqual({ a: 3, b: 8 });
  });

  it('drops a step that, merged, changes nothing', () => {
    let history = record(emptyHistory<number>(), step({ a: 1 }, { a: 2 }, { coalesce: 'k', at: 0 }));
    history = record(history, step({ a: 2 }, { a: 1 }, { coalesce: 'k', at: 1 }));
    expect(canUndo(history)).toBe(false);
  });

  describe('withoutLastCreation', () => {
    it('drops the last step if all it did was make `key`', () => {
      const history = record(emptyHistory<number>(), step({ a: null }, { a: 1 }));
      expect(canUndo(withoutLastCreation(history, 'a'))).toBe(false);
    });

    it('keeps it when it did more, or made something else', () => {
      const more = record(emptyHistory<number>(), step({ a: null, b: 1 }, { a: 1, b: 2 }));
      expect(canUndo(withoutLastCreation(more, 'a'))).toBe(true);
      const other = record(emptyHistory<number>(), step({ b: null }, { b: 1 }));
      expect(canUndo(withoutLastCreation(other, 'a'))).toBe(true);
    });
  });
});
