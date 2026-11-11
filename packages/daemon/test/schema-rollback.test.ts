import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, schemaVersion, type Migration } from '../src/migrate.ts';
import { backwardSafety, isBackwardSafe, migrationChecksum } from '../src/schema-rollback.ts';
import frozenChecksums from './migration-checksums.json' with { type: 'json' };
import { tempDataDir } from './helpers.ts';

const V1: Migration = { version: 1, name: 'zones', sql: 'CREATE TABLE zones (id TEXT PRIMARY KEY);' };
const V2: Migration = { version: 2, name: 'tiles', sql: 'CREATE TABLE tiles (id TEXT PRIMARY KEY);' };
/** Adds a column an older daemon can leave alone: it has a default, so an older daemon's inserts still work. */
const V3_SAFE: Migration = {
  version: 3,
  name: 'zone_colour',
  sql: "-- backward-safe: a new column with a default, which an older daemon leaves alone.\nALTER TABLE zones ADD COLUMN colour TEXT NOT NULL DEFAULT 'blue';",
};
/** Moves data an older daemon reads to where it doesn't look. */
const V3_UNSAFE: Migration = {
  version: 3,
  name: 'zones_renamed',
  sql: 'ALTER TABLE zones RENAME TO areas;',
};

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

/** The database at `path` after `migrations`, run as a daemon that knows exactly those would, then closed. */
function runDaemon<T>(path: string, migrations: readonly Migration[], then: (db: DatabaseSync) => T = () => undefined as T): T {
  const db = open(path);
  try {
    migrate(db, migrations);
    return then(db);
  } finally {
    db.close();
  }
}

const backups = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('.bak')).toSorted();

/** The message `migrate` throws, or '' when it doesn't. */
function refusal(path: string, migrations: readonly Migration[]): string {
  const db = open(path);
  try {
    migrate(db, migrations);
    return '';
  } catch (error) {
    return (error as Error).message;
  } finally {
    db.close();
  }
}

