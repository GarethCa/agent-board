import type { DatabaseSync } from 'node:sqlite';
import type { CredentialStore } from '@agent-board/tracker';
import { keyedQueue } from './keyed-queue.ts';
import { heldLaunchSettings, isEmptyLaunchSettings, launchSettingNamesColumn, tooLong } from './launch-settings.ts';
import type { LaunchSettings } from './protocol.ts';

/** The keychain account an agent's launch settings are kept under: one item per agent, by its session id. */
export function launchSettingsAccount(sessionId: string): string {
  return `launch-settings.${sessionId}`;
}

/**
 * Agents' launch settings: their values in the keychain, one item per agent, and their names alone in the agents
 * table, as the values may be secrets (the credentials rule: none in the database or its backups). The values are
 * read from the keychain once, as the daemon starts, and kept in memory for each launch, which can't wait on the
 * keychain.
 */
export interface LaunchSettingsKeeper {
  /**
   * Reads every agent's launch settings from the keychain, as the daemon starts, before any agent launches. Moves the
   * values an older build left in the database to the keychain first, overwriting them in the database file, and its
   * write-ahead log. One whose item is gone from the keychain loses its names too: it starts without them.
   */
  open(): Promise<void>;
  /**
   * The agent's launch settings, or undefined for none. Throws when it has some the keychain couldn't give yet, and
   * reads them again in the background for the next try.
   */
  get(sessionId: string): LaunchSettings | undefined;
  /** Keeps the agent's launch settings in the keychain and their names in its row; none forgets them. */
  put(sessionId: string, settings: LaunchSettings | undefined): Promise<void>;
  /** Deletes the keychain item of an agent that is gone, if it had one. Never throws: a failure is logged. */
  forget(sessionId: string): Promise<void>;
}

export interface LaunchSettingsKeeperOptions {
  db: DatabaseSync;
  /** Where the values are kept: the keychain, or files where there is none (`launch-settings-store.ts`); memory in tests. */
  credentials: CredentialStore;
  log(message: string): void;
  /** How long one call to the keychain may take before it counts as failed, and how long the start waits on it. */
  timeoutMs?: number;
}

/** A keychain that asks for its password, or a Secret Service waiting to be unlocked, never holds the board up longer. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** How many keychain calls the start makes at once: one `security` or `secret-tool` process each. */
const AT_ONCE = 4;

/** What the keychain item holds: the settings' JSON, as base64, which the keychain store takes as it is. */
function encode(settings: LaunchSettings): string {
  return Buffer.from(JSON.stringify(settings)).toString('base64');
}

function decode(secret: string): LaunchSettings | undefined {
  return heldLaunchSettings(Buffer.from(secret, 'base64').toString('utf8'));
}

