import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
import { BOARD_SESSION_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_ZONE_ENV } from './board-env.ts';
import { hashToken, newToken } from './tokens.ts';
import { createCwdLookup } from './cwd-lookup.ts';
import { foregroundOf, type Foreground } from './foreground.ts';
import { lastExitStatus, shellIntegrationEnv } from './shell-integration.ts';
import { processCwd } from './process-cwd.ts';
import {
  SCROLLBACK_LINES,
  type CreateShellParams,
  type DaemonEvent,
  type Harness,
  type SessionInfo,
  type TerminalSize,
} from './protocol.ts';
import type { TerminalBackend, TerminalExit } from './terminal-backend.ts';

/**
 * Longest piece of a snapshot sent in one event, in UTF-16 code units. JSON escapes each control character in six
 * bytes, so even a snapshot made of nothing else stays well under the protocol's line cap.
 */
const SNAPSHOT_CHUNK_LENGTH = 1024 * 1024;

/**
 * How far a subscriber may fall behind (bytes written to it but not yet delivered, beyond what its snapshot left)
 * before it stops getting output. Once it catches up it gets a fresh snapshot instead of what it missed.
 */
export const SUBSCRIBER_HIGH_WATER_BYTES = 4 * 1024 * 1024;

/** Output the headless model may have waiting to parse before the PTY is paused, and resumed. */
const MODEL_HIGH_WATER = 1024 * 1024;
const MODEL_LOW_WATER = 256 * 1024;

/** How long `kill` waits after SIGHUP before it sends SIGKILL, by default. */
const KILL_GRACE_MS = 3_000;

/**
 * How long a session's output must go quiet before its screen is saved (and a shell's folder looked up), by default.
 * Serializing a full scrollback takes tens of milliseconds of the daemon's one thread, so it is not done on every burst.
 */
const SAVE_QUIET_MS = 2_000;

/** The longest a session that never goes quiet waits for its screen to be saved, by default. */
const SAVE_MAX_WAIT_MS = 20_000;

/** The size an ended session's saved screen is shown at when nothing better is known. */
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** Where a session's events go: one per client connection. */
export interface SessionSubscriber {
  send(event: DaemonEvent): void;
  /** Bytes sent to the subscriber that it has not taken yet. */
  backlog(): number;
  /** Calls `callback` once the subscriber has taken everything sent to it. */
  whenDrained(callback: () => void): void;
}

/** How a live shell session is doing: see `SessionHost.shellState`. */
export interface ShellState {
  busy: boolean;
  ports: number[];
  lastStatus: number | undefined;
}

export interface SessionHostOptions {
  db: DatabaseSync;
  backend: TerminalBackend;
  /** The shell a shell session runs, and its arguments. */
  shell: string;
  shellArgs: string[];
  /** Where a shell session starts when it is given no `cwd`: `os.homedir()` by default. */
  homeDir?: string;
  /** Sends an event to every client. */
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
  killGraceMs?: number;
  /** Called when a session's process has exited and its row is marked ended, before clients hear of it. */
  onExit?(session: SessionInfo): void;
  /**
   * Where each session's screen and scrollback are saved, so an ended session still shows its last output, after a
   * restart too. Nothing is saved without it.
   */
  scrollbackDir?: string;
  /** How long output must go quiet before the screen is saved: `SAVE_QUIET_MS` by default. */
  saveQuietMs?: number;
  /** The longest output that never goes quiet waits for a save: `SAVE_MAX_WAIT_MS` by default. */
  saveMaxWaitMs?: number;
  /** The longest piece of a snapshot sent in one event: `SNAPSHOT_CHUNK_LENGTH` by default (tests shorten it). */
  snapshotChunkLength?: number;
  /** Finds a process's working directory, where a shell session last was: `processCwd` by default. */
  processCwd?(pid: number): Promise<string | undefined>;
  /** Called when a shell session is found in another folder than it was last seen in. */
  onCwd?(sessionId: string): void;
  /** What a shell's process is running, and the ports it listens on: `foregroundOf` by default. */
  foreground?(pid: number): Promise<Foreground>;
  /** Called when a shell session's `SessionHost.shellState` changes: a command started or ended, a port opened, a command failed. */
  onShellState?(sessionId: string): void;
  /**
   * Where the shell integration's files go (`shell-integration.ts`), which has a shell say how each command went. No
   * integration without it.
   */
  shellIntegrationDir?: string;
  /**
   * Hands every session the board env (ADR-0010): the daemon's socket, a board token of its own, its zone, and the
   * `agent-board` CLI's folder first on its PATH. None without it.
   */
  board?: { socketPath: string; cliDir: string };
}

