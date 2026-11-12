// What a to-do list shows, worked out from its data: how many lines are left, the words for its head and its pill,
// who wrote each line, the count on its zone's tab, and what a key does once the user has stepped into it.
import type { BoardItem, Harness, StepsWho, TodoData, TodoLine } from '@agent-board/daemon/protocol';

/** A to-do list's data, as it was saved. */
export const todoData = (data: Record<string, unknown>): TodoData => data as unknown as TodoData;

/** The data of a new, empty list of the user's, from the board's menus. */
export const newTodoData = (): TodoData => ({ owner: { kind: 'user' }, lines: [] });

/** What a to-do list reads of the board: the agents that wrote its lines, as they are now. */
export interface TodoLookup {
  /** The agent's name as it is now, if it is on the board. */
  name(sessionId: string): string | undefined;
  /** The agent's harness, if it is on the board. */
  harness(sessionId: string): Harness | undefined;
}

export const NO_LOOKUP: TodoLookup = { name: () => undefined, harness: () => undefined };

export interface TodoCounts {
  /** Lines not yet ticked. */
  open: number;
  ticked: number;
  total: number;
}

export function todoCounts(data: TodoData): TodoCounts {
  const open = data.lines.filter((line) => line.done === null).length;
  return { open, ticked: data.lines.length - open, total: data.lines.length };
}

/** The list's state: lines left, every line ticked, or none at all. */
export type TodoState = 'open' | 'done' | 'empty';

export const todoState = ({ open, total }: TodoCounts): TodoState => (total === 0 ? 'empty' : open === 0 ? 'done' : 'open');

/** The words on its folded pill: "3 to do", "All done", or "To do" for an empty list. */
export function pillText(counts: TodoCounts): string {
  const state = todoState(counts);
  return state === 'open' ? `${counts.open} to do` : state === 'done' ? 'All done' : 'To do';
}

/** The count at the end of its head: the lines left, "All done", or none for an empty list. */
export function headCount(counts: TodoCounts): string | undefined {
  const state = todoState(counts);
  return state === 'open' ? String(counts.open) : state === 'done' ? 'All done' : undefined;
}

/** Who wrote a line, as its chip says: "you", or the agent by its name now, with its harness's mark. */
export type Writer = { kind: 'you' } | { kind: 'agent'; sessionId: string; name: string; harness?: Harness };

export function writerOf(who: StepsWho, lookup: TodoLookup): Writer {
  if (who.kind === 'user') return { kind: 'you' };
  return { kind: 'agent', sessionId: who.sessionId, name: lookup.name(who.sessionId) ?? who.name, harness: lookup.harness(who.sessionId) };
}

/** The agents that wrote the open lines, once each, in the order they first wrote: the marks on its folded pill. */
export function openWriters(data: TodoData, lookup: TodoLookup): Writer[] {
  const seen = new Set<string>();
  const writers: Writer[] = [];
  for (const line of data.lines) {
    if (line.done !== null) continue;
    const key = line.by.kind === 'user' ? 'user' : line.by.sessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    writers.push(writerOf(line.by, lookup));
  }
  return writers;
}

/** The agent a list is tied to, if it is an agent's: the one whose tile it sits under. */
export const listAgent = (data: TodoData): string | undefined => (data.owner.kind === 'agent' ? data.owner.sessionId : undefined);

/** The lines still open across a zone's to-do lists: the count on its tab. */
export function zoneTodos(items: Iterable<BoardItem>, zoneId: string): { open: number } {
  let open = 0;
  for (const item of items) if (item.kind === 'todo' && item.zoneId === zoneId) open += todoCounts(todoData(item.data)).open;
  return { open };
}

/** The zone's to-do lists that hold any lines, in the board's order: what a click on its tab's count lists. */
export function zoneTodoLists(items: Iterable<BoardItem>, zoneId: string): BoardItem[] {
  return [...items].filter((item) => item.kind === 'todo' && item.zoneId === zoneId && todoData(item.data).lines.length > 0);
}

/** The agent's own list, the one its `remind` writes to, if it has one. */
export function agentTodoList(items: Iterable<BoardItem>, sessionId: string): BoardItem | undefined {
  for (const item of items) if (item.kind === 'todo' && listAgent(todoData(item.data)) === sessionId) return item;
  return undefined;
}

/** Whose list it is, as a heading names it: the agent by its name now, or "Yours". */
export function listOwnerName(data: TodoData, lookup: TodoLookup): string {
  const writer = writerOf(data.owner, lookup);
  return writer.kind === 'you' ? 'Yours' : writer.name;
}

/** How an open list looks: the checklist card, or a clipboard with its sheet. A Settings choice, the same in every window. */
export const TODO_LOOKS = ['card', 'clipboard'] as const;
export type TodoLook = (typeof TODO_LOOKS)[number];

/** The stored look, or the card for none or one this version doesn't know. */
export const todoLookOf = (value: string | undefined): TodoLook => TODO_LOOKS.find((look) => look === value) ?? 'card';

/** What the head says of the lines left: the count on the card, "3 left" on the clipboard's sheet. */
export function headCountIn(look: TodoLook, counts: TodoCounts): string | undefined {
  const count = headCount(counts);
  return look === 'clipboard' && todoState(counts) === 'open' ? `${count} left` : count;
}

/** The id of the line `by` places from `cursor`, kept inside the list; the first line when there is no cursor yet. */
export function moveCursor(lines: readonly TodoLine[], cursor: string | undefined, by: number): string | undefined {
  if (lines.length === 0) return undefined;
  const at = lines.findIndex((line) => line.id === cursor);
  if (at === -1) return lines[0]?.id;
  return lines[Math.min(lines.length - 1, Math.max(0, at + by))]?.id;
}

/** Where the cursor goes once its line has been taken off: the next line, or the one before the last. */
export function cursorAfterRemove(lines: readonly TodoLine[], removed: string): string | undefined {
  const at = lines.findIndex((line) => line.id === removed);
  const rest = lines.filter((line) => line.id !== removed);
  return rest[Math.min(Math.max(at, 0), rest.length - 1)]?.id;
}

/** What a key does on a list the user has stepped into, with ↵. */
export type TodoKeyAction = 'up' | 'down' | 'tick' | 'edit' | 'new' | 'delete' | 'clear' | 'raise' | 'lower' | 'leave';

export function todoKey(event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): TodoKeyAction | undefined {
  if (event.metaKey || event.ctrlKey) return undefined;
  switch (event.key) {
    case 'ArrowUp':
      return event.altKey ? 'raise' : 'up';
    case 'ArrowDown':
      return event.altKey ? 'lower' : 'down';
    case ' ':
      return 'tick';
    case 'Enter':
      return 'edit';
    case 'n':
    case 'N':
      return event.altKey ? undefined : 'new';
    case 'Backspace':
    case 'Delete':
      return event.shiftKey ? 'clear' : 'delete';
    case 'Escape':
      return 'leave';
    default:
      return undefined;
  }
}
