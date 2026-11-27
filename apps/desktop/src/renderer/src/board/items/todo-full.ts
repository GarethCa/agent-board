// What a to-do list's full screen shows, worked out from its lines: its groups (left, then ticked), what its search and
// chips leave, where ⌥↑⌥↓ put the picked line, its keys, and who wrote a line and who ticked it. Kept apart from React,
// so it is tested on its own.
import type { TodoLine } from '@agent-board/daemon/protocol';
import { todoKey, writerOf, type TodoKeyAction, type TodoLookup } from './todo-view';

export type TodoGroupId = 'left' | 'ticked';

export interface TodoGroup {
  id: TodoGroupId;
  label: string;
  lines: TodoLine[];
}

/** Whose lines the chips leave: the user's, the agents', or everyone's. */
export type TodoWriters = 'yours' | 'agents' | null;

export interface TodoFilter {
  search: string;
  writers: TodoWriters;
}

export const NO_TODO_FILTER: TodoFilter = { search: '', writers: null };

const isYours = (line: TodoLine) => line.by.kind === 'user';

/** How many lines each chip would leave. */
export function writerCounts(lines: readonly TodoLine[]): { yours: number; agents: number } {
  const yours = lines.filter(isYours).length;
  return { yours, agents: lines.length - yours };
}

/** The lines in their groups as the search and the chip leave them, in the list's order, those with none left out. */
export function todoGroups(lines: readonly TodoLine[], filter: TodoFilter, lookup: TodoLookup): TodoGroup[] {
  const words = filter.search.toLowerCase().split(/\s+/).filter((word) => word !== '');
  const kept = lines.filter((line) => {
    if (filter.writers === 'yours' && !isYours(line)) return false;
    if (filter.writers === 'agents' && isYours(line)) return false;
    const writer = writerOf(line.by, lookup);
    const text = `${line.text} ${writer.kind === 'you' ? 'you' : writer.name}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const groups: TodoGroup[] = [
    { id: 'left', label: 'Left', lines: kept.filter((line) => line.done === null) },
    { id: 'ticked', label: 'Ticked', lines: kept.filter((line) => line.done !== null) },
  ];
  return groups.filter((group) => group.lines.length > 0);
}

/** The lines in the order the list draws them. */
export const linesOf = (groups: readonly TodoGroup[]): TodoLine[] => groups.flatMap((group) => group.lines);

/**
 * Where ⌥↑ (-1) or ⌥↓ (1) puts a line: the place in the whole list of the line before or after it in its own group, as
 * shown, so it swaps with the one the user sees beside it; none at its group's ends.
 */
export function moveTo(lines: readonly TodoLine[], groups: readonly TodoGroup[], id: string, by: -1 | 1): number | undefined {
  const group = groups.find((each) => each.lines.some((line) => line.id === id));
  if (group === undefined) return undefined;
  const beside = group.lines[group.lines.findIndex((line) => line.id === id) + by];
  if (beside === undefined) return undefined;
  return lines.findIndex((line) => line.id === beside.id);
}

/** What a key does on the full screen, out of a field: the stepped-in list's keys, and / for the search. Esc is the frame's. */
export type TodoFullKey = Exclude<TodoKeyAction, 'leave'> | 'search';

export function todoFullKey(event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): TodoFullKey | undefined {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey) return 'search';
  const action = todoKey(event);
  return action === 'leave' ? undefined : action;
}

/** One line of "Who and when". */
export interface TodoStory {
  who: string;
  what: string;
  at: string;
}

/** Who wrote a line and when, and who ticked it and when, by their names now. */
export function lineStory(line: TodoLine, lookup: TodoLookup): TodoStory[] {
  const name = (by: TodoLine['by']) => {
    const writer = writerOf(by, lookup);
    return writer.kind === 'you' ? 'you' : writer.name;
  };
  const story: TodoStory[] = [{ who: name(line.by), what: 'wrote it', at: line.at }];
  if (line.done !== null) story.push({ who: name(line.done.by), what: 'ticked it', at: line.done.at });
  return story;
}
