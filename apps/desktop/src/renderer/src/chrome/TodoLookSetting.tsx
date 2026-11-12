import { setTodoLook, useTodoLook } from '../board/items/todo-look';
import { TODO_LOOKS, type TodoLook } from '../board/items/todo-view';
import { Fieldset, Hint, Segmented } from '../ui';

const LABELS: Record<TodoLook, string> = { card: 'Card', clipboard: 'Clipboard' };

/** Settings › General › Design › To-do lists: an open list as a checklist card, or a clipboard. */
export function TodoLookSetting() {
  return (
    <Fieldset legend="To-do lists">
      <Segmented aria-label="To-do lists" options={TODO_LOOKS.map((id) => ({ id, label: LABELS[id] }))} value={useTodoLook()} onChange={setTodoLook} />
      <Hint>How an open to-do list looks on the board and in an agent's window. Folded, it is a pill either way.</Hint>
    </Fieldset>
  );
}
