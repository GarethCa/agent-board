// A memory full screen: every document and fact in a list, searchable and filtered, beside the one picked, to read,
// write, pin, confirm or remove, with who changed it and when, and how many agents read it. It takes what to show and
// what to do as props, so the gallery draws it as the board does.
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Bold, Brain, Code, FileText, Heading, Italic, Link, List, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react';
import { MAX_MEMORY_FILE_BYTES, MAX_MEMORY_KEY, MAX_MEMORY_VALUE, type HistoryVersion, type MemoryChange, type MemoryEntry, type MemoryView } from '@agent-board/daemon/protocol';
import { Button, ErrorText, IconButton, Kbd, Segmented, Select, Tabs } from '../../ui';
import { chordPressed, chordText, type Chord } from '../../keys/registry';
import { isTyping } from '../../keys/typing';
import { renderMarkdown } from './StickyNode';
import { ScopeChip } from './ListCardParts';
import { agoText, ageText, entryBytes, entryLine, entryName, isStale, lastReaderText, readersOf, readersText, sizeText, staleCount, whoText } from './memory-card';
import {
  docBlocks,
  draftOf,
  editFor,
  escapeStays,
  factDraftError,
  historyLines,
  incoming,
  insertMarkdown,
  NO_FILTER,
  onLeave,
  shownEntries,
  tabCounts,
  titleError,
  writers,
  type Base,
  type Draft,
  type FullFilter,
  type FullTab,
  type MarkdownMark,
} from './memory-full';

/** How long after the last key a draft saves itself. */
const SAVE_AFTER_MS = 800;
/** The editor's keys: ⌘ on macOS, Ctrl elsewhere. */
const SAVE: Chord = { mod: 'command', key: 's', text: 'S' };
const BOLD: Chord = { mod: 'command', key: 'b', text: 'B' };
const ITALIC: Chord = { mod: 'command', key: 'i', text: 'I' };
const ADD: Chord = { mod: 'command', key: 'Enter', text: '↵' };

/** What a change gives back: the entry as it is now, null if it went, or false if it failed (and said so). */
export type ChangeMemory = (change: MemoryChange) => Promise<MemoryEntry | null | false>;

export interface MemoryFullProps {
  title: string;
  scope: string;
  zoneColor?: string;
  /** Its entries, in list order. */
  entries: readonly MemoryEntry[];
  /** Who read it and each entry: none until read. */
  readers?: MemoryView['readers'];
  now: Date;
  onChange: ChangeMemory;
  /** An entry's versions, newest first. */
  history(entry: string): Promise<HistoryVersion<MemoryEntry>[]>;
  /** Removes an entry; the board offers Undo. */
  onRemove(entry: MemoryEntry): void;
  /** The entry being written went (an agent removed it): the user's draft, so it isn't lost. */
  onGone?(entry: MemoryEntry, draft: string): void;
  /** A draft that couldn't be kept as it closed (it fails its checks, waits on a change made meanwhile, or is new). */
  onUnsaved?(unsaved: Unsaved): void;
  onClose(): void;
  openLink(url: string): void;
  /** Drawn open in place, not over the page: for the gallery. */
  inline?: boolean;
  /** Where it starts, for the gallery: the entry picked, a document open to write, and the list's filter. */
  initial?: { selected?: string; editing?: boolean; filter?: Partial<FullFilter> };
}

/** A draft offered back: its entry's name, its text, and the change that saves it, when it can be saved as it is. */
export interface Unsaved {
  name: string;
  text: string;
  change?: MemoryChange;
}

/** A memory full screen, over the board: Esc, the close button or a click outside closes it, and a draft saves first. */
export function MemoryFull(props: MemoryFullProps) {
  const { inline = false, onClose } = props;
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  if (inline)
    return (
      <RadixDialog.Root open modal={false}>
        <FullBody {...props} />
      </RadixDialog.Root>
    );
  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-scrim" />
        <RadixDialog.Content
          asChild
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            // The entry shown, in the list, so ↑↓ move at once; with none, the search. (One selector list would take
            // the search, which comes first on the page.)
            const root = event.target as HTMLElement | null;
            (root?.querySelector<HTMLElement>('.memory-full-item[aria-current="true"]') ?? root?.querySelector<HTMLElement>('.memory-full-search input'))?.focus();
          }}
          // Esc in a search with text clears it, and in a new entry cancels it: not the whole view.
          onEscapeKeyDown={(event) => escapeStays(document.activeElement) && event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener?.isConnected) opener.focus({ preventScroll: true });
          }}
          onInteractOutside={(event) => event.target instanceof Element && event.target.closest('.ui-toasts') !== null && event.preventDefault()}
        >
          <FullBody {...props} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

