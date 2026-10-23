// Agent records: what an agent writes about its own work for its sidebar (the pull requests it opened, its hand-off
// docs, the agents it started), kept per agent in the daemon. What the daemon guesses (gh, hooks) only fills the gaps.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pullRequestKey, pullRequestOfUrl } from '@agent-board/tracker';
import { isObject } from './json.ts';
import { invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import { AGENT_RECORD_KINDS, MAX_DOC_BYTES, type Agent, type AgentRecord, type AgentRecordKind, type DaemonMethods, type RecordParams } from './protocol.ts';
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
  if (row.kind === 'pr') {
    return typeof data.url === 'string' ? { ...base, kind: 'pr', url: data.url, title: typeof data.title === 'string' ? data.title : null } : undefined;
  }
  if (row.kind === 'doc') {
    const from = isObject(data.from) && typeof data.from.sessionId === 'string' && typeof data.from.name === 'string' ? { sessionId: data.from.sessionId, name: data.from.name } : null;
    return typeof data.path === 'string' ? { ...base, kind: 'doc', path: data.path, from } : undefined;
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
  throw invalidParams(`kind must be pr or doc, not ${kind}`);
}

/**
 * What `board.record` writes, and on whom: `caller`'s own sidebar, or for a doc `forOrchestrator`, the orchestrator's
 * that started it. A doc's relative path is from where the caller's session started; it must be a file, and is kept by
 * its real path, through any link, so one file is one entry however it was named.
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
  const named = resolve(caller.cwd, params.path.trim());
  if (params.path.trim() === '' || !isFile(named)) throw invalidParams(`${params.path} is not a file${isAbsolute(params.path) ? '' : ` in ${caller.cwd}`}`);
  const path = realpathSync(named);
  if (!params.forOrchestrator) return { on: caller.sessionId, record: { kind: 'doc', key: path, path, from: null } };
  const orchestrator = caller.spawnedBy === null ? undefined : agents.get(caller.spawnedBy);
  if (orchestrator === undefined) throw invalidParams('no orchestrator started you: record the doc on your own sidebar, without for orchestrator');
  return { on: orchestrator.sessionId, record: { kind: 'doc', key: path, path, from: { sessionId: caller.sessionId, name: caller.name } } };
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

/** The user's methods on an agent's records: deleting one (and Undo), and reading a hand-off doc for its tab. */
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
      const known = agent.guessedDoc === path || agent.records.some((record) => record.kind === 'doc' && record.deletedAt === null && record.path === path);
      if (!known) throw invalidParams(`${path} is not one of ${agent.name}'s hand-off docs`);
      if (!isFile(path)) throw invalidParams(`${path} is gone`);
      if (statSync(path).size > MAX_DOC_BYTES) throw invalidParams(`${path} is over ${MAX_DOC_BYTES / 1024 / 1024} MB, too big to show`);
      return { path, text: readFileSync(path, 'utf8') };
    },
  };
}
