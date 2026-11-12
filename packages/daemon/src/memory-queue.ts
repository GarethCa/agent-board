// Memories and queues: two board item kinds whose contents sit in their own tables beside the item (ADR-0005), read and
// written by agents through the board methods and by the user through their own. A memory holds keyed values, keyless
// notes and whole files; a queue holds jobs, which agents take, drop back and finish, and plain notes. Their scope is
// where they sit, as a steps card's is (`item-scope.ts`), unless set to No agents. Anyone in scope changes anything in
// them, whoever wrote it: every change is kept as a version, and a version can be put back.
//
// Nothing here types at any agent. A take is a lease the taker's session holds: as that session ends (not for a
// restart, nor hibernation), its jobs go back to the front of their queue, each drop counted.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, connectionAgent, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { readsItem, type ReachesZone } from './item-scope.ts';
import { isObject } from './json.ts';
import { AGENT_TILE_SIZE, freeSpotFor } from './board-layout.ts';
import { cutText } from './text-cut.ts';
import { jobBrief } from './memory-lines.ts';
import type { Answered } from './deliveries.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import { invalidParams, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  MAX_HISTORY_VERSIONS,
  MAX_JOB_LINK,
  MAX_JOB_TEXT,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_FILE_BYTES,
  MAX_MEMORY_KEY,
  MAX_MEMORY_VALUE,
  MAX_PLAN_TITLE_LENGTH,
  MAX_QUEUE_OPEN,
  MEMORY_CARD_SIZE,
  QUEUE_AUDIENCES,
  QUEUE_CARD_SIZE,
  QUEUE_ROW_KINDS,
  type Agent,
  type BoardItem,
  type BoardPlace,
  type DaemonMethods,
  type HistoryVersion,
  type MemoryChange,
  type MemoryData,
  type MemoryEntry,
  type MemoryReaders,
  type MemoryView,
  type QueueAudience,
  type QueueChange,
  type QueueData,
  type QueueJob,
  type QueueJobChange,
  type QueueDrain,
  isFreshAgent,
  MAX_DRAIN_AGENTS,
  MAX_DRAIN_DROPS,
  takesHandOn,
  type StepsWho,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { AgentHost } from './agents.ts';

type MemoryQueueMethods = Pick<
  DaemonMethods,
  | 'board.newMemory'
  | 'board.listMemories'
  | 'board.readMemory'
  | 'board.changeMemory'
  | 'board.memoryHistory'
  | 'board.newQueue'
  | 'board.listQueues'
  | 'board.readQueue'
  | 'board.changeQueue'
  | 'board.queueHistory'
  | 'board.drainQueue'
  | 'memory.read'
  | 'memory.change'
  | 'memory.history'
  | 'queue.read'
  | 'queue.change'
  | 'queue.history'
  | 'queue.hand'
  | 'queue.taken'
>;

export interface MemoryQueueHostOptions extends BoardCallerSources {
  agents: Pick<AgentHost, 'get' | 'fallbackOwner' | 'answer' | 'clearUnsent' | 'spawn' | 'delete' | 'stop'>;
  log?: (message: string) => void;
  db: DatabaseSync;
  /** The daemon's own methods: the cards are board items, made and changed through them. */
  call: DaemonCall;
  /** Where a new card of the agent's goes: beside its tile. */
  place(sessionId: string, size: { width: number; height: number }): Promise<BoardPlace | undefined>;
  reachesZone: ReachesZone;
  now?: () => Date;
}

/** File versions are big: fewer of them are kept. */
const MAX_FILE_VERSIONS = 5;
/**
 * The most a memory's or queue's history holds, its versions' values in bytes: past it, the oldest versions go, those
 * of rows removed since first.
 */
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

/** A drained agent's terminal, as a clock's fresh agent's. */
const DRAIN_SIZE = { cols: 120, rows: 40 };
/** How far below the queue its drained agents start. */
const DRAIN_GAP = 24;
/** The most characters of a job's first line a drained agent's name takes. */
const MAX_DRAIN_NAME = 32;
/** A queue's ref, as the CLI reads it: unique where its title may not be, and safe in a shell line. */
const itemRef = (item: BoardItem) => `item:${item.id}`;


const USER: StepsWho = { kind: 'user' };
const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);
const agentWho = (agent: Pick<Agent, 'sessionId' | 'name'>): StepsWho => ({ kind: 'agent', sessionId: agent.sessionId, name: agent.name });
const sameWho = (a: StepsWho | null, b: StepsWho) => a !== null && a.kind === b.kind && (a.kind === 'user' || (b.kind === 'agent' && a.sessionId === b.sessionId));
const whoName = (who: StepsWho) => (who.kind === 'user' ? 'the user' : who.name);
const isWho = (who: unknown) => isObject(who) && (who.kind === 'user' || (who.kind === 'agent' && typeof who.sessionId === 'string' && typeof who.name === 'string'));
const bytes = (text: string) => Buffer.byteLength(text);

function checkCommon(what: string, data: Record<string, unknown>): void {
  const fail = (problem: string) => invalidParams(`${what}'s ${problem}`);
  if (typeof data.title !== 'string' || data.title.trim() === '' || data.title.length > MAX_PLAN_TITLE_LENGTH) throw fail(`title must be 1 to ${MAX_PLAN_TITLE_LENGTH} characters`);
  if (!isWho(data.madeBy)) throw fail("madeBy must be { kind: 'user' } or { kind: 'agent', sessionId, name }");
  if (typeof data.noAgents !== 'boolean') throw fail('noAgents must be true or false');
  if (data.folded !== undefined && typeof data.folded !== 'boolean') throw fail('folded must be true or false');
  if (!Number.isInteger(data.count) || (data.count as number) < 0) throw fail('count must be a whole number');
}

/** A memory card's data as stored, checked: throws `invalidParams` for one it can't hold. */
export function checkMemoryData(data: Record<string, unknown>): void {
  checkCommon('a memory', data);
}

/** A queue card's data as stored, checked. */
export function checkQueueData(data: Record<string, unknown>): void {
  checkCommon('a queue', data);
  if (!(QUEUE_AUDIENCES as readonly unknown[]).includes(data.audience)) throw invalidParams(`a queue's audience must be one of ${QUEUE_AUDIENCES.join(', ')}`);
  const drain = data.drain;
  if (drain === undefined) return;
  const ok =
    isFreshAgent(drain) &&
    typeof (drain as unknown as QueueDrain).on === 'boolean' &&
    Number.isInteger((drain as unknown as QueueDrain).most) &&
    (drain as unknown as QueueDrain).most >= 1 &&
    (drain as unknown as QueueDrain).most <= MAX_DRAIN_AGENTS &&
    Array.isArray((drain as unknown as QueueDrain).started) &&
    (drain as unknown as QueueDrain).started.every((each) => typeof each === 'string');
  if (!ok) throw invalidParams(`a queue's drain must be { on, harness, model, role, closeWhenDone, most (1 to ${MAX_DRAIN_AGENTS}), started }`);
  if (drain !== undefined && (drain as unknown as QueueDrain).on && data.audience === 'user') throw invalidParams("the user's queue starts no agents: no agent takes from it");
}

interface EntryRow {
  id: string;
  item_id: string;
  key: string | null;
  is_file: number;
  text: string;
  pinned: number;
  made_by: string;
  changed_by: string;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  item_id: string;
  kind: QueueJob['kind'];
  text: string;
  link: string | null;
  position: number;
  taken_by: string | null;
  taken_at: string | null;
  drops: number;
  done_by: string | null;
  done_at: string | null;
  made_by: string;
  created_at: string;
  updated_at: string;
  /** Its latest version's `by` and `action`, read with it: null for a row whose history has been trimmed away. */
  changed_by: string | null;
  last_change: string | null;
}

