import type {} from './import-meta-glob.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The schema, from `migrations/NNNN_name.sql`. Forward-only: never edit a shipped file, add a new one. */
export const MIGRATIONS: readonly Migration[] = Object.entries(
  import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }),
)
  .map(([path, sql]) => {
    const match = /\/(\d+)_([\w-]+)\.sql$/.exec(path);
    if (!match) throw new Error(`migration file ${path} must be named NNNN_name.sql`);
    return { version: Number(match[1]), name: match[2]!, sql };
  })
  .sort((a, b) => a.version - b.version);

/**
 * Applies every migration newer than the database's `PRAGMA user_version`, each in its own transaction together
 * with the version bump, so a failing migration leaves the database at the last good version. Foreign keys are off
 * while they run, as SQLite needs to rebuild a table others reference, and each migration must leave every reference
 * whole before it commits.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`migrations must be numbered 1..n; found ${migration.version} at position ${index + 1}`);
    }
  });
  const from = schemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`database is at schema version ${from}, newer than this daemon knows (${migrations.length})`);
  }
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
  return { from, to: migrations.length };
}

/** The database's schema version, `PRAGMA user_version`: the number of migrations applied. */
export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}
