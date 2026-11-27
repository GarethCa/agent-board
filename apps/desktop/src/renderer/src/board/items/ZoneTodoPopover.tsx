// What a click on a zone tab's to-do count opens: the zone's to-do lists, one group per list headed by whose it is and
// how many are left, its lines under it to tick or edit in place; and one list's peek, beside its folded pill. Each
// change is saved as the user's, as on the card.
import { useContext, useState } from 'react';
import { useStore, type Node } from '@xyflow/react';
import { Eye, Maximize2 } from 'lucide-react';
import type { BoardItem, TodoData, TodoLine } from '@agent-board/daemon/protocol';
import { useBoardCommands } from '../commands';
import { isItemNode } from './items';
import { Box, LineField } from './TodoCard';
import { TodoLookupContext } from './todo-lookup';
import { listOwnerName, todoCounts, todoData, zoneTodoLists } from './todo-view';
import { useTodoChanges, type TodoChanges } from './use-todo-changes';

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
  const owner = listOwnerName(data, lookup);
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
      <TodoPopLines lines={data.lines} changes={changes} />
    </section>
  );
}

/** One list's peek, beside its folded pill: its lines to tick or edit, a field to add one, and ⤢ for full screen. */
export function TodoPeek({ data, changes, onFull }: { data: TodoData; changes: TodoChanges; onFull(): void }) {
  const [draft, setDraft] = useState('');
  const left = todoCounts(data).open;
  const add = () => {
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    void changes.add(text, null);
  };
  return (
    <div className="todo-pop todo-peek" data-testid="todo-peek">
      <div className="todo-pop-head">
        <span>To do · {left === 0 && data.lines.length > 0 ? 'all done' : `${left} left`}</span>
        <button type="button" className="todo-pop-show" aria-label="Open full screen" title="Open full screen · ⌘↵" onClick={onFull}>
          <Maximize2 aria-hidden />
        </button>
      </div>
      {data.lines.length === 0 ? <p className="todo-pop-none">Nothing to do yet.</p> : <TodoPopLines lines={data.lines} changes={changes} />}
      <input
        className="todo-input todo-peek-add"
        value={draft}
        placeholder="Add a to-do"
        aria-label="Add a to-do"
        maxLength={500}
        autoFocus={data.lines.length === 0}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && !event.nativeEvent.isComposing && (event.preventDefault(), add())}
      />
    </div>
  );
}

/** A list's lines in a popover: a click on a box ticks or unticks it, a double-click on its text edits it. */
function TodoPopLines({ lines, changes }: { lines: readonly TodoLine[]; changes: TodoChanges }) {
  const [editing, setEditing] = useState<{ line: string; text: string }>();
  const save = (line: TodoLine) => {
    if (editing === undefined) return;
    const text = editing.text.trim();
    setEditing(undefined);
    if (text !== '' && text !== line.text) changes.edit(line, text);
  };
  return (
    <ul className="todo-pop-lines">
      {lines.map((line) => (
        <li key={line.id} className="todo-pop-line" data-testid="todo-pop-line" data-done={line.done !== null || undefined}>
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
  );
}
