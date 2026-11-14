// A to-do list as the board draws it: open, a checklist card under a teal head, or a clipboard with its sheet (a
// Settings choice); folded, a pill of how many are left. It only reminds: nothing on it ticks itself, and a tick tells
// no agent. Where it is drawn (TodoNode on the board, TodoTab in an agent's window) saves each change.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { AppWindow, Check, Copy, Eye, GripVertical, Maximize2, Minimize2, Pencil, Plus, SquareCheckBig, Trash2, X } from 'lucide-react';
import type { TodoData, TodoLine } from '@agent-board/daemon/protocol';
import { ContextMenu, Tooltip, type MenuEntry } from '../../ui';
import { HarnessMark } from '../HarnessMark';
import { useScrollFade } from './CardSizing';
import { cursorAfterRemove, headCountIn, moveCursor, openWriters, pillText, todoCounts, todoKey, todoState, writerOf, type TodoLook, type TodoLookup, type Writer } from './todo-view';

/** What the user does to a list; each is saved where it is drawn. Those it can't do there are left out, with their menu entries. */
export interface TodoCardActions {
  /** Adds a line after `after`, or last; resolves to its id once saved. */
  add(text: string, after: string | null): Promise<string | undefined>;
  edit(line: TodoLine, text: string): void;
  tick(line: TodoLine, done: boolean): void;
  /** Takes a line off from place `at`, with an Undo. */
  remove(line: TodoLine, at: number): void;
  /** Takes the ticked lines off, with an Undo. */
  clear(): void;
  move(line: TodoLine, to: number): void;
  showAgent?(sessionId: string): void;
  copy(text: string): void;
  fold?(folded: boolean): void;
  deleteList?(): void;
  /** Opens an agent's list as the To do tab of its window. */
  openInWindow?(): void;
  /** Gives the keys back to the board. */
  leave(): void;
}

/** A line being typed into: one there already, or a new one after `after` (null for last). */
export type TodoEditing = { line: string } | { add: true; after: string | null };

interface TodoCardProps {
  data: TodoData;
  lookup: TodoLookup;
  zoneName?: string;
  /** The checklist card, or the clipboard. */
  look?: TodoLook;
  /** Stepped into with ↵: its keys are its own until esc. */
  steppedIn: boolean;
  /** Opens with its add field focused: a list the user just made. */
  addFirst?: boolean;
  actions: TodoCardActions;
  /** The node's toolbar. */
  children?: ReactNode;
  /** For the gallery: a state to open in. */
  initial?: { editing?: TodoEditing; draft?: string; cursor?: string; hot?: string };
}

const SHORTCUT = { tick: 'Space', edit: '↵', copy: '⌘C', remove: '⌫', add: 'N', clear: '⇧⌫' };

function WriterChip({ writer }: { writer: Writer }) {
  return (
    <span className="todo-writer" data-you={writer.kind === 'you' || undefined} title={writer.kind === 'you' ? 'You wrote this' : `${writer.name} wrote this`}>
      {writer.kind === 'you' ? <i className="todo-writer-you" aria-hidden /> : writer.harness === undefined ? <i className="todo-writer-agent" aria-hidden /> : <HarnessMark harness={writer.harness} className="todo-writer-mark" />}
      <span>{writer.kind === 'you' ? 'you' : writer.name}</span>
    </span>
  );
}

export function Box({ done }: { done: boolean }) {
  return (
    <span className="todo-box" data-done={done || undefined} aria-hidden>
      {done && <Check />}
    </span>
  );
}

/** Scrolls the card's list, and only it, so all of a field (its hint too) shows: the board's canvas never moves. */
function showInList(field: HTMLElement) {
  const list = field.closest<HTMLElement>('.todo-lines');
  if (list === null || list.offsetHeight === 0) return;
  const view = list.getBoundingClientRect();
  const box = field.getBoundingClientRect();
  // On screen the board's zoom scales both; the list scrolls in its own, unzoomed pixels.
  const zoom = view.height / list.offsetHeight;
  if (box.bottom > view.bottom) list.scrollTop += (box.bottom - view.bottom) / zoom;
  else if (box.top < view.top) list.scrollTop -= (view.top - box.top) / zoom;
}

/** The field a line is typed in: ↵ saves, esc puts it back. It takes the keys as it opens, unless it is a still look. */
export function LineField({ value, onChange, onSave, onCancel, hint, placeholder, still = false }: { value: string; onChange(text: string): void; onSave(): void; onCancel(): void; hint: string; placeholder?: string; still?: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  const whole = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!still) field.current?.focus({ preventScroll: true });
    if (whole.current !== null) showInList(whole.current);
  }, [still]);
  return (
    <div ref={whole} className="todo-field nodrag">
      <input
        ref={field}
        className="todo-input"
        data-testid="todo-input"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder ?? 'The to-do'}
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) onSave();
          else if (event.key === 'Escape') onCancel();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onBlur={onSave}
      />
      <span className="todo-field-hint">{hint}</span>
    </div>
  );
}

