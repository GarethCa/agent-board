// How an open to-do list looks, a Settings choice kept in localStorage so every window hears it change: the checklist
// card, or a clipboard with its sheet. What the choice is, and its words, are in todo-view.ts.
import { useSyncExternalStore } from 'react';
import { storedValue } from '../../stored-value';
import { todoLookOf, type TodoLook } from './todo-view';

const stored = storedValue('agent-board.todo-look');

export function setTodoLook(look: TodoLook): void {
  stored.set(look === 'card' ? undefined : look);
}

/** The look picked, heard in every window as it changes. */
export function useTodoLook(): TodoLook {
  return useSyncExternalStore(stored.subscribe, () => todoLookOf(stored.get()), () => 'card');
}
