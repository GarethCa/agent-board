// What a memory card shows, worked out from its data and entries: kept apart from React, so it is tested on its own.
import { MEMORY_OLD_DAYS, type MemoryData, type MemoryEntry, type StepsWho } from '@agent-board/daemon/protocol';

/** How many entries the open card lists; the peek lists every one. */
export const CARD_ROWS = 4;

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

/** Those of `entries` whose key or text (a file's start) holds every word of `search`, any case. */
export function matching(entries: readonly MemoryEntry[], search: string): MemoryEntry[] {
  const words = search.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = `${entry.key ?? ''} ${entry.file ? entry.text.slice(0, FILE_SHOWN) : entry.text}`.toLowerCase();
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

/** Whether an entry has gone untouched long enough to read as old. */
export function isOld(entry: MemoryEntry, now: Date): boolean {
  return now.getTime() - new Date(entry.updatedAt).getTime() > MEMORY_OLD_DAYS * DAY;
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