/** The card: head, lines, foot; or the empty card that says how lines get there. */
export function TodoCardView({ data, lookup, zoneName, look = 'card', steppedIn, addFirst = false, actions, children, initial }: TodoCardProps) {
  const counts = todoCounts(data);
  const state = todoState(counts);
  const fade = useScrollFade<HTMLOListElement>();
  const [cursor, setCursor] = useState<string | undefined>(initial?.cursor);
  const [editing, setEditingNow] = useState<TodoEditing | undefined>(initial?.editing ?? (addFirst ? { add: true, after: null } : undefined));
  const [draft, setDraftNow] = useState(initial?.draft ?? '');
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; line?: TodoLine }>();
  const [dragged, setDragged] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  // What is being typed, as of now: a blur heard after ↵ or esc (the field going) finds nothing left to save.
  const typing = useRef({ editing, draft, saving: false });
  const setEditing = (next: TodoEditing | undefined) => {
    typing.current.editing = next;
    setEditingNow(next);
  };
  const setDraft = (next: string) => {
    typing.current.draft = next;
    setDraftNow(next);
  };

  // Stepped in, the card takes the keys, its cursor on the first line; stepped out, it lets them go.
  useEffect(() => {
    if (!steppedIn) return;
    box.current?.focus();
    setCursor((at) => (data.lines.some((line) => line.id === at) ? at : data.lines[0]?.id));
    // Only as it steps in: lines changing under it keep the cursor where it is.
  }, [steppedIn]);

  const refocus = () => {
    if (steppedIn) requestAnimationFrame(() => box.current?.focus());
  };
  const startEdit = (line: TodoLine) => {
    setEditing({ line: line.id });
    setDraft(line.text);
    setCursor(line.id);
  };
  const startAdd = (after: string | null) => {
    setEditing({ add: true, after });
    setDraft('');
  };
  const stop = () => {
    setEditing(undefined);
    setDraft('');
    refocus();
  };
  const save = async () => {
    const { editing: now, draft: typed, saving } = typing.current;
    if (now === undefined || saving) return;
    const text = typed.trim();
    if ('line' in now) {
      const line = data.lines.find((each) => each.id === now.line);
      if (line !== undefined && text !== '' && text !== line.text) actions.edit(line, text);
      return stop();
    }
    if (text === '') return stop();
    // ↵ adds it, and the field stays for the next one, after it.
    typing.current.saving = true;
    setDraft('');
    const id = await actions.add(text, now.after).finally(() => {
      typing.current.saving = false;
    });
    const still = typing.current.editing;
    if (id === undefined) return;
    setCursor(id);
    if (still !== undefined && 'add' in still && now.after !== null) setEditing({ add: true, after: id });
  };
  const remove = (line: TodoLine) => {
    setCursor(cursorAfterRemove(data.lines, line.id));
    actions.remove(line, data.lines.indexOf(line));
  };
  const moveBy = (line: TodoLine, by: number) => {
    const to = data.lines.indexOf(line) + by;
    if (to >= 0 && to < data.lines.length) actions.move(line, to);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!steppedIn || event.defaultPrevented || (event.target as HTMLElement).tagName === 'INPUT') return;
    const line = data.lines.find((each) => each.id === cursor);
    const handled = (() => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'c') return line !== undefined && (actions.copy(line.text), true);
      const action = todoKey(event);
      switch (action) {
        case 'up':
        case 'down':
          return (setCursor(moveCursor(data.lines, cursor, action === 'up' ? -1 : 1)), true);
        case 'tick':
          return line !== undefined && (actions.tick(line, line.done === null), true);
        case 'edit':
          return line !== undefined && (startEdit(line), true);
        case 'new':
          return (startAdd(line?.id ?? null), true);
        case 'delete':
          return line !== undefined && (remove(line), true);
        case 'clear':
          return counts.ticked > 0 && (actions.clear(), true);
        case 'raise':
        case 'lower':
          return line !== undefined && (moveBy(line, action === 'raise' ? -1 : 1), true);
        case 'leave':
          return (actions.leave(), true);
        default:
          return false;
      }
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const openMenu = (event: MouseEvent, line?: TodoLine) => {
    event.preventDefault();
    event.stopPropagation();
    if (line !== undefined) setCursor(line.id);
    setMenu({ at: { x: event.clientX, y: event.clientY }, line });
  };
  const lineEntries = (line: TodoLine): MenuEntry[] => {
    const writer = writerOf(line.by, lookup);
    return [
      { label: line.done === null ? 'Tick' : 'Untick', icon: <Check />, shortcut: SHORTCUT.tick, onSelect: () => actions.tick(line, line.done === null) },
      { label: 'Edit', icon: <Pencil />, shortcut: SHORTCUT.edit, onSelect: () => startEdit(line) },
      { label: 'Copy text', icon: <Copy />, shortcut: SHORTCUT.copy, onSelect: () => actions.copy(line.text) },
      ...(writer.kind === 'agent' && actions.showAgent ? [{ label: `Show ${writer.name}`, icon: <Eye />, onSelect: () => actions.showAgent?.(writer.sessionId) }] : []),
      'separator',
      { label: 'Delete line', icon: <Trash2 />, shortcut: SHORTCUT.remove, danger: true, onSelect: () => remove(line) },
    ];
  };
  const headEntries: MenuEntry[] = [
    { label: 'Add a to-do', icon: <Plus />, shortcut: SHORTCUT.add, onSelect: () => startAdd(null) },
    { label: `Clear ticked (${counts.ticked})`, icon: <Check />, shortcut: SHORTCUT.clear, disabled: counts.ticked === 0, onSelect: actions.clear },
    ...(actions.openInWindow ? [{ label: 'Open in its window', icon: <AppWindow />, onSelect: actions.openInWindow }] : []),
    ...(actions.fold ? [{ label: 'Fold', icon: <Minimize2 />, onSelect: () => actions.fold?.(true) }] : []),
    ...(actions.deleteList ? ['separator' as const, { label: 'Delete list', icon: <Trash2 />, danger: true, onSelect: actions.deleteList }] : []),
  ];

  const onDrop = (event: DragEvent, to: number) => {
    const line = data.lines.find((each) => each.id === dragged);
    setDragged(undefined);
    if (line === undefined) return;
    event.preventDefault();
    if (data.lines.indexOf(line) !== to) actions.move(line, to);
  };

  const field = (placeholder?: string) => (
    <LineField
      value={draft}
      onChange={setDraft}
      onSave={() => void save()}
      onCancel={stop}
      hint={editing !== undefined && 'add' in editing ? '↵ add, then type the next · esc done' : '↵ save · esc cancel'}
      placeholder={placeholder}
      // A field the card opened with (a gallery's look) leaves the focus be, so two can sit on one page.
      still={initial?.editing !== undefined && editing === initial.editing}
    />
  );
  const adding = editing !== undefined && 'add' in editing ? editing : undefined;
  const count = look === 'clipboard' && state === 'done' ? undefined : headCountIn(look, counts);
  const clipboard = look === 'clipboard';

  return (
    <div
      ref={box}
      className="todo-card"
      data-testid="todo-card"
      data-state={state}
      data-look={look}
      data-stepped-in={steppedIn || undefined}
      data-keys-own={steppedIn || undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {children}
      {clipboard && <span className="todo-clip" aria-hidden />}
      {/* The clipboard's sheet; on the card it draws nothing of its own. */}
      <div className="todo-sheet">
      <div className="todo-head" onContextMenu={(event) => openMenu(event)}>
        <span className="todo-icon" aria-hidden>
          <SquareCheckBig />
        </span>
        <b className="todo-title">To do</b>
        {zoneName !== undefined && <span className="todo-zone">{zoneName}</span>}
        {count !== undefined && (
          <span className="todo-count" data-testid="todo-count" data-done={state === 'done' || undefined}>
            {count}
          </span>
        )}
      </div>
      {clipboard && state === 'done' && (
        <div className="todo-stamp" data-testid="todo-stamp">
          <span className="todo-stamp-ring" aria-hidden>
            <Check />
          </span>
          All done
        </div>
      )}
      {state === 'empty' && adding === undefined && clipboard ? (
        // The clipboard's empty sheet: ruled lines, the first to type on.
        <ol className="todo-lines todo-blank" aria-label="To do">
          <li className="todo-line">
            <button type="button" className="todo-blank-add nodrag" onClick={() => startAdd(null)}>
              <Box done={false} />
              Add a to-do…
            </button>
          </li>
          <li className="todo-line" aria-hidden>
            <Box done={false} />
          </li>
          <li className="todo-line" aria-hidden>
            <Box done={false} />
          </li>
        </ol>
      ) : state === 'empty' && adding === undefined ? (
        <div className="todo-empty">
          <span className="todo-empty-icon" aria-hidden>
            <SquareCheckBig />
          </span>
          <b>Nothing to do</b>
          <span>
            Type one here, or an agent adds one with <code>remind</code>.
          </span>
          <button type="button" className="todo-add nodrag" onClick={() => startAdd(null)}>
            <Plus aria-hidden />
            Add a to-do
          </button>
        </div>
      ) : (
        <ol ref={fade} className="todo-lines nowheel" aria-label="To do">
          {data.lines.map((line, at) => (
            <li
              key={line.id}
              className="todo-line"
              data-testid="todo-line"
              data-done={line.done !== null || undefined}
              data-cursor={(steppedIn && cursor === line.id) || undefined}
              data-hot={initial?.hot === line.id || undefined}
              data-dragged={dragged === line.id || undefined}
              onContextMenu={(event) => openMenu(event, line)}
              onDragOver={(event) => dragged !== undefined && event.preventDefault()}
              onDrop={(event) => onDrop(event, at)}
            >
              {editing !== undefined && 'line' in editing && editing.line === line.id ? (
                field()
              ) : (
                <>
                  <span
                    className="todo-grip nodrag"
                    draggable
                    aria-hidden
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      setDragged(line.id);
                    }}
                    onDragEnd={() => setDragged(undefined)}
                  >
                    <GripVertical />
                  </span>
                  <button
                    type="button"
                    className="todo-tick nodrag"
                    role="checkbox"
                    aria-checked={line.done !== null}
                    aria-label={line.text}
                    onClick={() => actions.tick(line, line.done === null)}
                  >
                    <Box done={line.done !== null} />
                  </button>
                  <span className="todo-text" title={line.text} onDoubleClick={(event) => (event.stopPropagation(), startEdit(line))}>
                    {line.text}
                  </span>
                  <WriterChip writer={writerOf(line.by, lookup)} />
                  <Tooltip content={`Delete line ${SHORTCUT.remove}`}>
                    <button type="button" className="todo-remove nodrag" aria-label={`Delete “${line.text}”`} onClick={() => remove(line)}>
                      <X />
                    </button>
                  </Tooltip>
                </>
              )}
              {adding !== undefined && adding.after === line.id && <div className="todo-line-new">{field('Add a to-do')}</div>}
            </li>
          ))}
          {adding !== undefined && (adding.after === null || !data.lines.some((line) => line.id === adding.after)) && (
            <li className="todo-line" data-new>
              {field('Add a to-do')}
            </li>
          )}
        </ol>
      )}
      {state !== 'empty' && (
        <div className="todo-foot">
          <button type="button" className="todo-add nodrag" onClick={() => startAdd(null)}>
            <Plus aria-hidden />
            {clipboard ? 'Add' : 'Add a to-do'}
          </button>
          {counts.ticked > 0 && (
            <button type="button" className="todo-clear nodrag" onClick={actions.clear}>
              Clear {counts.ticked} ticked
            </button>
          )}
        </div>
      )}
      </div>
      {menu !== undefined && (
        <ContextMenu at={menu.at} label={menu.line === undefined ? 'To-do list' : 'To-do'} entries={menu.line === undefined ? headEntries : lineEntries(menu.line)} onClose={() => setMenu(undefined)} />
      )}
    </div>
  );
}

