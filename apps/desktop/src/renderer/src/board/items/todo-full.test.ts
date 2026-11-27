import { describe, expect, it } from 'vitest';
import type { StepsWho, TodoLine } from '@agent-board/daemon/protocol';
import { NO_LOOKUP } from './todo-view';
import { linesOf, lineStory, moveTo, NO_TODO_FILTER, todoFullKey, todoGroups, writerCounts } from './todo-full';

const USER: StepsWho = { kind: 'user' };
const FIXER: StepsWho = { kind: 'agent', sessionId: 's1', name: 'fixer' };
const line = (id: string, text: string, by: StepsWho = USER, done = false): TodoLine => ({ id, text, by, at: '2026-11-05T09:00:00.000Z', done: done ? { by: USER, at: '2026-11-05T10:00:00.000Z' } : null });
const LINES = [line('a', 'Send the PR', FIXER), line('b', 'Rotate the key', USER, true), line('c', 'Book the slot'), line('d', 'Read the plan', FIXER, true)];
const lookup = { ...NO_LOOKUP, name: (id: string) => (id === 's1' ? 'fixer-2' : undefined) };
const ids = (lines: readonly TodoLine[]) => lines.map((each) => each.id);

describe('todoGroups', () => {
  it('groups the lines left, then those ticked, each in list order', () => {
    const groups = todoGroups(LINES, NO_TODO_FILTER, lookup);
    expect(groups.map((group) => [group.label, ids(group.lines)])).toEqual([
      ['Left', ['a', 'c']],
      ['Ticked', ['b', 'd']],
    ]);
    expect(ids(linesOf(groups))).toEqual(['a', 'c', 'b', 'd']);
  });

  it("keeps the user's lines or the agents' for a chip, and leaves out a group with none", () => {
    expect(ids(linesOf(todoGroups(LINES, { search: '', writers: 'yours' }, lookup)))).toEqual(['c', 'b']);
    expect(ids(linesOf(todoGroups(LINES, { search: '', writers: 'agents' }, lookup)))).toEqual(['a', 'd']);
    expect(todoGroups([LINES[0]!], NO_TODO_FILTER, lookup).map((group) => group.id)).toEqual(['left']);
  });

  it("searches every word in a line's text and its writer's name now", () => {
    expect(ids(linesOf(todoGroups(LINES, { search: 'the  KEY', writers: null }, lookup)))).toEqual(['b']);
    expect(ids(linesOf(todoGroups(LINES, { search: 'fixer-2 read', writers: null }, lookup)))).toEqual(['d']);
  });

  it('counts what each chip would leave', () => {
    expect(writerCounts(LINES)).toEqual({ yours: 2, agents: 2 });
  });
});

describe('moveTo', () => {
  const groups = todoGroups(LINES, NO_TODO_FILTER, lookup);
  it("puts a line at the place of the one beside it in its group, past a line of the other group between them", () => {
    expect(moveTo(LINES, groups, 'a', 1)).toBe(2);
    expect(moveTo(LINES, groups, 'c', -1)).toBe(0);
    expect(moveTo(LINES, groups, 'd', -1)).toBe(1);
  });
  it("goes nowhere past its group's ends, or for a line not shown", () => {
    expect(moveTo(LINES, groups, 'a', -1)).toBeUndefined();
    expect(moveTo(LINES, groups, 'c', 1)).toBeUndefined();
    expect(moveTo(LINES, groups, 'zz', 1)).toBeUndefined();
  });
});

describe('todoFullKey', () => {
  const key = (key: string, more: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => todoFullKey({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...more });
  it("answers to the stepped-in list's keys and / for the search, leaving esc to the frame", () => {
    expect([key('ArrowUp'), key('ArrowDown', { altKey: true }), key(' '), key('Enter'), key('n'), key('Backspace', { shiftKey: true }), key('Backspace'), key('/')]).toEqual(['up', 'lower', 'tick', 'edit', 'new', 'clear', 'delete', 'search']);
    expect(key('Escape')).toBeUndefined();
    expect(key('Enter', { metaKey: true })).toBeUndefined();
  });
});

describe('lineStory', () => {
  it('says who wrote a line, by its name now, and who ticked it', () => {
    expect(lineStory(LINES[3]!, lookup)).toEqual([
      { who: 'fixer-2', what: 'wrote it', at: '2026-11-05T09:00:00.000Z' },
      { who: 'you', what: 'ticked it', at: '2026-11-05T10:00:00.000Z' },
    ]);
    expect(lineStory(LINES[2]!, lookup)).toHaveLength(1);
  });
});
