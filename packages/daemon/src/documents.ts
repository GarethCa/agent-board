// Documents an agent shows the user (`board.showDoc`): a Markdown or HTML file of its, shown as a Document tab in its window
// or a card on the board. The file is the document: it is read each time it is shown, and looked at every 1.5 s, so a
// rewrite by the agent is a new version. The user's edits to a Markdown document are written to the file, and the agent is told what
// changed, typed at its prompt once it is ready for its next message, as a crew flag is (`crew-flags.ts`).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardCaller, isOwnLiveSession, type BoardCallerSources, type BoardConnection } from './board.ts';
import { systemClock, type Clock } from './clock.ts';
import { invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam, finiteNumberParam } from './params.ts';
import {
  MAX_PLAN_LENGTH,
  MAX_PLAN_TITLE_LENGTH,
  MAX_REPLY_LENGTH,
  type Agent,
  type AgentState,
  type DaemonMethods,
  type DocumentContent,
  type DocumentSummary,
  type DocumentWriter,
  type PlanFormat,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { RunStart } from './schedules.ts';
import { documentFormat, documentTitle } from './document-names.ts';
import { lineDiff, toldDiff } from './text-diff.ts';
import { isInside, realPath, whyNotWritable, writeWhole } from './user-files.ts';
import type { AgentHost } from './agents.ts';

type DocumentMethods = Pick<DaemonMethods, 'board.showDoc' | 'doc.read' | 'doc.save' | 'doc.comment'>;

/** How often the files of live agents' documents are looked at for a rewrite. */
const DOCUMENT_POLL_MS = 1_500;

/** States of a live agent at its prompt: only these are worth trying to tell. */
const AT_PROMPT: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'waiting']);

export interface DocumentHostOptions {
  db: DatabaseSync;
  /** The agent's documents changed: its tile, cards and tabs follow. */
  changed(sessionId: string): void;
  /** The agent as it is now, if it is. */
  agent(sessionId: string): Agent | undefined;
  /** Types `text` at the agent's prompt if it is ready for its next message (`AgentHost.tell`); else not started, busy. */
  tell(sessionId: string, text: string): Promise<RunStart>;
  /** Puts a card for the document beside its agent's tile on the board. */
  addCard(document: DocumentSummary): Promise<void>;
  log(message: string): void;
  clock?: Clock;
}

export interface DocumentHost {
  /**
   * The agent, working in `worktree`, shows its file at `path` (absolute), as a document; again, the same one. A link
   * is shown as the file it leads to. Throws `invalidParams` for a file it can't show.
   */
  show(sessionId: string, spec: { path: string; title?: string; worktree: string }): DocumentSummary;
  /** The agent's documents, first shown first. */
  list(sessionId: string): DocumentSummary[];
  /** The document with its text now. */
  read(documentId: string): DocumentContent;
  /**
   * The user saves `text` (line breaks as `\n`) over the Markdown document they edited at `baseVersion`, in the file's
   * own line breaks; its agent is told the diff. Refused for a document that isn't editable, a file gone or made a link
   * since it was shown, and, unless `force`, one written since `baseVersion`.
   */
  save(documentId: string, text: string, baseVersion: number, force?: boolean): DocumentSummary;
  /**
   * The user's text was written to the agent's file at `path` (a plan's approved edit): if it is one of the agent's
   * documents, the write is the user's next version, not an agent's rewrite. The agent is told by the plan's answer.
   */
  userWrote(sessionId: string, path: string): void;
  /** Types `text` at the agent's prompt once it is ready for its next message, with what else waits for it (a plan's decision). */
  tell(sessionId: string, text: string): void;
  /** The user's comments on the document, for its agent. */
  comment(documentId: string, text: string): void;
  /** Looks at every live agent's documents' files for a rewrite. */
  poll(): void;
  /** Hears an agent changed: back at its prompt, it is told what is waiting for it. */
  observe(agent: Agent): void;
  /** The agent is being deleted: its documents go with it. */
  forget(sessionId: string): void;
  handlers<Context extends BoardConnection>(sources: BoardCallerSources & { agents: Pick<AgentHost, 'get'> }): RpcHandlers<DocumentMethods, Context>;
  /** Starts looking at the files every `DOCUMENT_POLL_MS`. */
  start(): void;
  close(): void;
}

interface DocumentRow {
  id: string;
  session_id: string;
  path: string;
  format: PlanFormat;
  title: string;
  title_given: number;
  version: number;
  written_at: string;
  written_by: DocumentWriter;
  hash: string;
  editable: number;
  shown_at: string;
}

