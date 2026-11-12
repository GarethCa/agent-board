// What every place a to-do list is drawn does to it: the board's card, the zone tab's popover, and the agent's tab in
// its window. Each change is saved as the user's through the daemon, and none of it tells an agent.
import { useCallback, useMemo } from 'react';
import type { TodoChange, TodoLine } from '@agent-board/daemon/protocol';
import { useToast } from '../../ui';
import { why } from './ListCardNodeParts';
import type { TodoCardActions } from './TodoCard';
import { todoData } from './todo-view';

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/** The changes to the lines of list `itemId`, whose lines are now `lines`. A line taken off, or the ticked ones cleared, is one Undo from back. */
export type TodoChanges = Pick<TodoCardActions, 'add' | 'edit' | 'tick' | 'remove' | 'clear' | 'move' | 'copy'>;

export function useTodoChanges(itemId: string, lines: readonly TodoLine[]): TodoChanges {
  const toast = useToast();
  const change = useCallback(
    (what: TodoChange) =>
      window.agentBoard.items.changeTodo(itemId, what).catch((error: unknown) => {
        toast.show({ tone: 'error', id: `todo-${itemId}`, message: `Could not change the to-do list: ${why(error)}` });
        return undefined;
      }),
    [itemId, toast],
  );
  const clear = useCallback(() => {
    const ticked = lines.flatMap((line, at) => (line.done === null ? [] : [{ line, at }]));
    if (ticked.length === 0) return;
    void change({ action: 'clear' }).then((changed) => {
      if (changed === undefined) return;
      toast.show({
        message: `Cleared ${ticked.length} ticked ${ticked.length === 1 ? 'to-do' : 'to-dos'}`,
        // Put back at their old places, first place first: each lands where it was unless the list changed meanwhile
        // (a line added or moved since), when they come back near there, in their old order.
        action: { label: 'Undo', onClick: () => void ticked.reduce<Promise<unknown>>((done, { line, at }) => done.then(() => change({ action: 'restore', line, at })), Promise.resolve()) },
      });
    });
  }, [change, lines, toast]);

  return useMemo<TodoChanges>(
    () => ({
      add: async (text, after) => {
        const before = new Set(lines.map((line) => line.id));
        const changed = await change({ action: 'add', text, after });
        return changed === undefined ? undefined : todoData(changed.data).lines.find((line) => !before.has(line.id))?.id;
      },
      edit: (line, text) => void change({ action: 'edit', line: line.id, text }),
      tick: (line, done) => void change({ action: 'tick', line: line.id, done }),
      remove: (line, at) =>
        void change({ action: 'remove', line: line.id }).then((changed) => {
          if (changed === undefined) return;
          toast.show({ message: `Deleted “${short(line.text)}”`, action: { label: 'Undo', onClick: () => void change({ action: 'restore', line, at }) } });
        }),
      clear,
      move: (line, to) => void change({ action: 'move', line: line.id, to }),
      copy: (text) =>
        void navigator.clipboard.writeText(text).then(
          () => toast.show({ message: 'Copied the to-do' }),
          (error: unknown) => toast.show({ tone: 'error', id: `todo-copy-${itemId}`, message: `Could not copy it: ${why(error)}` }),
        ),
    }),
    [change, clear, itemId, lines, toast],
  );
}
