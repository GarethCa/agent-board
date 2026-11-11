// Going back to an older build: a backup of the database before each migration run, a record of the migrations it
// ran and which an older daemon may ignore, and, when it may not, the command that puts the backup back. See
// docs/rolling-back.md.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Migration } from './migrate.ts';
import { shellQuote } from './shell-words.ts';

/** How many backups are kept beside the database: the most recent, by when they were made. */
const KEPT_BACKUPS = 3;

/**
 * What a migration's first line says about an older daemon opening the database after it: `-- backward-safe: <why>`
 * when it only adds what an older daemon never reads (a table, or a column with a default) and drops, renames and
 * rewrites nothing; `-- not backward-safe: <why>` otherwise. Undefined when the first line says neither, with a reason.
 * Only the first line counts, so a later comment can't change it.
 */
export function backwardSafety(sql: string): 'safe' | 'unsafe' | undefined {
  const first = /^-- (not )?backward-safe: \S/.exec(sql.split('\n', 1)[0]!);
  if (first === null) return undefined;
  return first[1] === undefined ? 'safe' : 'unsafe';
}

export function isBackwardSafe(migration: Migration): boolean {
  return backwardSafety(migration.sql) === 'safe';
}

/**
 * A migration's SQL as a hash, so a database can tell when it ran a different migration under the same number (one
 * reverted, then landed again changed). Whole-line comments and spacing don't count; a comment after SQL on its line
 * does. The shipped migrations' checksums are frozen in a test, so an edit to one fails there, not on a user's board.
 */
export function migrationChecksum(sql: string): string {
  const statements = sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(statements).digest('hex');
}

/**
 * The migrations applied to the database, written in each migration's own transaction: what it was, its SQL's
 * checksum, and whether an older daemon may ignore it. Kept outside the numbered migrations: it describes them.
 */
export function recordMigration(db: DatabaseSync, migration: Migration): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sql_sha256 TEXT NOT NULL,
    backward_safe INTEGER NOT NULL CHECK (backward_safe IN (0, 1)),
    applied_at TEXT NOT NULL
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO schema_migrations (version, name, sql_sha256, backward_safe, applied_at) VALUES (?, ?, ?, ?, ?)',
  ).run(migration.version, migration.name, migrationChecksum(migration.sql), isBackwardSafe(migration) ? 1 : 0, new Date().toISOString());
}

interface Recorded {
  version: number;
  name: string;
  sql_sha256: string;
  backward_safe: number;
}

function recorded(db: DatabaseSync, after: number, upTo: number): Map<number, Recorded> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() !== undefined;
  if (!exists) return new Map();
  const rows = db
    .prepare('SELECT version, name, sql_sha256, backward_safe FROM schema_migrations WHERE version > ? AND version <= ?')
    .all(after, upTo) as unknown as Recorded[];
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * Throws, naming the backup to go back to and the command that does it, when the database ran one of `migrations`
 * as different SQL from what this build has: a migration reverted and then landed again, changed, under its number.
 * Migrating on would skip the new SQL, and the board would then fail on what it added.
 */
export function checkRecordedMigrations(db: DatabaseSync, migrations: readonly Migration[], version: number): void {
  const known = Math.min(version, migrations.length);
  const rows = recorded(db, 0, known);
  for (const migration of migrations.slice(0, known)) {
    const row = rows.get(migration.version);
    if (row === undefined || row.sql_sha256 === migrationChecksum(migration.sql)) continue;
    const v = migration.version;
    refuse(db, {
      problem:
        `this build's migration ${v} (${migration.name}) is not the one this database ran as migration ${v} (${row.name}): ` +
        'it was changed after the database ran it, so this build would skip the change and then fail on it',
      backupAtMost: v - 1,
      version,
      noBackup: `Open it with the build that last ran on it; this build can't, until its migration ${v} is put back as it was.`,
      withBackup: ({ path, command, kept }) =>
        `Open it with the build that last ran on it, or go back to the backup from before migration ${v}, ${path}: ` +
        `quit agent-board and run \`${command}\`. The database as it is now stays as ${kept}, and that build opens it as it is.`,
    });
  }
}

/**
 * Throws, naming the backup to go back to and the command that does it, unless every migration past `known` up to
 * `version` is recorded as backward-safe, so a daemon that knows only `known` may open a database at `version`.
 */
export function checkNewerDatabase(db: DatabaseSync, version: number, known: number): void {
  const rows = recorded(db, known, version);
  for (let v = known + 1; v <= version; v++) {
    const row = rows.get(v);
    if (row?.backward_safe === 1) continue;
    const why = row === undefined
      ? `it has no record of whether migration ${v} can be ignored`
      : `migration ${v} (${row.name}) changed it in a way this build can't read`;
    refuse(db, {
      problem: `database is at schema version ${version}, newer than this daemon knows (${known}): ${why}`,
      backupAtMost: known,
      version,
      noBackup: `Install a build that knows this database's version ${version} to open it.`,
      withBackup: ({ path, command, kept }) =>
        `The backup from before that upgrade is ${path}. To go back to it, quit agent-board and run \`${command}\`; ` +
        `the database as it is now stays as ${kept}, and a build that knows its version opens it as it is.`,
    });
  }
}