const toSummary = (row: DocumentRow): DocumentSummary => ({
  id: row.id,
  sessionId: row.session_id,
  path: row.path,
  title: row.title,
  format: row.format,
  version: row.version,
  writtenAt: row.written_at,
  writtenBy: row.written_by,
  editable: row.editable === 1,
  shownAt: row.shown_at,
});

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** Text with every line break as `\n`, as the Document tab edits it and the agent reads its diff. */
const unixLines = (text: string) => text.replace(/\r\n/g, '\n');

/** A file newer than this is read whatever its stat says: a write within the file system's time tick keeps its time. */
const FRESH_MS = 2_000;

/** The file's text, or a reason it can't be shown. */
function readText(path: string): { text: string } | { problem: string } {
  try {
    const { size } = statSync(path);
    if (size > MAX_PLAN_LENGTH * 4) return { problem: `it is too big to show (${size} bytes)` };
    const text = readFileSync(path, 'utf8');
    if (text.length > MAX_PLAN_LENGTH) return { problem: `it is too big to show (${text.length} characters, at most ${MAX_PLAN_LENGTH})` };
    return { text };
  } catch (error) {
    return { problem: `can't read it: ${(error as Error).message}` };
  }
}

/** The path as the agent knows it: relative to its worktree when inside it. */
function pathFor(agent: Agent | undefined, path: string): string {
  if (agent === undefined) return path;
  const worktree = realPath(agent.worktree);
  return isInside(worktree, path) ? relative(worktree, path) : path;
}

