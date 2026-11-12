// What a memory's full-screen view shows, worked out apart from React: its list's tabs and filters, the editor's
// Markdown buttons and drafts, a document's blocks as drawn, and an entry's history as lines of who did what.
import type { HistoryVersion, MemoryEntry } from '@agent-board/daemon/protocol';
import { inListOrder, isStale, matching, whoText } from './memory-card';

/** The list's tabs: every entry, the documents, the facts, or every entry by its latest change. */
export type FullTab = 'all' | 'docs' | 'facts' | 'history';

/** What the list shows: a tab, a search, the Pinned and Stale chips, and one writer ("you", or an agent's name). */
export interface FullFilter {
  tab: FullTab;
  search: string;
  pinned: boolean;
  stale: boolean;
  by: string | null;
}

export const NO_FILTER: FullFilter = { tab: 'all', search: '', pinned: false, stale: false, by: null };

/**
 * The entries the list shows, by `filter`: in list order (pinned first, then the newest), but on the History tab the
 * newest change first, whatever is pinned. A search reads a document's whole text.
 */
export function shownEntries(entries: readonly MemoryEntry[], filter: FullFilter, now: Date): MemoryEntry[] {
  const kept = matching(entries, filter.search, true).filter(
    (entry) =>
      (filter.tab !== 'docs' || entry.file) &&
      (filter.tab !== 'facts' || !entry.file) &&
      (!filter.pinned || entry.pinned) &&
      (!filter.stale || isStale(entry, now)) &&
      (filter.by === null || whoText(entry.changedBy) === filter.by),
  );
  return filter.tab === 'history' ? kept.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : inListOrder(kept);
}

/** The tabs' counts. */
export function tabCounts(entries: readonly MemoryEntry[]): { all: number; docs: number; facts: number } {
  const docs = entries.filter((entry) => entry.file).length;
  return { all: entries.length, docs, facts: entries.length - docs };
}

/** Who wrote its entries last, for the "By" menu: "you" first, then the agents by name. */
export function writers(entries: readonly MemoryEntry[]): string[] {
  const names = new Set(entries.map((entry) => whoText(entry.changedBy)));
  const agents = [...names].filter((name) => name !== 'you').toSorted((a, b) => a.localeCompare(b));
  return names.has('you') ? ['you', ...agents] : agents;
}

/** The editor's Markdown buttons. */
export type MarkdownMark = 'heading' | 'bold' | 'italic' | 'bullet' | 'code' | 'link';

/** A text and what is selected in it: `start` to `end`. */
export interface Edited {
  text: string;
  start: number;
  end: number;
}

/**
 * What a Markdown button makes of a text and its selection. Bold, italics, code and a link wrap the selection (a word
 * stands in for an empty one, selected after); a heading and a bullet mark each line it touches, or unmark them if all
 * are marked already. Code over more than one line is a fenced block.
 */
export function insertMarkdown({ text, start, end }: Edited, mark: MarkdownMark): Edited {
  if (mark === 'heading' || mark === 'bullet') return markLines({ text, start, end }, mark === 'heading' ? '## ' : '- ');
  const selected = text.slice(start, end);
  if (mark === 'code' && selected.includes('\n')) return wrap({ text, start, end }, '```\n', '\n```', 'code');
  const [before, after, stand]: readonly [string, string, string] = ({
    bold: ['**', '**', 'bold text'],
    italic: ['_', '_', 'italic text'],
    code: ['`', '`', 'code'],
    link: ['[', '](https://)', 'link text'],
  } as const)[mark];
  return wrap({ text, start, end }, before, after, stand);
}

function wrap({ text, start, end }: Edited, before: string, after: string, stand: string): Edited {
  const inner = start === end ? stand : text.slice(start, end);
  return { text: `${text.slice(0, start)}${before}${inner}${after}${text.slice(end)}`, start: start + before.length, end: start + before.length + inner.length };
}

function markLines({ text, start, end }: Edited, marker: string): Edited {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const close = text.indexOf('\n', Math.max(end - (end > start && text[end - 1] === '\n' ? 1 : 0), from));
  const to = close === -1 ? text.length : close;
  const lines = text.slice(from, to).split('\n');
  const unmark = lines.every((line) => line.startsWith(marker));
  const changed = lines.map((line) => (unmark ? line.slice(marker.length) : line.startsWith(marker) ? line : `${marker}${line}`)).join('\n');
  const shift = unmark ? -marker.length : marker.length;
  const first = lines[0]!.startsWith(marker) === unmark ? shift : 0;
  const at = Math.max(from, start + first);
  // A caret inside a marker taken away would land before the selection's start: it stays a caret there.
  return { text: `${text.slice(0, from)}${changed}${text.slice(to)}`, start: at, end: Math.max(at, end + changed.length - (to - from)) };
}

/** A document's text in the blocks the view draws: headings, fenced code, and the rest as a note's Markdown. */
export type DocBlock = { type: 'heading'; level: 1 | 2 | 3; text: string } | { type: 'code'; text: string } | { type: 'markdown'; text: string };

