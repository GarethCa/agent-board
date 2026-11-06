import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, schemaVersion, type Migration } from '../src/migrate.ts';

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (row) => row.name,
  );

const TWO_STEPS: Migration[] = [
  { version: 1, name: 'zones', sql: 'CREATE TABLE zones (id TEXT PRIMARY KEY);' },
  { version: 2, name: 'tiles', sql: 'CREATE TABLE tiles (id TEXT PRIMARY KEY, zone_id TEXT REFERENCES zones(id));' },
];

/** Each match of `pattern` in `sql`: the table its first group names, and where it starts. */
const statements = (sql: string, pattern: RegExp) =>
  [...sql.matchAll(pattern)].map((match) => ({ table: match[1]!.toLowerCase(), at: match.index }));

/**
 * Where a migration deletes rows another table still points at without clearing that table first, as `migration:
 * parent <- child`. Foreign keys are off while migrations run, so ON DELETE CASCADE, SET NULL and the rest never fire,
 * and each child row of a deleted one is left pointing at nothing. A REPLACE deletes the row it conflicts with, so it
 * counts as a delete. Triggers fire at run time, with foreign keys on, so a statement inside a trigger's body doesn't
 * count. It checks only that an earlier DELETE or UPDATE of each child is there, not that its WHERE matches the
 * parent's: a test that seeds child rows and runs the migration checks that.
 */
function deletesLeavingChildren(migrations: readonly Migration[]): string[] {
  const db = new DatabaseSync(':memory:');
  const children = () => {
    const byParent = new Map<string, Set<string>>();
    for (const table of tables(db)) {
      for (const { table: parent } of db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as { table: string }[]) {
        if (parent === table) continue;
        byParent.set(parent, (byParent.get(parent) ?? new Set()).add(table));
      }
    }
    return byParent;
  };
  const found: string[] = [];
  migrations.forEach((migration, index) => {
    const before = children();
    migrate(db, migrations.slice(0, index + 1));
    const after = children();
    const sql = migration.sql.replace(/--[^\n]*/g, '').replace(/\bCREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi, '');
    const writes = statements(sql, /\b(?:DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?)\s+"?(\w+)"?/gi);
    for (const { table, at } of statements(sql, /\b(?:DELETE\s+FROM|(?:INSERT\s+OR\s+)?REPLACE\s+INTO)\s+"?(\w+)"?/gi)) {
      for (const child of new Set([...(before.get(table) ?? []), ...(after.get(table) ?? [])])) {
        if (!writes.some((write) => write.table === child.toLowerCase() && write.at < at)) {
          found.push(`${String(migration.version).padStart(4, '0')}_${migration.name}: ${table} <- ${child}`);
        }
      }
    }
  });
  return found;
}

describe('MIGRATIONS', () => {
  it('lists every .sql file in the migrations folder, in order, with its text', () => {
    const dir = new URL('../src/migrations/', import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
    expect(MIGRATIONS.map((m) => `${String(m.version).padStart(4, '0')}_${m.name}.sql`)).toEqual(files);
    for (const m of MIGRATIONS) {
      expect(m.sql).toBe(readFileSync(new URL(`${String(m.version).padStart(4, '0')}_${m.name}.sql`, dir), 'utf8'));
    }
  });
});

describe('migrate', () => {
  it('brings an empty database to the latest version', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db, TWO_STEPS)).toEqual({ from: 0, to: 2 });
    expect(schemaVersion(db)).toBe(2);
    expect(tables(db)).toEqual(['tiles', 'zones']);
  });

  it('upgrades from a previous version by applying only the newer migrations', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, TWO_STEPS.slice(0, 1));
    db.exec("INSERT INTO zones (id) VALUES ('kept')");

    expect(migrate(db, TWO_STEPS)).toEqual({ from: 1, to: 2 });
    expect(tables(db)).toEqual(['tiles', 'zones']);
    expect(db.prepare('SELECT id FROM zones').all()).toEqual([{ id: 'kept' }]);
  });

  it('does nothing when the database is already current', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, TWO_STEPS);
    expect(migrate(db, TWO_STEPS)).toEqual({ from: 2, to: 2 });
  });

  it('rolls a failing migration back and leaves the version where it was', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, TWO_STEPS.slice(0, 1));
    const broken = [...TWO_STEPS.slice(0, 1), { version: 2, name: 'broken', sql: 'CREATE TABLE half (id TEXT); NOT SQL;' }];

    expect(() => migrate(db, broken)).toThrow(/migration 2 \(broken\)/);
    expect(schemaVersion(db)).toBe(1);
    expect(tables(db)).toEqual(['zones']);
  });

  it('refuses a database written by a newer daemon', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA user_version = 3');
    expect(() => migrate(db, TWO_STEPS)).toThrow(/newer/);
  });

  it('rebuilds a table other tables reference, with foreign keys on, and leaves them on', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, TWO_STEPS);
    db.exec("INSERT INTO zones (id) VALUES ('z'); INSERT INTO tiles (id, zone_id) VALUES ('t', 'z');");
    const rebuild = {
      version: 3,
      name: 'rebuild',
      sql: `CREATE TABLE zones_new (id TEXT PRIMARY KEY, name TEXT);
        INSERT INTO zones_new (id) SELECT id FROM zones; DROP TABLE zones; ALTER TABLE zones_new RENAME TO zones;`,
    };

    expect(migrate(db, [...TWO_STEPS, rebuild])).toEqual({ from: 2, to: 3 });
    expect(db.prepare('SELECT id, name FROM zones').all()).toEqual([{ id: 'z', name: null }]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec("INSERT INTO tiles (id, zone_id) VALUES ('u', 'missing')")).toThrow(/FOREIGN KEY/);
  });

  it('rolls back a migration that leaves a broken reference', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, TWO_STEPS);
    db.exec("INSERT INTO zones (id) VALUES ('z'); INSERT INTO tiles (id, zone_id) VALUES ('t', 'z');");
    const dangling = { version: 3, name: 'dangling', sql: "DELETE FROM zones WHERE id = 'z';" };

    expect(() => migrate(db, [...TWO_STEPS, dangling])).toThrow(/migration 3 \(dangling\).*foreign key/);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare('SELECT id FROM zones').all()).toEqual([{ id: 'z' }]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('rejects migration lists that are not numbered 1..n', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => migrate(db, [TWO_STEPS[1]!])).toThrow(/numbered/);
  });
});

