import type {} from './import-meta-glob.ts';
import type { DatabaseSync } from 'node:sqlite';
import { backUp, checkNewerDatabase, checkRecordedMigrations, recordMigration } from './schema-rollback.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * The schema, from `migrations/NNNN_name.sql`. Forward-only: never edit a shipped file (a test holds each to its
 * checksum in `test/migration-checksums.json`), add a new one, with its line in that file. Each new one
 * starts with a line saying whether an older daemon may open the database after it: `-- backward-safe: <why>` or
 * `-- not backward-safe: <why>` (see `schema-rollback.ts`).
 */
export const MIGRATIONS: readonly Migration[] = Object.entries(
  import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }),
)
  .map(([path, sql]) => {
    const match = /\/(\d+)_([\w-]+)\.sql$/.exec(path);
    if (!match) throw new Error(`migration file ${path} must be named NNNN_name.sql`);
    return { version: Number(match[1]), name: match[2]!, sql };
  })
  .sort((a, b) => a.version - b.version);

/**
 * Applies every migration newer than the database's `PRAGMA user_version`, each in its own transaction together
 * with the version bump and its line in `schema_migrations`, so a failing migration leaves the database at the last
 * good version. Before the first, it backs the database up beside its file (not a new, empty one). Foreign keys are
 * off while they run, as SQLite needs to rebuild a table others reference, and each migration must leave every
 * reference whole before it commits.
 *
 * A database newer than `migrations` opens as it is, with `from` past `to`, when every newer migration is recorded as
 * backward-safe; otherwise this throws, naming the backup and the command that restores it. So does a database that
 * ran one of `migrations` as different SQL (one reverted and landed again, changed, under its number).
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`migrations must be numbered 1..n; found ${migration.version} at position ${index + 1}`);
    }
  });
  const from = schemaVersion(db);
  checkRecordedMigrations(db, migrations, from);
  if (from > migrations.length) {
    checkNewerDatabase(db, from, migrations.length);
    return { from, to: migrations.length };
  }
  if (from === migrations.length) return { from, to: from };
  const backup = from > 0 ? backUp(db, from) : undefined;
  const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
  // Only outside a transaction does this take effect.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const migration of migrations.slice(from)) {
      db.exec('BEGIN');
      try {
        db.exec(migration.sql);
        const broken = db.prepare('PRAGMA foreign_key_check').all() as { table: string; parent: string }[];
        if (broken.length > 0) {
          const { table, parent } = broken[0]!;
          throw new Error(`it leaves ${broken.length} broken foreign key(s), the first from ${table} to ${parent}`);
        }
        recordMigration(db, migration);
        db.exec(`PRAGMA user_version = ${migration.version}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw new Error(`migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys = ON');
  }
  return backup === undefined ? { from, to: migrations.length } : { from, to: migrations.length, backup };
}

export interface MigrateResult {
  /** The version the database was at. Past `to` when it is newer than this daemon and opened as it is. */
  from: number;
  /** The newest version this daemon knows. */
  to: number;
  /** Where the database was copied before migrating, when it was. */
  backup?: string;
}

/** The database's schema version, `PRAGMA user_version`: the number of migrations applied. */
export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
