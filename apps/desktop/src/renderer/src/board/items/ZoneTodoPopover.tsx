// What a click on a zone tab's to-do count opens: the zone's to-do lists, one group per list headed by whose it is and
// how many are left, its lines under it to tick or edit in place. Each change is saved as the user's, as on the card.
import { useContext, useState } from 'react';
import { useStore, type Node } from '@xyflow/react';
import { Eye } from 'lucide-react';
import type { BoardItem, TodoLine } from '@agent-board/daemon/protocol';
import { useBoardCommands } from '../commands';
import { isItemNode } from './items';
import { Box, LineField } from './TodoCard';
import { TodoLookupContext } from './TodoNode';
import { listOwnerName, todoCounts, todoData, zoneTodoLists } from './todo-view';
import { useTodoChanges } from './use-todo-changes';

/** The board's items, from its nodes. */
export function* boardItems(nodes: readonly Node[]): Generator<BoardItem> {
  for (const node of nodes) if (isItemNode(node)) yield node.data.item;
}

const sameItems = (a: readonly BoardItem[], b: readonly BoardItem[]) => a.length === b.length && a.every((item, at) => item === b[at]);

/** The popover's lists: drawn again only as one of the zone's lists changes. */
export function ZoneTodoPopover({ zoneId, onShown }: { zoneId: string; onShown(): void }) {
  const lists = useStore((state) => zoneTodoLists(boardItems(state.nodes), zoneId), sameItems);
  return (
    <div className="todo-pop" data-testid="zone-todo-popover">
      {lists.length === 0 ? <p className="todo-pop-none">Nothing left to do here.</p> : lists.map((item) => <ZoneTodoGroup key={item.id} item={item} onShown={onShown} />)}
    </div>
  );
}

function ZoneTodoGroup({ item, onShown }: { item: BoardItem; onShown(): void }) {
  const lookup = useContext(TodoLookupContext);
  const commands = useBoardCommands();
  const data = todoData(item.data);
  const changes = useTodoChanges(item.id, data.lines);
  const [editing, setEditing] = useState<{ line: string; text: string }>();
  const owner = listOwnerName(data, lookup);
  const save = (line: TodoLine) => {
    if (editing === undefined) return;
    const text = editing.text.trim();
    setEditing(undefined);
    if (text !== '' && text !== line.text) changes.edit(line, text);
  };
  return (
    <section className="todo-pop-group" data-testid="zone-todo-group" aria-label={`${owner}'s to-do list`}>
      <div className="todo-pop-head">
        <span>
          {owner} · {todoCounts(data).open}
        </span>
        <button
          type="button"
          className="todo-pop-show"
          aria-label={`Show ${owner === 'Yours' ? 'your' : `${owner}'s`} list on the board`}
          title="Show it on the board"
          onClick={() => {
            onShown();
            commands.showItem(item.id);
          }}
        >
          <Eye aria-hidden />
        </button>
      </div>
      <ul className="todo-pop-lines">
        {data.lines.map((line) => (
          <li key={line.id} className="todo-pop-line" data-testid="zone-todo-line" data-done={line.done !== null || undefined}>
            {editing?.line === line.id ? (
              <LineField value={editing.text} onChange={(text) => setEditing({ line: line.id, text })} onSave={() => save(line)} onCancel={() => setEditing(undefined)} hint="↵ save · esc cancel" />
            ) : (
              <>
                <button type="button" className="todo-tick" role="checkbox" aria-checked={line.done !== null} aria-label={line.text} onClick={() => changes.tick(line, line.done === null)}>
                  <Box done={line.done !== null} />
                </button>
                <span className="todo-text" title={`${line.text} (double-click to edit)`} onDoubleClick={() => setEditing({ line: line.id, text: line.text })}>
                  {line.text}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