/** A session to start: a process in a terminal, and what its row records. */
export interface SessionSpec extends TerminalSize {
  id: string;
  harness: Harness | null;
  command: string;
  args: string[];
  /** Absolute; must exist. */
  cwd: string;
  env: Record<string, string>;
  /** SHA-256 of the token its hooks authenticate with. */
  hookTokenSha256: string;
  /** Output the session's terminal shows before its process's own, e.g. the scrollback of a pane it restores. */
  restore?: string;
  /** The zone its tile is in as it starts, for its board env; null or absent for none. */
  zoneId?: string | null;
}

/**
 * A subscriber's attachment to one session:
 * - `pending`: waiting for its snapshot; output is queued until the snapshot goes out.
 * - `ready`: gets output as it comes, until its backlog passes `limit`.
 * - `behind`: output is dropped until the subscriber drains, then it is sent a fresh snapshot.
 */
type Attachment =
  | { state: 'pending'; queue: DaemonEvent[]; queuedLength: number }
  | { state: 'ready'; limit: number }
  | { state: 'behind' };

interface LiveSession {
  info: SessionInfo;
  /** A headless terminal fed the session's output, so a reattaching client gets its screen and scrollback. */
  model: xtermHeadless.Terminal;
  serializer: xtermSerialize.SerializeAddon;
  attachments: Map<SessionSubscriber, Attachment>;
  exited: Promise<SessionInfo>;
  /** Set while a save of its screen is due. */
  saveTimer?: NodeJS.Timeout;
  /** When output first came since the last save, and when it last came: what the save waits on. */
  unsavedSince?: number;
  lastOutputAt?: number;
  /** A shell's folder, as last found. */
  lastCwd?: string;
  /** What a shell was running when its output last went quiet. */
  foreground?: Foreground;
  /** The exit status of a shell's last command, as its integration reported at its prompt. */
  lastStatus?: number;
}

export interface SessionHost {
  /**
   * Starts a shell session: a new one, or with `id`, an ended one again (a pane being resumed), showing `restore`
   * above its new output.
   */
  createShell(params: CreateShellParams & { id?: string; restore?: string; zoneId?: string | null }): SessionInfo;
  /**
   * Starts a session and records it. A session that has ended may be started again under its id, e.g. to relaunch an
   * agent: its row is reused, live again. Throws if the process can't be started, or the id is still live.
   */
  start(spec: SessionSpec): SessionInfo;
  list(): SessionInfo[];
  /**
   * Sends the subscriber a snapshot of the session, then its output as it comes. A session that has ended sends its
   * saved screen, if any, and then `session.exited`. Throws for a session it has no record of.
   */
  attach(sessionId: string, subscriber: SessionSubscriber): void;
  detach(sessionId: string, subscriber: SessionSubscriber): void;
  /** Detaches the subscriber from every session, e.g. when its connection closes. */
  detachAll(subscriber: SessionSubscriber): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, size: TerminalSize): void;
  /**
   * Ends the session (SIGHUP, then SIGKILL after a grace period) and resolves once it has exited. A session that is
   * already exiting resolves the same way.
   */
  kill(sessionId: string): Promise<SessionInfo>;
  /**
   * Ends every session. `stoppedByRestart` when the daemon is going away (shutting down, perhaps for a reboot), not
   * the user: the sessions are marked stopped by restart, so the app offers to resume them.
   */
  killAll(options: { stoppedByRestart: boolean }): Promise<void>;
  /** Deletes the session's saved screen, once nothing will show it again. */
  forget(sessionId: string): void;
  /**
   * How a live shell session is doing: whether it was running a command when its output last went quiet, the
   * ports that command listens on, and the exit status of its last command if its shell reports it. Nothing for an
   * agent's session or an ended one.
   */
  shellState(sessionId: string): ShellState;
  /**
   * The folder the session's process is in now: looked up, with lookups for one session shared, for a live
   * one; else where it was last seen, or started. Throws for a session it has no record of.
   */
  folderOf(sessionId: string): Promise<string>;
  /** What the session's terminal last showed, as saved: its scrollback and screen, serialized, and its size. */
  savedScreen(sessionId: string): SavedScreen | undefined;
  /** The live session holding the board token, if any (ADR-0010). */
  sessionForBoardToken(token: string): string | undefined;
}