describe('the shipped migrations', () => {
  it('clear the rows that point at any rows they delete, first, as no foreign key action fires while they run', () => {
    expect(deletesLeavingChildren(MIGRATIONS)).toEqual([]);
  });

  it('are checked for that by a scan that finds a delete with its children left, and passes one that clears them', () => {
    const cascade: Migration[] = [
      ...TWO_STEPS.slice(0, 1),
      { version: 2, name: 'tiles', sql: 'CREATE TABLE tiles (id TEXT PRIMARY KEY, zone_id TEXT REFERENCES zones(id) ON DELETE CASCADE);' },
    ];
    const step = (sql: string): Migration[] => [...cascade, { version: 3, name: 'prune', sql }];

    expect(deletesLeavingChildren(step("DELETE FROM zones WHERE id = 'old';"))).toEqual(['0003_prune: zones <- tiles']);
    expect(deletesLeavingChildren(step("DELETE FROM zones WHERE id = 'old'; DELETE FROM tiles WHERE zone_id = 'old';"))).toEqual([
      '0003_prune: zones <- tiles',
    ]);
    expect(deletesLeavingChildren(step("DELETE FROM tiles WHERE zone_id = 'old'; DELETE FROM zones WHERE id = 'old';"))).toEqual([]);
    expect(deletesLeavingChildren(step("UPDATE tiles SET zone_id = NULL WHERE zone_id = 'old'; DELETE FROM zones WHERE id = 'old';"))).toEqual([]);
    expect(
      deletesLeavingChildren(step('CREATE TRIGGER prune AFTER DELETE ON tiles BEGIN DELETE FROM zones WHERE id = OLD.zone_id; END;')),
    ).toEqual([]);
    expect(deletesLeavingChildren(step("INSERT OR REPLACE INTO zones (id) VALUES ('old');"))).toEqual(['0003_prune: zones <- tiles']);
    expect(deletesLeavingChildren(step("REPLACE INTO zones (id) VALUES ('old');"))).toEqual(['0003_prune: zones <- tiles']);
  });

  it('are numbered 1..n', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('apply to an empty database', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: MIGRATIONS.length });
  });

  it("leave the zone-removal trigger in place: a later rebuild of zones would drop it unless it's made again", () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const triggers = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'").all();
    expect(triggers).toContainEqual({ name: 'board_items_leave_removed_zone', tbl_name: 'zones' });
  });

  it("leave the connector triggers in place on every table a connector can end on, for the same reason", () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const triggers = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'connectors_%'").all();
    expect(triggers).toHaveLength(5);
    expect(triggers.map((trigger) => trigger.tbl_name).sort()).toEqual(['agents', 'board_items', 'external_sessions', 'shells', 'zones']);
  });

  // Vacuous until there are two shipped migrations; the synthetic TWO_STEPS tests cover the mechanism meanwhile.
  it.skipIf(MIGRATIONS.length < 2)('upgrade a database at the previous version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS.slice(0, -1));
    expect(migrate(db)).toEqual({ from: MIGRATIONS.length - 1, to: MIGRATIONS.length });
  });

  it('give existing zones no fill opacity of their own, so they keep the theme default', () => {
    const db = new DatabaseSync(':memory:');
    const added = MIGRATIONS.findIndex((m) => m.name === 'zone_fill_opacity');
    expect(added).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, added));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
      VALUES ('a', NULL, '', 'ideas', '#4c6ef5', 0, 0, 300, 200)`);

    migrate(db);

    expect(db.prepare('SELECT fill_opacity FROM zones').all()).toEqual([{ fill_opacity: null }]);
    expect(() => db.exec("UPDATE zones SET fill_opacity = 41")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE zones SET fill_opacity = 40")).not.toThrow();
  });

  it('give existing zones normal spacing, the gaps they were laid out at, and refuse any other than the three', () => {
    const db = new DatabaseSync(':memory:');
    const added = MIGRATIONS.findIndex((m) => m.name === 'zone_spacing');
    expect(added).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, added));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
      VALUES ('a', NULL, '', 'ideas', '#4c6ef5', 0, 0, 300, 200)`);

    migrate(db);

    expect(db.prepare('SELECT spacing FROM zones').all()).toEqual([{ spacing: 'normal' }]);
    expect(() => db.exec("UPDATE zones SET spacing = 'huge'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE zones SET spacing = 'roomy'")).not.toThrow();
  });

  it("remember existing zones' folders as recent ones, once each, when zones get sources", () => {
    const db = new DatabaseSync(':memory:');
    const sources = MIGRATIONS.findIndex((m) => m.name === 'zone_sources');
    migrate(db, MIGRATIONS.slice(0, sources));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, created_at) VALUES
        ('a', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200, '2026-10-01T00:00:00.000Z'),
        ('b', '/code/app', 'apps/web', 'web', '#4c6ef5', 0, 0, 300, 200, '2026-10-02T00:00:00.000Z'),
        ('c', '/code/app', '', 'app again', '#4c6ef5', 0, 0, 300, 200, '2026-10-03T00:00:00.000Z'),
        ('d', NULL, '', 'ideas', '#4c6ef5', 0, 0, 300, 200, '2026-10-04T00:00:00.000Z')`);

    migrate(db);

    expect(db.prepare('SELECT path, used_at FROM recent_folders ORDER BY used_at').all()).toEqual([
      { path: '/code/app/apps/web', used_at: '2026-10-02T00:00:00.000Z' },
      { path: '/code/app', used_at: '2026-10-03T00:00:00.000Z' },
    ]);
    expect(db.prepare('SELECT DISTINCT clone_repo, clone_path FROM zones').all()).toEqual([{ clone_repo: null, clone_path: null }]);
  });

  it('keep existing zones, and their agents, shells and schedules, when zones become unbindable', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const unbound = MIGRATIONS.findIndex((m) => m.name === 'unbound_zones');
    migrate(db, MIGRATIONS.slice(0, unbound));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, tracker_provider, tracker_scope)
        VALUES ('z', '/code/app', 'apps/web', 'app/apps/web', '#4c6ef5', 1, 2, 300, 200, 'linear', 'ACME');
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('s', 'claude', 'h', '/w');
      INSERT INTO agents (session_id, zone_id, name, description, branch, worktree, state)
        VALUES ('s', 'z', 'Ada', 'Do it', 'ada', '/w', 'idle');
      INSERT INTO schedules (session_id, cron, prompt) VALUES ('s', '0 9 * * *', 'Morning');
      INSERT INTO shells (id, zone_id, name, cwd, layout) VALUES ('sh', 'z', 'Shell', '/code/app/apps/web', '{}');`);
    const before = db.prepare('SELECT * FROM zones').all();
    // Object equality ignores key order, so the columns' order is checked on its own.
    const columns = () => (db.prepare('PRAGMA table_info(zones)').all() as { name: string }[]).map((column) => column.name);
    const columnsBefore = columns();

    migrate(db);

    // Later migrations only add columns, after these.
    expect(columns().slice(0, columnsBefore.length)).toEqual(columnsBefore);
    expect(db.prepare(`SELECT ${columnsBefore.join(', ')} FROM zones`).all()).toEqual(before);
    expect(db.prepare('SELECT zone_id FROM agents').all()).toEqual([{ zone_id: 'z' }]);
    expect(db.prepare('SELECT zone_id FROM shells').all()).toEqual([{ zone_id: 'z' }]);
    expect(db.prepare("SELECT kind, zone_id, json_extract(data, '$.agent') AS agent FROM board_items").all()).toEqual([{ kind: 'clock', zone_id: 'z', agent: 's' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec(`INSERT INTO zones (id, repo_root, name, color, x, y, width, height)
      VALUES ('u', NULL, 'Ideas', '#12b886', 0, 0, 300, 200)`);
    expect(() =>
      db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('v', NULL, 'apps', 'Bad', '#12b886', 0, 0, 300, 200)`),
    ).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout) VALUES ('sh2', 'nope', 'S', '/', '{}')")).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => db.exec("INSERT INTO agents (session_id, zone_id, repo_root, name, description, branch, worktree, state) VALUES ('s2', 'nope', '/code/app', 'a', 'b', 'c', 'd', 'idle')")).toThrow(/FOREIGN KEY|NOT NULL/);
  });
});

describe('the movable tiles migration', () => {
  it('keeps shells, agents and external sessions, with no stored position, and lets a shell leave its zone', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const movable = MIGRATIONS.findIndex((m) => m.name === 'movable_tiles');
    expect(movable).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, movable));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 1, 2, 300, 200);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('s', 'claude', 'h', '/w');
      INSERT INTO agents (session_id, zone_id, name, description, branch, worktree, state)
        VALUES ('s', 'z', 'Ada', 'Do it', 'ada', '/w', 'idle');
      INSERT INTO shells (id, zone_id, name, cwd, layout, created_at) VALUES ('sh', 'z', 'Shell 1', '/code/app', '{}', '2026-01-01T00:00:00.000Z');
      INSERT INTO external_sessions (id, harness, session_id, cwd, state) VALUES ('claude:e', 'claude', 'e', '/x', 'idle');`);

    migrate(db);

    expect(db.prepare('SELECT id, zone_id, name, cwd, layout, created_at, x, y, z FROM shells').all()).toEqual([
      { id: 'sh', zone_id: 'z', name: 'Shell 1', cwd: '/code/app', layout: '{}', created_at: '2026-01-01T00:00:00.000Z', x: null, y: null, z: null },
    ]);
    expect(db.prepare('SELECT session_id, zone_id, x, y, z FROM agents').all()).toEqual([
      { session_id: 's', zone_id: 'z', x: null, y: null, z: null },
    ]);
    expect(db.prepare('SELECT id, position_zone_id, x, y, z FROM external_sessions').all()).toEqual([
      { id: 'claude:e', position_zone_id: null, x: null, y: null, z: null },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout, x, y, z) VALUES ('loose', NULL, 'Shell 1', '/home', '{}', 5, 6, 1)");
    expect(() => db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout) VALUES ('sh2', 'nope', 'S', '/', '{}')")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout, x) VALUES ('sh3', NULL, 'S', '/', '{}', 1)")).toThrow(/CHECK/);
  });
});

