// Memories were removed from the board. Before the migration that drops them runs, the daemon writes every memory's
// entries to a dated Markdown file in its data folder, so nothing the user or an agent kept is lost, and once it is up
// it says where the file is, as a line on a to-do list of the user's own.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TODO_CARD_SIZE, type DaemonCall, type StepsWho, type TodoData } from './protocol.ts';

interface MemoryRow {
  id: string;
  data: string;
  zone: string | null;
  ticket: string | null;
}

interface EntryRow {
  key: string | null;
  is_file: number;
  text: string;
  pinned: number;
}

const USER: StepsWho = { kind: 'user' };

/** The migration that drops memories; the file is written just before it runs, at the schema it was written for. */
export const REMOVE_MEMORIES = 'remove_memories';

/** The board still holds memories' tables, so the migration that drops them is still to run. */
const keepsMemories = (db: DatabaseSync) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'").get() !== undefined;

/** A fence of backticks longer than any run of them in `text`, so the text reads back whole. */
const fenceFor = (text: string) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

const whoText = (who: unknown) => {
  const named = who as Partial<{ kind: string; name: string }> | undefined;
  return named?.kind === 'agent' && typeof named.name === 'string' ? named.name : 'you';
};

/** A memory's settings, or undefined when they aren't a JSON object, so its entries are still saved. */
function readData(text: string): { title?: unknown; madeBy?: unknown; noAgents?: unknown } | undefined {
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function memoryText(memory: MemoryRow, entries: readonly EntryRow[]): string {
  const data = readData(memory.data);
  const title = typeof data?.title === 'string' && data.title.trim() !== '' ? data.title : 'Memory';
  const where = memory.zone !== null ? `In the zone ${memory.zone}` : memory.ticket !== null ? "On a ticket's board" : 'On the board, outside any zone';
  const about =
    data === undefined
      ? `${where}. Its settings couldn't be read; as stored: ${JSON.stringify(memory.data)}.`
      : `${where}${data.noAgents === true ? ', set to No agents' : ''}. Made by ${whoText(data.madeBy)}.`;
  const lines = [`## ${title}`, '', about, ''];
  if (entries.length === 0) lines.push('No entries.', '');
  const facts = entries.filter((entry) => entry.is_file === 0);
  for (const entry of facts) {
    const head = entry.key === null ? '' : `**${entry.key}**${entry.pinned === 1 ? ' (pinned)' : ''}: `;
    lines.push(`- ${head}${entry.text.replaceAll('\n', '\n  ')}`);
  }
  if (facts.length > 0) lines.push('');
  for (const entry of entries.filter((each) => each.is_file === 1)) {
    const fence = fenceFor(entry.text);
    lines.push(`### ${entry.key ?? 'Document'}`, '', fence, entry.text, fence, '');
  }
  return lines.join('\n');
}

/**
 * Writes every memory on the board (title, where it was, who made it, and its entries: facts and notes, then documents
 * whole) to `removed-memories-<date>.md` in `dir`, never over a file already there, and returns its path. One that
 * already holds the same text (a start before this one wrote it, then failed) is used as it is. Undefined,
 * writing nothing, when the board holds no memory or has already dropped them. Throws if the file can't be written, so
 * the migration that drops them never runs before they are saved.
 */
export function saveRemovedMemories(db: DatabaseSync, dir: string, now: Date): string | undefined {
  if (!keepsMemories(db)) return undefined;
  const memories = db
    .prepare(
      `SELECT b.id, b.data, z.name AS zone, b.ticket FROM board_items b LEFT JOIN zones z ON z.id = b.zone_id
       WHERE b.kind = 'memory' ORDER BY b.created_at, b.z`,
    )
    .all() as unknown as MemoryRow[];
  if (memories.length === 0) return undefined;
  const entriesOf = db.prepare('SELECT key, is_file, text, pinned FROM memory_entries WHERE item_id = ? ORDER BY is_file, pinned DESC, created_at, id');
  const date = now.toISOString().slice(0, 10);
  const text = [
    '# Memories removed from agent-board',
    '',
    `agent-board no longer keeps memories. This is every memory it held on ${date}, as it removed them.`,
    '',
    ...memories.map((memory) => memoryText(memory, entriesOf.all(memory.id) as unknown as EntryRow[])),
  ].join('\n');
  for (let n = 1; ; n++) {
    const path = join(dir, `removed-memories-${date}${n === 1 ? '' : `-${n}`}.md`);
    try {
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (readFileSync(path, 'utf8') === text) return path;
    }
  }
}

/** Where the to-do list goes: right of every zone and loose item on the main board, level with the highest. */
function spotRightOfBoard(db: DatabaseSync): { x: number; y: number } {
  const { right, top } = db
    .prepare(
      `SELECT MAX(x + width) AS right, MIN(y) AS top FROM (
         SELECT x, y, width FROM zones UNION ALL SELECT x, y, width FROM board_items WHERE zone_id IS NULL AND ticket IS NULL)`,
    )
    .get() as { right: number | null; top: number | null };
  return right === null || top === null ? { x: 0, y: 0 } : { x: right + 80, y: top };
}

/** Tells the user, once, where their memories went: a to-do list of their own with that one line. */
export async function tellRemovedMemories(db: DatabaseSync, call: DaemonCall, path: string, now: Date): Promise<void> {
  const text = `Memories are no longer on the board. Everything they held is saved in ${path}: move what still matters into your repo's instructions, then tick this.`;
  const data: TodoData = { owner: USER, lines: [{ id: randomUUID(), text, by: USER, at: now.toISOString(), done: null }] };
  await call('item.create', { kind: 'todo', zoneId: null, ...spotRightOfBoard(db), ...TODO_CARD_SIZE, data: { ...data } });
}