const HEADING = /^(#{1,3})\s+(.*)$/;
const FENCE = /^\s*```/;

export function docBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.some((line) => line.trim() !== '')) blocks.push({ type: 'markdown', text: lines.join('\n') });
    lines = [];
  };
  const source = text.split('\n');
  for (let at = 0; at < source.length; at++) {
    const line = source[at]!;
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!.trim() });
    } else if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      for (at++; at < source.length && !FENCE.test(source[at]!); at++) code.push(source[at]!);
      blocks.push({ type: 'code', text: code.join('\n') });
    } else lines.push(line);
  }
  flush();
  return blocks;
}

/** One line of an entry's "Who and when": who, what they did, when, and the version a Put back takes, if any. */
export interface HistoryLine {
  version: number;
  who: string;
  what: string;
  at: string;
  /** Put back takes it: a version with a value that differs from the newest one's. */
  restorable: boolean;
}

/** An entry's history, newest first, as lines: each change read against the version before it. */
export function historyLines(versions: readonly HistoryVersion<MemoryEntry>[]): HistoryLine[] {
  const newest = versions.find((version) => version.value !== null)?.value ?? null;
  return versions.map((version, index) => {
    const before = versions.slice(index + 1).find((older) => older.value !== null)?.value ?? null;
    const { value } = version;
    const restorable = value !== null && newest !== null && (value.text !== newest.text || value.key !== newest.key);
    return { version: version.version, who: whoText(version.by), what: whatChanged(version, before), at: version.at, restorable };
  });
}

function whatChanged({ action, value }: HistoryVersion<MemoryEntry>, before: MemoryEntry | null): string {
  if (action === 'confirm') return 'said it is still true';
  if (action === 'remove') return 'removed it';
  if (action === 'restore') return 'put back an earlier version';
  if (value === null || before === null || action === 'add') return before === null ? 'wrote it' : 'wrote it again';
  if (value.text !== before.text) return 'changed the text';
  if (value.key !== before.key) return value.file ? 'renamed it' : 'changed its key';
  if (value.pinned !== before.pinned) return value.pinned ? 'pinned it' : 'unpinned it';
  return 'changed it';
}

/** What is wrong with a fact as typed, if anything: its key (optional) one line, its value set and short enough. */
export function factDraftError(key: string, text: string, maxKey: number, maxText: number): string | undefined {
  if (text.trim() === '') return 'A fact needs a value';
  if (key.includes('\n') || key.length > maxKey) return `A key is one line of at most ${maxKey} characters`;
  if (text.trim().length > maxText) return `A fact is at most ${maxText} characters: keep a longer text as a document`;
  return undefined;
}

/** What is wrong with a document's title, if anything: one line, set, at most `max` long, and not another entry's. */
export function titleError(title: string, max: number, others: readonly MemoryEntry[], self?: string): string | undefined {
  const trimmed = title.trim();
  if (trimmed === '' || trimmed.includes('\n') || trimmed.length > max) return `A title is one line of 1 to ${max} characters`;
  if (others.some((entry) => entry.id !== self && entry.key === trimmed)) return `This memory has “${trimmed}” already`;
  return undefined;
}

/** What the editor holds: a fact's key or a document's title (empty for none), and its text. */
export interface Draft {
  key: string;
  text: string;
}

/** The draft an entry starts. */
export const draftOf = (entry: MemoryEntry): Draft => ({ key: entry.key ?? '', text: entry.text });

/** What the draft changes in `base`, as the daemon would keep it: a fact's text and any key trimmed. None: nothing to send. */
export function editFor(draft: Draft, base: Draft, file: boolean): { text?: string; key?: string | null } | undefined {
  const text = file ? draft.text : draft.text.trim();
  const key = draft.key.trim();
  const edit = { ...(text === base.text ? {} : { text }), ...(key === base.key.trim() ? {} : { key: key === '' ? null : key }) };
  return Object.keys(edit).length === 0 ? undefined : edit;
}

/** The entry as the editor last had it from the daemon. */
export type Base = Draft & { updatedAt: string };

/**
 * What the editor does with the entry as it now is: nothing (no newer, or its own save still out); `rebase` for a
 * newer one that changes neither text nor name (a pin, a confirm), keeping the draft; `take` the newer one when the
 * draft changes nothing, or says the same; `hold` the draft behind a banner when they differ.
 */
export function incoming(entry: MemoryEntry, base: Base, draft: Draft, saving: boolean): 'none' | 'rebase' | 'take' | 'hold' {
  if (saving || entry.updatedAt <= base.updatedAt) return 'none';
  const theirs = draftOf(entry);
  if (editFor(theirs, base, entry.file) === undefined) return 'rebase';
  if (editFor(draft, base, entry.file) === undefined || editFor(draft, theirs, entry.file) === undefined) return 'take';
  return 'hold';
}

/**
 * What becomes of a draft as its editor closes: nothing when it changes nothing, or the entry is being removed or
 * went; `save` it; or, when it can't be (it doesn't pass its checks, or waits behind the banner), `offer` it back.
 */
export function onLeave(draft: Draft, base: Draft, { file, error, held, removing }: { file: boolean; error: boolean; held: boolean; removing: boolean }): 'none' | 'save' | 'offer' {
  if (removing || editFor(draft, base, file) === undefined) return 'none';
  return error || held ? 'offer' : 'save';
}

/** What has focus, as far as Esc asks: an element's place and, for a field, its value. */
export interface Focused {
  closest(selector: string): unknown;
  matches(selector: string): boolean;
  value?: string;
}

/** Whether Esc stays in the view: it clears a search with text, or cancels the new entry being written. */
export function escapeStays(focused: Focused | null): boolean {
  if (focused === null) return false;
  if (focused.closest('.memory-full-new') !== null) return true;
  return focused.matches('.memory-full-search input') && (focused.value ?? '') !== '';
}