describe('the free agents migration', () => {
  it("keeps agents, their places and schedules, records each one's repo, and lets an agent leave every zone", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const free = MIGRATIONS.findIndex((m) => m.name === 'free_agents');
    expect(free).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, free));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', 'apps/web', 'app/apps/web', '#4c6ef5', 1, 2, 300, 200);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('s', 'claude', 'h', '/w');
      INSERT INTO agents (session_id, zone_id, name, description, branch, worktree, state, issue_provider, issue_id,
          issue_title, issue_url, notice, muted, x, y, z)
        VALUES ('s', 'z', 'Ada', 'Do it', 'ada', '/w', 'idle', 'linear', 'ACME-1', 'One', 'https://l/1', 'Note', 1, 5, 6, 7);
      INSERT INTO schedules (session_id, cron, prompt) VALUES ('s', '0 9 * * *', 'Morning');`);
    const before = db.prepare('SELECT * FROM agents').get();

    // Up to this migration only: later ones may add columns of their own.
    migrate(db, MIGRATIONS.slice(0, free + 1));

    expect(db.prepare('SELECT * FROM agents').get()).toEqual({ ...before, repo_root: '/code/app', codex_bypass_hook_trust: 1 });
    expect(db.prepare('SELECT session_id FROM schedules').all()).toEqual([{ session_id: 's' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec(`INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('s2', 'claude', 'h2', '/w2');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state, x, y)
        VALUES ('s2', NULL, '/code/app', 0, 'Bo', 'Go', 'bo', '/w2', 'idle', 1, 2)`);
    const insert = (zone: string, x: string) =>
      db.exec(`INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state, x)
        VALUES ('s', ${zone}, '/code/app', 1, 'a', 'b', 'c', 'd', 'idle', ${x})`);
    db.exec("DELETE FROM agents WHERE session_id = 's'");
    expect(() => insert("'nope'", 'NULL')).toThrow(/FOREIGN KEY/);
    expect(() => insert('NULL', '1')).toThrow(/CHECK/);
    db.exec("DELETE FROM agents");
    expect(db.prepare('SELECT count(*) AS n FROM schedules').get()).toEqual({ n: 0 });
  });

  it('keep every zone bound as it was, and its agents, when groups get a default repo and agents a model', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const zoneless = MIGRATIONS.findIndex((m) => m.name === 'zoneless_agents');
    expect(zoneless).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, zoneless));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, tracker_provider, tracker_scope)
        VALUES ('repo', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200, 'linear', 'ACME'),
          ('folder', '/code/app', 'apps/web', 'web', '#4c6ef5', 0, 0, 300, 200, NULL, NULL),
          ('group', NULL, '', 'ideas', '#4c6ef5', 0, 0, 300, 200, NULL, NULL);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('s', 'claude', 'h', '/w');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state)
        VALUES ('s', 'folder', '/code/app', 1, 'Ada', 'Do it', 'ada', '/w', 'idle');`);
    const zones = db.prepare('SELECT * FROM zones ORDER BY rowid').all();
    const agents = db.prepare('SELECT * FROM agents').all();

    migrate(db, MIGRATIONS.slice(0, zoneless + 1));

    expect(db.prepare('SELECT * FROM zones ORDER BY rowid').all()).toEqual(zones.map((zone) => ({ ...zone, default_repo: null })));
    expect(db.prepare('SELECT * FROM agents').all()).toEqual(agents.map((agent) => ({ ...agent, model: null, role: null })));
    db.exec("UPDATE zones SET default_repo = '/code/app' WHERE id = 'group'");
    expect(() => db.exec("UPDATE zones SET default_repo = '/code/app' WHERE id = 'repo'")).toThrow(/CHECK/);
  });

  it('fails, rather than dropping it, on an agent whose zone is missing', () => {
    const db = new DatabaseSync(':memory:');
    const free = MIGRATIONS.findIndex((m) => m.name === 'free_agents');
    migrate(db, MIGRATIONS.slice(0, free));
    // As if its zone went while foreign keys were off.
    db.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('s', 'claude', 'h', '/w');
      INSERT INTO agents (session_id, zone_id, name, description, branch, worktree, state)
        VALUES ('s', 'gone', 'Ada', 'Do it', 'ada', '/w', 'idle');`);

    expect(() => migrate(db)).toThrow(/free_agents.*NOT NULL constraint failed: agents_new.repo_root/);
    expect(db.prepare('SELECT session_id FROM agents').all()).toEqual([{ session_id: 's' }]);
  });
});

describe('the shell tile tabs migration', () => {
  it("keeps every shell tile and agent's tab, its connectors and owner index, and lets a shell tile own tabs", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const tileTabs = MIGRATIONS.findIndex((m) => m.name === 'shell_tile_tabs');
    expect(tileTabs).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, tileTabs));
    db.exec(`INSERT INTO shells (id, zone_id, name, cwd, layout, created_at, x, y, z)
        VALUES ('tile', NULL, 'Shell 1', '/home', '{"type":"pane","sessionId":"p"}', '2026-01-01T00:00:00.000Z', 5, 6, 1);
      INSERT INTO shells (id, zone_id, name, cwd, layout, owner_kind, owner_id) VALUES ('tab', NULL, 'zsh', '/w', '{}', 'agent', 'a');
      INSERT INTO connectors (id, from_type, from_id, from_side, to_type, to_id, to_side, style, start_end, end_end)
        VALUES ('c', 'shell', 'tile', 'right', 'shell', 'tab', 'left', 'solid', 'none', 'arrow');`);

    migrate(db);

    expect(db.prepare('SELECT id, zone_id, name, cwd, layout, created_at, x, y, z, owner_kind, owner_id FROM shells ORDER BY rowid').all()).toEqual([
      { id: 'tile', zone_id: null, name: 'Shell 1', cwd: '/home', layout: '{"type":"pane","sessionId":"p"}', created_at: '2026-01-01T00:00:00.000Z', x: 5, y: 6, z: 1, owner_kind: null, owner_id: null },
      { id: 'tab', zone_id: null, name: 'zsh', cwd: '/w', layout: '{}', created_at: expect.any(String), x: null, y: null, z: null, owner_kind: 'agent', owner_id: 'a' },
    ]);
    db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout, owner_kind, owner_id) VALUES ('tile-tab', NULL, 'zsh', '/home', '{}', 'shell', 'tile')");
    expect(() => db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout, owner_kind, owner_id) VALUES ('x', NULL, 'S', '/', '{}', 'zone', 'z')")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO shells (id, zone_id, name, cwd, layout, owner_kind) VALUES ('y', NULL, 'S', '/', '{}', 'shell')")).toThrow(/CHECK/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shells' AND name = 'shells_owner'").all()).toHaveLength(1);
    db.exec("DELETE FROM shells WHERE id = 'tile'");
    expect(db.prepare('SELECT id FROM connectors').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('the edge shapes migration', () => {
  it('keeps every connector and flow edge as it was, with its rules, approvals, hold and history, drawn as before', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const shapes = MIGRATIONS.findIndex((m) => m.name === 'edge_shapes');
    expect(shapes).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, shapes));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('a', 'claude', 'ha', '/a'), ('b', 'claude', 'hb', '/b');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state)
        VALUES ('a', 'z', '/code/app', 1, 'Ada', 'Do it', 'ada', '/a', 'idle'), ('b', 'z', '/code/app', 1, 'Bo', 'Check it', 'bo', '/b', 'idle');
      INSERT INTO connectors (id, from_type, from_id, from_side, to_type, to_id, to_side, style, start_end, end_end, label)
        VALUES ('c', 'agent', 'a', 'left', 'agent', 'b', 'right', 'elbow', 'none', 'arrow', 'see');
      INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, path, conditions, approvals, deliver_as, paused,
          held_name, held_text, held_since, held_reason)
        VALUES ('e', 'a', 'b', 'auto', 'handover', 'handover.md', '[{"kind":"script","command":"./ready.sh"}]', '{"./ready.sh":"f1"}',
          'queue', 1, 'handover.md', '# Done', '2026-10-14T10:00:00.000Z', 'exited 1');
      INSERT INTO flow_edge_events (edge_id, kind, detail) VALUES ('e', 'held', 'exited 1');`);
    const connectors = db.prepare('SELECT * FROM connectors').all();
    const edges = db.prepare('SELECT * FROM flow_edges').all();
    const events = db.prepare('SELECT * FROM flow_edge_events').all();

    migrate(db, MIGRATIONS.slice(0, shapes + 1));

    // Unbent, and a flow edge from its tile's right side to the other's left, curved: as each was drawn before.
    expect(db.prepare('SELECT * FROM connectors').all()).toEqual(connectors.map((connector) => ({ ...connector, points: '[]' })));
    expect(db.prepare('SELECT * FROM flow_edges').all()).toEqual(
      edges.map((edge) => ({ ...edge, from_side: 'right', to_side: 'left', style: 'curved', points: '[]' })),
    );
    expect(db.prepare('SELECT * FROM flow_edge_events').all()).toEqual(events);
  });
});

