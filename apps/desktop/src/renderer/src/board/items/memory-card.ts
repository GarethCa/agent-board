// What a memory card shows, worked out from its data and entries: kept apart from React, so it is tested on its own.
import { MEMORY_OLD_DAYS, type MemoryData, type MemoryEntry, type MemoryReaders, type StepsWho } from '@agent-board/daemon/protocol';

const DAY = 24 * 60 * 60 * 1000;

/** A memory card's data as saved, with what an older card lacks filled in. */
export function memoryData(data: Record<string, unknown>): MemoryData {
  const saved = data as Partial<MemoryData>;
  return {
    title: typeof saved.title === 'string' && saved.title !== '' ? saved.title : 'Memory',
    madeBy: saved.madeBy ?? { kind: 'user' },
    noAgents: saved.noAgents === true,
    count: typeof saved.count === 'number' ? saved.count : 0,
    folded: saved.folded === true,
  };
}

/** A new memory the user makes, named after the zone it lands in. */
export function newMemoryData(zoneName?: string): MemoryData {
  return { title: zoneName === undefined ? 'Memory' : `${zoneName} memory`, madeBy: { kind: 'user' }, noAgents: false, count: 0 };
}

/** Who may use it, as its head's chip says: its zone's agents, every agent on the board, or only the user. */
export function scopeText(noAgents: boolean, zoneName: string | undefined): string {
  if (noAgents) return 'No agents';
  return zoneName === undefined ? 'Board' : `Zone · ${zoneName}`;
}

/** The order entries are listed in: pinned ones first, then the newest written. */
export function inListOrder(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

/** How much of a file the peek shows, and searches: its start, in characters, whatever its lines. */
const FILE_SHOWN = 4000;
const FILE_LINES = 40;

/** A file's first lines, cut short at `FILE_SHOWN` characters for one with a huge line (a lockfile, a bundle). */
export function filePreview(text: string): string {
  const lines = text.slice(0, FILE_SHOWN).split('\n').slice(0, FILE_LINES).join('\n');
  return lines.length < text.length ? `${lines}\n…` : lines;
}

/**
 * Those of `entries` whose key or text holds every word of `search`, any case: a document's start, or with `whole` all of
 * it.
 */
export function matching(entries: readonly MemoryEntry[], search: string, whole = false): MemoryEntry[] {
  const words = search.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = `${entry.key ?? ''} ${entry.file && !whole ? entry.text.slice(0, FILE_SHOWN) : entry.text}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** What an entry is called on a row: its key, its file's name, or "note" for a keyless one. */
export function entryName(entry: MemoryEntry): string {
  return entry.key ?? 'note';
}

/** An entry's value on one line: a file's first line that says something, else its text with its line breaks as spaces. */
export function entryLine(entry: MemoryEntry): string {
  if (entry.file) return entry.text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '(empty file)';
  return entry.text.replace(/\s+/g, ' ').trim();
}

/** Who wrote an entry last, as a row's corner says: "you", or the agent's name. */
export function whoText(who: StepsWho): string {
  return who.kind === 'user' ? 'you' : who.name;
}

/** When, as a row's corner says: the time today, the weekday this week, else the day and month. */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - at.getTime() < 6 * DAY) return at.toLocaleDateString('en-GB', { weekday: 'short' });
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Whether an entry has gone untouched (neither changed nor confirmed) long enough to read as stale. */
export function isStale(entry: MemoryEntry, now: Date): boolean {
  return now.getTime() - new Date(entry.updatedAt).getTime() > MEMORY_OLD_DAYS * DAY;
}

/** How many of `entries` are stale. */
export function staleCount(entries: readonly MemoryEntry[], now: Date): number {
  return entries.filter((entry) => isStale(entry, now)).length;
}

/**
 * What the open card lists, from entries in list order: its pinned facts first, so they show at its first size, then
 * its documents, then its other facts, every one. The card scrolls what its size doesn't show.
 */
export function cardSections(entries: readonly MemoryEntry[]): { pinned: MemoryEntry[]; docs: MemoryEntry[]; facts: MemoryEntry[] } {
  const facts = entries.filter((entry) => !entry.file);
  return { pinned: facts.filter((entry) => entry.pinned), docs: entries.filter((entry) => entry.file), facts: facts.filter((entry) => !entry.pinned) };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** How long ago, short, as a row's corner says: "now", "5 min", "2 h", "3 d", else the day and month. */
export function ageText(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ago = now.getTime() - at.getTime();
  if (ago < MINUTE) return 'now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h`;
  if (ago < MEMORY_OLD_DAYS * DAY) return `${Math.floor(ago / DAY)} d`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "just now", "5 min ago", or a date: for a sentence. */
export function agoText(iso: string, now: Date): string {
  const age = ageText(iso, now);
  return age === 'now' ? 'just now' : /\d (min|h|d)$/.test(age) ? `${age} ago` : age;
}

/** An entry's text in bytes of UTF-8: what an agent's listing says of a document's size. */
export function entryBytes(entry: MemoryEntry): number {
  return entry.listed?.bytes ?? new TextEncoder().encode(entry.text).length;
}

/** A size as a document's row says it: "640 B", "2.1 KB", "1.2 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const NO_READERS: MemoryReaders = { count: 0, last: null };

/** An entry's readers, from a memory's view: none if it has no row there. */
export function readersOf(readers: Record<string, MemoryReaders> | undefined, id: string): MemoryReaders {
  return readers?.[id] ?? NO_READERS;
}

/** Who read it, as a sentence: "Read by 9 agents", or "No agent has read it yet". */
export function readersText(readers: MemoryReaders): string {
  if (readers.count === 0) return 'No agent has read it yet';
  return `Read by ${readers.count} ${readers.count === 1 ? 'agent' : 'agents'}`;
}

/** Who read it last, and when: "last: impl-634, 3 min ago"; nothing if no one has. */
export function lastReaderText(readers: MemoryReaders, now: Date): string | undefined {
  return readers.last === null ? undefined : `last: ${readers.last.name}, ${agoText(readers.last.at, now)}`;
}

/** The foot's count: "No entries yet", "1 entry", "14 entries · 2 pinned". */
export function countText(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return 'No entries yet';
  const pinned = entries.filter((entry) => entry.pinned).length;
  const count = entries.length === 1 ? '1 entry' : `${entries.length} entries`;
  return pinned === 0 ? count : `${count} · ${pinned} pinned`;
}

/** The newest entry written since `seen` (an `updatedAt`), for the card to flash: an agent's write the user didn't watch. */
export function freshEntry(entries: readonly MemoryEntry[], seen: string | undefined): MemoryEntry | undefined {
  if (seen === undefined) return undefined;
  const newest = entries.reduce<MemoryEntry | undefined>((best, entry) => (best === undefined || entry.updatedAt > best.updatedAt ? entry : best), undefined);
  return newest !== undefined && newest.updatedAt > seen && newest.changedBy.kind === 'agent' ? newest : undefined;
}

/** The newest `updatedAt` of `entries`, or undefined for none. */
export function newestWrite(entries: readonly MemoryEntry[]): string | undefined {
  return entries.reduce<string | undefined>((best, entry) => (best === undefined || entry.updatedAt > best ? entry.updatedAt : best), undefined);
}
