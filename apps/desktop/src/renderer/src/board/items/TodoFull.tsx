// A to-do list full screen: its lines in groups on the left (left, then ticked), searchable and filtered by whose they
// are, beside the one picked, with its box, its text to edit, who wrote it and ticked it and when, Delete, and for an
// agent's line, Show it on the board. It takes what to show and what to do as props, so the gallery draws it as the board does.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AppWindow, Eye, Plus, Search, SquareCheckBig, Trash2 } from 'lucide-react';
import type { TodoData, TodoLine } from '@agent-board/daemon/protocol';
import { Button, IconButton, Kbd } from '../../ui';
import { isTyping } from '../../keys/typing';
import { FullScreen, type FullScreenKey } from './FullScreen';
import { whenText } from './list-card-text';
import { Box, WriterChip, type TodoCardActions } from './TodoCard';
import { linesOf, lineStory, moveTo, NO_TODO_FILTER, todoFullKey, todoGroups, writerCounts, type TodoFilter } from './todo-full';
import { cursorAfterRemove, listOwnerName, moveCursor, todoCounts, writerOf, type TodoLookup } from './todo-view';

export interface TodoFullProps {
  data: TodoData;
  lookup: TodoLookup;
  zoneName?: string;
  now: Date;
  actions: Pick<TodoCardActions, 'add' | 'edit' | 'tick' | 'remove' | 'clear' | 'move' | 'showAgent' | 'openInWindow'>;
  onClose(): void;
  /** Drawn open in place, not over the page: for the gallery. */
  inline?: boolean;
  /** Where it starts, for the gallery: the line picked, the list's filter, and a line being added. */
  initial?: { picked?: string; filter?: Partial<TodoFilter>; adding?: string };
  /** The list on the board, for the focus as it closes. */
  object?(): HTMLElement | null | undefined;
}

/** Esc in an edit or the add field cancels it, and in a search with text clears it: not the whole view. */
const escapeStays = (focused: Element | null) =>
  focused instanceof HTMLElement && (focused.closest('.todo-full-edit, .todo-full-add') !== null || (focused.closest('.list-full-search') !== null && (focused as HTMLInputElement).value !== ''));

const FOOT_KEYS: FullScreenKey[] = [
  { keys: '↑↓', label: 'move' },
  { keys: 'Space', label: 'tick' },
  { keys: '↵', label: 'edit' },
  { keys: '⌥↑⌥↓', label: 'reorder' },
  { keys: 'N', label: 'add' },
  { keys: '⇧⌫', label: 'clear ticked' },
  { keys: '/', label: 'search' },
  { keys: 'esc', label: 'back to the board' },
];

