import { describe, expect, it } from 'vitest';
import type { BoardItem, TodoData, TodoLine } from '@agent-board/daemon/protocol';
import { cursorAfterRemove, headCount, moveCursor, newTodoData, openWriters, pillText, todoCounts, todoKey, writerOf, zoneTodos, zoneTodoLists, agentTodoList, listOwnerName, todoLookOf, headCountIn, type TodoLookup } from './todo-view';

const AT = '2026-11-11T09:00:00.000Z';
const agent = { kind: 'agent' as const, sessionId: 's1', name: 'Fixer' };
const line = (id: string, done = false, by: TodoLine['by'] = agent): TodoLine => ({ id, text: `line ${id}`, by, at: AT, done: done ? { by: { kind: 'user' }, at: AT } : null });
const list = (...lines: TodoLine[]): TodoData => ({ owner: agent, lines });
const lookup: TodoLookup = { name: (id) => (id === 's1' ? 'Fixer now' : undefined), harness: (id) => (id === 's1' ? 'codex' : undefined) };
const key = (k: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) =>
  todoKey({ key: k, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });

describe('to-do counts and words', () => {
  it('counts the open lines, and names them on the pill and the head', () => {
    const counts = todoCounts(list(line('a'), line('b', true), line('c')));
    expect(counts).toEqual({ open: 2, ticked: 1, total: 3 });
    expect(pillText(counts)).toBe('2 to do');
    expect(headCount(counts)).toBe('2');
  });

  it('says All done once every line is ticked, and nothing of a count for an empty list', () => {
    const done = todoCounts(list(line('a', true)));
    expect([pillText(done), headCount(done)]).toEqual(['All done', 'All done']);
    const empty = todoCounts(newTodoData());
    expect([pillText(empty), headCount(empty)]).toEqual(['To do', undefined]);
  });
});

describe('writers', () => {
  it('names an agent as it is now, with its harness, and the user as you', () => {
    expect(writerOf(agent, lookup)).toEqual({ kind: 'agent', sessionId: 's1', name: 'Fixer now', harness: 'codex' });
    expect(writerOf({ kind: 'agent', sessionId: 'gone', name: 'Old' }, lookup)).toEqual({ kind: 'agent', sessionId: 'gone', name: 'Old', harness: undefined });
    expect(writerOf({ kind: 'user' }, lookup)).toEqual({ kind: 'you' });
  });

  it('marks each writer of an open line once, ticked lines left out', () => {
    const writers = openWriters(list(line('a'), line('b', false, { kind: 'user' }), line('c'), line('d', true, { kind: 'agent', sessionId: 's2', name: 'Done' })), lookup);
    expect(writers.map((each) => (each.kind === 'you' ? 'you' : each.name))).toEqual(['Fixer now', 'you']);
  });
});

describe('the zone tab count', () => {
  it('adds up the open lines of the to-do lists in the zone alone', () => {
    const item = (id: string, zoneId: string | null, kind: BoardItem['kind'], data: unknown) => ({ id, zoneId, kind, data }) as unknown as BoardItem;
    const items = [
      item('0', 'z', 'todo', list(line('x', true))),
      item('1', 'z', 'todo', list(line('a'), line('b'))),
      item('2', 'z', 'todo', list(line('c', true), line('d'))),
      item('3', 'other', 'todo', list(line('e'))),
      item('4', 'z', 'sticky', { lines: [line('f')] }),
    ];
    expect(zoneTodos(items, 'z')).toEqual({ open: 3 });
    expect(zoneTodos(items, 'other')).toEqual({ open: 1 });
    expect(zoneTodos(items, 'empty')).toEqual({ open: 0 });
  });
});

describe('the zone popover and the agent tab', () => {
  const item = (id: string, zoneId: string | null, data: unknown, kind: BoardItem['kind'] = 'todo') => ({ id, zoneId, kind, data }) as unknown as BoardItem;
  const yours: TodoData = { owner: { kind: 'user' }, lines: [line('y', false, { kind: 'user' })] };

  it("lists the zone's lists that hold any lines, in board order", () => {
    const items = [item('0', 'z', list()), item('1', 'z', list(line('a', true))), item('2', 'other', list(line('b'))), item('3', 'z', yours), item('4', 'z', { lines: [line('c')] }, 'sticky')];
    expect(zoneTodoLists(items, 'z').map((it) => it.id)).toEqual(['1', '3']);
  });

  it("finds the agent's own list, and none for an agent with no list", () => {
    const items = [item('0', 'z', yours), item('1', 'z', list(line('a')))];
    expect(agentTodoList(items, 's1')?.id).toBe('1');
    expect(agentTodoList(items, 's2')).toBeUndefined();
  });

  it("heads a list with its agent's name now, or Yours", () => {
    expect(listOwnerName(list(), lookup)).toBe('Fixer now');
    expect(listOwnerName(yours, lookup)).toBe('Yours');
  });
});

describe('the look', () => {
  it('reads the stored look, and falls back to the card', () => {
    expect(todoLookOf('clipboard')).toBe('clipboard');
    expect(todoLookOf(undefined)).toBe('card');
    expect(todoLookOf('neon')).toBe('card');
  });

  it('says "N left" on the clipboard while lines are open', () => {
    const open = todoCounts(list(line('a'), line('b', true)));
    expect(headCountIn('clipboard', open)).toBe('1 left');
    expect(headCountIn('card', open)).toBe('1');
    expect(headCountIn('clipboard', todoCounts(list(line('a', true))))).toBe('All done');
  });
});

describe('the cursor', () => {
  const lines = [line('a'), line('b'), line('c')];
  it('moves within the list, starting on the first line', () => {
    expect(moveCursor(lines, undefined, 1)).toBe('a');
    expect(moveCursor(lines, 'a', 1)).toBe('b');
    expect(moveCursor(lines, 'c', 1)).toBe('c');
    expect(moveCursor(lines, 'a', -1)).toBe('a');
    expect(moveCursor([], 'a', 1)).toBeUndefined();
  });

  it('goes to the next line once its own is taken off, or back from the last', () => {
    expect(cursorAfterRemove(lines, 'b')).toBe('c');
    expect(cursorAfterRemove(lines, 'c')).toBe('b');
    expect(cursorAfterRemove([line('a')], 'a')).toBeUndefined();
  });
});

describe('keys once stepped in', () => {
  it('maps the list keys', () => {
    expect([key('ArrowUp'), key('ArrowDown'), key(' '), key('Enter'), key('n'), key('Backspace'), key('Escape')]).toEqual(['up', 'down', 'tick', 'edit', 'new', 'delete', 'leave']);
    expect([key('ArrowUp', { altKey: true }), key('ArrowDown', { altKey: true }), key('Backspace', { shiftKey: true })]).toEqual(['raise', 'lower', 'clear']);
  });

  it('leaves ⌘ and ⌃ keys and the rest to the board', () => {
    expect(key('c', { metaKey: true })).toBeUndefined();
    expect(key('Enter', { ctrlKey: true })).toBeUndefined();
    expect(key('x')).toBeUndefined();
  });
});