describe('the auto edge sides migration', () => {
  it('gives automatic sides to each edge an agent made still drawn as made, from right to left unbent, and leaves the rest', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const auto = MIGRATIONS.findIndex((m) => m.name === 'auto_edge_sides');
    expect(auto).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, auto));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd)
        VALUES ('a', 'claude', 'ha', '/a'), ('b', 'claude', 'hb', '/b'), ('c', 'claude', 'hc', '/c'), ('d', 'claude', 'hd', '/d');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state)
        VALUES ('a', 'z', '/code/app', 1, 'Ada', '', 'ada', '/a', 'idle'), ('b', 'z', '/code/app', 1, 'Bo', '', 'bo', '/b', 'idle'),
          ('c', 'z', '/code/app', 1, 'Cy', '', 'cy', '/c', 'idle'), ('d', 'z', '/code/app', 1, 'Di', '', 'di', '/d', 'idle');
      INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, made_by, one_off, from_side, to_side, style, points)
        VALUES ('orchestrated', 'a', 'b', 'auto', 'final-message', 'd', 0, 'right', 'left', 'curved', '[]'),
          ('one-off', 'b', 'a', 'manual', 'final-message', 'b', 1, 'right', 'left', 'elbow', '[]'),
          ('drawn', 'a', 'c', 'manual', 'final-message', NULL, 0, 'right', 'left', 'curved', '[]'),
          ('bent', 'c', 'a', 'manual', 'final-message', 'd', 0, 'right', 'left', 'curved', '[{"x":10,"y":20}]'),
          ('picked', 'b', 'c', 'manual', 'final-message', 'd', 0, 'bottom', 'top', 'curved', '[]');`);
    const sides = () => db.prepare('SELECT id, from_side, to_side, style, points FROM flow_edges ORDER BY id').all();
    const before = sides();

    migrate(db, MIGRATIONS.slice(0, auto + 1));

    // An agent never gives an edge its sides, so one it made from right to left unbent was never given them. One the
    // user drew may have been dropped on those two handles: it stays as it is. Its style isn't where it attaches.
    const now = new Map(before.map((row) => [row.id, row]));
    for (const id of ['orchestrated', 'one-off']) now.set(id, { ...now.get(id)!, from_side: 'auto', to_side: 'auto' });
    expect(sides()).toEqual([...now.values()]);
  });

  it('record the agents each orchestrator started as its crew, when agents get records', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const added = MIGRATIONS.findIndex((m) => m.name === 'agent_records');
    expect(added).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, added));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd)
        VALUES ('lead', 'claude', 'h1', '/a'), ('impl', 'claude', 'h2', '/b'), ('orphan', 'claude', 'h3', '/c');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state, spawned_by)
        VALUES ('lead', 'z', '/code/app', 1, 'Lead', '', 'lead', '/a', 'idle', NULL),
          ('impl', 'z', '/code/app', 1, 'Impl', '', 'impl', '/b', 'idle', 'lead'),
          ('orphan', 'z', '/code/app', 1, 'Orphan', '', 'orphan', '/c', 'idle', 'gone')`);

    migrate(db);

    expect(db.prepare('SELECT session_id, kind, key, data, deleted_at FROM agent_records').all()).toEqual([
      { session_id: 'lead', kind: 'crew', key: 'impl', data: '{}', deleted_at: null },
    ]);
  });
});