const restoreCommand = (message: string) => /run `([^`]+)`/.exec(message)?.[1];

describe('isBackwardSafe', () => {
  it('is true only for a migration whose SQL has a backward-safe line of its own', () => {
    expect(isBackwardSafe(V3_SAFE)).toBe(true);
    expect(isBackwardSafe(V3_UNSAFE)).toBe(false);
    expect(isBackwardSafe({ ...V1, sql: 'CREATE TABLE t (note TEXT); -- not backward-safe' })).toBe(false);
  });
});

describe('backwardSafety', () => {
  it('reads only the first line, so a later comment never makes a migration backward-safe', () => {
    expect(backwardSafety('-- backward-safe: a new table.\nCREATE TABLE t (id TEXT);')).toBe('safe');
    expect(backwardSafety('-- not backward-safe: renames zones.\nALTER TABLE zones RENAME TO areas;')).toBe('unsafe');
    expect(backwardSafety('-- not backward-safe: renames zones.\n-- backward-safe: no, see above.\nALTER TABLE zones RENAME TO areas;')).toBe('unsafe');
    expect(backwardSafety('ALTER TABLE zones RENAME TO areas;\n-- backward-safe: says a comment further down.')).toBeUndefined();
    expect(backwardSafety('-- Renames zones.\n-- backward-safe: says the second line.')).toBeUndefined();
  });

  it('needs the reason after the mark', () => {
    expect(backwardSafety('-- backward-safe\nCREATE TABLE t (id TEXT);')).toBeUndefined();
    expect(backwardSafety('-- backward-safe:\nCREATE TABLE t (id TEXT);')).toBeUndefined();
    expect(backwardSafety('-- backward-safety is a word\nCREATE TABLE t (id TEXT);')).toBeUndefined();
    expect(backwardSafety('-- backward-safe: a new table.\r\nCREATE TABLE t (id TEXT);')).toBe('safe');
  });
});

describe('a backup before migrating', () => {
  it('copies the database, as it was, before each run that applies a migration, and not when there is nothing to apply', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1], (db) => db.exec("INSERT INTO zones (id) VALUES ('kept')"));
    expect(backups(dir)).toEqual([]);

    runDaemon(path, [V1, V2]);
    runDaemon(path, [V1, V2]);

    expect(backups(dir)).toEqual(['agent-board.db.v1.bak']);
    const backup = new DatabaseSync(join(dir, 'agent-board.db.v1.bak'));
    expect(schemaVersion(backup)).toBe(1);
    expect(backup.prepare('SELECT id FROM zones').all()).toEqual([{ id: 'kept' }]);
    backup.close();
  });

  it('says where it put the backup', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1]);
    const db = open(path);
    expect(migrate(db, [V1, V2])).toEqual({ from: 1, to: 2, backup: join(dir, 'agent-board.db.v1.bak') });
    db.close();
  });

  it('keeps the three most recent backups', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    const steps = Array.from({ length: 6 }, (_, i): Migration => ({ version: i + 1, name: `t${i + 1}`, sql: `CREATE TABLE t${i + 1} (id TEXT);` }));
    runDaemon(path, steps.slice(0, 1));
    for (let known = 2; known <= 6; known++) {
      runDaemon(path, steps.slice(0, known));
      // Each backup a minute older than the next, as runs on different days would leave them.
      const made = join(dir, `agent-board.db.v${known - 1}.bak`);
      const at = new Date(Date.UTC(2026, 0, 1, 0, known));
      utimesSync(made, at, at);
    }
    expect(backups(dir)).toEqual(['agent-board.db.v3.bak', 'agent-board.db.v4.bak', 'agent-board.db.v5.bak']);
  });

  it('replaces an older backup from the same version, as when the same upgrade runs again after a restore', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1]);
    writeFileSync(join(dir, 'agent-board.db.v1.bak'), 'stale');
    runDaemon(path, [V1, V2]);
    const backup = new DatabaseSync(join(dir, 'agent-board.db.v1.bak'));
    expect(schemaVersion(backup)).toBe(1);
    backup.close();
  });

  it('migrates nothing when it cannot make the backup', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1]);
    // A folder where the backup goes, with something in it, so the finished copy can't be put there.
    mkdirSync(join(dir, 'agent-board.db.v1.bak', 'in-the-way'), { recursive: true });
    const db = open(path);
    expect(() => migrate(db, [V1, V2])).toThrow(/^could not back up the database to .*agent-board\.db\.v1\.bak before migrating it/);
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'tiles'").all()).toEqual([]);
    db.close();
    expect(readdirSync(dir).filter((name) => name.includes('.partial'))).toEqual([]);
    expect(statSync(join(dir, 'agent-board.db.v1.bak')).isDirectory()).toBe(true);
  });

  it('keeps no copy of a held or queued hand-off file in the backup, but keeps a final message', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    const edges: Migration = {
      version: 1,
      name: 'flow_edges',
      sql: 'CREATE TABLE flow_edges (id TEXT PRIMARY KEY, payload TEXT NOT NULL, held_text TEXT, queued_text TEXT);',
    };
    runDaemon(path, [edges], (db) =>
      db.exec(`INSERT INTO flow_edges (id, payload, held_text, queued_text) VALUES
        ('held', 'file', 'a held file', NULL),
        ('queued', 'file', NULL, 'a queued file'),
        ('final', 'final-message', 'a final message', 'a queued final message')`),
    );
    runDaemon(path, [edges, { ...V2, version: 2 }]);

    const backup = new DatabaseSync(join(dir, 'agent-board.db.v1.bak'));
    expect(backup.prepare('SELECT id, held_text, queued_text FROM flow_edges ORDER BY id').all()).toEqual([
      { id: 'final', held_text: 'a final message', queued_text: 'a queued final message' },
      { id: 'held', held_text: null, queued_text: null },
      { id: 'queued', held_text: null, queued_text: null },
    ]);
    backup.close();
    // The board itself still has them, until each hand-off is delivered or dropped.
    expect(runDaemon(path, [edges, V2], (db) => db.prepare("SELECT held_text FROM flow_edges WHERE id = 'held'").get())).toEqual({
      held_text: 'a held file',
    });
  });

  it('makes none for a new database, which has nothing in it to lose', () => {
    const dir = tempDataDir();
    runDaemon(join(dir, 'agent-board.db'), [V1, V2]);
    expect(backups(dir)).toEqual([]);
  });
});

describe('an older daemon opening a database a newer daemon migrated', () => {
  it('opens it, and says so, when every newer migration is marked backward-safe', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2]);
    runDaemon(path, [V1, V2, V3_SAFE], (db) => db.exec("INSERT INTO zones (id, colour) VALUES ('newer', 'red')"));

    const opened = open(path);
    expect(migrate(opened, [V1, V2])).toEqual({ from: 3, to: 2 });
    // The older daemon reads and writes as it always has.
    opened.exec("INSERT INTO zones (id) VALUES ('older')");
    expect(opened.prepare('SELECT id, colour FROM zones ORDER BY id').all()).toEqual([
      { id: 'newer', colour: 'red' },
      { id: 'older', colour: 'blue' },
    ]);
    // And leaves the version alone, so the newer daemon has nothing to redo.
    expect(schemaVersion(opened)).toBe(3);
    opened.close();
  });

  it('refuses one with a newer migration not marked backward-safe, naming the backup and the command that restores it', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2], (db) => db.exec("INSERT INTO zones (id) VALUES ('before')"));
    runDaemon(path, [V1, V2, V3_UNSAFE], (db) => db.exec("INSERT INTO areas (id) VALUES ('after')"));

    const refused = open(path);
    let message = '';
    try {
      migrate(refused, [V1, V2]);
    } catch (error) {
      message = (error as Error).message;
    }
    refused.close();

    expect(message).toMatch(/^database is at schema version 3, newer than this daemon knows \(2\)/);
    expect(message).toContain('migration 3 (zones_renamed)');
    expect(message).toContain(join(dir, 'agent-board.db.v2.bak'));
    const command = /run `([^`]+)`/.exec(message)?.[1];
    expect(command).toBeDefined();

    execFileSync('/bin/sh', ['-c', command!]);

    // The older daemon now starts, on the board as it was before the upgrade.
    expect(runDaemon(path, [V1, V2], (db) => db.prepare('SELECT id FROM zones').all())).toEqual([{ id: 'before' }]);
    // Nothing is dropped: the newer database is kept beside it, whole.
    const kept = new DatabaseSync(join(dir, 'agent-board.db.v3.newer'));
    expect(schemaVersion(kept)).toBe(3);
    expect(kept.prepare('SELECT id FROM areas ORDER BY id').all()).toEqual([{ id: 'after' }, { id: 'before' }]);
    kept.close();
  });

  it('gives a command that stops, moving nothing, when it is run again', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2], (db) => db.exec("INSERT INTO zones (id) VALUES ('before')"));
    runDaemon(path, [V1, V2, V3_UNSAFE], (db) => db.exec("INSERT INTO areas (id) VALUES ('after')"));
    const command = restoreCommand(refusal(path, [V1, V2]));
    expect(command).toBeDefined();

    execFileSync('/bin/sh', ['-c', command!]);
    // Again, as from the shell's history, or pasted twice.
    expect(() => execFileSync('/bin/sh', ['-c', command!], { stdio: 'ignore' })).toThrow();

    const kept = new DatabaseSync(join(dir, 'agent-board.db.v3.newer'));
    expect(schemaVersion(kept)).toBe(3);
    expect(kept.prepare("SELECT id FROM areas WHERE id = 'after'").all()).toEqual([{ id: 'after' }]);
    kept.close();
    expect(runDaemon(path, [V1, V2], (db) => db.prepare('SELECT id FROM zones').all())).toEqual([{ id: 'before' }]);
  });

  it('moves the newer database to a name of its own when an earlier one was kept, so the restore never overwrites it', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2]);
    runDaemon(path, [V1, V2, V3_UNSAFE]);
    writeFileSync(join(dir, 'agent-board.db.v3.newer'), 'kept from an earlier rollback');
    const db = open(path);
    expect(() => migrate(db, [V1, V2])).toThrow('mv agent-board.db agent-board.db.v3.newer.2 &&');
    db.close();
  });

  it('refuses one whose newer migrations it has no record of, as one written before they were recorded', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1], (db) => db.exec('PRAGMA user_version = 2'));
    // Files that look like backups but name no version.
    writeFileSync(join(dir, 'agent-board.db.v.bak'), '');
    writeFileSync(join(dir, 'agent-board.db.vx.bak'), '');
    const db = open(path);
    expect(() => migrate(db, [V1])).toThrow(/newer than this daemon knows \(1\).*no backup/);
    db.close();
  });

  it('names the newest backup it can migrate from when there is none from its own version', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1]);
    // A newer daemon that skipped this one's version: it migrated from 1 straight to 3.
    runDaemon(path, [V1, V2, V3_UNSAFE]);
    const db = open(path);
    expect(() => migrate(db, [V1, V2])).toThrow(/agent-board\.db\.v1\.bak/);
    db.close();
  });

  it('leaves no write-ahead log behind once it closes, so the restore command moves the whole database', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2]);
    runDaemon(path, [V1, V2, V3_UNSAFE]);
    const db = open(path);
    expect(() => migrate(db, [V1, V2])).toThrow(/newer/);
    db.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
  });
});

