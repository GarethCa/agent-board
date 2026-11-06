// A memory's looks, apart from the board: the open card, the folded icon and the peek. They take what to show and what
// to do as props, so the gallery draws them as the board does.
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { Brain, FileText, Pin, PinOff, Search, Trash2 } from 'lucide-react';
import { entryFrom } from '@agent-board/daemon/memory-lines';
import { MAX_MEMORY_VALUE, type MemoryEntry } from '@agent-board/daemon/protocol';
import { IconButton } from '../../ui';
import { peekKeys, ScopeChip, ListCardAddBox, ListCardFace, ListCardIconView } from './ListCardParts';
import { CARD_ROWS, countText, entryLine, entryName, filePreview, isOld, matching, whenText, whoText } from './memory-card';

/** What the add box makes of what was typed: `key: value` (the key one word) is a keyed entry, anything else a note. */
export type AddEntry = (entry: { key: string | null; text: string }) => void;

const BRAIN = <Brain className="listcard-glyph" />;

/** The box at a card's foot, and the peek's: ↵ remembers what is typed, by the CLI's rule. */
function MemoryAddBox({ onAdd, autoFocus }: { onAdd: AddEntry; autoFocus?: boolean }) {
  return (
    <ListCardAddBox
      onAdd={(text) => onAdd(entryFrom(text))}
      placeholder="Remember something…"
      label="Remember something: key: value, or plain text"
      maxLength={MAX_MEMORY_VALUE}
      testId="memory-add"
      autoFocus={autoFocus}
    />
  );
}

/**
 * One entry on a row: its key (or "note", or the file's name), its value on one line, and when it was written: on the
 * card the time alone (who is its tooltip), in the peek who wrote it too.
 */
function EntryRow({ entry, now, who = false }: { entry: MemoryEntry; now: Date; who?: boolean }) {
  const when = isOld(entry, now) ? 'old' : whenText(entry.updatedAt, now);
  return (
    <>
      <span className="memory-key" data-note={entry.key === null || undefined} title={entryName(entry)}>
        {entry.file && <FileText className="memory-file-mark" aria-label="File" />}
        {entry.pinned && <Pin className="memory-pin-mark" aria-label="Pinned" />}
        <span className="memory-key-name">{entryName(entry)}</span>
      </span>
      <span className="listcard-value" title={entry.file ? undefined : entry.text}>
        {entryLine(entry)}
      </span>
      {who ? (
        <span className="listcard-who">
          <i className="listcard-who-mark" data-you={entry.changedBy.kind === 'user' || undefined} aria-hidden="true" />
          {whoText(entry.changedBy)} · {when}
        </span>
      ) : (
        <span className="listcard-who" title={`${whoText(entry.changedBy)} wrote it`}>
          {when}
        </span>
      )}
    </>
  );
}

interface MemoryCardViewProps {
  title: string;
  scope: string;
  /** Its zone's colour, for the scope chip's dot. */
  zoneColor?: string;
  /** Its entries, in list order: the card lists the first few. */
  entries: readonly MemoryEntry[];
  /** How many it holds: its saved count until its entries are read. */
  count?: number;
  /** Whether its entries are read yet: until then it says nothing of being empty. */
  loaded?: boolean;
  now: Date;
  onAdd: AddEntry;
  /** Opens the peek, with every entry. */
  onOpen(): void;
  /** The entry an agent just wrote, which flashes once. */
  fresh?: string;
  /** A memory just made opens with its add box focused. */
  focusAdd?: boolean;
  /** The board's toolbar over it, when it is drawn on the board. */
  children?: ReactNode;
}

/**
 * A memory open on the board (A): a raised card in the theme's neutrals, with the brain's face and count at its head's
 * left, its name and who may use it, the newest entries (pinned first) and a box to remember something.
 */
export function MemoryCardView({ title, scope, zoneColor, entries, count = entries.length, loaded = true, now, onAdd, onOpen, fresh, focusAdd, children }: MemoryCardViewProps) {
  const rows = entries.slice(0, CARD_ROWS);
  return (
    <div className="listcard listcard-unfolded" data-testid="memory-card" onDoubleClick={(event) => (event.stopPropagation(), onOpen())}>
      {children}
      <div className="listcard-head">
        <ListCardFace glyph={BRAIN} count={count} />
        <b className="listcard-title">{title}</b>
        <ScopeChip scope={scope} zoneColor={zoneColor} testId="memory-scope" />
      </div>
      {!loaded ? (
        <div className="listcard-rows" />
      ) : rows.length === 0 ? (
        <div className="listcard-empty">
          <b>Nothing remembered yet</b>
          <span>Type a note, or key: value. Agents read and write here with agent-board memory.</span>
        </div>
      ) : (
        <ul className="listcard-rows" aria-label="Newest entries">
          {rows.map((entry) => (
            <li key={entry.id} className="listcard-row" data-fresh={entry.id === fresh || undefined}>
              <EntryRow entry={entry} now={now} />
            </li>
          ))}
        </ul>
      )}
      <div className="listcard-foot">
        <MemoryAddBox onAdd={onAdd} autoFocus={focusAdd} />
        <span className="listcard-foot-line">
          <span>{countText(entries)}</span>
          <button type="button" className="listcard-open nodrag" onClick={onOpen}>
            Open ↗
          </button>
        </span>
      </div>
    </div>
  );
}

/** A memory folded (D): the brain on a big round face with its count, and its name under it. A click opens the peek. */
export function MemoryIconView(props: Omit<ComponentProps<typeof ListCardIconView>, 'glyph' | 'empty' | 'testId'>) {
  return <ListCardIconView glyph={BRAIN} empty="Empty · click to add" testId="memory-icon" {...props} />;
}