describe('the clocks migration', () => {
  it("makes each agent's schedule a clock beside its tile, joined to it, with its runs, and keeps nothing else of it", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const clocks = MIGRATIONS.findIndex((m) => m.name === 'clocks');
    expect(clocks).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, clocks));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 900, 400);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('a', 'claude', 'ha', '/a'), ('b', 'claude', 'hb', '/b'), ('c', 'claude', 'hc', '/c'), ('d', 'claude', 'hd', '/d');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state, x, y)
        VALUES ('a', 'z', '/code/app', 1, 'Ada', 'Do it', 'ada', '/a', 'idle', 400, 40), ('b', 'z', '/code/app', 1, 'Bo', 'Do it', 'bo', '/b', 'idle', 16, 200),
          ('c', NULL, '/code/app', 1, 'Cy', 'Do it', 'cy', '/c', 'idle', 16, 600),
          ('d', NULL, '/code/app', 1, 'Di', 'Do it', 'di', '/d', 'idle', NULL, NULL);
      INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES ('n', 'sticky', 'z', 0, 0, 200, 200, 5, '{}');
      INSERT INTO schedules (session_id, cron, prompt, enabled) VALUES ('a', '0 9 * * 1-5', 'Morning', 1), ('b', '@hourly', 'Sweep', 0), ('c', '@daily', 'Tidy', 1), ('d', '@daily', 'Tidy up', 1);
      INSERT INTO schedule_runs (session_id, due_at, fired_at, outcome, reason)
        VALUES ('a', '2026-10-12T08:00:00.000Z', '2026-10-12T08:00:01.000Z', 'started', NULL),
               ('a', '2026-10-13T08:00:00.000Z', '2026-10-13T08:00:00.000Z', 'skipped', 'it was still running');`);

    migrate(db, MIGRATIONS.slice(0, clocks + 1));

    const items = db.prepare("SELECT id, zone_id, x, y, width, height, z, data FROM board_items WHERE kind = 'clock' ORDER BY id").all() as { data: string }[];
    expect(items.map((item) => ({ ...item, data: JSON.parse(item.data) as unknown }))).toEqual([
      {
        id: 'clock-a',
        zone_id: 'z',
        // 60 px left of its tile.
        x: 84,
        y: 40,
        width: 256,
        height: 76,
        z: 6,
        data: {
          cron: '0 9 * * 1-5',
          enabled: true,
          does: 'message',
          agent: 'a',
          prompt: 'Morning',
          fresh: { harness: 'claude', model: null, role: null, closeWhenDone: true },
          result: 'history',
          handoffTo: null,
          folded: false,
        },
      },
      // No room on its left in the zone: on its right.
      expect.objectContaining({ id: 'clock-b', x: 332, y: 200, z: 7, data: expect.objectContaining({ agent: 'b', enabled: false, cron: '@hourly' }) }),
      // Loose on the board, its left is always room.
      expect.objectContaining({ id: 'clock-c', zone_id: null, x: -300, y: 600, z: 8 }),
      // Not placed yet: beside the board's origin, as the app puts one.
      expect.objectContaining({ id: 'clock-d', zone_id: null, x: -316, y: 0, z: 9 }),
    ]);
    expect(db.prepare('SELECT clock_id, due_at, outcome, reason, session_id, agent_name FROM clock_runs ORDER BY id').all()).toEqual([
      { clock_id: 'clock-a', due_at: '2026-10-12T08:00:00.000Z', outcome: 'started', reason: null, session_id: 'a', agent_name: 'Ada' },
      { clock_id: 'clock-a', due_at: '2026-10-13T08:00:00.000Z', outcome: 'skipped', reason: 'it was still running', session_id: 'a', agent_name: 'Ada' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('schedules', 'schedule_runs')").all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('the drop-pacing migration', () => {
  it('drops pacing by usage: zone priorities and holds, why an agent was paused, and its settings; the reading and everything else stay', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const drop = MIGRATIONS.findIndex((m) => m.name === 'drop_usage_pacing');
    expect(drop).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, drop));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, priority, usage_hold_reason, usage_hold_at)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 900, 400, 'low', '5h at 86%', '2026-10-28T10:00:00Z');
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd) VALUES ('a', 'claude', 'ha', '/a');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state, x, y, hibernated_at, hibernated_reason)
        VALUES ('a', 'z', '/code/app', 1, 'Ada', 'Do it', 'ada', '/a', 'idle', 400, 40, '2026-10-28T10:00:00Z', '5h at 96%');
      INSERT INTO usage_reading (id, five_hour_used, read_at) VALUES (1, 72, '2026-10-28T10:00:00Z');
      INSERT INTO settings (key, value) VALUES ('usagePacing', 'true'), ('usageThresholds', '{}'), ('arrangeSpacing', '"compact"');`);

    migrate(db);

    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    expect(columns('zones')).not.toContain('priority');
    expect(columns('zones')).not.toContain('usage_hold_reason');
    expect(columns('zones')).not.toContain('usage_hold_at');
    expect(columns('agents')).not.toContain('hibernated_reason');
    expect(db.prepare('SELECT name FROM zones').all()).toEqual([{ name: 'app' }]);
    expect(db.prepare('SELECT state, hibernated_at FROM agents').all()).toEqual([{ state: 'idle', hibernated_at: '2026-10-28T10:00:00Z' }]);
    expect(db.prepare('SELECT five_hour_used FROM usage_reading').all()).toEqual([{ five_hour_used: 72 }]);
    expect(db.prepare('SELECT key FROM settings').all()).toEqual([{ key: 'arrangeSpacing' }]);
  });
});