/**
 * Marks sessions the database still has live as ended, and stopped by restart. Run at daemon start: they belong to a
 * daemon that died (or a machine that went down), and their PTYs went with it. Returns how many there were.
 */
export function reconcileLostSessions(db: DatabaseSync): number {
  const lost = db
    .prepare('UPDATE sessions SET ended_at = ?, stopped_by_restart = 1 WHERE ended_at IS NULL')
    .run(new Date().toISOString());
  return Number(lost.changes);
}

interface SessionRow {
  id: string;
  harness: Harness | null;
  cwd: string;
  created_at: string;
  ended_at: string | null;
  exit_code: number | null;
  stopped_by_restart: number;
}

/** A saved screen: what `serialize` gave, and the size it was laid out at. */
export interface SavedScreen extends TerminalSize {
  data: string;
}

/**
 * Owns the daemon's sessions (ADR-0002): starts their processes on the terminal backend, records them in the
 * database, keeps a headless terminal per session for reattach, and streams output to attached clients.
 */
export function createSessionHost(options: SessionHostOptions): SessionHost {
  const { db, backend } = options;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const snapshotChunkLength = options.snapshotChunkLength ?? SNAPSHOT_CHUNK_LENGTH;
  const sessions = new Map<string, LiveSession>();
  /** Sessions whose process has exited but whose exit is still being delivered. */
  const exiting = new Map<string, LiveSession>();
  const upsert = db.prepare(
    `INSERT INTO sessions (id, harness, hook_token_sha256, cwd, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET harness = excluded.harness, hook_token_sha256 = excluded.hook_token_sha256,
       cwd = excluded.cwd, created_at = excluded.created_at, ended_at = NULL, exit_code = NULL, stopped_by_restart = 0`,
  );
  const markEnded = db.prepare('UPDATE sessions SET ended_at = ?, exit_code = ?, stopped_by_restart = ? WHERE id = ?');
  const selectRow = db.prepare(
    'SELECT id, harness, cwd, created_at, ended_at, exit_code, stopped_by_restart FROM sessions WHERE id = ?',
  );
  const updateLastCwd = db.prepare('UPDATE sessions SET last_cwd = ? WHERE id = ?');
  const saveQuietMs = options.saveQuietMs ?? SAVE_QUIET_MS;
  const saveMaxWaitMs = options.saveMaxWaitMs ?? SAVE_MAX_WAIT_MS;
  const lookupCwd = createCwdLookup({ find: options.processCwd ?? processCwd });
  const findForeground = options.foreground ?? foregroundOf;
  const { scrollbackDir } = options;
  if (scrollbackDir !== undefined) mkdirSync(scrollbackDir, { recursive: true, mode: 0o700 });
  const screenFile = (sessionId: string) => join(scrollbackDir!, `${sessionId}.json`);
  /** Sessions the user (or the daemon, on their behalf) is ending, which a shutdown then doesn't count as its doing. */
  const killing = new Set<string>();
  /** Live sessions by the SHA-256 of their board token. Only in memory: a session can't outlive the daemon. */
  const boardTokens = new Map<string, string>();
  /** Sessions the daemon is ending because it is going away: they are stopped by restart. */
  const stoppedByShutdown = new Set<string>();

  /** Writes the screen to disk, whole or not at all. */
  const writeScreen = (session: LiveSession) => {
    if (scrollbackDir === undefined) return;
    const { cols, rows } = session.model;
    const screen: SavedScreen = { cols, rows, data: session.serializer.serialize({ scrollback: SCROLLBACK_LINES }) };
    const file = screenFile(session.info.id);
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(screen), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      options.log(`could not save the screen of ${session.info.id}: ${(error as Error).message}`);
    }
  };

  const readScreen = (sessionId: string): SavedScreen | undefined => {
    if (scrollbackDir === undefined) return undefined;
    try {
      const screen = JSON.parse(readFileSync(screenFile(sessionId), 'utf8')) as SavedScreen;
      return typeof screen.data === 'string' ? screen : undefined;
    } catch {
      return undefined;
    }
  };

  /** Saves the session's screen once the model has parsed what came so far, and for a shell notes its folder. */
  const save = (session: LiveSession) => {
    const { id, pid, harness } = session.info;
    session.unsavedSince = undefined;
    session.model.write('', () => {
      if (sessions.has(id)) writeScreen(session);
    });
    if (harness === null) {
      void lookupCwd(id, pid).then((cwd) => {
        if (cwd === undefined || !sessions.has(id) || cwd === session.lastCwd) return;
        session.lastCwd = cwd;
        updateLastCwd.run(cwd, id);
        options.onCwd?.(id);
      });
      void findForeground(pid).then((foreground) => {
        const known = session.foreground ?? { busy: false, ports: [] };
        if (!sessions.has(id) || (foreground.busy === known.busy && foreground.ports.join() === known.ports.join())) return;
        session.foreground = foreground;
        options.onShellState?.(id);
      });
    }
  };

  /**
   * Notes output, and saves the screen once it has gone quiet for `saveQuietMs`, or `saveMaxWaitMs` after the first
   * unsaved output if it never does. One timer per session, re-armed only when it fires, not on every chunk.
   */
  const scheduleSave = (session: LiveSession) => {
    if (scrollbackDir === undefined && session.info.harness !== null) return;
    const now = Date.now();
    session.lastOutputAt = now;
    session.unsavedSince ??= now;
    if (session.saveTimer !== undefined) return;
    const arm = (delay: number) => {
      session.saveTimer = setTimeout(() => {
        session.saveTimer = undefined;
        if (!sessions.has(session.info.id) || session.unsavedSince === undefined) return;
        const at = Date.now();
        const due = Math.min(session.lastOutputAt! + saveQuietMs, session.unsavedSince + saveMaxWaitMs);
        if (at >= due) save(session);
        else arm(due - at);
      }, delay);
      session.saveTimer.unref();
    };
    arm(saveQuietMs);
  };

  /** Shows an ended session: its saved screen, if any, then that it has exited. */
  const attachEnded = (sessionId: string, subscriber: SessionSubscriber) => {
    const row = selectRow.get(sessionId) as SessionRow | undefined;
    if (row === undefined || row.ended_at === null) throw new Error(`no session ${sessionId}`);
    const screen = readScreen(sessionId);
    const [first = '', ...rest] = chunk(screen?.data ?? '', snapshotChunkLength);
    const { cols, rows } = screen ?? DEFAULT_SIZE;
    subscriber.send({ type: 'session.snapshot', sessionId, data: first, cols, rows });
    for (const data of rest) subscriber.send({ type: 'session.output', sessionId, data });
    const session: SessionInfo = {
      id: row.id,
      harness: row.harness,
      cwd: row.cwd,
      pid: 0,
      cols,
      rows,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      exitCode: row.exit_code,
      stoppedByRestart: row.stopped_by_restart === 1,
    };
    subscriber.send({ type: 'session.exited', sessionId, session });
  };

  const live = (sessionId: string): LiveSession => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`no live session ${sessionId}`);
    return session;
  };

  /** (Re)starts an attachment: the snapshot goes out once the model has caught up with the output so far. */
  function startAttachment(session: LiveSession, subscriber: SessionSubscriber): void {
    const attachment: Attachment = { state: 'pending', queue: [], queuedLength: 0 };
    session.attachments.set(subscriber, attachment);
    // The callback runs once the model has parsed everything written so far, and nothing after it; output that
    // arrives meanwhile is queued, so the client sees the snapshot and then every byte after it exactly once.
    session.model.write('', () => {
      if (session.attachments.get(subscriber) !== attachment) return;
      sendSnapshot(session, subscriber);
      for (const event of attachment.queue) subscriber.send(event);
      session.attachments.set(subscriber, { state: 'ready', limit: subscriber.backlog() + SUBSCRIBER_HIGH_WATER_BYTES });
    });
  }

  function sendSnapshot(session: LiveSession, subscriber: SessionSubscriber): void {
    const sessionId = session.info.id;
    const [first = '', ...rest] = chunk(session.serializer.serialize({ scrollback: SCROLLBACK_LINES }), snapshotChunkLength);
    const { cols, rows } = session.model;
    subscriber.send({ type: 'session.snapshot', sessionId, data: first, cols, rows });
    for (const data of rest) subscriber.send({ type: 'session.output', sessionId, data });
  }

  function fallBehind(session: LiveSession, subscriber: SessionSubscriber): void {
    const attachment: Attachment = { state: 'behind' };
    session.attachments.set(subscriber, attachment);
    subscriber.whenDrained(() => {
      if (session.attachments.get(subscriber) === attachment && sessions.has(session.info.id)) {
        startAttachment(session, subscriber);
      }
    });
  }

  function deliver(session: LiveSession, event: DaemonEvent & { data: string }): void {
    for (const [subscriber, attachment] of session.attachments) {
      if (attachment.state === 'ready') {
        if (subscriber.backlog() > attachment.limit) fallBehind(session, subscriber);
        else subscriber.send(event);
      } else if (attachment.state === 'pending') {
        attachment.queue.push(event);
        attachment.queuedLength += event.data.length;
        // The model is far behind the PTY: start over with a later snapshot rather than queue without bound.
        if (attachment.queuedLength > SUBSCRIBER_HIGH_WATER_BYTES) startAttachment(session, subscriber);
      }
    }
  }

  async function kill(sessionId: string): Promise<SessionInfo> {
    const ending = exiting.get(sessionId);
    if (ending !== undefined) return { ...(await ending.exited) };
    const session = live(sessionId);
    backend.kill(sessionId);
    const escalate = setTimeout(() => {
      if (sessions.has(sessionId)) backend.kill(sessionId, 'SIGKILL');
    }, killGraceMs);
    try {
      return { ...(await session.exited) };
    } finally {
      clearTimeout(escalate);
    }
  }

  function start(spec: SessionSpec): SessionInfo {
    const { id, harness, cwd, cols, rows } = spec;
    if (!isAbsolute(cwd)) throw new Error(`the working directory must be an absolute path: ${cwd}`);
    if (!isDirectory(cwd)) throw new Error(`not a directory: ${cwd}`);
    if (sessions.has(id) || exiting.has(id)) throw new Error(`session ${id} is still live`);
    const boardToken = options.board === undefined ? undefined : newToken();
    const env = boardToken === undefined ? spec.env : withBoardEnv(spec.env, options.board!, boardToken, spec.zoneId ?? null);
    const terminal = backend.spawn({ id, command: spec.command, args: spec.args, cwd, env, cols, rows });
    const createdAt = new Date().toISOString();
    try {
      upsert.run(id, harness, spec.hookTokenSha256, cwd, createdAt);
    } catch (error) {
      backend.kill(id, 'SIGKILL');
      throw error;
    }
    const boardTokenSha256 = boardToken === undefined ? undefined : hashToken(boardToken);
    if (boardTokenSha256 !== undefined) boardTokens.set(boardTokenSha256, id);

    const model = new xtermHeadless.Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    const serializer = new xtermSerialize.SerializeAddon();
    model.loadAddon(serializer);
    if (spec.restore !== undefined) model.write(spec.restore);
    const info: SessionInfo = {
      id,
      harness,
      cwd,
      pid: terminal.pid,
      cols,
      rows,
      createdAt,
      endedAt: null,
      exitCode: null,
      stoppedByRestart: false,
    };
    let resolveExited!: (info: SessionInfo) => void;
    const session: LiveSession = {
      info,
      model,
      serializer,
      attachments: new Map(),
      exited: new Promise((resolve) => (resolveExited = resolve)),
    };
    sessions.set(id, session);

    // Flow control for the model: xterm drops (throws on) writes once too much is waiting to be parsed.
    let unparsed = 0;
    let paused = false;
    backend.attach(id, {
      onData(data) {
        unparsed += data.length;
        model.write(data, () => {
          unparsed -= data.length;
          if (paused && unparsed < MODEL_LOW_WATER && sessions.has(id)) {
            paused = false;
            backend.resume(id);
          }
        });
        if (!paused && unparsed > MODEL_HIGH_WATER) {
          paused = true;
          backend.pause(id);
        }
        deliver(session, { type: 'session.output', sessionId: id, data });
        scheduleSave(session);
        if (harness === null) {
          const status = lastExitStatus(data);
          if (status !== undefined && status !== session.lastStatus) {
            session.lastStatus = status;
            options.onShellState?.(id);
          }
        }
      },
      onExit(exit) {
        sessions.delete(id);
        lookupCwd.forget(id);
        exiting.set(id, session);
        clearTimeout(session.saveTimer);
        const ended: SessionInfo = {
          ...session.info,
          endedAt: new Date().toISOString(),
          exitCode: exitCode(exit),
          stoppedByRestart: stoppedByShutdown.has(id),
        };
        killing.delete(id);
        stoppedByShutdown.delete(id);
        if (boardTokenSha256 !== undefined) boardTokens.delete(boardTokenSha256);
        session.info = ended;
        markEnded.run(ended.endedAt, ended.exitCode, ended.stoppedByRestart ? 1 : 0, id);
        options.onExit?.(ended);
        // Let pending snapshots and their queued output go out first.
        model.write('', () => {
          writeScreen(session);
          exiting.delete(id);
          model.dispose();
          session.attachments.clear();
          options.broadcast({ type: 'session.exited', sessionId: id, session: ended });
          resolveExited(ended);
        });
      },
    });
    options.log(`started ${harness ?? 'shell'} session ${id} (pid ${terminal.pid}) in ${cwd}`);
    return { ...info };
  }

  return {
    createShell({ cols, rows, cwd = options.homeDir ?? homedir(), id = randomUUID(), restore, zoneId }) {
      // Shell sessions get no harness hooks, but every row carries a token; this one is never handed out.
      const hookTokenSha256 = hashToken(newToken());
      const { shell: command, shellArgs: args, shellIntegrationDir } = options;
      const base = sessionEnv(id);
      const env = shellIntegrationDir === undefined ? base : { ...base, ...shellIntegrationEnv(command, shellIntegrationDir, base) };
      return start({ id, harness: null, command, args, cwd, env, cols, rows, hookTokenSha256, restore, zoneId });
    },

    sessionForBoardToken: (token) => boardTokens.get(hashToken(token)),

    start,

    list: () => [...sessions.values()].map((session) => ({ ...session.info })),

    attach(sessionId, subscriber) {
      const session = sessions.get(sessionId);
      if (session === undefined) attachEnded(sessionId, subscriber);
      else startAttachment(session, subscriber);
    },

    detach(sessionId, subscriber) {
      sessions.get(sessionId)?.attachments.delete(subscriber);
    },

    detachAll(subscriber) {
      for (const session of sessions.values()) session.attachments.delete(subscriber);
    },

    write(sessionId, data) {
      live(sessionId);
      backend.write(sessionId, data);
    },

    resize(sessionId, { cols, rows }) {
      const session = live(sessionId);
      backend.resize(sessionId, cols, rows);
      session.model.resize(cols, rows);
      session.info = { ...session.info, cols, rows };
    },

    kill(sessionId) {
      if (sessions.has(sessionId)) killing.add(sessionId);
      return kill(sessionId);
    },

    async killAll({ stoppedByRestart }) {
      // A session the user is already stopping ends by their hand, not the shutdown's.
      if (stoppedByRestart) for (const id of sessions.keys()) if (!killing.has(id)) stoppedByShutdown.add(id);
      await Promise.all([...sessions.keys()].map(kill));
    },

    savedScreen: readScreen,

    shellState(sessionId) {
      const session = sessions.get(sessionId);
      return { busy: session?.foreground?.busy ?? false, ports: session?.foreground?.ports ?? [], lastStatus: session?.lastStatus };
    },

    forget(sessionId) {
      if (scrollbackDir !== undefined) rmSync(screenFile(sessionId), { force: true });
    },

    async folderOf(sessionId) {
      const session = sessions.get(sessionId);
      if (session !== undefined) return (await lookupCwd(sessionId, session.info.pid)) ?? session.lastCwd ?? session.info.cwd;
      const row = db.prepare('SELECT cwd, last_cwd FROM sessions WHERE id = ?').get(sessionId) as { cwd: string; last_cwd: string | null } | undefined;
      if (row === undefined) throw new Error(`no session ${sessionId}`);
      return row.last_cwd ?? row.cwd;
    },
  };
}

