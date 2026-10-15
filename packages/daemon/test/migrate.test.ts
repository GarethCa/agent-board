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
    expect(db.prepare('SELECT session_id FROM schedules').all()).toEqual([{ session_id: 's' }]);
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