type Adding = 'fact' | 'doc';

/** What the dialog's content puts on the card it wraps: its ref, for the focus trap, and its own attributes and keys. */
type Frame = Omit<HTMLAttributes<HTMLDivElement>, keyof MemoryFullProps> & { ref?: Ref<HTMLDivElement> };

function FullBody({ title, scope, zoneColor, entries, readers, now, onChange, history, onRemove, onGone, onUnsaved, onClose, openLink, inline = false, initial, ...frame }: MemoryFullProps & Frame) {
  const [filter, setFilter] = useState<FullFilter>({ ...NO_FILTER, ...initial?.filter });
  const [picked, setPicked] = useState(initial?.selected);
  const [adding, setAdding] = useState<Adding>();
  const [editFirst, setEditFirst] = useState(initial?.editing === true ? initial.selected : undefined);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // The entry last shown, so one removed under the user can still say so.
  const seen = useRef(new Map<string, MemoryEntry>());
  for (const entry of entries) seen.current.set(entry.id, entry);

  const shown = shownEntries(entries, filter, now);
  const grouped = filter.tab === 'all';
  const ordered = grouped ? [...shown.filter((entry) => entry.file), ...shown.filter((entry) => !entry.file)] : shown;
  const live = picked === undefined ? undefined : entries.find((entry) => entry.id === picked);
  const current = adding !== undefined ? undefined : picked === undefined ? ordered[0] : (live ?? seen.current.get(picked));
  // The entry shown stays picked as the list's filter changes, and as the user writes in it.
  useEffect(() => {
    if (picked === undefined && adding === undefined && current !== undefined) setPicked(current.id);
  }, [picked, adding, current]);
  const counts = tabCounts(entries);
  const stale = staleCount(entries, now);
  const pinned = entries.filter((entry) => entry.pinned).length;
  const names = writers(entries);
  const set = (change: Partial<FullFilter>) => setFilter((was) => ({ ...was, ...change }));
  const pick = (id: string | undefined) => (setAdding(undefined), setPicked(id));

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '/' && !isTyping(event) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      search.current?.focus();
    }
  };
  const listKeys = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = ordered.findIndex((entry) => entry.id === current?.id);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next === undefined) return;
    pick(next.id);
    list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next.id)}"]`)?.focus();
  };
  const added = (entry: MemoryEntry, doc: boolean) => {
    setAdding(undefined);
    setFilter((was) => ({ ...was, search: '', tab: was.tab === 'history' || was.tab === (doc ? 'facts' : 'docs') ? 'all' : was.tab }));
    setPicked(entry.id);
    if (doc) setEditFirst(entry.id);
  };

  // A document's row ends with how many agents read it, as the card's foot does for the memory.
  const readCount = (id: string) => {
    const count = readersOf(readers?.entries, id).count;
    return count === 0 ? '' : ` · read by ${count}`;
  };
  const item = (entry: MemoryEntry) => (
    <li key={entry.id}>
      <button
        type="button"
        className="memory-full-item"
        data-row={entry.id}
        data-stale={isStale(entry, now) || undefined}
        aria-current={entry.id === current?.id || undefined}
        tabIndex={entry.id === current?.id ? 0 : -1}
        onClick={() => pick(entry.id)}
      >
        <span className="memory-full-item-name">
          {entry.file ? <FileText aria-label="Document" /> : entry.pinned ? <Pin aria-label="Pinned" /> : <Brain aria-hidden="true" />}
          <b>{entryName(entry)}</b>
        </span>
        <span className="memory-full-item-sub">
          {filter.tab === 'history'
            ? `${whoText(entry.changedBy)} · ${agoText(entry.updatedAt, now)}`
            : entry.file
              ? `${whoText(entry.changedBy)} · ${isStale(entry, now) ? 'stale' : ageText(entry.updatedAt, now)} · ${sizeText(entryBytes(entry))}${readCount(entry.id)}`
              : entryLine(entry)}
        </span>
      </button>
    </li>
  );
  const group = (label: string, rows: MemoryEntry[]) =>
    rows.length === 0 ? null : (
      <>
        <li className="memory-full-group" aria-hidden="true">
          {label}
        </li>
        {rows.map(item)}
      </>
    );

  return (
    <div
      {...frame}
      className="ui-card memory-full"
      role="dialog"
      aria-label={`${title}: full screen`}
      data-inline={inline || undefined}
      data-testid="memory-full"
      onKeyDown={(event) => {
        keys(event);
        frame.onKeyDown?.(event);
      }}
    >
      <div className="memory-full-head">
        <span className="memory-full-face" aria-hidden="true">
          <Brain />
        </span>
        <RadixDialog.Title className="memory-full-title">{title}</RadixDialog.Title>
        <ScopeChip scope={scope} zoneColor={zoneColor} />
        <Tabs<FullTab>
          className="memory-full-tabs"
          aria-label="Show"
          value={filter.tab}
          onChange={(tab) => set({ tab })}
          tabs={[
            { id: 'all', label: 'All', count: counts.all },
            { id: 'docs', label: 'Docs', count: counts.docs },
            { id: 'facts', label: 'Facts', count: counts.facts },
            { id: 'history', label: 'History' },
          ]}
        />
        {inline ? (
          <IconButton icon={<X />} size="sm" aria-label="Close" onClick={onClose} />
        ) : (
          <RadixDialog.Close asChild>
            <IconButton icon={<X />} size="sm" aria-label="Close" tooltip="Close · esc" />
          </RadixDialog.Close>
        )}
      </div>
      <div className="memory-full-bar">
        <label className="listcard-search memory-full-search">
          <Search className="listcard-search-mark" aria-hidden="true" />
          <input
            ref={search}
            className="listcard-search-input"
            value={filter.search}
            placeholder="Search facts and documents"
            aria-label="Search facts and documents"
            onChange={(event) => set({ search: event.target.value })}
            onKeyDown={(event) => event.key === 'Escape' && filter.search !== '' && (event.preventDefault(), event.stopPropagation(), set({ search: '' }))}
          />
          <Kbd>/</Kbd>
        </label>
        <button type="button" className="memory-full-chip" aria-pressed={filter.pinned} disabled={pinned === 0 && !filter.pinned} onClick={() => set({ pinned: !filter.pinned })}>
          <Pin aria-hidden="true" /> Pinned {pinned}
        </button>
        <button type="button" className="memory-full-chip" data-tone="warn" aria-pressed={filter.stale} disabled={stale === 0 && !filter.stale} onClick={() => set({ stale: !filter.stale })}>
          Stale {stale}
        </button>
        <Select size="sm" aria-label="Written by" value={filter.by ?? ''} onChange={(event) => set({ by: event.target.value === '' ? null : event.target.value })}>
          <option value="">By anyone</option>
          {names.map((name) => (
            <option key={name} value={name}>
              By {name}
            </option>
          ))}
        </Select>
        <span className="memory-full-bar-end">
          <Button size="sm" icon={<Plus />} onClick={() => setAdding('fact')}>
            Fact
          </Button>
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding('doc')}>
            Document
          </Button>
        </span>
      </div>
      <div className="memory-full-body">
        <ul ref={list} className="memory-full-list" aria-label="Entries" onKeyDown={listKeys}>
          {grouped ? (
            <>
              {group('Docs', ordered.filter((entry) => entry.file))}
              {group('Facts', ordered.filter((entry) => !entry.file))}
            </>
          ) : (
            ordered.map(item)
          )}
          {ordered.length === 0 && <li className="memory-full-none">{entries.length === 0 ? 'Nothing remembered yet' : filter.search === '' ? 'Nothing here' : `Nothing matches “${filter.search}”`}</li>}
        </ul>
        <div className="memory-full-detail">
          {adding !== undefined ? (
            <NewEntry kind={adding} entries={entries} onChange={onChange} onAdded={added} onCancel={() => setAdding(undefined)} onUnsaved={onUnsaved} />
          ) : current === undefined ? (
            <div className="memory-full-empty">
              <b>{entries.length === 0 ? 'Nothing remembered yet' : 'Pick an entry'}</b>
              <span>Facts are short: a command, a version, a rule. Documents are longer: a guide, a checklist, notes on how the code works. Agents read and write both.</span>
            </div>
          ) : (
            <EntryDetail
              key={current.id}
              entry={current}
              gone={live === undefined && picked !== undefined}
              entries={entries}
              readers={readers}
              now={now}
              editing={editFirst === current.id}
              onChange={onChange}
              history={history}
              onRemove={(entry) => (pick(ordered.find((each) => each.id !== entry.id)?.id), onRemove(entry))}
              onGone={(entry, draft) => (pick(undefined), draft === undefined || onGone?.(entry, draft))}
              onUnsaved={onUnsaved}
              openLink={openLink}
            />
          )}
        </div>
      </div>
    </div>
  );
}