describe('the drop-reviewer-edges migration', () => {
  it("drops the reviewer's edges an agent made and what happened along them; an edge the user drew keeps its history", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const drop = MIGRATIONS.findIndex((m) => m.name === 'drop_reviewer_edges');
    expect(drop).toBeGreaterThan(0);
    migrate(db, MIGRATIONS.slice(0, drop));
    db.exec(`INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height)
        VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200);
      INSERT INTO sessions (id, harness, hook_token_sha256, cwd)
        VALUES ('owner', 'claude', 'ho', '/o'), ('reviewer', 'claude', 'hr', '/r'), ('lead', 'claude', 'hl', '/l'), ('second', 'claude', 'hs', '/s');
      INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state, reviews_branch)
        VALUES ('owner', 'z', '/code/app', 1, 'Owner', '', 'feature', '/o', 'idle', NULL),
          ('reviewer', 'z', '/code/app', 1, 'Reviewer', '', 'review-feature', '/r', 'idle', 'feature'),
          ('second', 'z', '/code/app', 1, 'Second', '', 'second-look', '/s', 'idle', 'feature'),
          ('lead', 'z', '/code/app', 1, 'Lead', '', 'lead', '/l', 'idle', NULL);
      INSERT INTO flow_edges (id, from_session_id, to_session_id, trigger, payload, made_by, one_off)
        VALUES ('findings', 'reviewer', 'owner', 'manual', 'final-message', 'lead', 0),
          ('next-round', 'owner', 'reviewer', 'manual', 'final-message', 'lead', 0),
          ('drawn', 'second', 'owner', 'manual', 'final-message', NULL, 0);
      INSERT INTO flow_edge_events (edge_id, kind, detail)
        VALUES ('findings', 'delivered', 'sent the findings'), ('next-round', 'delivered', 'sent the next round'),
          ('drawn', 'delivered', 'sent by hand');`);

    migrate(db, MIGRATIONS.slice(0, drop + 1));

    expect(db.prepare('SELECT id FROM flow_edges').all()).toEqual([{ id: 'drawn' }]);
    expect(db.prepare('SELECT edge_id, detail FROM flow_edge_events').all()).toEqual([{ edge_id: 'drawn', detail: 'sent by hand' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