/** Splits `text` into pieces of at most `length` code units, never between the halves of a surrogate pair. */
export function chunk(text: string, length: number): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + length, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/**
 * The environment of anything the daemon starts, a session or an edge's gate: `base` minus what only made sense for
 * the daemon itself.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  // The daemon runs on Electron as Node (ADR-0001); an Electron app started from the shell, or a gate's e2e, must not.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * A session's environment: `base` (the daemon's own by default), minus what only made sense for the daemon itself,
 * plus `extra`.
 */
export function sessionEnv(
  sessionId: string,
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = childEnv(base);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env[BOARD_SESSION_ENV] = sessionId;
  return Object.assign(env, extra);
}

/**
 * `env` with the board env added (ADR-0010): the socket, the session's board token, its zone if it has one, and the
 * CLI's folder first on PATH.
 */
function withBoardEnv(
  env: Record<string, string>,
  board: { socketPath: string; cliDir: string },
  token: string,
  zoneId: string | null,
): Record<string, string> {
  const next: Record<string, string> = { ...env, [BOARD_SOCKET_ENV]: board.socketPath, [BOARD_TOKEN_ENV]: token };
  if (zoneId === null) delete next[BOARD_ZONE_ENV];
  else next[BOARD_ZONE_ENV] = zoneId;
  next.PATH = env.PATH ? `${board.cliDir}${delimiter}${env.PATH}` : board.cliDir;
  return next;
}

function exitCode(exit: TerminalExit): number | null {
  return exit.signal ? null : exit.exitCode;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