/** Runs at most `count` of the tasks given it at once, the rest in the order given. */
function limiter(count: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= count) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export function createLaunchSettingsKeeper({ db, credentials, log, timeoutMs = KEYCHAIN_TIMEOUT_MS }: LaunchSettingsKeeperOptions): LaunchSettingsKeeper {
  const selectAll = db.prepare('SELECT session_id, launch_settings FROM agents WHERE launch_settings IS NOT NULL');
  const selectOne = db.prepare('SELECT launch_settings FROM agents WHERE session_id = ?');
  const setColumn = db.prepare('UPDATE agents SET launch_settings = ? WHERE session_id = ?');
  /** What was read of the keychain, or last kept in it, by agent. */
  const read = new Map<string, LaunchSettings>();
  /** Why the last read of an agent's item failed. */
  const failed = new Map<string, string>();
  const loading = new Map<string, Promise<void>>();
  /** Bumped by each `put`, so a read that started before it never puts back what it replaced. */
  const writes = new Map<string, number>();
  /** Each agent's writes and deletes, one at a time in the order called: the last call's settings are what stay. */
  const inTurn = keyedQueue();
  const column = (sessionId: string) => (selectOne.get(sessionId) as { launch_settings: string | null } | undefined)?.launch_settings ?? null;

  /** `call`, failing once it has taken `timeoutMs` (and calling `onLate` then): what it started may still finish. */
  const bounded = <T>(call: Promise<T>, onLate?: () => void): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onLate?.();
        reject(new Error(`the keychain did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      timer.unref();
    });
    const stop = () => clearTimeout(timer);
    call.then(stop, stop);
    return Promise.race([call, late]);
  };

  /**
   * Runs `task` in the agent's turn, which lasts until the keychain has really answered, so a call that took too
   * long never lands after the next one. The caller hears within `timeoutMs` all the same; `late()` says it has
   * stopped waiting, for a task that should then not start.
   */
  const inBoundedTurn = <T>(sessionId: string, task: (late: () => boolean) => Promise<T>): Promise<T> => {
    let gaveUp = false;
    return bounded(
      inTurn(sessionId, () => task(() => gaveUp)),
      () => (gaveUp = true),
    );
  };

  /** Moves made as the daemon starts, and whether its start has counted them yet. */
  let moved = 0;
  let counted = false;
  const scrubMoved = (count: number) => {
    // The pages that held them, in the write-ahead log too.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    log(`moved the launch settings of ${count} agent${count === 1 ? '' : 's'} from the database to the keychain`);
  };

  const load = (sessionId: string): Promise<void> => {
    const running = loading.get(sessionId);
    if (running !== undefined) return running;
    const at = writes.get(sessionId) ?? 0;
    const reading = bounded(credentials.get(launchSettingsAccount(sessionId)))
      .then(
        (secret) => {
          // Put meanwhile, or gone with its agent.
          if ((writes.get(sessionId) ?? 0) !== at || column(sessionId) === null) return;
          failed.delete(sessionId);
          const settings = secret === undefined ? undefined : decode(secret);
          if (settings !== undefined) {
            read.set(sessionId, settings);
            return;
          }
          // The keychain says it has none (deleted by hand), or holds what isn't launch settings: its tile no longer
          // names them. A keychain that couldn't say fails instead, keeping them for the next try.
          log(`${sessionId}'s launch settings are not in the keychain, so it starts without them`);
          setColumn.run(null, sessionId);
        },
        (error: Error) => {
          failed.set(sessionId, error.message);
          log(`could not read ${sessionId}'s launch settings from the keychain: ${error.message}`);
        },
      )
      .finally(() => loading.delete(sessionId));
    loading.set(sessionId, reading);
    return reading;
  };

  /** Moves an older build's values to the keychain, in the agent's turn. */
  const move = (sessionId: string, held: LaunchSettings): Promise<void> =>
    inBoundedTurn(sessionId, async () => {
      if (tooLong(held)) {
        log(`${sessionId}'s launch settings are too long for the keychain, so they stay in the database: restart it with shorter ones, or none`);
        return;
      }
      await credentials.set(launchSettingsAccount(sessionId), encode(held));
      // Restarted with others meanwhile, or gone.
      if (heldLaunchSettings(column(sessionId)) === undefined) return;
      setColumn.run(launchSettingNamesColumn(held), sessionId);
      // One the keychain gave after the start had counted the rest is scrubbed on its own.
      if (counted) scrubMoved(1);
      else moved++;
    }).catch((error: Error) => {
      log(`could not move ${sessionId}'s launch settings to the keychain, so they stay in the database until the next start: ${error.message}`);
    });

  return {
    async open() {
      // Overwrites what is replaced in the file, whatever the connection was opened with.
      db.exec('PRAGMA secure_delete = ON');
      const rows = selectAll.all() as { session_id: string; launch_settings: string }[];
      const slot = limiter(AT_ONCE);
      const moves: Promise<void>[] = [];
      const reads: Promise<void>[] = [];
      for (const { session_id: sessionId, launch_settings: stored } of rows) {
        const held = heldLaunchSettings(stored);
        if (held === undefined) {
          reads.push(slot(() => load(sessionId)));
          continue;
        }
        // An older build's: it launches with them whether or not they can be moved.
        read.set(sessionId, held);
        moves.push(slot(() => move(sessionId, held)));
      }
      const all = Promise.all([...moves, ...reads]).then(() => {
        counted = true;
        if (moved > 0) scrubMoved(moved);
      });
      // A keychain that is slow to answer never holds the board up: what it hasn't given yet is read again at launch.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answered = await Promise.race([
        all.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!answered) log("the keychain hasn't given every agent's launch settings yet: an agent it hasn't launches once it has");
    },

    get(sessionId) {
      if (column(sessionId) === null) return undefined;
      const settings = read.get(sessionId);
      if (settings !== undefined) return settings;
      const why = failed.get(sessionId);
      void load(sessionId);
      throw new Error(`its launch settings could not be read from the keychain${why === undefined ? '' : `: ${why}`}. Try again`);
    },

    put(sessionId, settings) {
      writes.set(sessionId, (writes.get(sessionId) ?? 0) + 1);
      return inBoundedTurn(sessionId, async (late) => {
        // Its caller was told it failed: it never lands after that.
        if (late()) return;
        const account = launchSettingsAccount(sessionId);
        const none = settings === undefined || isEmptyLaunchSettings(settings);
        // Deleting one it never had does nothing.
        await (none ? credentials.delete(account) : credentials.set(account, encode(settings)));
        // Even once its caller has stopped waiting: what is kept, read and named stay one.
        failed.delete(sessionId);
        if (none) read.delete(sessionId);
        else read.set(sessionId, settings);
        setColumn.run(launchSettingNamesColumn(settings), sessionId);
      }).catch((error: Error) => {
        throw new Error(`its launch settings could not be kept in the keychain: ${error.message}`, { cause: error });
      });
    },

    forget(sessionId) {
      read.delete(sessionId);
      failed.delete(sessionId);
      writes.delete(sessionId);
      // Whatever its row said: an item can outlive the names that pointed to it.
      return inBoundedTurn(sessionId, () => credentials.delete(launchSettingsAccount(sessionId))).catch((error: Error) => {
        log(`could not delete ${sessionId}'s launch settings from the keychain: ${error.message}`);
      });
    },
  };
}