interface Refusal {
  /** What is wrong, as the message's first sentence. */
  problem: string;
  /** The newest schema version a backup to go back to may be from. */
  backupAtMost: number;
  /** The database's schema version. */
  version: number;
  /** What to do when there is no such backup. */
  noBackup: string;
  /** What to do when there is: go back to the backup at `path` with `command`, which keeps the database as `kept`. */
  withBackup: (restore: { path: string; command: string; kept: string }) => string;
}

/** Throws the refusal's problem and what to do: with the newest backup it may go back to, and the command, if any. */
function refuse(db: DatabaseSync, { problem, backupAtMost, version, noBackup, withBackup }: Refusal): never {
  const file = databaseFile(db);
  const backup = file === undefined ? undefined : newestBackup(file, backupAtMost);
  if (file === undefined || backup === undefined) {
    throw new Error(`${problem}, and there is no backup from schema version ${backupAtMost} or older to go back to. ${noBackup}`);
  }
  const dir = dirname(file);
  const kept = keptName(file, version);
  // `test` first, so running the command again (from the shell's history, say) stops before it moves anything onto
  // the kept copy. Not `mv -n`: whether it fails when it moves nothing differs between systems.
  const command = [
    `cd ${shellQuote(dir)}`,
    `test ! -e ${shellQuote(kept)}`,
    `mv ${shellQuote(basename(file))} ${shellQuote(kept)}`,
    `cp ${shellQuote(basename(backup.path))} ${shellQuote(basename(file))}`,
  ].join(' && ');
  throw new Error(`${problem}. ${withBackup({ path: backup.path, command, kept: join(dir, kept) })}`);
}

/** Where the restore command moves the database: a name nothing has yet, so an earlier one kept there stays. */
function keptName(file: string, version: number): string {
  const name = `${basename(file)}.v${version}.newer`;
  let candidate = name;
  for (let n = 2; existsSync(join(dirname(file), candidate)); n++) candidate = `${name}.${n}`;
  return candidate;
}

/**
 * Copies the database, as it is at `version`, to `<file>.v<version>.bak` beside it, replacing an older copy from the
 * same version, then removes all but the most recent {@link KEPT_BACKUPS}. Returns the copy's path, or undefined for
 * a database with no file (in memory). Throws if it can't make the copy: no migration runs without one.
 */
export function backUp(db: DatabaseSync, version: number): string | undefined {
  const file = databaseFile(db);
  if (file === undefined) return undefined;
  const path = `${file}.v${version}.bak`;
  const partial = `${path}.partial`;
  try {
    rmSync(partial, { force: true, recursive: true });
    // A consistent copy of what is committed, the write-ahead log's pages included, from the open connection.
    db.prepare('VACUUM INTO ?').run(partial);
    chmodSync(partial, 0o600);
    dropHeldCopies(partial);
    // So a backup that a crash cuts short is never the one the restore command names.
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true, recursive: true });
    throw new Error(`could not back up the database to ${path} before migrating it: ${(error as Error).message}`, { cause: error });
  }
  for (const old of backups(file).slice(KEPT_BACKUPS)) rmSync(old.path, { force: true });
  return path;
}

/**
 * Clears, in the backup at `path`, the copies of held and queued hand-off files, as the "Path only" setting does: a
 * copy is meant to last only until its hand-off is delivered or dropped, and a backup would keep it on. A restored
 * board reads the file again at delivery. A final message is kept anyway (on its agent), so its copy stays.
 */
function dropHeldCopies(path: string): void {
  const copy = new DatabaseSync(path);
  try {
    // No journal file to hold the old pages, and what is cleared is overwritten in the file.
    copy.exec('PRAGMA journal_mode = MEMORY');
    copy.exec('PRAGMA secure_delete = ON');
    const columns = new Set((copy.prepare('PRAGMA table_info(flow_edges)').all() as { name: string }[]).map((column) => column.name));
    const cleared = ['held_text', 'queued_text'].filter((column) => columns.has(column));
    if (cleared.length === 0) return;
    const where = columns.has('payload') ? " WHERE payload != 'final-message'" : '';
    copy.exec(`UPDATE flow_edges SET ${cleared.map((column) => `${column} = NULL`).join(', ')}${where}`);
  } finally {
    copy.close();
  }
}

interface Backup {
  path: string;
  version: number;
  madeAt: number;
}

/** The backups beside `file`, most recent first. */
function backups(file: string): Backup[] {
  const name = basename(file);
  const dir = dirname(file);
  const found: Backup[] = [];
  for (const entry of readdirSync(dir)) {
    const digits = entry.startsWith(`${name}.v`) && entry.endsWith('.bak') ? entry.slice(name.length + 2, -'.bak'.length) : '';
    if (!/^\d+$/.test(digits)) continue;
    const path = join(dir, entry);
    found.push({ path, version: Number(digits), madeAt: statSync(path).mtimeMs });
  }
  return found.sort((a, b) => b.madeAt - a.madeAt || b.version - a.version);
}

/** The backup from the newest version at most `version`: one a daemon that knows `version` can open and migrate. */
function newestBackup(file: string, version: number): Backup | undefined {
  return backups(file)
    .filter((backup) => backup.version <= version)
    .sort((a, b) => b.version - a.version || b.madeAt - a.madeAt)[0];
}

/** The open database's file, or undefined when it has none (in memory, or a temporary database). */
function databaseFile(db: DatabaseSync): string | undefined {
  const main = (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find((row) => row.name === 'main');
  return main?.file ? main.file : undefined;
}