describe('a database that ran a migration as different SQL', () => {
  // As when a migration is reverted, the board opens on an older build, and then it lands again, changed.
  const V3_RELANDED: Migration = {
    version: 3,
    name: 'zone_colour',
    sql: "-- backward-safe: a new column with a default, which an older daemon leaves alone.\nALTER TABLE zones ADD COLUMN colour TEXT NOT NULL DEFAULT 'green';\nALTER TABLE zones ADD COLUMN shade TEXT;",
  };

  it('is refused, naming the backup from before that migration and the command that restores it', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2], (db) => db.exec("INSERT INTO zones (id) VALUES ('before')"));
    runDaemon(path, [V1, V2, V3_SAFE]);
    runDaemon(path, [V1, V2]);

    const message = refusal(path, [V1, V2, V3_RELANDED]);

    expect(message).toMatch(/^this build's migration 3 \(zone_colour\) is not the one this database ran as migration 3 \(zone_colour\)/);
    expect(message).toContain('Open it with the build that last ran on it, or go back to the backup from before migration 3');
    expect(message).toContain(join(dir, 'agent-board.db.v2.bak'));
    expect(message).not.toContain('Install a build');
    execFileSync('/bin/sh', ['-c', restoreCommand(message)!]);
    // From the backup, this build runs its own migration 3.
    expect(runDaemon(path, [V1, V2, V3_RELANDED], (db) => db.prepare('SELECT id, colour, shade FROM zones').all())).toEqual([
      { id: 'before', colour: 'green', shade: null },
    ]);
  });

  it('is refused by the build that knows only up to it, as by a newer one', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2]);
    runDaemon(path, [V1, V2, V3_SAFE]);
    const V4: Migration = { version: 4, name: 'notes', sql: '-- backward-safe: a new table.\nCREATE TABLE notes (id TEXT);' };
    expect(refusal(path, [V1, V2, V3_RELANDED, V4])).toMatch(/^this build's migration 3 \(zone_colour\) is not the one/);
    expect(refusal(path, [V1, V2, V3_RELANDED])).toMatch(/^this build's migration 3 \(zone_colour\) is not the one/);
  });

  it('says to use the build that ran it, not to install one that knows its version, when there is no backup from before it', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    // A new database, so no backup from before migration 1.
    runDaemon(path, [V1, V2]);
    const message = refusal(path, [{ ...V1, sql: 'create table zones (id text primary key);' }, V2]);
    expect(message).toMatch(/^this build's migration 1 \(zones\) is not the one this database ran as migration 1/);
    expect(message).toContain("there is no backup from schema version 0 or older to go back to. Open it with the build that last ran on it; this build can't, until its migration 1 is put back as it was.");
    expect(message).not.toContain('Install a build');
  });

  it('is not refused when only a comment or the spacing changed', () => {
    const dir = tempDataDir();
    const path = join(dir, 'agent-board.db');
    runDaemon(path, [V1, V2]);
    runDaemon(path, [V1, V2, V3_SAFE]);
    const reworded: Migration = {
      ...V3_SAFE,
      sql: "-- backward-safe: a column with a default.\r\n-- Older daemons leave it alone.\r\nALTER TABLE zones\r\n  ADD COLUMN colour TEXT NOT NULL DEFAULT 'blue';\r\n",
    };
    expect(refusal(path, [V1, V2, reworded])).toBe('');
  });
});

describe('the shipped migrations', () => {
  it('are as they shipped: each SQL matches its checksum in migration-checksums.json, and each new one adds its own', () => {
    // A board that ran a migration refuses a build whose migration of that number differs, so a shipped one never changes.
    const shipped = Object.fromEntries(
      MIGRATIONS.map((migration) => [`${String(migration.version).padStart(4, '0')}_${migration.name}`, migrationChecksum(migration.sql)]),
    );
    expect(shipped, 'change a shipped migration with a new one; add a new one to migration-checksums.json').toEqual(frozenChecksums);
  });


  it('each say on their first line whether they are backward-safe, from the first that is recorded', () => {
    // Older daemons only ever compare the migrations after their own, so those from before the record began are left as they are.
    const recorded = MIGRATIONS.filter((migration) => migration.version > 81);
    for (const migration of recorded) {
      expect(backwardSafety(migration.sql), `${migration.version}_${migration.name}`).toBeDefined();
    }
  });
});
