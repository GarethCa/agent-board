// Queues: a board item kind whose contents sit in their own table beside the item (ADR-0005), read and written by agents
// through the board methods and by the user through their own. A queue holds jobs, which agents take, drop back and
// finish, and plain notes. Its scope is where it sits, as a steps card's is (`item-scope.ts`), unless set to No agents.
// Anyone in scope changes anything in it, whoever wrote it: every change is kept as a version, and a version can be put
// back.
//
// Nothing here types at any agent. A take is a lease the taker's session holds: as that session ends (not for a
// restart, nor hibernation), its jobs go back to the front of their queue, each drop counted.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, connectionAgent, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { notReadBecause, readsItem } from './item-scope.ts';
import { isObject } from './json.ts';
import { cutText } from './text-words.ts';
import { jobBrief, jobTextOf, rowNamed } from './queue-lines.ts';
import type { Answered } from './deliveries.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import {
  BOARD_ERROR,
  MAX_HISTORY_VERSIONS,
  MAX_JOB_HEADLINE,
  MAX_JOB_LINK,
  MAX_JOB_RESULT,
  MAX_JOB_TEXT,
  MAX_PLAN_TITLE_LENGTH,
  MAX_QUEUE_OPEN,
  QUEUE_AUDIENCES,
  QUEUE_CARD_SIZE,
  AGENT_QUEUE_KINDS,
  defaultQueueKind,
  isCardSize,
  isQueueWork,
  QUEUE_LATER,
  queueKindOn,
  queueKindsFor,
  type Agent,
  type BoardItem,
  type BoardPlace,
  type DaemonMethods,
  type HistoryVersion,
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
  type DaemonCall,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { AgentHost } from './agents.ts';

type QueueMethods = Pick<
  DaemonMethods,
  | 'board.newQueue'
  | 'board.listQueues'
  | 'board.readQueue'
  | 'board.changeQueue'
  | 'board.queueHistory'
  | 'board.drainQueue'
  | 'queue.read'
  | 'queue.change'
  | 'queue.history'
  | 'queue.hand'
  | 'queue.taken'
>;

export interface QueueHostOptions extends BoardCallerSources {
  agents: Pick<AgentHost, 'get' | 'fallbackOwner' | 'answer' | 'clearUnsent' | 'spawn' | 'stop'>;
  log?: (message: string) => void;
  db: DatabaseSync;
  /** The daemon's own methods: the cards are board items, made and changed through them. */
  call: DaemonCall;
  /** Starts a drained agent with `start` where its tile goes in its queue's zone, as every new agent's goes: one at a time in a zone. */
  placeAgent<T>(zoneId: string, start: (position: { x: number; y: number }) => Promise<T>): Promise<T>;
  /** Closes a drained agent as every close goes, its helpers and reviewers first; refused, before any goes, by unsaved work of its own or its helpers'. */
  close(sessionId: string, why: string): Promise<void>;
  /** Where a new card of the agent's goes: beside its tile. */
  place(sessionId: string, size: { width: number; height: number }): Promise<BoardPlace | undefined>;
  now?: () => Date;
}

/**
 * The most a queue's history holds, its versions' values in bytes: past it, the oldest versions go, those
 * of rows removed since first.
 */
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

