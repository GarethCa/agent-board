// Agent records: what an agent writes about its own work for its sidebar (the pull requests it opened, its hand-off
// docs, the agents it started, what it pinned for the user to see), kept per agent in the daemon. What the daemon guesses (gh, hooks) only fills the gaps.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pullRequestKey, pullRequestOfUrl } from '@agent-board/tracker';
import { isObject } from './json.ts';
import { isWebTabUrl, WEB_TAB_RULE } from './web-url.ts';
import { invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  AGENT_RECORD_KINDS,
  MAX_DOC_BYTES,
  MAX_PIN_LABEL,
  MAX_PIN_NOTE,
  MAX_PIN_URL,
  type Agent,
  type AgentRecord,
  type AgentRecordKind,
  type DaemonMethods,
  type PinRef,
  type PinTarget,
  type RecordParams,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type RecordMethods = Pick<DaemonMethods, 'agent.setRecordDeleted' | 'agent.readDoc'>;

/** The most characters of a recorded pull request's title. */
const MAX_TITLE = 300;
/** Where in its worktree an agent writes its handover, as the role templates ask: guessed as a hand-off doc. */
const HANDOVER_DOC = join('.agent-board', 'handover.md');

/** A record as it is written: its kind, key and data, without what the store adds. */
export type NewRecord = DistributiveOmit<AgentRecord, 'recordedAt' | 'deletedAt'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface RecordRow {
  kind: string;
  key: string;
  data: string;
  recorded_at: string;
  deleted_at: string | null;
}

export interface AgentRecordStore {
  /** The agent's records, deleted ones too, oldest first. */
  of(sessionId: string): AgentRecord[];
  /**
   * Records `record` on the agent, replacing one of the same kind and key (but for a pull request's title, kept when the
   * new one has none), and bringing it back if it was deleted.
   */
  put(sessionId: string, record: NewRecord): AgentRecord;
  /** Deletes the record, or brings it back; false when the agent has no such record. */
  setDeleted(sessionId: string, kind: AgentRecordKind, key: string, deleted: boolean): boolean;
  /** Takes the record off, row and all, as an agent unpinning does; the record it was, or undefined for none. */
  remove(sessionId: string, kind: AgentRecordKind, key: string): AgentRecord | undefined;
}

export function createAgentRecordStore(db: DatabaseSync): AgentRecordStore {
  const selectOf = db.prepare('SELECT kind, key, data, recorded_at, deleted_at FROM agent_records WHERE session_id = ? ORDER BY recorded_at, rowid');
  const selectOne = db.prepare('SELECT kind, key, data, recorded_at, deleted_at FROM agent_records WHERE session_id = ? AND kind = ? AND key = ?');
  const upsert = db.prepare(
    `INSERT INTO agent_records (session_id, kind, key, data) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, kind, key) DO UPDATE SET data = excluded.data, deleted_at = NULL,
       recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const updateDeleted = db.prepare(
    `UPDATE agent_records SET deleted_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
     WHERE session_id = ? AND kind = ? AND key = ?`,
  );
  const deleteOne = db.prepare('DELETE FROM agent_records WHERE session_id = ? AND kind = ? AND key = ?');
  return {
    of: (sessionId) => (selectOf.all(sessionId) as unknown as RecordRow[]).flatMap((row) => recordOfRow(row) ?? []),
    put(sessionId, record) {
      const { kind, key, ...data } = record;
      if (record.kind === 'pr' && record.title === null) {
        const row = selectOne.get(sessionId, kind, key) as unknown as RecordRow | undefined;
        const was = row === undefined ? undefined : recordOfRow(row);
        if (was?.kind === 'pr') Object.assign(data, { title: was.title });
      }
      upsert.run(sessionId, kind, key, JSON.stringify(data));
      return recordOfRow(selectOne.get(sessionId, kind, key) as unknown as RecordRow)!;
    },
    setDeleted(sessionId, kind, key, deleted) {
      const row = selectOne.get(sessionId, kind, key) as unknown as RecordRow | undefined;
      if (row === undefined) return false;
      // Deleting again keeps when it was first deleted.
      if ((row.deleted_at !== null) !== deleted) updateDeleted.run(deleted ? 1 : 0, sessionId, kind, key);
      return true;
    },
    remove(sessionId, kind, key) {
      const row = selectOne.get(sessionId, kind, key) as unknown as RecordRow | undefined;
      if (row === undefined) return undefined;
      deleteOne.run(sessionId, kind, key);
      return recordOfRow(row);
    },
  };
}

/** A stored row as a record; undefined for one this daemon can't read, which is left alone. */
function recordOfRow(row: RecordRow): AgentRecord | undefined {
  if (!(AGENT_RECORD_KINDS as readonly string[]).includes(row.kind)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    return undefined;
  }
  if (!isObject(data)) return undefined;
  const base = { key: row.key, recordedAt: row.recorded_at, deletedAt: row.deleted_at };
  const from = isObject(data.from) && typeof data.from.sessionId === 'string' && typeof data.from.name === 'string' ? { sessionId: data.from.sessionId, name: data.from.name } : null;
  if (row.kind === 'pr') {
    return typeof data.url === 'string' ? { ...base, kind: 'pr', url: data.url, title: typeof data.title === 'string' ? data.title : null } : undefined;
  }
  if (row.kind === 'doc') return typeof data.path === 'string' ? { ...base, kind: 'doc', path: data.path, from } : undefined;
  if (row.kind === 'pin') {
    const target = pinTargetOf(data.target);
    return target === undefined ? undefined : { ...base, kind: 'pin', target, label: typeof data.label === 'string' ? data.label : null, from };
  }
  return { ...base, kind: 'crew' };
}

/** The record of the pull request `url` names, by its plain URL; undefined for a URL that names none. */
export function pullRequestRecord(url: string, title: string | null): NewRecord | undefined {
  const ref = pullRequestOfUrl(url);
  return ref === undefined ? undefined : { kind: 'pr', key: pullRequestKey(ref), url: `https://github.com/${ref.repo}/pull/${ref.number}`, title };
}

/** `board.record`'s params past the token, checked. */
export function recordParams(params: Record<string, unknown>): RecordParams {
  const kind = stringParam(params, 'kind');
  if (kind === 'pr') {
    const title = optionalStringParam(params, 'title')?.trim();
    return { kind, url: stringParam(params, 'url').trim(), ...(title ? { title: title.slice(0, MAX_TITLE) } : {}) };
  }
  if (kind === 'doc') return { kind, path: stringParam(params, 'path'), forOrchestrator: optionalBooleanParam(params, 'forOrchestrator') ?? false };
  if (kind === 'pin') {
    const label = optionalStringParam(params, 'label');
    return {
      kind,
      ...exactlyOne(params, ['path', 'url', 'note'], 'pin one of path, url or note'),
      ...(label === undefined ? {} : { label }),
      forOrchestrator: optionalBooleanParam(params, 'forOrchestrator') ?? false,
    };
  }
  throw invalidParams(`kind must be pr, doc or pin, not ${kind}`);
}

/** `board.unpin`'s params past the token, checked: exactly one of a file's path, a link, or a note's label. */
export function pinRefParams(params: Record<string, unknown>): PinRef {
  return {
    ...exactlyOne(params, ['path', 'url', 'label'], "unpin one of path, url or a note's label"),
    forOrchestrator: optionalBooleanParam(params, 'forOrchestrator') ?? false,
  };
}

/** The one string param of `names` that was given, as an object of it alone; refused with `message` unless exactly one was. */
function exactlyOne<Name extends string>(params: Record<string, unknown>, names: readonly Name[], message: string): Partial<Record<Name, string>> {
  const given = names.flatMap((name) => {
    const value = optionalStringParam(params, name);
    return value === undefined ? [] : [[name, value] as const];
  });
  if (given.length !== 1) throw invalidParams(message);
  return Object.fromEntries(given) as Partial<Record<Name, string>>;
}

/**
 * What `board.record` writes, and on whom: `caller`'s own sidebar, or for a doc or a pin `forOrchestrator`, the
 * orchestrator's that started it. A doc's (or a pinned file's) relative path is from where the caller's session started;
 * it must be a file, and is kept by its real path, through any link, so one file is one entry however it was named.
 */
export function recordFor(
  caller: Pick<Agent, 'sessionId' | 'name' | 'cwd' | 'spawnedBy'>,
  params: RecordParams,
  agents: { get(sessionId: string): Pick<Agent, 'sessionId'> | undefined },
): { on: string; record: NewRecord } {
  if (params.kind === 'pr') {
    const record = pullRequestRecord(params.url, params.title ?? null);
    if (record === undefined) throw invalidParams(`${params.url} is not a GitHub pull request URL (https://github.com/owner/repo/pull/n)`);
    return { on: caller.sessionId, record };
  }
  const { on, from } = scopeOf(caller, params.forOrchestrator ?? false, agents);
  if (params.kind === 'doc') {
    const path = realFile(caller.cwd, params.path);
    return { on, record: { kind: 'doc', key: path, path, from } };
  }
  const target = pinTargetFor(caller.cwd, params);
  const label = labelOf(params.label ?? '') || null;
  if (target.kind === 'note' && label === null) throw invalidParams('a note needs a label, which names it on the sidebar');
  if (label !== null && label.length > MAX_PIN_LABEL) throw invalidParams(`a pin's label is at most ${MAX_PIN_LABEL} characters`);
  return { on, record: { kind: 'pin', key: authoredKey(pinKey(target, label), from), target, label, from } };
}

/**
 * Where `board.unpin` takes a pin off, and its key: a file named as `recordFor` names it (by its real path while it is
 * there, else as named), a link as it was pinned, a note by its label; on the orchestrator's sidebar, only among the
 * caller's own pins there.
 */
export function unpinFor(
  caller: Pick<Agent, 'sessionId' | 'name' | 'cwd' | 'spawnedBy'>,
  ref: PinRef,
  agents: { get(sessionId: string): Pick<Agent, 'sessionId'> | undefined },
): { on: string; key: string } {
  const { on, from } = scopeOf(caller, ref.forOrchestrator ?? false, agents);
  return { on, key: authoredKey(pinRefKey(caller.cwd, ref), from) };
}

/** A pin's key as `unpin` names it, before whose it is. */
function pinRefKey(cwd: string, ref: PinRef): string {
  if (ref.url !== undefined) return pinKey(linkTarget(ref.url), null);
  if (ref.label !== undefined) return noteKey(labelOf(ref.label));
  const named = resolve(cwd, (ref.path ?? '').trim());
  return isFile(named) ? realpathSync(named) : realFolderOf(named);
}

/**
 * A pin's key on the sidebar it is on: as it is for the agent's own, and under the crew member's session for one it
 * pinned for its orchestrator, so a crew member's pin never replaces, nor its unpin removes, the orchestrator's own or
 * another crew member's.
 */
const authoredKey = (key: string, from: { sessionId: string } | null): string => (from === null ? key : `from:${from.sessionId}:${key}`);

/** A label as it names a pin: its runs of whitespace (line breaks, tabs) one space, trimmed. */
const labelOf = (label: string): string => label.replace(/\s+/g, ' ').trim();

/** A path gone from disk, through its folder's real path while that is there, as it was kept when it was. */
function realFolderOf(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

/** Whose sidebar a record goes on: the caller's own, or `forOrchestrator`, the orchestrator's that started it, saying who it is from. */
function scopeOf(
  caller: Pick<Agent, 'sessionId' | 'name' | 'spawnedBy'>,
  forOrchestrator: boolean,
  agents: { get(sessionId: string): Pick<Agent, 'sessionId'> | undefined },
): { on: string; from: { sessionId: string; name: string } | null } {
  if (!forOrchestrator) return { on: caller.sessionId, from: null };
  const orchestrator = caller.spawnedBy === null ? undefined : agents.get(caller.spawnedBy);
  if (orchestrator === undefined) throw invalidParams('no orchestrator started you: record it on your own sidebar, without for orchestrator');
  return { on: orchestrator.sessionId, from: { sessionId: caller.sessionId, name: caller.name } };
}

/** The file `path` names from `cwd`, by its real path; refused unless it is a file. */
function realFile(cwd: string, path: string): string {
  const named = resolve(cwd, path.trim());
  if (path.trim() === '' || !isFile(named)) throw invalidParams(`${path} is not a file${isAbsolute(path) ? '' : ` in ${cwd}`}`);
  return realpathSync(named);
}

/** What a pin's params name: a file by its real path, a link, or a note, each checked. */
function pinTargetFor(cwd: string, params: Extract<RecordParams, { kind: 'pin' }>): PinTarget {
  if (params.path !== undefined) return { kind: 'file', path: realFile(cwd, params.path) };
  if (params.url !== undefined) return linkTarget(params.url);
  const text = (params.note ?? '').trim();
  if (text === '') throw invalidParams('a note needs some text');
  if (text.length > MAX_PIN_NOTE) throw invalidParams(`a pinned note is at most ${MAX_PIN_NOTE} characters`);
  return { kind: 'note', text };
}

/** A link pin, as the URL parses: only one a web tab opens, and at most `MAX_PIN_URL` characters. */
function linkTarget(url: string): PinTarget {
  if (url.trim().length > MAX_PIN_URL) throw invalidParams(`a pinned link is at most ${MAX_PIN_URL} characters`);
  let href: string | undefined;
  try {
    href = new URL(url.trim()).href;
  } catch {
    href = undefined;
  }
  if (href === undefined || !isWebTabUrl(href)) throw invalidParams(`${url} is not a link a web tab opens. ${WEB_TAB_RULE}`);
  return { kind: 'link', url: href };
}

/** A pin's record key: a file's path, a link, or `note:` and a note's label, so pinning a note of the same label replaces it. */
const pinKey = (target: PinTarget, label: string | null): string =>
  target.kind === 'file' ? target.path : target.kind === 'link' ? target.url : noteKey(label ?? '');
const noteKey = (label: string): string => `note:${label}`;

/** A stored pin's target; undefined for one this daemon can't read. */
function pinTargetOf(data: unknown): PinTarget | undefined {
  if (!isObject(data)) return undefined;
  if (data.kind === 'file' && typeof data.path === 'string') return { kind: 'file', path: data.path };
  if (data.kind === 'link' && typeof data.url === 'string') return { kind: 'link', url: data.url };
  if (data.kind === 'note' && typeof data.text === 'string') return { kind: 'note', text: data.text };
  return undefined;
}

/** The agent's guessed hand-off doc: its worktree's handover file, by its real path as a record keeps it, while it is there. */
export function guessedDocOf(worktree: string): string | null {
  try {
    return realpathSync(join(worktree, HANDOVER_DOC));
  } catch {
    return null;
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The file a record names, a hand-off doc's or a pinned file's; undefined for any other. */
const recordedPath = (record: AgentRecord): string | undefined =>
  record.kind === 'doc' ? record.path : record.kind === 'pin' && record.target.kind === 'file' ? record.target.path : undefined;

/** The user's methods on an agent's records: deleting one (and Undo), and reading a hand-off doc or pinned file for its tab. */
export function recordHandlers<Context>(options: {
  records: Pick<AgentRecordStore, 'setDeleted'>;
  agents: { get(sessionId: string): Agent | undefined; announce(sessionId: string): void };
}): RpcHandlers<RecordMethods, Context> {
  const { records, agents } = options;
  const agentOf = (sessionId: string): Agent => {
    const agent = agents.get(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    return agent;
  };
  return {
    'agent.setRecordDeleted': (params) => {
      const p = paramsObject(params);
      const sessionId = stringParam(p, 'sessionId');
      const kind = stringParam(p, 'kind');
      const key = stringParam(p, 'key');
      if (typeof p.deleted !== 'boolean') throw invalidParams('deleted must be a boolean');
      agentOf(sessionId);
      if (!(AGENT_RECORD_KINDS as readonly string[]).includes(kind) || !records.setDeleted(sessionId, kind as AgentRecordKind, key, p.deleted)) {
        throw invalidParams(`agent ${sessionId} has no ${kind} record ${key}`);
      }
      agents.announce(sessionId);
      return agentOf(sessionId);
    },
    'agent.readDoc': (params) => {
      const p = paramsObject(params);
      const agent = agentOf(stringParam(p, 'sessionId'));
      const path = stringParam(p, 'path');
      const known = agent.guessedDoc === path || agent.records.some((record) => record.deletedAt === null && recordedPath(record) === path);
      if (!known) throw invalidParams(`${path} is not one of ${agent.name}'s hand-off docs or pins`);
      if (!isFile(path)) throw invalidParams(`${path} is gone`);
      // Kept by its real path: one made a link since leads elsewhere, which is not what was recorded.
      if (realpathSync(path) !== path) throw invalidParams(`${path} is a link now, not the file that was recorded`);
      if (statSync(path).size > MAX_DOC_BYTES) throw invalidParams(`${path} is over ${MAX_DOC_BYTES / 1024 / 1024} MB, too big to show`);
      return { path, text: readFileSync(path, 'utf8') };
    },
  };
}