/** A to-do list full screen, over the board: Esc, the close button or a click outside closes it. */
export function TodoFull({ data, lookup, zoneName, now, actions, onClose, inline = false, initial, object }: TodoFullProps) {
  const [filter, setFilter] = useState<TodoFilter>({ ...NO_TODO_FILTER, ...initial?.filter });
  const [picked, setPicked] = useState(initial?.picked);
  const [adding, setAdding] = useState(initial?.adding !== undefined);
  const [draft, setDraft] = useState(initial?.adding ?? '');
  const [editing, setEditing] = useState<{ line: string; text: string }>();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const groups = todoGroups(data.lines, filter, lookup);
  const lines = linesOf(groups);
  // When the picked line goes (deleted, cleared, filtered out), the line now in its place is picked, not the first.
  const at = useRef(0);
  const found = lines.findIndex((line) => line.id === picked);
  const current = found >= 0 ? lines[found] : lines[Math.min(at.current, lines.length - 1)];
  useEffect(() => {
    const index = lines.findIndex((line) => line.id === current?.id);
    if (index >= 0) at.current = index;
  });
  // A tick or a move redraws the picked line's row in another place: it gets the focus back, unless the user went elsewhere.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    const active = document.activeElement;
    const lost = !(active instanceof HTMLElement) || active === document.body || !active.isConnected || active.getAttribute('role') === 'dialog';
    if (!lost) return;
    refocus.current = false;
    list.current?.querySelector<HTMLElement>('.todo-full-item[aria-current="true"]')?.focus();
  });
  const counts = todoCounts(data);
  const writers = writerCounts(data.lines);
  const owner = listOwnerName(data, lookup);
  const set = (change: Partial<TodoFilter>) => setFilter((was) => ({ ...was, ...change }));
  const pick = (line: TodoLine | undefined, focus = false) => {
    if (line === undefined) return;
    setAdding(false);
    setPicked(line.id);
    if (focus) list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(line.id)}"]`)?.focus();
  };
  const tick = (line: TodoLine) => {
    refocus.current = true;
    actions.tick(line, line.done === null);
  };
  const remove = (line: TodoLine) => {
    refocus.current = true;
    setPicked(cursorAfterRemove(lines, line.id));
    actions.remove(line, data.lines.indexOf(line));
  };
  const reorder = (line: TodoLine, by: -1 | 1) => {
    const to = moveTo(data.lines, groups, line.id, by);
    if (to === undefined) return;
    refocus.current = true;
    actions.move(line, to);
  };
  const save = (line: TodoLine) => {
    const text = editing?.text.trim() ?? '';
    setEditing(undefined);
    refocus.current = true;
    if (text !== '' && text !== line.text) actions.edit(line, text);
  };
  const add = async () => {
    const text = draft.trim();
    if (text === '') return setAdding(false);
    // ↵ adds it, and the field stays for the next one.
    setDraft('');
    const id = await actions.add(text, null);
    if (id !== undefined) setPicked(id);
  };
  const startAdding = () => {
    setEditing(undefined);
    setDraft('');
    setAdding(true);
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(event)) return;
    const key = todoFullKey(event);
    if (key === undefined) return;
    // A row's button would take Space and ↵ as its own click.
    if ((key === 'tick' || key === 'edit') && (event.target as HTMLElement).closest('.todo-full-item') === null && (event.target as HTMLElement).closest('button') !== null) return;
    event.preventDefault();
    // The board's own keys (⌫ deletes the object) stay out of it.
    event.stopPropagation();
    if (key === 'search') search.current?.focus();
    else if (key === 'new') startAdding();
    else if (key === 'clear') {
      if (counts.ticked > 0) actions.clear();
    } else if (key === 'up' || key === 'down') {
      const id = moveCursor(lines, current?.id, key === 'up' ? -1 : 1);
      pick(lines.find((line) => line.id === id), true);
    } else if (current !== undefined) {
      if (key === 'tick') tick(current);
      else if (key === 'edit') setEditing({ line: current.id, text: current.text });
      else if (key === 'delete') remove(current);
      else reorder(current, key === 'raise' ? -1 : 1);
    }
  };

  const row = (line: TodoLine) => (
    <li key={line.id}>
      <button
        type="button"
        className="list-full-item todo-full-item"
        data-row={line.id}
        data-done={line.done !== null || undefined}
        aria-current={line.id === current?.id || undefined}
        tabIndex={line.id === current?.id ? 0 : -1}
        onClick={() => pick(line)}
      >
        <span className="list-full-item-name">
          <Box done={line.done !== null} />
          <b>{line.text}</b>
        </span>
        <span className="list-full-item-sub">
          <WriterChip writer={writerOf(line.by, lookup)} />
        </span>
      </button>
    </li>
  );

  return (
    <FullScreen
      className="todo-full"
      testId="todo-full"
      title="To do"
      face={<SquareCheckBig />}
      sub={[owner === 'Yours' ? 'Your list' : `${owner}'s list`, zoneName].filter(Boolean).join(' · ')}
      count={counts.total === 0 ? 'Nothing to do' : counts.open > 0 ? `${counts.open} left` : 'All done'}
      headEnd={
        actions.openInWindow !== undefined && (
          <Button size="sm" variant="ghost" icon={<AppWindow />} onClick={actions.openInWindow}>
            Open in its window
          </Button>
        )
      }
      bar={
        <>
          <label className="listcard-search list-full-search">
            <Search className="listcard-search-mark" aria-hidden="true" />
            <input
              ref={search}
              className="listcard-search-input"
              value={filter.search}
              placeholder="Search to-dos"
              aria-label="Search to-dos"
              onChange={(event) => set({ search: event.target.value })}
              onKeyDown={(event) => event.key === 'Escape' && filter.search !== '' && (event.preventDefault(), event.stopPropagation(), set({ search: '' }))}
            />
            <Kbd>/</Kbd>
          </label>
          <button type="button" className="list-full-chip" aria-pressed={filter.writers === 'yours'} disabled={writers.yours === 0} onClick={() => set({ writers: filter.writers === 'yours' ? null : 'yours' })}>
            Yours {writers.yours}
          </button>
          <button type="button" className="list-full-chip" aria-pressed={filter.writers === 'agents'} disabled={writers.agents === 0} onClick={() => set({ writers: filter.writers === 'agents' ? null : 'agents' })}>
            From agents {writers.agents}
          </button>
          <span className="full-screen-bar-end">
            {counts.ticked > 0 && (
              <Button size="sm" variant="ghost" onClick={actions.clear}>
                Clear {counts.ticked} ticked
              </Button>
            )}
            <Button size="sm" variant="primary" icon={<Plus />} onClick={startAdding}>
              Add a to-do
            </Button>
          </span>
        </>
      }
      side={
        <ul ref={list} className="list-full-list" aria-label="To-dos in groups">
          {groups.map((group) => (
            <li key={group.id} className="queue-full-group">
              <span className="list-full-group" aria-hidden="true">
                {group.label} · {group.lines.length}
              </span>
              <ul className="queue-full-rows">{group.lines.map(row)}</ul>
            </li>
          ))}
          {lines.length === 0 && <li className="list-full-none">{filter.search.trim() !== '' ? `Nothing matches “${filter.search}”` : 'Nothing to do'}</li>}
        </ul>
      }
      detail={
        adding ? (
          <section className="list-full-entry todo-full-add" aria-label="Add a to-do" onKeyDown={(event) => event.key === 'Escape' && (event.preventDefault(), event.stopPropagation(), setAdding(false))}>
            <h3 className="queue-full-heading">Add a to-do</h3>
            <input
              className="list-full-name todo-full-input"
              value={draft}
              maxLength={500}
              autoFocus={initial?.adding === undefined}
              placeholder="What to do"
              aria-label="Add a to-do"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && !event.nativeEvent.isComposing && (event.preventDefault(), void add())}
            />
            <span className="queue-full-hint">↵ adds, then type the next · esc done</span>
          </section>
        ) : current === undefined ? (
          <div className="list-full-empty">
            <b>Nothing to do</b>
            <span>
              Type one with Add a to-do, or an agent adds one with <code>remind</code>.
            </span>
          </div>
        ) : (
          <article key={current.id} className="list-full-entry" aria-label={current.text}>
            <div className="list-full-entry-head">
              <button type="button" className="todo-tick todo-full-tick" role="checkbox" aria-checked={current.done !== null} aria-label={current.done === null ? 'Tick it' : 'Untick it'} onClick={() => tick(current)}>
                <Box done={current.done !== null} />
                {current.done === null ? 'Tick' : 'Ticked'}
              </button>
              <span className="list-full-entry-tools">
                <IconButton icon={<Trash2 />} size="sm" aria-label="Delete" tooltip="Delete · ⌫" onClick={() => remove(current)} />
              </span>
            </div>
            {editing?.line === current.id ? (
              <textarea
                className="list-full-name queue-full-edit todo-full-edit"
                value={editing.text}
                maxLength={500}
                autoFocus
                aria-label={`Edit ${current.text}`}
                // A line is one line: a line break typed or pasted becomes a space.
                onChange={(event) => setEditing({ line: current.id, text: event.target.value.replace(/\s*\n\s*/g, ' ') })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    save(current);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setEditing(undefined);
                  }
                }}
                onBlur={() => save(current)}
              />
            ) : (
              <button type="button" className="queue-full-title todo-full-title" data-done={current.done !== null || undefined} aria-label={`Edit ${current.text}`} title="Click to edit · ↵" onClick={() => setEditing({ line: current.id, text: current.text })}>
                {current.text}
              </button>
            )}
            <LineAgent line={current} lookup={lookup} showAgent={actions.showAgent} />
            <section className="list-full-who" aria-label="Who and when">
              <h3>Who and when</h3>
              <ol className="list-full-timeline">
                {lineStory(current, lookup).map((story) => (
                  <li key={story.what}>
                    <span>
                      {story.who} {story.what}
                    </span>
                    <time dateTime={story.at}>{whenText(story.at, now)}</time>
                  </li>
                ))}
              </ol>
            </section>
          </article>
        )
      }
      keys={FOOT_KEYS}
      inline={inline}
      onClose={onClose}
      // The line shown, in the list, so ↑↓ move at once; with none, the search.
      initialFocus={(root) => root.querySelector<HTMLElement>('.todo-full-item[aria-current="true"]') ?? root.querySelector<HTMLElement>('.list-full-search input')}
      escapeStays={escapeStays}
      object={object}
      onKeyDown={keys}
    />
  );
}

/** An agent's line: Show it on the board, its writer's tile. */
function LineAgent({ line, lookup, showAgent }: { line: TodoLine; lookup: TodoLookup; showAgent?(sessionId: string): void }) {
  const writer = writerOf(line.by, lookup);
  if (writer.kind !== 'agent' || showAgent === undefined) return null;
  return (
    <div className="queue-full-acts">
      <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => showAgent(writer.sessionId)}>
        Show {writer.name} on the board
      </Button>
    </div>
  );
}