/** A drained agent's terminal, as a clock's fresh agent's. */
const DRAIN_SIZE = { cols: 120, rows: 40 };
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
function checkCommon(what: string, data: Record<string, unknown>): void {
  const fail = (problem: string) => invalidParams(`${what}'s ${problem}`);
  if (typeof data.title !== 'string' || data.title.trim() === '' || data.title.length > MAX_PLAN_TITLE_LENGTH) throw fail(`title must be 1 to ${MAX_PLAN_TITLE_LENGTH} characters`);
  if (!isWho(data.madeBy)) throw fail("madeBy must be { kind: 'user' } or { kind: 'agent', sessionId, name }");
  if (typeof data.noAgents !== 'boolean') throw fail('noAgents must be true or false');
  if (data.folded !== undefined && typeof data.folded !== 'boolean') throw fail('folded must be true or false');
  if (data.openSize !== undefined && !isCardSize(data.openSize)) throw fail('openSize must be { width, height }');
  if (data.foldedSize !== undefined && !isCardSize(data.foldedSize)) throw fail('foldedSize must be { width, height }');
  if (!Number.isInteger(data.count) || (data.count as number) < 0) throw fail('count must be a whole number');
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
  result: string | null;
  hidden_until: string | null;
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

/** Work an agent takes: a task, a request or a prompt. Never info, nor a kind from the user's queue. */
const agentsWork = (kind: QueueJob['kind']): boolean => kind !== 'info' && (AGENT_QUEUE_KINDS as readonly string[]).includes(kind);

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
  result: row.result,
  hiddenUntil: row.hidden_until,
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

/** The row `ref` names among `rows`: by its whole id, or the start of its id (at least 4 characters). */
function pick<Row extends { id: string }>(rows: readonly Row[], said: string, what: string): Row | undefined {
  const { ref, row, starts } = rowNamed(rows, said);
  if (ref === '') throw invalidParams(`give the ${what}`);
  if (starts > 1) throw invalidParams(`#${ref} names ${starts} ${what}s: give more of its id`);
  return row;
}

export interface QueueHost {
  /** `items` as the connection may see them: a board-token agent sees only the queues it reads. */
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
   * `item` with its count put right, for a queue whose saved count isn't its rows' (an undo sends an older one
   * back); `changed`, its jobs or drain were, so its drain may start an agent. A queue whose audience changed has its
   * rows' kinds moved over to the kinds it now takes (`queueKindOn`), so the user's things to read are never an agent's work.
   */
  recounted(item: BoardItem, changed: boolean): Promise<BoardItem>;
  /** Keeps the agents a queue's drain started as the daemon has them, in an update that isn't the daemon's own. */
  keepStarted(params: unknown): void;
  /** An agent's turn ended: a drained one done with its job is closed, if its drain says so. */
  turnEnded(sessionId: string): void;
  /** Refuses an update that makes a queue the user's while an agent holds one of its jobs. */
  checkUpdate(params: unknown): void;
  handlers<Context extends BoardConnection>(): RpcHandlers<QueueMethods, Context>;
}

export function createQueueHost(options: QueueHostOptions): QueueHost {
  const { db } = options;
  const now = () => (options.now?.() ?? new Date()).toISOString();

  // Rows whose item is gone for good: an item deleted and not made again before the daemon started.
  db.exec(`
    DELETE FROM queue_jobs WHERE item_id NOT IN (SELECT id FROM board_items);
    DELETE FROM board_history WHERE item_id NOT IN (SELECT id FROM board_items);
  `);

  const sql = {
    jobs: db.prepare(`SELECT ${JOB_COLUMNS} FROM queue_jobs WHERE item_id = ? ORDER BY done_at IS NOT NULL, CASE WHEN done_at IS NULL THEN position END, done_at DESC, id`),
    job: db.prepare(`SELECT ${JOB_COLUMNS} FROM queue_jobs WHERE id = ?`),
    heldIn: db.prepare('SELECT COUNT(*) AS n FROM queue_jobs WHERE item_id = ? AND taken_by IS NOT NULL AND done_at IS NULL'),
    openCount: db.prepare('SELECT COUNT(*) AS n FROM queue_jobs WHERE item_id = ? AND done_at IS NULL'),
    ends: db.prepare('SELECT MIN(position) AS front, MAX(position) AS back FROM queue_jobs WHERE item_id = ? AND done_at IS NULL'),
    insertJob: db.prepare(
      'INSERT INTO queue_jobs (id, item_id, kind, text, link, position, drops, made_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updateJob: db.prepare(
      'UPDATE queue_jobs SET text = ?, link = ?, position = ?, taken_by = ?, taken_at = ?, drops = ?, done_by = ?, done_at = ?, result = ?, hidden_until = ?, updated_at = ? WHERE id = ?',
    ),
    deleteJob: db.prepare('DELETE FROM queue_jobs WHERE id = ?'),
    placeJob: db.prepare('UPDATE queue_jobs SET position = ? WHERE id = ?'),
    hideJob: db.prepare('UPDATE queue_jobs SET hidden_until = ?, updated_at = ? WHERE id = ?'),
    kindsIn: db.prepare('SELECT id, kind FROM queue_jobs WHERE item_id = ?'),
    setKind: db.prepare('UPDATE queue_jobs SET kind = ? WHERE id = ?'),
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
       ORDER BY EXISTS (SELECT 1 FROM queue_jobs WHERE id = h.row_id), seq`,
    ),
    deleteHistory: db.prepare('DELETE FROM board_history WHERE seq = ?'),
    takenJobs: db.prepare('SELECT * FROM queue_jobs WHERE taken_by IS NOT NULL AND done_at IS NULL'),
    // A row keeps its newest `keep` versions.
    trimHistory: db.prepare(
      'DELETE FROM board_history WHERE item_id = ? AND row_id = ? AND seq < (SELECT MIN(seq) FROM (SELECT seq FROM board_history WHERE item_id = ? AND row_id = ? ORDER BY seq DESC LIMIT ?))',
    ),
  };

  const jobsOf = (itemId: string) => (sql.jobs.all(itemId) as unknown as JobRow[]).map(toJob);

  const remember = (itemId: string, rowId: string, action: string, value: QueueJob | null, by: StepsWho, at: string) => {
    sql.addHistory.run(itemId, rowId, action, value === null ? null : JSON.stringify(value), JSON.stringify(by), at);
    sql.trimHistory.run(itemId, rowId, itemId, rowId, MAX_HISTORY_VERSIONS);
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

  /** A job by `ref`, now or, with `past`, as its history last had it (one removed since). */
  const pastRow = <Row extends { id: string }>(itemId: string, ref: string, what: string): Row | undefined => {
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

  const itemsOf = async (kind: 'queue') => (await options.call('item.list', { allBoards: true })).filter((item) => item.kind === kind);
  const itemOf = async (kind: 'queue', id: string): Promise<BoardItem> => {
    const found = (await itemsOf(kind)).find((item) => item.id === id);
    if (found === undefined) throw invalidParams(`no ${kind} ${id}`);
    return found;
  };
  const dataOf = (item: BoardItem) => item.data as unknown as QueueData;
  const titleOf = (item: BoardItem) => dataOf(item).title;

  /** The card's count brought up to date, which also tells the app it changed. */
  const countOf = (item: BoardItem) => (sql.openCount.get(item.id) as { n: number }).n;
  const touch = async (item: BoardItem): Promise<BoardItem> => options.call('item.update', { id: item.id, data: { count: countOf(item) } });

  // ---- who calls ----

  const reads = (agent: Agent, item: BoardItem) => !dataOf(item).noAgents && readsItem(agent, item, sameWho(dataOf(item).madeBy, agentWho(agent)));

  /** The agent whose board token the call holds; with `live`, only its own live session. */
  const agentCaller = (p: Record<string, unknown>, connection: BoardConnection, live: boolean): Agent => {
    const who = boardCaller(options, stringParam(p, 'token'), connection);
    const me = who.kind === 'agent' ? options.agents.get(who.tileId) : undefined;
    if (me === undefined) throw invalidParams('only an agent uses queues: not a shell');
    if (live && !isOwnLiveSession(me, who.sessionId)) throw invalidParams("only a live agent changes queues, from its own session: not an ended agent's");
    return me;
  };

  /** The card `id` of `kind`, refused if `me` (an agent) doesn't read it. */
  const reached = async (kind: 'queue', id: string, me: Agent | null): Promise<BoardItem> => {
    const item = await itemOf(kind, id);
    if (me !== null && !reads(me, item)) {
      throw outOfScope(
        dataOf(item).noAgents ? `“${titleOf(item)}” is set to No agents: only the user reads it` : notReadBecause(`that ${kind}`, item),
      );
    }
    return item;
  };

  const newCard = async (me: Agent, rawTitle: string, audience?: QueueAudience): Promise<BoardItem> => {
    const title = rawTitle.trim();
    if (title === '' || title.length > MAX_PLAN_TITLE_LENGTH) throw invalidParams(`title must be 1 to ${MAX_PLAN_TITLE_LENGTH} characters`);
    const size = QUEUE_CARD_SIZE;
    const spot = (await options.place(me.sessionId, size)) ?? { zoneId: me.zoneId, x: 0, y: 0 };
    const data = { title, madeBy: agentWho(me), noAgents: false, count: 0, audience: audience ?? 'agents' };
    return options.call('item.create', { kind: 'queue', ...spot, ...size, data });
  };
  /** The value version `version` of the row left, refused for one that isn't the row's or a remove's. */
  const versionValue = <Row>(item: BoardItem, rowId: string, version: unknown): Row => {
    if (!Number.isInteger(version)) throw invalidParams('version must be a version number, as history lists them');
    const row = sql.version.get(item.id, rowId, version as number) as HistoryRow | undefined;
    if (row === undefined) throw invalidParams(`there is no version ${String(version)} of that in “${titleOf(item)}”: history lists them`);
    if (row.value === null) throw invalidParams(`version ${String(version)} removed it: restore one before`);
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
    if (typeof text !== 'string' || text.trim() === '' || text.trim().length > MAX_JOB_TEXT) throw invalidParams(`a queue row's text is 1 to ${MAX_JOB_TEXT} characters`);
    return text.trim();
  };
  /** An add's text: given whole, or as a headline (one short line) and a body. */
  const addText = (change: Extract<QueueChange, { action: 'add' }>): string => {
    if (change.headline === undefined) {
      if (change.body !== undefined) throw invalidParams('a body goes with a headline: give both, or the text whole');
      return jobText(change.text);
    }
    if (change.text !== undefined) throw invalidParams('give the text whole, or a headline and a body: not both');
    const { headline, body } = change;
    if (typeof headline !== 'string' || headline.trim() === '' || headline.trim().length > MAX_JOB_HEADLINE || /[\r\n]/.test(headline)) {
      throw invalidParams(`a headline is one line of 1 to ${MAX_JOB_HEADLINE} characters: put the rest in the body`);
    }
    if (body !== undefined && typeof body !== 'string') throw invalidParams('body must be a string');
    return jobText(jobTextOf(headline, body));
  };
  /** The kind an add asks for, of those its queue takes: the names before kinds read as its default, or info. */
  const kindFor = (audience: QueueData['audience'], kind: unknown): QueueJob['kind'] => {
    const kinds = queueKindsFor(audience);
    if (kind === undefined || kind === 'job') return defaultQueueKind(audience);
    if (kind === 'note') return queueKindOn(audience, 'info');
    if (!(kinds as readonly unknown[]).includes(kind)) throw invalidParams(`kind must be one of ${kinds.join(', ')}${audience === 'user' ? " on the user's queue" : ''}`);
    return kind as QueueJob['kind'];
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
    sql.updateJob.run(row.text, row.link, row.position, row.taken_by, row.taken_at, row.drops, row.done_by, row.done_at, row.result, row.hidden_until, at, row.id);
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

  /** A done job's result: none, or a short text. */
  const doneResult = (result: unknown): string | null => {
    if (result === undefined || result === null || (typeof result === 'string' && result.trim() === '')) return null;
    if (typeof result !== 'string' || result.trim().length > MAX_JOB_RESULT) throw invalidParams(`a result is at most ${MAX_JOB_RESULT} characters`);
    return result.trim();
  };
  /** Put off, and not back yet: marked Later, or put off until a time still ahead. No take without a job, nor a drain, starts it. */
  const hidden = (row: JobRow, at = now()) => row.hidden_until !== null && row.hidden_until > at;
  /** Refuses to start a job put off: it is moved up first. */
  const notPutOff = (row: JobRow) => {
    if (!hidden(row)) return;
    throw invalidParams(row.hidden_until === QUEUE_LATER ? `#${row.id.slice(0, 8)} is marked Later: move it up first` : `#${row.id.slice(0, 8)} is put off until ${row.hidden_until}: show it again first`);
  };
  /** When a job put off for later comes back: a time, as ISO 8601. */
  const laterParam = (until: unknown): string => {
    const at = typeof until === 'string' ? Date.parse(until) : Number.NaN;
    if (Number.isNaN(at)) throw invalidParams('until must be a time (ISO 8601), or null to show it again');
    return new Date(at).toISOString();
  };

  /** Each row's kind as the queue's audience takes it, after a change of hands: whether any moved. Not a version. */
  const fitKinds = (item: BoardItem): boolean =>
    transaction(() => {
      const { audience } = dataOf(item) as QueueData;
      let moved = false;
      for (const row of sql.kindsIn.all(item.id) as unknown as { id: string; kind: QueueJob['kind'] }[]) {
        const kind = queueKindOn(audience, row.kind);
        if (kind !== row.kind) {
          sql.setKind.run(kind, row.id);
          moved = true;
        }
      }
      return moved;
    });

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
      /** An open job of the user's queue, changed by the user alone: `doing` it is theirs to do. */
      const userOnly = (queue: BoardItem, ref: string, doing: string): JobRow => {
        if (data.audience !== 'user') throw invalidParams(`“${data.title}” is for agents: only the user's queue has skip`);
        return ownRow(queue, ref, doing);
      };
      /** An open row of the user's queue, changed by the user alone. */
      const ownRow = (queue: BoardItem, ref: string, doing: string): JobRow => {
        if (me !== null) throw outOfScope(`only the user ${doing} a row on their queue`);
        const row = jobFor(queue, ref);
        if (row.done_at !== null) throw invalidParams(`#${row.id.slice(0, 8)} is done: only an open one ${doing === 'skips' ? 'is skipped' : 'is put off'}`);
        return row;
      };
      /** A waiting job of an agents' queue, marked Later or moved up by an agent or the user: not info, nor one taken, or starting. */
      const waitingRow = (queue: BoardItem, ref: string): JobRow => {
        const row = jobFor(queue, ref);
        if (!agentsWork(row.kind)) throw invalidParams(`#${row.id.slice(0, 8)} is info: only a task, a request or a prompt is marked Later`);
        if (row.done_at !== null) throw invalidParams(`#${row.id.slice(0, 8)} is done: only an open one is put off`);
        if (row.taken_by !== null) throw invalidParams(`#${row.id.slice(0, 8)} is taken: it is its taker's until done, or dropped back`);
        notStarting(row);
        return row;
      };
      // Finished, dropped or removed meanwhile, it would leave the starting agent with nothing: an edit or a move is fine.
      if (change.action === 'done' || change.action === 'drop' || change.action === 'remove' || change.action === 'later') {
        const named = pick(jobRows(item.id), change.job, 'job');
        if (named !== undefined) notStarting(named);
      }
      switch (change.action) {
        case 'add': {
          const kind = kindFor(data.audience, change.kind);
          return insertJob(item, randomUUID(), kind, addText(change), linkParam(change.link), change.front === true ? front(item.id) : back(item.id), by, 'add');
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
          const row = change.job === undefined ? rows.find((each) => agentsWork(each.kind) && each.taken_by === null && each.done_at === null && !starting.has(each.id) && !hidden(each)) : jobFor(item, change.job);
          if (row === undefined) throw invalidParams(`“${data.title}” has no job waiting to be taken`);
          notStarting(row);
          if (!agentsWork(row.kind)) throw invalidParams(`#${row.id.slice(0, 8)} is ${row.kind}: only a task, a request or a prompt is taken`);
          if (row.done_at !== null) throw invalidParams(`job #${row.id.slice(0, 8)} is done already`);
          if (row.taken_by !== null) {
            const taker = JSON.parse(row.taken_by) as StepsWho;
            if (sameWho(taker, by)) return toJob(row);
            throw outOfScope(`${whoName(taker)} has job #${row.id.slice(0, 8)} already`);
          }
          notPutOff(row);
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
          if (!isQueueWork(row.kind)) throw invalidParams(`#${row.id.slice(0, 8)} is info: it is read, not done`);
          if (row.done_at !== null) throw invalidParams(`job #${row.id.slice(0, 8)} is done already`);
          notHeldByOther(row, 'finishes');
          const result = doneResult(change.result);
          return putJob(item, { ...row, taken_by: null, taken_at: null, done_by: JSON.stringify(by), done_at: now(), result, hidden_until: null }, by, 'done');
        }
        case 'later': {
          // Without `until`, marked Later (a time that never comes); null moves it up. A time is for the user's queue alone:
          // nothing wakes an agents' drain as one passes.
          const row = data.audience === 'user' ? ownRow(item, change.job, 'puts off') : waitingRow(item, change.job);
          if (data.audience !== 'user' && change.until !== undefined && change.until !== null) throw invalidParams(`“${data.title}” is for agents: its jobs are marked Later, with no time, until moved up`);
          const until = change.until === undefined ? QUEUE_LATER : change.until === null ? null : laterParam(change.until);
          // Told it moved up, an agent that named the wrong job would never know.
          if (data.audience !== 'user' && until === null && row.hidden_until === null) throw invalidParams(`#${row.id.slice(0, 8)} isn't marked Later: it waits in its place already`);
          if (until === row.hidden_until) return toJob(row);
          // Not a version, as a move isn't: the row is as it was, and twenty put-offs would push its edits out of its history.
          sql.hideJob.run(until, now(), row.id);
          return toJob(sql.job.get(row.id) as unknown as JobRow);
        }
        case 'skip': {
          const row = userOnly(item, change.job, 'skips');
          const at_ = now();
          if (hidden(row, at_)) throw invalidParams(`#${row.id.slice(0, 8)} is put off until ${row.hidden_until}: show it again to skip it`);
          // Behind the next open one the queue shows (one put off stays where it is), or the last: the rest renumbered in
          // order, as a move does. Not a version: the row is as it was.
          const open = jobRows(item.id).filter((each) => each.done_at === null);
          const at = open.findIndex((each) => each.id === row.id);
          const past = open.findIndex((each, index) => index > at && !hidden(each, at_));
          if (past < 0) return toJob(row);
          open.splice(at, 1);
          open.splice(past, 0, row);
          open.forEach((each, index) => index + 1 !== each.position && sql.placeJob.run(index + 1, each.id));
          return toJob(sql.job.get(row.id) as unknown as JobRow);
        }
        case 'restore': {
          const current = pick(jobRows(item.id), change.job, 'job');
          const rowId = current?.id ?? pastRow<QueueJob>(item.id, change.job, 'job')?.id;
          if (rowId === undefined) throw invalidParams(`“${data.title}” has no job ${change.job}, nor any history of one`);
          const value = versionValue<QueueJob>(item, rowId, change.version);
          // A removed job comes back with its drops counted, as it was; a take it had is not given back.
          // Its kind as this queue now takes it: the queue may have changed hands since.
          if (current === undefined) return insertJob(item, rowId, queueKindOn(data.audience, value.kind), value.text, value.link, back(item.id), by, 'restore', value.drops);
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
  const queueChange = (value: unknown) => checkedChange<QueueChange>(value, ['add', 'edit', 'remove', 'take', 'drop', 'done', 'restore', 'move', 'later', 'skip']);

  const queueHistory = (item: BoardItem, ref: string) => {
    const rowId = pick(jobRows(item.id), ref, 'job')?.id ?? pastRow<QueueJob>(item.id, ref, 'job')?.id;
    if (rowId === undefined) throw invalidParams(`“${titleOf(item)}” has no job ${ref}, nor any history of one`);
    return versionsOf<QueueJob>(item.id, rowId);
  };

  /**
   * The user hands a waiting job to an idle agent the queue is for (its zone's, or any for a loose one): taken for it, then `text` typed at its prompt.
   * A send that fails puts the job back as it was, so no agent holds a job it never heard of.
   */
  const handOn = async (item: BoardItem, ref: string, sessionId: string, rawText: string): Promise<QueueJob> => {
    const data = dataOf(item) as QueueData;
    if (data.audience === 'user') throw invalidParams(`“${data.title}” is the user's queue: its jobs are for them, not handed to agents`);
    const agent = options.agents.get(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    if (!reads(agent, item)) throw outOfScope(`${agent.name} doesn't use “${data.title}”: hand it a job from a queue in its zone, or a loose one`);
    if (!takesHandOn(agent)) throw invalidParams(`${agent.name} is busy or asking you something: hand a job to an idle agent`);
    const text = rawText.trim();
    if (text === '' || text.length > MAX_JOB_TEXT) throw invalidParams(`the message is 1 to ${MAX_JOB_TEXT} characters`);
    const before = jobFor(item, ref);
    const taker = JSON.stringify(agentWho(agent));
    const taken = transaction(() => {
      if (!agentsWork(before.kind)) throw invalidParams(`#${before.id.slice(0, 8)} is ${before.kind}: only a task, a request or a prompt is handed on`);
      if (before.done_at !== null || before.taken_by !== null) throw invalidParams(`job #${before.id.slice(0, 8)} isn't waiting: only a waiting job is handed on`);
      if (starting.has(before.id)) throw invalidParams(`an agent is starting for job #${before.id.slice(0, 8)}: it is that agent's`);
      notPutOff(before);
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
    // Held as the user types there (only another agent's message is, never the board's): the agent never got it.
    if ('userTyping' in answered) {
      undo();
      throw invalidParams(`${agent.name} didn't get it (the user is typing at its prompt): the job is waiting again`);
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
      const next = rows.find((row) => agentsWork(row.kind) && row.taken_by === null && row.done_at === null && row.drops < MAX_DRAIN_DROPS && !starting.has(row.id) && !hidden(row));
      if (next === undefined || held >= settings.most) return;
      starting.add(next.id);
      let agent: Agent;
      try {
        agent = await options.placeAgent(item.zoneId, (position) =>
          options.agents.spawn({
            zoneId: item.zoneId,
            position,
            harness: settings.harness,
            model: settings.model ?? undefined,
            role: settings.role ?? undefined,
            name: cutText(next.text.split('\n', 1)[0]!.trim(), MAX_DRAIN_NAME),
            prompt: jobBrief({ title: data.title, ref: itemRef(item) }, next.id, next.text, next.link, 'taken for you'),
            ...DRAIN_SIZE,
          }),
        );
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
        await options.close(sessionId, 'its queue job is done').catch(() => options.agents.stop(sessionId, 'its queue job is done').catch(() => {}));
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

  const listFor = async (kind: 'queue', me: Agent) => (await itemsOf(kind)).filter((item) => reads(me, item));

  return {
    visible(items, connection) {
      const me = connectionAgent(options, connection);
      if (me === undefined) return items;
      if (me === null) return items.filter((item) => item.kind !== 'queue');
      return items.filter((item) => item.kind !== 'queue' || reads(me, item));
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
      if (item.kind !== 'queue') return item;
      const moved = fitKinds(item);
      // A change to its jobs (its count saved) or to its drain may let its drain start the next agent; a move doesn't.
      if (changed || moved) void drain(item.id);
      return dataOf(item).count === countOf(item) && !moved ? item : touch(item);
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

    handlers<Context extends BoardConnection>(): RpcHandlers<QueueMethods, Context> {
      return {
        'board.newQueue': async (params, connection) => {
          const p = paramsObject(params);
          const audience = p.audience ?? 'agents';
          if (!(QUEUE_AUDIENCES as readonly unknown[]).includes(audience)) throw invalidParams(`audience must be one of ${QUEUE_AUDIENCES.join(', ')}`);
          return newCard(agentCaller(p, connection, true), stringParam(p, 'title'), audience as QueueAudience);
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