export function createDocumentHost(options: DocumentHostOptions): DocumentHost {
  const { db } = options;
  /** Each agent's documents, once read: its tile reads them at every update. */
  const listed = new Map<string, DocumentSummary[]>();
  const changed = (sessionId: string) => {
    listed.delete(sessionId);
    options.changed(sessionId);
  };
  const clock = options.clock ?? systemClock;
  const insert = db.prepare(
    'INSERT INTO documents (id, session_id, path, format, title, title_given, version, written_at, written_by, hash, editable, shown_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare('SELECT * FROM documents WHERE id = ?');
  const selectByPath = db.prepare('SELECT * FROM documents WHERE session_id = ? AND path = ?');
  const selectOf = db.prepare('SELECT * FROM documents WHERE session_id = ? ORDER BY rowid');
  const selectAll = db.prepare('SELECT * FROM documents');
  const reshow = db.prepare('UPDATE documents SET shown_at = ?, title = ?, title_given = ? WHERE id = ?');
  const rewrite = db.prepare('UPDATE documents SET version = version + 1, written_at = ?, written_by = ?, hash = ?, title = ? WHERE id = ?');
  const deleteOf = db.prepare('DELETE FROM documents WHERE session_id = ?');

  /** Per agent, the messages still to type at its prompt, oldest first. */
  const pending = new Map<string, string[]>();
  /** The agents being typed to now. */
  const typing = new Set<string>();
  /** Each document's file's stat (modified time and size), as last looked at: the poll reads only a file that changed. */
  const seenStat = new Map<string, string>();
  let stopPolling: (() => void) | undefined;

  const now = () => new Date(clock.now()).toISOString();

  const row = (documentId: string): DocumentRow => {
    const found = selectOne.get(documentId) as unknown as DocumentRow | undefined;
    if (found === undefined) throw invalidParams(`no document ${documentId}`);
    return found;
  };

  /** Records a write of `text` to the document's file, by `by`. */
  const recordWrite = (document: DocumentRow, text: string, by: DocumentWriter) => {
    const title = document.title_given === 1 ? document.title : documentTitle(document.path, document.format, text);
    rewrite.run(now(), by, hashOf(text), title, document.id);
  };

  /** Types what waits for the agent, if it is at its prompt; what isn't taken in stays for the next time. */
  const tellWaiting = (sessionId: string) => {
    const messages = pending.get(sessionId);
    if (messages === undefined || typing.has(sessionId)) return;
    const agent = options.agent(sessionId);
    if (agent === undefined || agent.endedAt !== null) {
      // An agent that ended reads nothing typed at its prompt: it would be told once resumed, but its own file says it.
      if (agent === undefined) pending.delete(sessionId);
      return;
    }
    if (!AT_PROMPT.has(agent.state)) return;
    const told = [...messages];
    typing.add(sessionId);
    options
      .tell(sessionId, told.join('\n\n'))
      .then(
        (start) => {
          if (!start.started) return;
          const left = (pending.get(sessionId) ?? []).slice(told.length);
          if (left.length === 0) pending.delete(sessionId);
          else pending.set(sessionId, left);
        },
        (error: unknown) => options.log(`could not tell ${agent.name} about its documents: ${(error as Error).message}`),
      )
      .finally(() => typing.delete(sessionId));
  };

  const queue = (sessionId: string, message: string) => {
    pending.set(sessionId, [...(pending.get(sessionId) ?? []), message]);
    tellWaiting(sessionId);
  };

  /**
   * Reads the document's file, recording the agent's rewrite if its text changed. The poll (`always` false) skips a
   * file whose stat is as last seen, unless it is new enough to have been written again within the same time tick;
   * everything else reads it, whatever its stat. True if it was rewritten.
   */
  const look = (document: DocumentRow, always: boolean): boolean => {
    let stat: string;
    let modified: number;
    try {
      const { mtimeMs, size } = statSync(document.path);
      modified = mtimeMs;
      stat = `${mtimeMs}:${size}`;
    } catch {
      return false;
    }
    if (!always && seenStat.get(document.id) === stat && clock.now() - modified > FRESH_MS) return false;
    seenStat.set(document.id, stat);
    const read = readText(document.path);
    if (!('text' in read) || hashOf(read.text) === document.hash) return false;
    recordWrite(document, read.text, 'agent');
    return true;
  };

  /** Why the user can't save over the document's file now, if they can't: not editable, gone, or made a link. */
  const whyNotSaved = (document: DocumentRow): string | undefined => {
    if (document.format !== 'markdown') return 'an HTML document is view-only: comment on it instead';
    if (document.editable !== 1) return 'it is outside its agent\'s worktree, so it is view-only here: edit it there';
    return whyNotWritable(document.path);
  };

  const host: DocumentHost = {
    show(sessionId, spec) {
      if (!isAbsolute(spec.path)) throw invalidParams('the path must be absolute');
      // A link is shown as the file it leads to, and written there only if that is in the agent's worktree.
      const path = realPath(spec.path);
      const format = documentFormat(path);
      if (format === undefined) throw invalidParams(`only a Markdown (.md) or HTML (.html) file is shown as a document, not ${basename(path)}`);
      const read = readText(path);
      if (!('text' in read)) throw invalidParams(`can't show ${spec.path}: ${read.problem}`);
      const given = spec.title?.trim();
      if (given !== undefined && given.length > MAX_PLAN_TITLE_LENGTH) throw invalidParams(`title must be at most ${MAX_PLAN_TITLE_LENGTH} characters`);
      const titled = given !== undefined && given !== '';
      const title = titled ? given : documentTitle(path, format, read.text);
      const existing = selectByPath.get(sessionId, path) as unknown as DocumentRow | undefined;
      if (existing === undefined) {
        const editable = format === 'markdown' && isInside(realPath(spec.worktree), path);
        insert.run(randomUUID(), sessionId, path, format, title, titled ? 1 : 0, now(), 'agent', hashOf(read.text), editable ? 1 : 0, now());
      } else {
        look(existing, true);
        const fresh = row(existing.id);
        reshow.run(now(), titled ? title : fresh.title, titled || fresh.title_given === 1 ? 1 : 0, existing.id);
      }
      changed(sessionId);
      return toSummary(selectByPath.get(sessionId, path) as unknown as DocumentRow);
    },

    list(sessionId) {
      if (!listed.has(sessionId)) listed.set(sessionId, (selectOf.all(sessionId) as unknown as DocumentRow[]).map(toSummary));
      return listed.get(sessionId)!;
    },

    read(documentId) {
      const document = row(documentId);
      if (look(document, true)) changed(document.session_id);
      const fresh = row(documentId);
      const read = readText(fresh.path);
      return 'text' in read ? { ...toSummary(fresh), text: unixLines(read.text) } : { ...toSummary(fresh), text: null, problem: read.problem };
    },

    save(documentId, text, baseVersion, force = false) {
      let document = row(documentId);
      const refused = whyNotSaved(document);
      if (refused !== undefined) throw invalidParams(refused);
      if (text.length > MAX_PLAN_LENGTH) throw invalidParams(`the document must be at most ${MAX_PLAN_LENGTH} characters`);
      // Its text, whatever its stat says: a rewrite that kept its time is still one.
      if (look(document, true)) {
        changed(document.session_id);
        document = row(documentId);
      }
      const overwritten = document.version !== baseVersion;
      if (overwritten && !force) {
        throw invalidParams(
          document.written_by === 'agent'
            ? `the agent wrote v${document.version} while you were editing v${baseVersion}: keep yours, or take theirs`
            : `it was saved as v${document.version} since you began editing v${baseVersion}: open it again`,
        );
      }
      const read = readText(document.path);
      if (!('text' in read)) throw invalidParams(`can't save it: ${read.problem}`);
      const before = read.text;
      // Written back in the file's own line breaks.
      const written = before.includes('\r\n') ? unixLines(text).replace(/\n/g, '\r\n') : unixLines(text);
      writeWhole(document.path, written, statSync(document.path).mode);
      const { mtimeMs, size } = statSync(document.path);
      seenStat.set(document.id, `${mtimeMs}:${size}`);
      recordWrite(document, written, 'user');
      const saved = row(documentId);
      changed(saved.session_id);
      const diff = lineDiff(unixLines(before), unixLines(written));
      if (diff !== '') {
        const where = pathFor(options.agent(saved.session_id), saved.path);
        const head =
          overwritten && document.written_by === 'agent'
            ? `[agent-board] The user kept their version of ${where} over your v${document.version} (now v${saved.version}), which undoes your changes since v${baseVersion}. The file is already changed:`
            : `[agent-board] The user edited ${where} (v${saved.version}). The file is already changed; you don't need to apply this:`;
        queue(saved.session_id, `${head}\n${toldDiff(diff)}`);
      }
      return toSummary(saved);
    },

    userWrote(sessionId, path) {
      const document = selectByPath.get(sessionId, path) as unknown as DocumentRow | undefined;
      if (document === undefined) return;
      const read = readText(path);
      if (!('text' in read) || hashOf(read.text) === document.hash) return;
      const { mtimeMs, size } = statSync(path);
      seenStat.set(document.id, `${mtimeMs}:${size}`);
      recordWrite(document, read.text, 'user');
      changed(sessionId);
    },

    tell: (sessionId, text) => queue(sessionId, text),

    comment(documentId, text) {
      const document = row(documentId);
      const said = text.trim();
      if (said === '') throw invalidParams('the comment must not be empty');
      if (said.length > MAX_REPLY_LENGTH) throw invalidParams(`the comment must be at most ${MAX_REPLY_LENGTH} characters`);
      const agent = options.agent(document.session_id);
      queue(document.session_id, `[agent-board] The user commented on ${pathFor(agent, document.path)} (v${document.version}):\n${said}`);
    },

    poll() {
      const touched = new Set<string>();
      // Each agent looked up once a round, not once a document.
      const live = new Map<string, boolean>();
      for (const document of selectAll.all() as unknown as DocumentRow[]) {
        if (!live.has(document.session_id)) live.set(document.session_id, options.agent(document.session_id)?.endedAt === null);
        if (!live.get(document.session_id)) continue;
        if (look(document, false)) touched.add(document.session_id);
      }
      for (const sessionId of touched) changed(sessionId);
    },

    observe(agent) {
      if (pending.has(agent.sessionId)) tellWaiting(agent.sessionId);
    },

    forget(sessionId) {
      for (const document of host.list(sessionId)) seenStat.delete(document.id);
      deleteOf.run(sessionId);
      listed.delete(sessionId);
      pending.delete(sessionId);
    },

    handlers<Context extends BoardConnection>(sources: BoardCallerSources & { agents: Pick<AgentHost, 'get'> }): RpcHandlers<DocumentMethods, Context> {
      return {
        'board.showDoc': async (params, connection) => {
          const p = paramsObject(params);
          const who = boardCaller(sources, stringParam(p, 'token'), connection);
          const me = who.kind === 'agent' ? sources.agents.get(who.tileId) : undefined;
          if (me === undefined || !isOwnLiveSession(me, who.sessionId)) {
            throw invalidParams("only a live agent shows a document, from its own session: not a shell, nor an ended agent's shell");
          }
          const shown = host.show(me.sessionId, { path: stringParam(p, 'path'), title: optionalStringParam(p, 'title'), worktree: me.worktree });
          if (optionalBooleanParam(p, 'onBoard') === true) await options.addCard(shown);
          return shown;
        },
        'doc.read': (params) => host.read(stringParam(paramsObject(params), 'documentId')),
        'doc.save': (params) => {
          const p = paramsObject(params);
          return host.save(stringParam(p, 'documentId'), stringParam(p, 'text'), finiteNumberParam(p, 'baseVersion'), optionalBooleanParam(p, 'force'));
        },
        'doc.comment': (params) => {
          const p = paramsObject(params);
          host.comment(stringParam(p, 'documentId'), stringParam(p, 'text'));
          return null;
        },
      };
    },

    start() {
      const tick = () => {
        try {
          host.poll();
        } catch (error) {
          options.log(`could not look at the documents: ${(error as Error).message}`);
        }
        stopPolling = clock.setTimer(tick, DOCUMENT_POLL_MS);
      };
      stopPolling = clock.setTimer(tick, DOCUMENT_POLL_MS);
    },

    close() {
      stopPolling?.();
      stopPolling = undefined;
    },
  };
  return host;
}