type Saving = { state: 'saved'; at?: string } | { state: 'saving' } | { state: 'failed' };

interface EntryDetailProps {
  entry: MemoryEntry;
  /** It went while shown. */
  gone: boolean;
  entries: readonly MemoryEntry[];
  readers?: MemoryView['readers'];
  now: Date;
  /** A document opens to write, not to read. */
  editing: boolean;
  onChange: ChangeMemory;
  history(entry: string): Promise<HistoryVersion<MemoryEntry>[]>;
  onRemove(entry: MemoryEntry): void;
  /** It went: with the user's draft, if there was one. */
  onGone(entry: MemoryEntry, draft: string | undefined): void;
  onUnsaved?(unsaved: Unsaved): void;
  openLink(url: string): void;
}

/**
 * The entry picked: a document to read or write, a fact to change. A draft saves itself a moment after the last key,
 * and as it closes; one that can't be saved then is offered back. If an agent changes the entry while the user has a
 * draft, the draft waits for the user to keep it or take theirs.
 */
function EntryDetail({ entry, gone, entries, readers, now, editing: editFirst, onChange, history, onRemove, onGone, onUnsaved, openLink }: EntryDetailProps) {
  const [base, setBase] = useState<Base>({ ...draftOf(entry), updatedAt: entry.updatedAt });
  const [draft, setDraft] = useState(() => draftOf(entry));
  const [theirs, setTheirs] = useState<MemoryEntry>();
  const [saving, setSaving] = useState<Saving>({ state: 'saved' });
  const [mode, setMode] = useState<'preview' | 'editing'>(editFirst || !entry.file ? 'editing' : 'preview');
  const [versions, setVersions] = useState<HistoryVersion<MemoryEntry>[]>();
  const text = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number }>(undefined);
  const inFlight = useRef(false);
  const sent = useRef<Draft>(undefined);
  const leaving = useRef(false);
  const told = useRef(false);

  const dirty = editFor(draft, base, entry.file) !== undefined;
  const error = entry.file ? docError(draft, entries, entry.id) : (factDraftError(draft.key, draft.text, MAX_MEMORY_KEY, MAX_MEMORY_VALUE) ?? keyTaken(draft.key, entries, entry.id));
  const save = async () => {
    const edit = editFor(draft, base, entry.file);
    if (edit === undefined || error !== undefined || theirs !== undefined || inFlight.current || gone) return;
    inFlight.current = true;
    sent.current = draft;
    setSaving({ state: 'saving' });
    const result = await onChange({ action: 'edit', entry: entry.id, ...edit });
    inFlight.current = false;
    if (result === false || result === null) return setSaving({ state: 'failed' });
    setBase({ ...draftOf(result), updatedAt: result.updatedAt });
    setSaving({ state: 'saved', at: result.updatedAt });
  };
  // As it closes: the draft saved, or offered back when it can't be; nothing when it went or is being removed.
  const leave = () => {
    const what = onLeave(draft, base, { file: entry.file, error: error !== undefined, held: theirs !== undefined, removing: leaving.current });
    if (what === 'none' || (inFlight.current && sent.current !== undefined && editFor(draft, sent.current, entry.file) === undefined)) return;
    const edit = editFor(draft, theirs === undefined ? base : draftOf(theirs), entry.file);
    const change: MemoryChange | undefined = edit === undefined || error !== undefined ? undefined : { action: 'edit', entry: entry.id, ...edit };
    const offer = () => onUnsaved?.({ name: entryName(entry), text: draft.text, ...(change === undefined ? {} : { change }) });
    if (what === 'save' && change !== undefined) void onChange(change).then((result) => result === false && offer());
    else offer();
  };
  const latest = useRef({ save, leave });
  latest.current = { save, leave };

  // Saves a moment after the last key; and as it closes.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void latest.current.save(), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty]);
  useEffect(() => () => latest.current.leave(), []);

  // A newer entry than the draft began from: an agent's write, a Put back, a pin (see `incoming`).
  useEffect(() => {
    const what = incoming(entry, base, draft, inFlight.current);
    if (what === 'rebase') setBase((was) => ({ ...was, updatedAt: entry.updatedAt }));
    else if (what === 'take') {
      setBase({ ...draftOf(entry), updatedAt: entry.updatedAt });
      setDraft(draftOf(entry));
      setTheirs(undefined);
    } else if (what === 'hold') setTheirs(entry);
  }, [entry, base, draft]);

  // Gone while shown: the draft, if any, goes to the board to offer back.
  useEffect(() => {
    if (!gone || told.current) return;
    told.current = true;
    leaving.current = true;
    onGone(entry, dirty && draft.text.trim() !== '' ? draft.text : undefined);
  }, [gone, entry, dirty, draft, onGone]);

  useEffect(() => {
    let current = true;
    history(entry.id).then(
      (read) => current && setVersions(read),
      () => current && setVersions([]),
    );
    return () => {
      current = false;
    };
  }, [entry.id, entry.updatedAt, history]);

  // A Markdown button's selection, put back once its text is drawn.
  useLayoutEffect(() => {
    const at = selection.current;
    if (at === undefined || text.current === null) return;
    selection.current = undefined;
    text.current.focus();
    text.current.setSelectionRange(at.start, at.end);
  });
  const mark = (what: MarkdownMark) => {
    const field = text.current;
    if (field === null) return;
    const next = insertMarkdown({ text: draft.text, start: field.selectionStart, end: field.selectionEnd }, what);
    selection.current = { start: next.start, end: next.end };
    setDraft({ ...draft, text: next.text });
  };
  const fieldKeys = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (chordPressed(SAVE, event)) {
      event.preventDefault();
      void save();
    } else if (entry.file && (chordPressed(BOLD, event) || chordPressed(ITALIC, event))) {
      event.preventDefault();
      mark(chordPressed(BOLD, event) ? 'bold' : 'italic');
    }
  };

  const lines = versions === undefined ? [] : historyLines(versions);
  const entryReaders = readersOf(readers?.entries, entry.id);
  const lastReader = lastReaderText(entryReaders, now);
  const stale = isStale(entry, now);
  const status =
    theirs !== undefined ? 'Waiting for you'
    : error !== undefined && dirty ? 'Not saved'
    : saving.state === 'saving' ? 'Saving…'
    : saving.state === 'failed' ? 'Not saved: it will try again as you type'
    : dirty ? 'Editing…'
    : saving.at !== undefined ? `✓ Saved ${new Date(saving.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : undefined;

  return (
    <article className="memory-full-entry" aria-label={entryName(entry)}>
      <header className="memory-full-entry-head">
        {entry.file ? (
          <input className="memory-full-name" value={draft.key} aria-label="Title" maxLength={MAX_MEMORY_KEY} onChange={(event) => setDraft({ ...draft, key: event.target.value })} onKeyDown={fieldKeys} />
        ) : (
          <input
            className="memory-full-name"
            data-mono
            value={draft.key}
            placeholder="No key: a note"
            aria-label="Key"
            maxLength={MAX_MEMORY_KEY}
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
            onKeyDown={fieldKeys}
          />
        )}
        {stale && (
          <span className="memory-full-stale">
            Stale: 30 days unchanged
            <Button size="xs" variant="ghost" onClick={() => void onChange({ action: 'confirm', entry: entry.id })}>
              Still true
            </Button>
          </span>
        )}
        <span className="memory-full-entry-tools">
          {entry.file && (
            <Segmented<'preview' | 'editing'>
              aria-label="Show the document"
              value={mode}
              onChange={setMode}
              options={[
                { id: 'preview', label: 'Preview' },
                { id: 'editing', label: 'Edit' },
              ]}
            />
          )}
          <IconButton
            icon={entry.pinned ? <PinOff /> : <Pin />}
            size="sm"
            aria-label={entry.pinned ? 'Unpin' : 'Pin'}
            tooltip={entry.pinned ? 'Unpin' : 'Pin: agents get it as they start'}
            onClick={() => void onChange({ action: 'edit', entry: entry.id, pinned: !entry.pinned })}
          />
          <IconButton
            icon={<Trash2 />}
            size="sm"
            aria-label={`Remove ${entryName(entry)}`}
            tooltip="Remove; its history keeps it"
            onClick={() => {
              leaving.current = true;
              onRemove(entry);
            }}
          />
        </span>
      </header>
      {theirs !== undefined && (
        <div className="memory-full-conflict" role="status">
          <span>{whoText(theirs.changedBy)} changed it while you typed. Yours is not saved yet.</span>
          <Button
            size="xs"
            onClick={() => {
              setBase({ ...draftOf(theirs), updatedAt: theirs.updatedAt });
              setTheirs(undefined);
            }}
          >
            Keep mine
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setBase({ ...draftOf(theirs), updatedAt: theirs.updatedAt });
              setDraft(draftOf(theirs));
              setTheirs(undefined);
            }}
          >
            Take theirs
          </Button>
        </div>
      )}
      {entry.file && mode === 'editing' && (
        <div className="memory-full-toolbar" role="toolbar" aria-label="Markdown">
          {(
            [
              ['heading', <Heading key="h" />, 'Heading'],
              ['bold', <Bold key="b" />, `Bold · ${chordText(BOLD)}`],
              ['italic', <Italic key="i" />, `Italic · ${chordText(ITALIC)}`],
              ['bullet', <List key="l" />, 'Bullet list'],
              ['code', <Code key="c" />, 'Code'],
              ['link', <Link key="k" />, 'Link'],
            ] as const satisfies readonly (readonly [MarkdownMark, ReactNode, string])[]
          ).map(([what, icon, label]) => (
            <IconButton key={what} icon={icon} size="xs" aria-label={label.split(' · ')[0]!} tooltip={label} onMouseDown={(event) => event.preventDefault()} onClick={() => mark(what)} />
          ))}
          <span className="memory-full-status" aria-live="polite">
            {status}
          </span>
        </div>
      )}
      <div className="memory-full-text nowheel">
        {entry.file && mode === 'preview' ? (
          <DocPreview text={draft.text} openLink={openLink} />
        ) : (
          <textarea
            ref={text}
            className="memory-full-editor"
            data-mono={entry.file || undefined}
            value={draft.text}
            autoFocus={editFirst}
            aria-label={entry.file ? 'Document text' : 'Value'}
            spellCheck={entry.file}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            onKeyDown={fieldKeys}
          />
        )}
      </div>
      {error !== undefined && dirty && <ErrorText>{error}</ErrorText>}
      {!(entry.file && mode === 'editing') && status !== undefined && (
        <span className="memory-full-status" aria-live="polite">
          {status}
        </span>
      )}
      <section className="memory-full-who" aria-label="Who and when">
        <h3>Who and when</h3>
        <ol className="memory-full-timeline">
          {lines.map((line, index) => (
            <li key={line.version} data-now={index === 0 || undefined}>
              <span>
                <b>{line.who}</b> {line.what}
              </span>
              <time dateTime={line.at}>{agoText(line.at, now)}</time>
              {line.restorable && (
                <Button size="xs" variant="ghost" onClick={() => void onChange({ action: 'restore', entry: entry.id, version: line.version })}>
                  Put back
                </Button>
              )}
            </li>
          ))}
          {versions !== undefined && lines.length === 0 && (
            <li data-now>
              <span>
                <b>{whoText(entry.madeBy)}</b> wrote it
              </span>
              <time dateTime={entry.createdAt}>{agoText(entry.createdAt, now)}</time>
            </li>
          )}
        </ol>
        <p className="memory-full-readers">
          <b>{readersText(entryReaders)}</b>
          {lastReader !== undefined && ` · ${lastReader}`}
          {entry.file && ` · ${sizeText(entryBytes(entry))}`}
        </p>
      </section>
    </article>
  );
}

/** A document as drawn: its headings, its fenced code, and the rest as a note's Markdown. */
function DocPreview({ text, openLink }: { text: string; openLink(url: string): void }) {
  const blocks = docBlocks(text);
  if (blocks.length === 0) return <p className="memory-full-none">Nothing written yet</p>;
  return (
    <div className="memory-full-doc">
      {blocks.map((block, index): ReactNode => {
        if (block.type === 'heading') {
          const Tag = (['h2', 'h3', 'h4'] as const)[block.level - 1]!;
          return <Tag key={index}>{block.text}</Tag>;
        }
        if (block.type === 'code') return <pre key={index}>{block.text}</pre>;
        return <div key={index}>{renderMarkdown(block.text, openLink)}</div>;
      })}
    </div>
  );
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** What is wrong with a document as typed: its title, or no text, or too much. */
function docError(draft: Draft, entries: readonly MemoryEntry[], self?: string): string | undefined {
  return (
    titleError(draft.key, MAX_MEMORY_KEY, entries, self) ??
    (draft.text.trim() === '' ? 'A document needs some text'
    : bytes(draft.text) > MAX_MEMORY_FILE_BYTES ? `A document is at most ${sizeText(MAX_MEMORY_FILE_BYTES)}`
    : undefined)
  );
}

/** A fact's key another entry has: an add with it would write over that entry. */
function keyTaken(key: string, entries: readonly MemoryEntry[], self?: string): string | undefined {
  return key.trim() === '' ? undefined : titleError(key, MAX_MEMORY_KEY, entries, self);
}

interface NewEntryProps {
  kind: Adding;
  entries: readonly MemoryEntry[];
  onChange: ChangeMemory;
  onAdded(entry: MemoryEntry, doc: boolean): void;
  onCancel(): void;
  onUnsaved?(unsaved: Unsaved): void;
}

/**
 * A new fact or document: its key or title, and its text. ⌘↵ adds it. Closed any way but Add or Cancel (Esc, the
 * view closing), text typed is offered back.
 */
function NewEntry({ kind, entries, onChange, onAdded, onCancel, onUnsaved }: NewEntryProps) {
  const doc = kind === 'doc';
  const [draft, setDraft] = useState<Draft>({ key: '', text: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // Added, being added, or cancelled: nothing to offer back.
  const done = useRef(false);
  const error = doc ? docError(draft, entries) : (factDraftError(draft.key, draft.text, MAX_MEMORY_KEY, MAX_MEMORY_VALUE) ?? keyTaken(draft.key, entries));
  const key = draft.key.trim();
  const change: MemoryChange = { action: 'add', key: key === '' ? null : key, text: doc ? draft.text : draft.text.trim(), ...(doc ? { file: true } : {}) };
  const add = async () => {
    setTried(true);
    if (error !== undefined || busy) return;
    setBusy(true);
    done.current = true;
    const result = await onChange(change);
    setBusy(false);
    if (result !== false && result !== null) onAdded(result, doc);
    else done.current = false;
  };
  const offer = () => {
    if (done.current || draft.text.trim() === '') return;
    onUnsaved?.({ name: key === '' ? (doc ? 'Your new document' : 'Your new fact') : key, text: draft.text, ...(error === undefined ? { change } : {}) });
  };
  const latest = useRef(offer);
  latest.current = offer;
  useEffect(() => () => latest.current(), []);
  const cancel = () => {
    done.current = true;
    onCancel();
  };
  const keys = (event: KeyboardEvent) => {
    if (chordPressed(ADD, event)) {
      event.preventDefault();
      void add();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <form
      className="memory-full-entry memory-full-new"
      aria-label={doc ? 'New document' : 'New fact'}
      onKeyDown={keys}
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <h3>{doc ? 'New document' : 'New fact'}</h3>
      <input
        className="memory-full-name"
        data-mono={!doc || undefined}
        value={draft.key}
        autoFocus
        placeholder={doc ? 'Title: How we test' : 'Key, or none: test-cmd'}
        aria-label={doc ? 'Title' : 'Key'}
        maxLength={MAX_MEMORY_KEY}
        onChange={(event) => setDraft({ ...draft, key: event.target.value })}
      />
      <textarea
        className="memory-full-editor"
        data-mono={doc || undefined}
        value={draft.text}
        placeholder={doc ? 'Write it in Markdown: # headings, - lists, `code`' : 'What to remember: npm run test:unit'}
        aria-label={doc ? 'Document text' : 'Value'}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
      />
      {tried && error !== undefined && <ErrorText>{error}</ErrorText>}
      <span className="memory-full-new-foot">
        <span className="memory-full-status">{doc ? 'Agents see its title, and read it when they need it' : 'Agents read every fact'}</span>
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy}>
          Add <Kbd>{chordText(ADD)}</Kbd>
        </Button>
      </span>
    </form>
  );
}