/** Folded: a pill of what is left and who wrote it; all done, a quiet one with Clear; empty, a dashed + To do. */
export function TodoPillView({ data, lookup, onOpen, onClear, children }: { data: TodoData; lookup: TodoLookup; onOpen(): void; onClear(): void; children?: ReactNode }) {
  const counts = todoCounts(data);
  const state = todoState(counts);
  const writers = openWriters(data, lookup);
  return (
    <div className="todo-pill" data-testid="todo-pill" data-state={state} onDoubleClick={(event) => (event.stopPropagation(), onOpen())}>
      {children}
      <span className="todo-pill-icon" aria-hidden>
        {state === 'done' ? <Check /> : state === 'empty' ? <Plus /> : <SquareCheckBig />}
      </span>
      <b className="todo-pill-text">{pillText(counts)}</b>
      {state === 'open' && (
        <span className="todo-pill-writers" aria-label={`Written by ${writers.map((each) => (each.kind === 'you' ? 'you' : each.name)).join(', ')}`}>
          {writers.slice(0, 3).map((writer) =>
            writer.kind === 'agent' && writer.harness !== undefined ? (
              <HarnessMark key={writer.sessionId} harness={writer.harness} className="todo-writer-mark" />
            ) : (
              <i key={writer.kind === 'you' ? 'you' : writer.sessionId} className={writer.kind === 'you' ? 'todo-writer-you' : 'todo-writer-agent'} aria-hidden />
            ),
          )}
        </span>
      )}
      {state === 'done' && (
        <button type="button" className="todo-pill-clear nodrag" onClick={onClear}>
          Clear
        </button>
      )}
      <button type="button" className="todo-pill-open nodrag" aria-label="Open the list" title="Open the list" onClick={onOpen}>
        <Maximize2 aria-hidden />
      </button>
    </div>
  );
}