interface HistoryRow {
  seq: number;
  row_id: string;
  action: string;
  value: string | null;
  by: string;
  at: string;
}

const toEntry = (row: EntryRow): MemoryEntry => ({
  id: row.id,
  memoryId: row.item_id,
  key: row.key,
  file: row.is_file === 1,
  text: row.text,
  pinned: row.pinned === 1,
  madeBy: JSON.parse(row.made_by) as StepsWho,
  changedBy: JSON.parse(row.changed_by) as StepsWho,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toJob = (row: JobRow): QueueJob => ({
  id: row.id,
  queueId: row.item_id,
  kind: row.kind,
  text: row.text,
  link: row.link,
  state: row.done_at !== null ? 'done' : row.taken_by !== null ? 'taken' : 'queued',
  takenBy: row.taken_by === null ? null : (JSON.parse(row.taken_by) as StepsWho),
  takenAt: row.taken_at,
  drops: row.drops,
  doneBy: row.done_by === null ? null : (JSON.parse(row.done_by) as StepsWho),
  doneAt: row.done_at,
  madeBy: JSON.parse(row.made_by) as StepsWho,
  changedBy: JSON.parse(row.changed_by ?? row.made_by) as StepsWho,
  lastChange: (row.last_change ?? 'add') as QueueJobChange,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A job row with who changed it last and how, from its newest version (by the history index: item, row, seq). */
const JOB_COLUMNS = `*,
  (SELECT h.by FROM board_history h WHERE h.item_id = queue_jobs.item_id AND h.row_id = queue_jobs.id ORDER BY h.seq DESC LIMIT 1) AS changed_by,
  (SELECT h.action FROM board_history h WHERE h.item_id = queue_jobs.item_id AND h.row_id = queue_jobs.id ORDER BY h.seq DESC LIMIT 1) AS last_change`;

/** The row `ref` names among `rows`: by its key (memories), its whole id, or the start of its id (at least 4 characters). */
function pick<Row extends { id: string; key?: string | null }>(rows: readonly Row[], said: string, what: string): Row | undefined {
  const ref = said.trim().replace(/^#/, '');
  if (ref === '') throw invalidParams(`give the ${what}`);
  const byKey = rows.find((row) => row.key === said.trim());
  if (byKey !== undefined) return byKey;
  const exact = rows.find((row) => row.id === ref);
  if (exact !== undefined) return exact;
  if (ref.length < 4) return undefined;
  const starts = rows.filter((row) => row.id.startsWith(ref));
  if (starts.length > 1) throw invalidParams(`#${ref} names ${starts.length} ${what}s: give more of its id`);
  return starts[0];
}

export interface MemoryQueueHost {
  /** `items` as the connection may see them: a board-token agent sees only the memories and queues it reads. */
  visible(items: BoardItem[], connection: BoardConnection): BoardItem[];
  /** The session ended: unless for a restart or hibernation, the jobs it held go back to the front of their queues. */
  sessionEnded(sessionId: string, keepsLease: boolean): Promise<void>;
  /**
   * The jobs held by agents no longer on the board go back to the front of their queues: one deleted (`sessionId`), or,
   * without it, any gone, as the daemon starts. An agent kept its jobs through a pause or a restart, and is deleted with
   * no exit to come.
   */
  releaseGone(sessionId?: string): Promise<void>;
  /**
   * `item` with its count put right, for a memory or queue whose saved count isn't its rows' (an undo sends an older one
   * back); `changed`, its jobs or drain were, so its drain may start an agent.
   */
  recounted(item: BoardItem, changed: boolean): Promise<BoardItem>;
  /** Keeps the agents a queue's drain started as the daemon has them, in an update that isn't the daemon's own. */
  keepStarted(params: unknown): void;
  /** An agent's turn ended: a drained one done with its job is closed, if its drain says so. */
  turnEnded(sessionId: string): void;
  /** Refuses an update that makes a queue the user's while an agent holds one of its jobs. */
  checkUpdate(params: unknown): void;
  handlers<Context extends BoardConnection>(): RpcHandlers<MemoryQueueMethods, Context>;
}

export function createMemoryQueueHost(options: MemoryQueueHostOptions): MemoryQueueHost {
  const { db } = options;
  const now = () => (options.now?.() ?? new Date()).toISOString();

  // Rows whose item is gone for good: an item deleted and not made again before the daemon started.
  db.exec(`
    DELETE FROM memory_entries WHERE item_id NOT IN (SELECT id FROM board_items);
    DELETE FROM queue_jobs WHERE item_id NOT IN (SELECT id FROM board_items);
    DELETE FROM board_history WHERE item_id NOT IN (SELECT id FROM board_items);
    DELETE FROM memory_reads WHERE item_id NOT IN (SELECT id FROM board_items);
  `);

  const sql = {
    entries: db.prepare('SELECT * FROM memory_entries WHERE item_id = ? ORDER BY pinned DESC, updated_at DESC, id'),
    entryCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS size FROM memory_entries WHERE item_id = ?'),
    entry: db.prepare('SELECT * FROM memory_entries WHERE id = ?'),
    insertEntry: db.prepare(
      'INSERT INTO memory_entries (id, item_id, key, is_file, text, pinned, made_by, changed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updateEntry: db.prepare('UPDATE memory_entries SET key = ?, is_file = ?, text = ?, pinned = ?, changed_by = ?, updated_at = ? WHERE id = ?'),
    deleteEntry: db.prepare('DELETE FROM memory_entries WHERE id = ?'),
    addRead: db.prepare(
      'INSERT INTO memory_reads (entry_id, item_id, session_id, name, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (entry_id, session_id) DO UPDATE SET name = excluded.name, at = excluded.at',
    ),
    // A bare column beside one MAX() is SQLite's: `name` comes from the row holding the newest `at`.
    entryReaders: db.prepare('SELECT entry_id, COUNT(*) AS n, name, MAX(at) AS at FROM memory_reads WHERE item_id = ? GROUP BY entry_id'),
    // The memory's readers are those of the entries it holds now.
    memoryReaders: db.prepare(
      'SELECT COUNT(DISTINCT session_id) AS n, name, MAX(at) AS at FROM memory_reads WHERE item_id = ? AND entry_id IN (SELECT id FROM memory_entries WHERE item_id = ?)',
    ),
    clearReads: db.prepare('DELETE FROM memory_reads WHERE entry_id = ?'),
    jobs: db.prepare(`SELECT ${JOB_COLUMNS} FROM queue_jobs WHERE item_id = ? ORDER BY done_at IS NOT NULL, CASE WHEN done_at IS NULL THEN position END, done_at DESC, id`),
    job: db.prepare(`SELECT ${JOB_COLUMNS} FROM queue_jobs WHERE id = ?`),
    heldIn: db.prepare('SELECT COUNT(*) AS n FROM queue_jobs WHERE item_id = ? AND taken_by IS NOT NULL AND done_at IS NULL'),
    openCount: db.prepare('SELECT COUNT(*) AS n FROM queue_jobs WHERE item_id = ? AND done_at IS NULL'),
    ends: db.prepare('SELECT MIN(position) AS front, MAX(position) AS back FROM queue_jobs WHERE item_id = ? AND done_at IS NULL'),
    insertJob: db.prepare(
      'INSERT INTO queue_jobs (id, item_id, kind, text, link, position, drops, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updateJob: db.prepare('UPDATE queue_jobs SET text = ?, link = ?, position = ?, taken_by = ?, taken_at = ?, drops = ?, done_by = ?, done_at = ?, updated_at = ? WHERE id = ?'),
    deleteJob: db.prepare('DELETE FROM queue_jobs WHERE id = ?'),
    placeJob: db.prepare('UPDATE queue_jobs SET position = ? WHERE id = ?'),
    untake: db.prepare('UPDATE queue_jobs SET taken_by = NULL, taken_at = NULL WHERE id = ?'),
    dropLastTake: db.prepare("DELETE FROM board_history WHERE seq = (SELECT MAX(seq) FROM board_history WHERE item_id = ? AND row_id = ? AND action = 'take')"),
    itemData: db.prepare('SELECT data FROM board_items WHERE id = ?'),
    jobsTakenBy: db.prepare("SELECT * FROM queue_jobs WHERE json_extract(taken_by, '$.sessionId') = ? AND done_at IS NULL"),
    history: db.prepare('SELECT seq, row_id, action, value, by, at FROM board_history WHERE item_id = ? AND row_id = ? ORDER BY seq DESC'),
    historyOf: db.prepare('SELECT row_id, value FROM board_history WHERE item_id = ? AND value IS NOT NULL ORDER BY seq DESC'),
    version: db.prepare('SELECT seq, row_id, action, value, by, at FROM board_history WHERE item_id = ? AND row_id = ? AND seq = ?'),
    addHistory: db.prepare('INSERT INTO board_history (item_id, row_id, action, value, by, at) VALUES (?, ?, ?, ?, ?, ?)'),
    historyBytes: db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS size FROM board_history WHERE item_id = ?'),
    // Oldest first, those of rows that are gone first: a removed row's versions are the first to go (its remove stays).
    oldestHistory: db.prepare(
      `SELECT seq, COALESCE(LENGTH(CAST(value AS BLOB)), 0) AS size FROM board_history h WHERE item_id = ? AND value IS NOT NULL
       ORDER BY EXISTS (SELECT 1 FROM memory_entries WHERE id = h.row_id) OR EXISTS (SELECT 1 FROM queue_jobs WHERE id = h.row_id), seq`,
    ),
    deleteHistory: db.prepare('DELETE FROM board_history WHERE seq = ?'),
    takenJobs: db.prepare('SELECT * FROM queue_jobs WHERE taken_by IS NOT NULL AND done_at IS NULL'),
    // A row keeps its newest `keep` versions, and whatever confirms came since the oldest of them: a confirm is no version.
    trimHistory: db.prepare(
      "DELETE FROM board_history WHERE item_id = ? AND row_id = ? AND seq < (SELECT MIN(seq) FROM (SELECT seq FROM board_history WHERE item_id = ? AND row_id = ? AND action <> 'confirm' ORDER BY seq DESC LIMIT ?))",
    ),
    dropNewestConfirm: db.prepare(
      "DELETE FROM board_history WHERE seq = (SELECT MAX(seq) FROM board_history WHERE item_id = ? AND row_id = ?) AND action = 'confirm'",
    ),
  };

  const entriesOf = (itemId: string) => (sql.entries.all(itemId) as unknown as EntryRow[]).map(toEntry);
  const jobsOf = (itemId: string) => (sql.jobs.all(itemId) as unknown as JobRow[]).map(toJob);

  const remember = (itemId: string, rowId: string, action: string, value: MemoryEntry | QueueJob | null, by: StepsWho, at: string) => {
    sql.addHistory.run(itemId, rowId, action, value === null ? null : JSON.stringify(value), JSON.stringify(by), at);
    const keep = value !== null && 'file' in value && value.file ? MAX_FILE_VERSIONS : MAX_HISTORY_VERSIONS;
    sql.trimHistory.run(itemId, rowId, itemId, rowId, keep);
    let over = (sql.historyBytes.get(itemId) as { size: number }).size - MAX_HISTORY_BYTES;
    if (over <= 0) return;
    for (const old of sql.oldestHistory.all(itemId) as { seq: number; size: number }[]) {
      sql.deleteHistory.run(old.seq);
      over -= old.size;
      if (over <= 0) break;
    }
  };

  const versionsOf = <Row>(itemId: string, rowId: string): HistoryVersion<Row>[] =>
    (sql.history.all(itemId, rowId) as unknown as HistoryRow[]).map((row) => ({
      version: row.seq,
      action: row.action,
      value: row.value === null ? null : (JSON.parse(row.value) as Row),
      by: JSON.parse(row.by) as StepsWho,
      at: row.at,
    }));

  /** An entry or job by `ref`, now or, with `past`, as its history last had it (one removed since). */
  const pastRow = <Row extends { id: string; key?: string | null }>(itemId: string, ref: string, what: string): Row | undefined => {
    const seen = new Map<string, Row>();
    for (const row of sql.historyOf.all(itemId) as unknown as { row_id: string; value: string }[]) {
      if (!seen.has(row.row_id)) seen.set(row.row_id, JSON.parse(row.value) as Row);
    }
    return pick([...seen.values()], ref, what);
  };

  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  // ---- the cards ----

  const itemsOf = async (kind: 'memory' | 'queue') => (await options.call('item.list', undefined)).filter((item) => item.kind === kind);
  const itemOf = async (kind: 'memory' | 'queue', id: string): Promise<BoardItem> => {
    const found = (await itemsOf(kind)).find((item) => item.id === id);
    if (found === undefined) throw invalidParams(`no ${kind} ${id}`);
    return found;
  };
  const dataOf = (item: BoardItem) => item.data as unknown as MemoryData | QueueData;
  const titleOf = (item: BoardItem) => dataOf(item).title;

  /** The card's count brought up to date, which also tells the app it changed. */
  const countOf = (item: BoardItem) => (item.kind === 'memory' ? (sql.entryCount.get(item.id) as { n: number }).n : (sql.openCount.get(item.id) as { n: number }).n);
  const touch = async (item: BoardItem): Promise<BoardItem> => options.call('item.update', { id: item.id, data: { count: countOf(item) } });

  // ---- who calls ----

  const reads = (agent: Agent, item: BoardItem) => !dataOf(item).noAgents && readsItem(agent, item, sameWho(dataOf(item).madeBy, agentWho(agent)), options.reachesZone);

  /** The agent whose board token the call holds; with `live`, only its own live session. */
  const agentCaller = (p: Record<string, unknown>, connection: BoardConnection, live: boolean): Agent => {
    const who = boardCaller(options, stringParam(p, 'token'), connection);
    const me = who.kind === 'agent' ? options.agents.get(who.tileId) : undefined;
    if (me === undefined) throw invalidParams('only an agent uses memories and queues: not a shell');
    if (live && !isOwnLiveSession(me, who.sessionId)) throw invalidParams("only a live agent changes memories and queues, from its own session: not an ended agent's");
    return me;
  };

  /** The card `id` of `kind`, refused if `me` (an agent) doesn't read it. */
  const reached = async (kind: 'memory' | 'queue', id: string, me: Agent | null): Promise<BoardItem> => {
    const item = await itemOf(kind, id);
    if (me !== null && !reads(me, item)) {
      throw outOfScope(
        dataOf(item).noAgents ? `“${titleOf(item)}” is set to No agents: only the user reads it` : `that ${kind} is outside your scope: in a zone you are not in, nor reach`,
      );
    }
    return item;
  };

  const newCard = async (me: Agent, kind: 'memory' | 'queue', rawTitle: string, audience?: QueueAudience): Promise<BoardItem> => {
    const title = rawTitle.trim();
    if (title === '' || title.length > MAX_PLAN_TITLE_LENGTH) throw invalidParams(`title must be 1 to ${MAX_PLAN_TITLE_LENGTH} characters`);
    const size = kind === 'memory' ? MEMORY_CARD_SIZE : QUEUE_CARD_SIZE;
    const spot = (await options.place(me.sessionId, size)) ?? { zoneId: me.zoneId, x: 0, y: 0 };
    const data = { title, madeBy: agentWho(me), noAgents: false, count: 0, ...(kind === 'queue' ? { audience: audience ?? 'agents' } : {}) };
    return options.call('item.create', { kind, ...spot, ...size, data });
  };

  // ---- memories ----

  const keyParam = (key: unknown): string | null => {
    if (key === null || key === undefined) return null;
    if (typeof key !== 'string') throw invalidParams('key must be a string or null');
    const trimmed = key.trim();
    if (trimmed === '' || trimmed.length > MAX_MEMORY_KEY || /[\r\n]/.test(trimmed)) throw invalidParams(`a key is one line of 1 to ${MAX_MEMORY_KEY} characters`);
    return trimmed;
  };
  const textFor = (text: unknown, file: boolean): string => {
    if (typeof text !== 'string') throw invalidParams('text must be a string');
    const kept = file ? text : text.trim();
    if (kept.trim() === '') throw invalidParams(file ? 'that file is empty' : 'give the text to remember');
    if (file && bytes(kept) > MAX_MEMORY_FILE_BYTES) throw invalidParams(`a file is at most ${MAX_MEMORY_FILE_BYTES} bytes: that one is ${bytes(kept)}`);
    if (!file && kept.length > MAX_MEMORY_VALUE) throw invalidParams(`a value is at most ${MAX_MEMORY_VALUE} characters (keep a longer text as a file): that one is ${kept.length}`);
    return kept;
  };

  /** Throws unless the memory has room for `adding` more bytes (and, with `newRow`, another entry). */
  const roomFor = (item: BoardItem, adding: number, newRow: boolean) => {
    const { n, size } = sql.entryCount.get(item.id) as { n: number; size: number };
    if (newRow && n >= MAX_MEMORY_ENTRIES) throw invalidParams(`“${titleOf(item)}” holds ${MAX_MEMORY_ENTRIES} entries, its most: remove some first`);
    if (size + adding > MAX_MEMORY_BYTES) throw invalidParams(`“${titleOf(item)}” would hold more than ${MAX_MEMORY_BYTES} bytes: remove or shorten some entries first`);
  };

  const entryRows = (itemId: string) => sql.entries.all(itemId) as unknown as EntryRow[];
  const entryFor = (item: BoardItem, ref: string): EntryRow => {
    const row = pick(entryRows(item.id), ref, 'entry');
    if (row === undefined) throw invalidParams(`“${titleOf(item)}” has no entry ${ref}`);
    return row;
  };

  /** An entry's readers read the text it had: a new text has none yet. */
  const readsOf = (entryId: string, was: string, text: string) => {
    if (was !== text) sql.clearReads.run(entryId);
  };

  /** Saves `entry` as a change by `by`, recording the version. */
  const putEntry = (item: BoardItem, before: EntryRow | undefined, next: Omit<MemoryEntry, 'createdAt' | 'updatedAt' | 'madeBy' | 'changedBy'>, by: StepsWho, action: string): MemoryEntry => {
    const at = now();
    const clash = next.key === null ? undefined : entryRows(item.id).find((row) => row.key === next.key && row.id !== next.id);
    if (clash !== undefined) throw invalidParams(`“${titleOf(item)}” already has a ${next.key} entry: edit that one, or give another key`);
    roomFor(item, bytes(next.text) - (before === undefined ? 0 : bytes(before.text)), before === undefined);
    if (before === undefined) sql.insertEntry.run(next.id, item.id, next.key, next.file ? 1 : 0, next.text, next.pinned ? 1 : 0, JSON.stringify(by), JSON.stringify(by), at, at);
    else sql.updateEntry.run(next.key, next.file ? 1 : 0, next.text, next.pinned ? 1 : 0, JSON.stringify(by), at, next.id);
    if (before !== undefined) readsOf(next.id, before.text, next.text);
    const saved = toEntry(sql.entry.get(next.id) as unknown as EntryRow);
    remember(item.id, saved.id, action, saved, by, at);
    return saved;
  };

  const changeMemory = (item: BoardItem, change: MemoryChange, by: StepsWho): MemoryEntry | null =>
    transaction(() => {
      switch (change.action) {
        case 'add': {
          const file = change.file === true;
          const key = keyParam(change.key);
          if (file && key === null) throw invalidParams('a file is kept under its name: give its key');
          const text = textFor(change.text, file);
          const before = key === null ? undefined : entryRows(item.id).find((row) => row.key === key);
          const pinned = before?.pinned === 1;
          return putEntry(item, before, { id: before?.id ?? randomUUID(), memoryId: item.id, key, file, text, pinned }, by, before === undefined ? 'add' : 'edit');
        }
        case 'edit': {
          const before = entryFor(item, change.entry);
          const file = before.is_file === 1;
          const key = change.key === undefined ? before.key : keyParam(change.key);
          if (file && key === null) throw invalidParams('a file is kept under its name: it keeps a key');
          const text = change.text === undefined ? before.text : textFor(change.text, file);
          const pinned = change.pinned ?? before.pinned === 1;
          if (typeof pinned !== 'boolean') throw invalidParams('pinned must be true or false');
          if (key === before.key && text === before.text && pinned === (before.pinned === 1)) throw invalidParams('nothing to change: give the new text, key or pin');
          return putEntry(item, before, { id: before.id, memoryId: item.id, key, file, text, pinned }, by, 'edit');
        }
        case 'remove': {
          const before = entryFor(item, change.entry);
          sql.deleteEntry.run(before.id);
          remember(item.id, before.id, 'remove', null, by, now());
          return null;
        }
        case 'confirm': {
          // Still true costs no version: the entry's date and who changed it move on, and its history gets a row with no
          // value, the newest standing for a run of them, which no trim counts. Its readers read this text, so they stay.
          const before = entryFor(item, change.entry);
          const at = now();
          sql.updateEntry.run(before.key, before.is_file, before.text, before.pinned, JSON.stringify(by), at, before.id);
          sql.dropNewestConfirm.run(item.id, before.id);
          sql.addHistory.run(item.id, before.id, 'confirm', null, JSON.stringify(by), at);
          return toEntry(sql.entry.get(before.id) as unknown as EntryRow);
        }
        case 'restore': {
          const current = pick(entryRows(item.id), change.entry, 'entry');
          const rowId = current?.id ?? pastRow<MemoryEntry>(item.id, change.entry, 'entry')?.id;
          if (rowId === undefined) throw invalidParams(`“${titleOf(item)}” has no entry ${change.entry}, nor any history of one`);
          const value = versionValue<MemoryEntry>(item, rowId, change.version);
          // One put back after a remove had the readers of the text it was removed with.
          if (current === undefined) readsOf(rowId, pastRow<MemoryEntry>(item.id, rowId, 'entry')?.text ?? '', value.text);
          return putEntry(item, current, { id: rowId, memoryId: item.id, key: value.key, file: value.file, text: value.text, pinned: value.pinned }, by, 'restore');
        }
      }
    });

  /** The value version `version` of the row left, refused for one that isn't the row's or a remove's. */
  const versionValue = <Row>(item: BoardItem, rowId: string, version: unknown): Row => {
    if (!Number.isInteger(version)) throw invalidParams('version must be a version number, as history lists them');
    const row = sql.version.get(item.id, rowId, version as number) as HistoryRow | undefined;
    if (row === undefined) throw invalidParams(`there is no version ${String(version)} of that in “${titleOf(item)}”: history lists them`);
    if (row.value === null) throw invalidParams(row.action === 'confirm' ? `version ${String(version)} only confirmed it: restore one with a value` : `version ${String(version)} removed it: restore one before`);
    return JSON.parse(row.value) as Row;
  };

  // ---- queues ----

  const jobRows = (itemId: string) => sql.jobs.all(itemId) as unknown as JobRow[];
  const jobFor = (item: BoardItem, ref: string): JobRow => {
    const row = pick(jobRows(item.id), ref, 'job');
    if (row === undefined) throw invalidParams(`“${titleOf(item)}” has no job ${ref}`);
    return row;
  };
  const jobText = (text: unknown): string => {
    if (typeof text !== 'string' || text.trim() === '' || text.trim().length > MAX_JOB_TEXT) throw invalidParams(`a job or note is 1 to ${MAX_JOB_TEXT} characters`);
    return text.trim();
  };
  const linkParam = (link: unknown): string | null => {
    if (link === null || link === undefined) return null;
    if (typeof link !== 'string' || link.trim() === '' || link.trim().length > MAX_JOB_LINK || /[\r\n]/.test(link)) throw invalidParams(`a link is one line of 1 to ${MAX_JOB_LINK} characters`);
    return link.trim();
  };
  const front = (itemId: string) => ((sql.ends.get(itemId) as { front: number | null }).front ?? 1) - 1;
  const back = (itemId: string) => ((sql.ends.get(itemId) as { back: number | null }).back ?? 0) + 1;

  /** Saves the job row as it is now, a change by `by`, and records the version. */
  const putJob = (item: BoardItem, row: JobRow, by: StepsWho, action: string): QueueJob => {
    const at = now();
    sql.updateJob.run(row.text, row.link, row.position, row.taken_by, row.taken_at, row.drops, row.done_by, row.done_at, at, row.id);
    const saved: QueueJob = { ...toJob(sql.job.get(row.id) as unknown as JobRow), changedBy: by, lastChange: action as QueueJobChange };
    remember(item.id, saved.id, action, saved, by, at);
    return saved;
  };

  const insertJob = (item: BoardItem, id: string, kind: QueueJob['kind'], text: string, link: string | null, position: number, by: StepsWho, action: string, drops = 0): QueueJob => {
    if ((sql.openCount.get(item.id) as { n: number }).n >= MAX_QUEUE_OPEN) throw invalidParams(`“${titleOf(item)}” holds ${MAX_QUEUE_OPEN} open jobs, its most`);
    const at = now();
    sql.insertJob.run(id, item.id, kind, text, link, position, drops, JSON.stringify(by), at, at);
    const saved: QueueJob = { ...toJob(sql.job.get(id) as unknown as JobRow), changedBy: by, lastChange: action as QueueJobChange };
    remember(item.id, id, action, saved, by, at);
    return saved;
  };

  /** Back to the front of its queue, the drop counted. */
  const dropped = (row: JobRow, front_: number): JobRow => ({ ...row, taken_by: null, taken_at: null, drops: row.drops + 1, position: front_ });

  /** `me` is the agent changing it, null for the user. */
  const changeQueue = (item: BoardItem, change: QueueChange, me: Agent | null): QueueJob | null =>
    transaction(() => {
      const by = me === null ? USER : agentWho(me);
      const data = dataOf(item) as QueueData;
      /** Refuses a job another agent holds: only its taker, or the user, changes it then. */
      const notHeldByOther = (row: JobRow, doing: string) => {
        const taker = row.taken_by === null ? null : (JSON.parse(row.taken_by) as StepsWho);
        if (me !== null && taker !== null && !sameWho(taker, by)) throw outOfScope(`${whoName(taker)} has job #${row.id.slice(0, 8)}: only it, or the user, ${doing} it now`);
      };
      /** Refuses a job the queue's drain is starting an agent for: it is that agent's. */
      const notStarting = (row: JobRow) => {
        if (starting.has(row.id)) throw invalidParams(`an agent is starting for job #${row.id.slice(0, 8)}: it is that agent's`);
      };
      // Finished, dropped or removed meanwhile, it would leave the starting agent with nothing: an edit or a move is fine.
      if (change.action === 'done' || change.action === 'drop' || change.action === 'remove') {
        const named = pick(jobRows(item.id), change.job, 'job');
        if (named !== undefined) notStarting(named);
      }
      switch (change.action) {
        case 'add': {
          const kind = change.kind ?? 'job';
          if (!(QUEUE_ROW_KINDS as readonly unknown[]).includes(kind)) throw invalidParams(`kind must be one of ${QUEUE_ROW_KINDS.join(', ')}`);
          return insertJob(item, randomUUID(), kind, jobText(change.text), linkParam(change.link), change.front === true ? front(item.id) : back(item.id), by, 'add');
        }
        case 'edit': {
          const row = jobFor(item, change.job);
          notHeldByOther(row, 'changes');
          const text = change.text === undefined ? row.text : jobText(change.text);
          const link = change.link === undefined ? row.link : linkParam(change.link);
          if (text === row.text && link === row.link) throw invalidParams('nothing to change: give the new text or link');
          return putJob(item, { ...row, text, link }, by, 'edit');
        }
        case 'remove': {
          const row = jobFor(item, change.job);
          notHeldByOther(row, 'removes');
          sql.deleteJob.run(row.id);
          remember(item.id, row.id, 'remove', null, by, now());
          return null;
        }
        case 'take': {
          if (me === null) throw invalidParams('the user takes no job: hand one to an agent instead');
          if (data.audience === 'user') throw outOfScope(`“${data.title}” is the user's queue: its jobs are for them, not taken by agents`);
          const rows = jobRows(item.id);
          const row = change.job === undefined ? rows.find((each) => each.kind === 'job' && each.taken_by === null && each.done_at === null && !starting.has(each.id)) : jobFor(item, change.job);
          if (row === undefined) throw invalidParams(`“${data.title}” has no job waiting to be taken`);
          notStarting(row);
          if (row.kind === 'note') throw invalidParams(`#${row.id.slice(0, 8)} is a note: only a job is taken`);
          if (row.done_at !== null) throw invalidParams(`job #${row.id.slice(0, 8)} is done already`);
          if (row.taken_by !== null) {
            const taker = JSON.parse(row.taken_by) as StepsWho;
            if (sameWho(taker, by)) return toJob(row);
            throw outOfScope(`${whoName(taker)} has job #${row.id.slice(0, 8)} already`);
          }
          return putJob(item, { ...row, taken_by: JSON.stringify(by), taken_at: now() }, by, 'take');
        }
        case 'drop': {
          const row = jobFor(item, change.job);
          if (row.taken_by === null || row.done_at !== null) throw invalidParams(`job #${row.id.slice(0, 8)} isn't taken: there is nothing to drop`);
          notHeldByOther(row, 'drops');
          return putJob(item, dropped(row, front(item.id)), by, 'drop');
        }
        case 'done': {
          const row = jobFor(item, change.job);
          if (row.kind === 'note') throw invalidParams(`#${row.id.slice(0, 8)} is a note: only a job is done`);
          if (row.done_at !== null) throw invalidParams(`job #${row.id.slice(0, 8)} is done already`);
          notHeldByOther(row, 'finishes');
          return putJob(item, { ...row, taken_by: null, taken_at: null, done_by: JSON.stringify(by), done_at: now() }, by, 'done');
        }
        case 'restore': {
          const current = pick(jobRows(item.id), change.job, 'job');
          const rowId = current?.id ?? pastRow<QueueJob>(item.id, change.job, 'job')?.id;
          if (rowId === undefined) throw invalidParams(`“${data.title}” has no job ${change.job}, nor any history of one`);
          const value = versionValue<QueueJob>(item, rowId, change.version);
          // A removed job comes back with its drops counted, as it was; a take it had is not given back.
          if (current === undefined) return insertJob(item, rowId, value.kind, value.text, value.link, back(item.id), by, 'restore', value.drops);
          notHeldByOther(current, 'changes');
          return putJob(item, { ...current, text: value.text, link: value.link }, by, 'restore');
        }
        case 'move': {
          if (change.before !== null && typeof change.before !== 'string') throw invalidParams('before must be the open job to move it before, or null for last');
          const row = jobFor(item, change.job);
          if (row.done_at !== null) throw invalidParams(`job #${row.id.slice(0, 8)} is done: only an open one moves`);
          notHeldByOther(row, 'moves');
          if (change.before !== null && jobFor(item, change.before).id === row.id) return toJob(row);
          const open = jobRows(item.id).filter((each) => each.done_at === null && each.id !== row.id);
          const at = change.before === null ? open.length : open.findIndex((each) => each.id === jobFor(item, change.before!).id);
          if (at < 0) throw invalidParams(`#${change.before!} is done: move a job before an open one`);
          // The open ones numbered again in their new order; only a place that changes is written. Not a version: the job is as it was.
          open.splice(at, 0, row);
          open.forEach((each, index) => index + 1 !== each.position && sql.placeJob.run(index + 1, each.id));
          return toJob(sql.job.get(row.id) as unknown as JobRow);
        }
      }
    });

  const checkedChange = <Change extends { action: string }>(value: unknown, known: readonly string[]): Change => {
    if (!isObject(value) || typeof value.action !== 'string') throw invalidParams('change must be { action, … }');
    if (!known.includes(value.action)) throw invalidParams(`change.action must be one of ${known.join(', ')}`);
    return value as unknown as Change;
  };
  const memoryChange = (value: unknown) => checkedChange<MemoryChange>(value, ['add', 'edit', 'remove', 'restore', 'confirm']);
  const queueChange = (value: unknown) => checkedChange<QueueChange>(value, ['add', 'edit', 'remove', 'take', 'drop', 'done', 'restore', 'move']);

  type ReadersRow = { n: number; name: string | null; at: string | null };
  const readersOf = (row: ReadersRow | undefined): MemoryReaders => ({ count: row?.n ?? 0, last: row?.name == null || row.at === null ? null : { name: row.name, at: row.at } });

  /**
   * A memory's entries, or the one `entry` names, as `reader` (an agent; null for the user) reads them. An agent reads
   * what comes back whole: the one named, or, as it reads the memory, its facts and notes. A document it lists by its
   * title and size alone, its text left out, so a long one costs it nothing until it names it. The user gets every
   * text, and reads nothing.
   */
  const memoryView = (item: BoardItem, search: string | undefined, entry: string | undefined, reader: Agent | null): MemoryView => {
    const wanted = search?.trim().toLowerCase();
    const all = entry !== undefined ? [toEntry(entryFor(item, entry))] : entriesOf(item.id);
    const found = entry !== undefined || wanted === undefined || wanted === '' ? all : all.filter((row) => (row.key ?? '').toLowerCase().includes(wanted) || row.text.toLowerCase().includes(wanted));
    const listed = reader !== null && entry === undefined;
    const entries = found.map((row) => (listed && row.file ? { ...row, text: '', listed: { bytes: bytes(row.text), lines: row.text.split('\n').length } } : row));
    if (reader !== null) {
      const at = now();
      transaction(() => {
        for (const read of entries) if (read.listed === undefined) sql.addRead.run(read.id, item.id, reader.sessionId, reader.name, at);
      });
    }
    const byEntry = new Map((sql.entryReaders.all(item.id) as unknown as (ReadersRow & { entry_id: string })[]).map((row) => [row.entry_id, row]));
    return {
      item,
      entries,
      readers: {
        memory: readersOf(sql.memoryReaders.get(item.id, item.id) as unknown as ReadersRow),
        entries: Object.fromEntries(entries.map((read) => [read.id, readersOf(byEntry.get(read.id))])),
      },
    };
  };
  const memoryHistory = (item: BoardItem, ref: string) => {
    const rowId = pick(entryRows(item.id), ref, 'entry')?.id ?? pastRow<MemoryEntry>(item.id, ref, 'entry')?.id;
    if (rowId === undefined) throw invalidParams(`“${titleOf(item)}” has no entry ${ref}, nor any history of one`);
    return versionsOf<MemoryEntry>(item.id, rowId);
  };
  const queueHistory = (item: BoardItem, ref: string) => {
    const rowId = pick(jobRows(item.id), ref, 'job')?.id ?? pastRow<QueueJob>(item.id, ref, 'job')?.id;
    if (rowId === undefined) throw invalidParams(`“${titleOf(item)}” has no job ${ref}, nor any history of one`);
    return versionsOf<QueueJob>(item.id, rowId);
  };

  /**
   * The user hands a waiting job to an idle agent in the queue's scope: taken for it, then `text` typed at its prompt.
   * A send that fails puts the job back as it was, so no agent holds a job it never heard of.
   */
  const handOn = async (item: BoardItem, ref: string, sessionId: string, rawText: string): Promise<QueueJob> => {
    const data = dataOf(item) as QueueData;
    if (data.audience === 'user') throw invalidParams(`“${data.title}” is the user's queue: its jobs are for them, not handed to agents`);
    const agent = options.agents.get(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    if (!reads(agent, item)) throw outOfScope(`${agent.name} doesn't use “${data.title}”: hand it a job from a queue in its scope`);
    if (!takesHandOn(agent)) throw invalidParams(`${agent.name} is busy or asking you something: hand a job to an idle agent`);
    const text = rawText.trim();
    if (text === '' || text.length > MAX_JOB_TEXT) throw invalidParams(`the message is 1 to ${MAX_JOB_TEXT} characters`);
    const before = jobFor(item, ref);
    const taker = JSON.stringify(agentWho(agent));
    const taken = transaction(() => {
      if (before.kind === 'note') throw invalidParams(`#${before.id.slice(0, 8)} is a note: only a job is handed on`);
      if (before.done_at !== null || before.taken_by !== null) throw invalidParams(`job #${before.id.slice(0, 8)} isn't waiting: only a waiting job is handed on`);
      if (starting.has(before.id)) throw invalidParams(`an agent is starting for job #${before.id.slice(0, 8)}: it is that agent's`);
      return putJob(item, { ...before, taken_by: taker, taken_at: now() }, USER, 'take');
    });
    /**
     * The take undone, as the message never reached the agent: only while the job is still this hand-on's, clearing the
     * take alone and its own history row, so a change made meanwhile (an edit, a move) stays.
     */
    const undo = () =>
      transaction(() => {
        const row = sql.job.get(before.id) as unknown as JobRow | undefined;
        if (row === undefined || row.taken_by !== taker || row.done_at !== null) return;
        sql.untake.run(row.id);
        sql.dropLastTake.run(item.id, row.id);
      });
    let answered: Answered;
    try {
      answered = await options.agents.answer(sessionId, text);
    } catch (error) {
      undo();
      throw error;
    }
    // Typed but given up on, Enter starting no turn: the agent never got it. Queued until its session is up, or for
    // after a turn it started as the text landed: it gets it then, so the job is its.
    if (answered.unsent !== undefined) {
      undo();
      // Nor is the message left typed at its prompt, for an Enter later to send a job it no longer has.
      try {
        options.agents.clearUnsent(sessionId);
      } catch {
        // Gone from its prompt already: nothing to clear.
      }
      throw invalidParams(`${agent.name} didn't get it (${answered.unsent}): the job is waiting again`);
    }
    return taken;
  };

  // ---- drain ----

  /** The queues being drained now: a second call waits for the first, so no job gets two agents. */
  const draining = new Map<string, Promise<void>>();
  /**
   * The jobs an agent is starting for: reserved for it while it starts (seconds, a worktree made), so no take, hand-on
   * or other change gives the job to anyone else meanwhile.
   */
  const starting = new Set<string>();

  /**
   * Starts fresh agents for the queue's waiting jobs while its drain is on and fewer than `most` of its jobs are taken,
   * each job taken for its agent and its text the agent's task. Only for agents, in a zone, and not No agents.
   */
  const drain = (itemId: string): Promise<void> => {
    const going: Promise<void> = (draining.get(itemId) ?? Promise.resolve())
      .then(() => drainNow(itemId))
      .catch((error: unknown) => options.log?.(`queue ${itemId}: could not start an agent: ${(error as Error).message}`))
      .finally(() => {
        if (draining.get(itemId) === going) draining.delete(itemId);
      });
    draining.set(itemId, going);
    return going;
  };

  /** An agent the queue's drain started, added to those saved on it (kept by the daemon: a user's update keeps them). */
  const saveStarted = async (item: BoardItem, sessionId: string) => {
    const latest = (await itemsOf('queue')).find((each) => each.id === item.id);
    const settings = latest === undefined ? undefined : (dataOf(latest) as QueueData).drain;
    if (settings === undefined) return;
    const started = [...settings.started.filter((each) => options.agents.get(each) !== undefined), sessionId];
    const params = { id: item.id, data: { drain: { ...settings, started } } };
    ownUpdates.add(params);
    await options.call('item.update', params);
  };

  /** The host's own updates of a queue's drain: the only ones that change its `started`. */
  const ownUpdates = new WeakSet<object>();

  const drainNow = async (itemId: string) => {
    for (;;) {
      // Read again before each start: the user may have turned it off, or lowered its most, as the last one started.
      const item = (await itemsOf('queue')).find((each) => each.id === itemId);
      if (item === undefined || item.zoneId === null) return;
      const data = dataOf(item) as QueueData;
      const settings = data.drain;
      if (settings?.on !== true || data.audience !== 'agents' || data.noAgents) return;
      const rows = jobRows(item.id);
      const held = rows.filter((row) => row.taken_by !== null && row.done_at === null).length;
      // A job dropped back MAX_DRAIN_DROPS times is left for a person: drain doesn't start agent after agent on it.
      const next = rows.find((row) => row.kind === 'job' && row.taken_by === null && row.done_at === null && row.drops < MAX_DRAIN_DROPS && !starting.has(row.id));
      if (next === undefined || held >= settings.most) return;
      starting.add(next.id);
      let agent: Agent;
      try {
        const tiles = (await options.call('agent.list', undefined)).filter((each) => each.zoneId === item.zoneId && each.position !== null).map((each) => ({ ...each.position!, ...AGENT_TILE_SIZE }));
        agent = await options.agents.spawn({
          zoneId: item.zoneId,
          position: freeSpotFor({ x: item.x, y: item.y + item.height + DRAIN_GAP }, AGENT_TILE_SIZE, tiles),
          harness: settings.harness,
          model: settings.model ?? undefined,
          role: settings.role ?? undefined,
          name: cutText(next.text.split('\n', 1)[0]!.trim(), MAX_DRAIN_NAME),
          prompt: jobBrief({ title: data.title, ref: itemRef(item) }, next.id, next.text, next.link, 'taken for you'),
          ...DRAIN_SIZE,
        });
        transaction(() => {
          const row = sql.job.get(next.id) as unknown as JobRow | undefined;
          if (row !== undefined && row.taken_by === null && row.done_at === null) putJob(item, { ...row, taken_by: JSON.stringify(agentWho(agent)), taken_at: now() }, agentWho(agent), 'take');
        });
      } finally {
        starting.delete(next.id);
      }
      // Kept as each starts, so one started before a later start fails is still known, and closed once done.
      await saveStarted(item, agent.sessionId);
    }
  };

  /** A drained agent's turn ended: one holding none of its queue's jobs is closed, if its drain says so, and the next started. */
  const drainTurnEnded = async (sessionId: string) => {
    for (const item of await itemsOf('queue')) {
      const settings = (dataOf(item) as QueueData).drain;
      if (settings === undefined || !settings.started.includes(sessionId)) continue;
      // One holding any queue's job (another queue's too) is at work: it stays.
      if ((sql.jobsTakenBy.all(sessionId) as unknown[]).length > 0) return;
      if (settings.closeWhenDone) {
        // Unsaved work is never thrown away: it is stopped instead, and stays for the user.
        await options.agents.delete(sessionId, 'its queue job is done', false).catch(() => options.agents.stop(sessionId, 'its queue job is done').catch(() => {}));
      }
      await drain(item.id);
      return;
    }
  };

  /** Each held job back at the front of its queue, its drop counted, as its taker's. */
  const putBack = async (held: JobRow[]) => {
    if (held.length === 0) return;
    const queues = await itemsOf('queue');
    const touched = new Map<string, BoardItem>();
    for (const row of held) {
      const item = queues.find((each) => each.id === row.item_id);
      if (item === undefined) continue;
      touched.set(item.id, item);
      const current = sql.job.get(row.id) as unknown as JobRow | undefined;
      if (current?.taken_by !== row.taken_by || current.done_at !== null) continue;
      transaction(() => putJob(item, dropped(current, front(item.id)), JSON.parse(current.taken_by!) as StepsWho, 'drop'));
    }
    for (const item of touched.values()) await touch(item);
  };

  const listFor = async (kind: 'memory' | 'queue', me: Agent) => (await itemsOf(kind)).filter((item) => reads(me, item));

  return {
    visible(items, connection) {
      const me = connectionAgent(options, connection);
      if (me === undefined) return items;
      if (me === null) return items.filter((item) => item.kind !== 'memory' && item.kind !== 'queue');
      return items.filter((item) => (item.kind !== 'memory' && item.kind !== 'queue') || reads(me, item));
    },

    checkUpdate(params) {
      if (!isObject(params) || typeof params.id !== 'string' || !isObject(params.data) || params.data.audience !== 'user') return;
      const held = (sql.heldIn.get(params.id) as { n: number }).n;
      if (held > 0) throw invalidParams(`an agent holds ${held === 1 ? 'a job' : `${held} jobs`} from this queue: it stays for agents until they are done or put back`);
    },

    turnEnded(sessionId) {
      void drainTurnEnded(sessionId).catch((error: unknown) => options.log?.(`could not close ${sessionId} after its queue job: ${(error as Error).message}`));
    },

    keepStarted(params) {
      if (!isObject(params) || ownUpdates.has(params) || typeof params.id !== 'string' || !isObject(params.data) || !isObject(params.data.drain)) return;
      const stored = (sql.itemData.get(params.id) as { data: string } | undefined)?.data;
      const started = stored === undefined ? undefined : (JSON.parse(stored) as Partial<QueueData>).drain?.started;
      params.data.drain = { ...params.data.drain, started: started ?? [] };
    },

    async recounted(item, changed) {
      if (item.kind !== 'memory' && item.kind !== 'queue') return item;
      // A change to its jobs (its count saved) or to its drain may let its drain start the next agent; a move doesn't.
      if (item.kind === 'queue' && changed) void drain(item.id);
      return dataOf(item).count === countOf(item) ? item : touch(item);
    },

    async sessionEnded(sessionId, keepsLease) {
      if (!keepsLease) await putBack(sql.jobsTakenBy.all(sessionId) as unknown as JobRow[]);
    },

    async releaseGone(sessionId) {
      const held = sessionId === undefined ? (sql.takenJobs.all() as unknown as JobRow[]) : (sql.jobsTakenBy.all(sessionId) as unknown as JobRow[]);
      await putBack(held.filter((row) => options.agents.get((JSON.parse(row.taken_by!) as { sessionId: string }).sessionId) === undefined));
      // As the daemon starts, the queues being drained start agents for what waits.
      if (sessionId === undefined) for (const item of await itemsOf('queue')) void drain(item.id);
    },

    handlers<Context extends BoardConnection>(): RpcHandlers<MemoryQueueMethods, Context> {
      return {
        'board.newMemory': async (params, connection) => {
          const p = paramsObject(params);
          return newCard(agentCaller(p, connection, true), 'memory', stringParam(p, 'title'));
        },
        'board.listMemories': async (params, connection) => listFor('memory', agentCaller(paramsObject(params), connection, false)),
        'board.readMemory': async (params, connection) => {
          const p = paramsObject(params);
          const me = agentCaller(p, connection, false);
          const item = await reached('memory', stringParam(p, 'id'), me);
          return memoryView(item, optionalStringParam(p, 'search'), optionalStringParam(p, 'entry'), me);
        },
        'board.changeMemory': async (params, connection) => {
          const p = paramsObject(params);
          const me = agentCaller(p, connection, true);
          const change = memoryChange(p.change);
          const item = await reached('memory', stringParam(p, 'id'), me);
          const entry = changeMemory(item, change, agentWho(me));
          return { item: await touch(item), entry };
        },
        'board.memoryHistory': async (params, connection) => {
          const p = paramsObject(params);
          const item = await reached('memory', stringParam(p, 'id'), agentCaller(p, connection, false));
          return memoryHistory(item, stringParam(p, 'entry'));
        },
        'board.newQueue': async (params, connection) => {
          const p = paramsObject(params);
          const audience = p.audience ?? 'agents';
          if (!(QUEUE_AUDIENCES as readonly unknown[]).includes(audience)) throw invalidParams(`audience must be one of ${QUEUE_AUDIENCES.join(', ')}`);
          return newCard(agentCaller(p, connection, true), 'queue', stringParam(p, 'title'), audience as QueueAudience);
        },
        'board.listQueues': async (params, connection) => listFor('queue', agentCaller(paramsObject(params), connection, false)),
        'board.readQueue': async (params, connection) => {
          const p = paramsObject(params);
          const item = await reached('queue', stringParam(p, 'id'), agentCaller(p, connection, false));
          return { item, jobs: jobsOf(item.id) };
        },
        'board.changeQueue': async (params, connection) => {
          const p = paramsObject(params);
          const me = agentCaller(p, connection, true);
          const change = queueChange(p.change);
          const item = await reached('queue', stringParam(p, 'id'), me);
          const job = changeQueue(item, change, me);
          return { item: await touch(item), job };
        },
        'board.drainQueue': async (params, connection) => {
          const p = paramsObject(params);
          const me = agentCaller(p, connection, true);
          // Starting agents is an orchestrator's (ADR-0011): checked here too, as the CLI calls with its token alone.
          if (me.orchestrate === null) throw new RpcMethodError(BOARD_ERROR.notAllowed, `board.drainQueue is only for an orchestrator: ${me.name} doesn't orchestrate`);
          const item = await reached('queue', stringParam(p, 'id'), me);
          const data = dataOf(item) as QueueData;
          if (!sameWho(data.madeBy, agentWho(me))) throw outOfScope(`“${data.title}” isn't yours: an agent turns on the drain of a queue it made, and the user any`);
          if (typeof p.on !== 'boolean') throw invalidParams('on must be true or false');
          const most = p.most ?? data.drain?.most ?? 2;
          const settings: QueueDrain = { harness: me.harness, model: null, role: null, closeWhenDone: true, started: [], ...data.drain, on: p.on, most: most as number };
          return options.call('item.update', { id: item.id, data: { drain: settings } });
        },
        'board.queueHistory': async (params, connection) => {
          const p = paramsObject(params);
          const item = await reached('queue', stringParam(p, 'id'), agentCaller(p, connection, false));
          return queueHistory(item, stringParam(p, 'job'));
        },
        'memory.read': async (params) => {
          const p = paramsObject(params);
          return memoryView(await itemOf('memory', stringParam(p, 'id')), optionalStringParam(p, 'search'), optionalStringParam(p, 'entry'), null);
        },
        'memory.change': async (params) => {
          const p = paramsObject(params);
          const change = memoryChange(p.change);
          const item = await itemOf('memory', stringParam(p, 'id'));
          const entry = changeMemory(item, change, USER);
          return { item: await touch(item), entry };
        },
        'memory.history': async (params) => {
          const p = paramsObject(params);
          return memoryHistory(await itemOf('memory', stringParam(p, 'id')), stringParam(p, 'entry'));
        },
        'queue.read': async (params) => {
          const item = await itemOf('queue', stringParam(paramsObject(params), 'id'));
          return { item, jobs: jobsOf(item.id) };
        },
        'queue.change': async (params) => {
          const p = paramsObject(params);
          const change = queueChange(p.change);
          const item = await itemOf('queue', stringParam(p, 'id'));
          const job = changeQueue(item, change, null);
          return { item: await touch(item), job };
        },
        'queue.hand': async (params) => {
          const p = paramsObject(params);
          const item = await itemOf('queue', stringParam(p, 'id'));
          const job = await handOn(item, stringParam(p, 'job'), stringParam(p, 'sessionId'), stringParam(p, 'text'));
          return { item: await touch(item), job };
        },
        'queue.taken': async () => {
          const queues = new Map((await itemsOf('queue')).map((item) => [item.id, item]));
          return (sql.takenJobs.all() as unknown as JobRow[]).flatMap((row) => {
            const item = queues.get(row.item_id);
            const job = toJob(sql.job.get(row.id) as unknown as JobRow);
            return item === undefined || job.takenBy?.kind !== 'agent' ? [] : [{ sessionId: job.takenBy.sessionId, queueId: item.id, queueTitle: titleOf(item), job }];
          });
        },
        'queue.history': async (params) => {
          const p = paramsObject(params);
          return queueHistory(await itemOf('queue', stringParam(p, 'id')), stringParam(p, 'job'));
        },
      };
    },
  };
}