interface MemoryPeekProps {
  title: string;
  scope: string;
  zoneColor?: string;
  entries: readonly MemoryEntry[];
  now: Date;
  onAdd: AddEntry;
  onEdit(entry: MemoryEntry, text: string): void;
  onPin(entry: MemoryEntry, pinned: boolean): void;
  onRemove(entry: MemoryEntry): void;
  /** The entry being edited went (an agent removed it): the user's draft, so it isn't lost. */
  onGone?(entry: MemoryEntry, draft: string): void;
  /** The search to start on, for the gallery. */
  search?: string;
  /** Opens with the add box focused, else the search. */
  focusAdd?: boolean;
  /** Whether it takes the focus as it opens: not in the gallery. */
  autoFocus?: boolean;
}

/**
 * Every entry of a memory, searchable, over the board: a click on a value edits it (↵ saves, esc puts it back), a
 * file's opens its first lines. Each row pins or removes; the box at its foot remembers something new. Keys: / searches,
 * ↑ and ↓ move between rows, E (or ↵) edits the row, ⌫ removes it.
 */
export function MemoryPeek({ title, scope, zoneColor, entries, now, onAdd, onEdit, onPin, onRemove, onGone, search: initial = '', focusAdd = false, autoFocus = true }: MemoryPeekProps) {
  const [search, setSearch] = useState(initial);
  // The entry as it was when its edit began: an agent's write since shows on the row.
  const [editing, setEditing] = useState<{ entry: MemoryEntry; text: string }>();
  const [opened, setOpened] = useState<string>();
  const searchField = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  const shown = matching(entries, search);
  const save = (entry: MemoryEntry) => {
    const text = editing?.text.trim() ?? '';
    if (text !== '' && text !== entry.text) onEdit(entry, text);
    setEditing(undefined);
  };
  // Removed while it was being edited: the draft goes to the board to offer back, and the edit ends.
  useEffect(() => {
    if (editing === undefined || entries.some((entry) => entry.id === editing.entry.id)) return;
    onGone?.(editing.entry, editing.text);
    setEditing(undefined);
  }, [entries, editing, onGone]);
  const startEditing = (entry: MemoryEntry) => (entry.file ? setOpened(opened === entry.id ? undefined : entry.id) : setEditing({ entry, text: entry.text }));
  const rowKeys = peekKeys({ list: rows, search: searchField, row: (id) => shown.find((each) => each.id === id), onEdit: startEditing, onRemove });
  const editKeys = (entry: MemoryEntry) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save(entry);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(undefined);
    }
  };
  return (
    <div className="listcard-peek" data-testid="memory-peek" onKeyDown={rowKeys}>
      <div className="listcard-peek-head">
        <b className="listcard-title">{title}</b>
        <ScopeChip scope={scope} zoneColor={zoneColor} />
      </div>
      <label className="listcard-search">
        <Search className="listcard-search-mark" aria-hidden="true" />
        <input
          ref={searchField}
          className="listcard-search-input"
          value={search}
          autoFocus={autoFocus && !focusAdd}
          placeholder={entries.length === 0 ? 'Nothing to search yet' : `Search ${countText(entries).split(' · ')[0]}`}
          aria-label="Search entries"
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <ul ref={rows} className="listcard-peek-rows nowheel" aria-label="Entries">
        {shown.map((entry) => (
          <li key={entry.id} className="listcard-peek-row" data-editing={editing?.entry.id === entry.id || undefined}>
            {editing?.entry.id === entry.id ? (
              <>
                <span className="memory-key">{entryName(entry)}</span>
                <textarea
                  className="listcard-edit"
                  value={editing.text}
                  maxLength={MAX_MEMORY_VALUE}
                  autoFocus
                  aria-label={`Edit ${entryName(entry)}`}
                  onChange={(event) => setEditing({ entry: editing.entry, text: event.target.value })}
                  onKeyDown={editKeys(entry)}
                  onBlur={() => save(entry)}
                />
                {entry.updatedAt === editing.entry.updatedAt ? (
                  <span className="listcard-who">↵ saves · esc</span>
                ) : (
                  <span className="listcard-who listcard-changed" title={entry.text}>
                    {whoText(entry.changedBy)} changed it: ↵ replaces
                  </span>
                )}
              </>
            ) : (
              <button
                type="button"
                className="listcard-peek-entry"
                data-row={entry.id}
                aria-label={entry.file ? `Show ${entryName(entry)}` : `Edit ${entryName(entry)}`}
                onClick={() => startEditing(entry)}
              >
                <EntryRow entry={entry} now={now} who />
              </button>
            )}
            <span className="listcard-row-actions">
              <IconButton
                icon={entry.pinned ? <PinOff /> : <Pin />}
                size="sm"
                aria-label={entry.pinned ? `Unpin ${entryName(entry)}` : `Pin ${entryName(entry)}`}
                tooltip={entry.pinned ? 'Unpin' : 'Pin to the top'}
                onClick={() => onPin(entry, !entry.pinned)}
              />
              <IconButton icon={<Trash2 />} size="sm" aria-label={`Remove ${entryName(entry)}`} tooltip="Remove; its history keeps it" onClick={() => onRemove(entry)} />
            </span>
            {entry.file && opened === entry.id && <pre className="memory-file-text">{filePreview(entry.text)}</pre>}
          </li>
        ))}
        {shown.length === 0 && <li className="listcard-peek-none">{entries.length === 0 ? 'Nothing remembered yet' : `Nothing matches “${search}”`}</li>}
      </ul>
      <div className="listcard-peek-foot">
        <MemoryAddBox onAdd={onAdd} autoFocus={autoFocus && focusAdd} />
        <span className="listcard-peek-hint">key: value, or plain text · / searches, ↑↓ move, E edits, ⌫ removes</span>
      </div>
    </div>
  );
}
