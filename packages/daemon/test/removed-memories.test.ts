import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS, migrate } from '../src/migrate.ts';
import { saveRemovedMemories } from '../src/removed-memories.ts';
import type { TodoData } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

const REMOVED = MIGRATIONS.findIndex((migration) => migration.name === 'remove_memories');
const NOW = new Date('2026-11-27T09:30:00Z');
const USER = JSON.stringify({ kind: 'user' });
const AGENT = JSON.stringify({ kind: 'agent', sessionId: 's1', name: 'Builder' });

/** A board's database as it was while the board kept memories: a zone's memory, a loose one set to No agents, and a queue. */
function boardWithMemories(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  migrate(db, MIGRATIONS.slice(0, REMOVED));
  db.exec(`INSERT INTO zones (id, repo_root, name, color, x, y, width, height) VALUES ('web', '/tmp/web', 'Web app', '#888', 0, 0, 800, 600);
    INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES
      ('zone-memory', 'memory', 'web', 10, 10, 340, 244, 1, '{"title":"Release notes","madeBy":${AGENT},"noAgents":false,"count":3}'),
      ('own-memory', 'memory', NULL, 900, 0, 340, 244, 2, '{"title":"Mine","madeBy":${USER},"noAgents":true,"count":0}'),
      ('jobs', 'queue', 'web', 400, 10, 340, 244, 3, '{"title":"Jobs","madeBy":${USER},"noAgents":false,"audience":"agents","count":1}');
    INSERT INTO memory_entries (id, item_id, key, is_file, text, pinned, made_by, changed_by, created_at) VALUES
      ('e1', 'zone-memory', 'base', 0, 'main', 1, '${AGENT}', '${AGENT}', '2026-11-01T10:00:00Z'),
      ('e2', 'zone-memory', NULL, 0, 'Keep pull requests small.', 0, '${USER}', '${USER}', '2026-11-02T10:00:00Z'),
      ('e3', 'zone-memory', 'Runbook', 1, '# Steps\n\n\`\`\`\npnpm build\n\`\`\`', 0, '${AGENT}', '${AGENT}', '2026-11-03T10:00:00Z');
    INSERT INTO memory_reads (entry_id, item_id, session_id, name, at) VALUES ('e1', 'zone-memory', 's2', 'Reviewer', '2026-11-04T10:00:00Z');
    INSERT INTO queue_jobs (id, item_id, kind, text, position, made_by) VALUES ('j1', 'jobs', 'task', 'Fix the build', 1, '${USER}');
    INSERT INTO board_history (item_id, row_id, action, value, by) VALUES
      ('zone-memory', 'e1', 'add', '{"text":"main"}', '${AGENT}'),
      ('jobs', 'j1', 'add', '{"kind":"task","text":"Fix the build"}', '${USER}');`);
  return db;
}

const tableNames = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);

describe('saving the memories before they are removed', () => {
  it("writes every memory's entries, with its title and where it was, to a dated file in the data folder", () => {
    const dir = tempDataDir();
    const db = boardWithMemories(join(dir, 'agent-board.db'));
    onTestFinished(() => db.close());

    const path = saveRemovedMemories(db, dir, NOW);

    expect(path).toBe(join(dir, 'removed-memories-2026-11-27.md'));
    const text = readFileSync(path!, 'utf8');
    expect(text).toContain('## Release notes');
    expect(text).toContain('In the zone Web app. Made by Builder.');
    expect(text).toContain('- **base** (pinned): main');
    expect(text).toContain('- Keep pull requests small.');
    // A document keeps its text whole, in a fence longer than any it holds.
    expect(text).toContain('### Runbook\n\n````\n# Steps\n\n```\npnpm build\n```\n````');
    expect(text).toContain('## Mine');
    expect(text).toContain('On the board, outside any zone, set to No agents. Made by you.');
    expect(text).toContain('No entries.');
    expect(text.indexOf('## Release notes')).toBeLessThan(text.indexOf('## Mine'));
  });

  it('writes nothing for a board with no memories, or one already past their removal', () => {
    const dir = tempDataDir();
    const before = new DatabaseSync(':memory:');
    migrate(before, MIGRATIONS.slice(0, REMOVED));
    expect(saveRemovedMemories(before, dir, NOW)).toBeUndefined();
    const after = new DatabaseSync(':memory:');
    migrate(after);
    expect(saveRemovedMemories(after, dir, NOW)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says a ticket's memory was on its board, and keeps the entries of one whose settings can't be read", () => {
    const dir = tempDataDir();
    const db = boardWithMemories(join(dir, 'agent-board.db'));
    onTestFinished(() => db.close());
    db.exec(`INSERT INTO board_items (id, kind, zone_id, ticket, x, y, width, height, z, data) VALUES
        ('ticket-memory', 'memory', NULL, 'chat-1', 0, 0, 340, 244, 4, '{"title":"Ticket notes","madeBy":${USER},"noAgents":false}'),
        ('broken', 'memory', NULL, NULL, 0, 0, 340, 244, 5, 'null');
      INSERT INTO memory_entries (id, item_id, key, is_file, text, pinned, made_by, changed_by) VALUES
        ('e4', 'broken', NULL, 0, 'Still saved.', 0, '${USER}', '${USER}');`);
    const text = readFileSync(saveRemovedMemories(db, dir, NOW)!, 'utf8');
    expect(text).toContain("## Ticket notes\n\nOn a ticket's board. Made by you.");
    expect(text).toContain("## Memory\n\nOn the board, outside any zone. Its settings couldn't be read; as stored: \"null\".\n\n- Still saved.");
  });

  it('uses the file a failed start already wrote, rather than writing another copy', () => {
    const dir = tempDataDir();
    const db = boardWithMemories(join(dir, 'agent-board.db'));
    onTestFinished(() => db.close());
    const first = saveRemovedMemories(db, dir, NOW);
    expect(saveRemovedMemories(db, dir, NOW)).toBe(first);
    expect(readdirSync(dir).filter((name) => name.startsWith('removed-memories-'))).toHaveLength(1);
  });

  it('never overwrites a file of the same name', () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, 'removed-memories-2026-11-27.md'), 'kept');
    const db = boardWithMemories(join(dir, 'agent-board.db'));
    onTestFinished(() => db.close());
    expect(saveRemovedMemories(db, dir, NOW)).toBe(join(dir, 'removed-memories-2026-11-27-2.md'));
    expect(readFileSync(join(dir, 'removed-memories-2026-11-27.md'), 'utf8')).toBe('kept');
  });
});

describe('the migration that removes memories', () => {
  it("takes a memory's connectors with it, and keeps the queue at their other end", () => {
    const db = boardWithMemories(join(tempDataDir(), 'agent-board.db'));
    onTestFinished(() => db.close());
    db.exec(`INSERT INTO connectors (id, from_type, from_id, from_side, to_type, to_id, to_side, style, start_end, end_end)
      VALUES ('c1', 'item', 'zone-memory', 'right', 'item', 'jobs', 'left', 'straight', 'none', 'arrow')`);
    migrate(db);
    expect(db.prepare('SELECT id FROM connectors').all()).toEqual([]);
    expect(db.prepare("SELECT id FROM board_items WHERE id = 'jobs'").get()).toEqual({ id: 'jobs' });
  });

  it('drops the memory cards, their history and both tables, and leaves queues and their history', () => {
    const db = boardWithMemories(join(tempDataDir(), 'agent-board.db'));
    onTestFinished(() => db.close());
    migrate(db);
    expect((db.prepare('SELECT id FROM board_items ORDER BY id').all() as { id: string }[]).map((row) => row.id)).toEqual(['jobs']);
    expect(db.prepare('SELECT item_id, row_id FROM board_history').all()).toEqual([{ item_id: 'jobs', row_id: 'j1' }]);
    expect(tableNames(db)).not.toContain('memory_entries');
    expect(tableNames(db)).not.toContain('memory_reads');
    expect(tableNames(db)).toContain('queue_jobs');
  });

  it("still turns a removed zone's queue to No agents", () => {
    const db = boardWithMemories(join(tempDataDir(), 'agent-board.db'));
    onTestFinished(() => db.close());
    migrate(db);
    db.exec("DELETE FROM zones WHERE id = 'web'");
    expect(db.prepare("SELECT zone_id, json_extract(data, '$.noAgents') AS noAgents FROM board_items WHERE id = 'jobs'").get()).toEqual({ zone_id: null, noAgents: 1 });
  });
});

describe('a daemon starting on a board with memories', () => {
  it('saves them to the data folder before it migrates, and says so once, as a line on a to-do list of the user\'s own', async () => {
    const dataDir = tempDataDir();
    boardWithMemories(join(dataDir, 'agent-board.db')).close();
    const first = await startTestDaemon({ dataDir });
    const files = readdirSync(dataDir).filter((name) => name.startsWith('removed-memories-'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dataDir, files[0]!), 'utf8')).toContain('- **base** (pinned): main');
    const client = await connectTestClient(first);
    const todos = (await client.call('item.list')).filter((item) => item.kind === 'todo');
    expect(todos).toHaveLength(1);
    const data = todos[0]!.data as unknown as TodoData;
    expect(data.owner).toEqual({ kind: 'user' });
    expect(data.lines.map((line) => line.text)).toEqual([expect.stringContaining(join(dataDir, files[0]!))]);
    expect((await client.call('item.list')).some((item) => (item.kind as string) === 'memory')).toBe(false);
    client.close();
    await first.stop();

    const again = await startTestDaemon({ dataDir });
    const next = await connectTestClient(again);
    expect((await next.call('item.list')).filter((item) => item.kind === 'todo')).toHaveLength(1);
    expect(readdirSync(dataDir).filter((name) => name.startsWith('removed-memories-'))).toHaveLength(1);
  });

  it('saves them from a board made before tickets had boards of their own, and drops them', async () => {
    const dataDir = tempDataDir();
    const db = new DatabaseSync(join(dataDir, 'agent-board.db'));
    migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((migration) => migration.name === 'memory_and_queue') + 1));
    db.exec(`INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES
        ('old', 'memory', NULL, 0, 0, 340, 244, 1, '{"title":"From long ago","madeBy":${USER},"noAgents":false,"count":1}');
      INSERT INTO memory_entries (id, item_id, key, is_file, text, pinned, made_by, changed_by) VALUES
        ('e1', 'old', 'kept', 0, 'yes', 0, '${USER}', '${USER}');`);
    db.close();
    const daemon = await startTestDaemon({ dataDir });
    const files = readdirSync(dataDir).filter((name) => name.startsWith('removed-memories-'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dataDir, files[0]!), 'utf8')).toContain('## From long ago');
    const client = await connectTestClient(daemon);
    expect((await client.call('item.list')).map((item) => item.kind)).toEqual(['todo']);
  });

  it('writes no file and adds no to-do on a board that had none', async () => {
    const dataDir = tempDataDir();
    const db = new DatabaseSync(join(dataDir, 'agent-board.db'));
    migrate(db, MIGRATIONS.slice(0, REMOVED));
    db.close();
    const daemon = await startTestDaemon({ dataDir });
    const client = await connectTestClient(daemon);
    expect((await client.call('item.list')).filter((item) => item.kind === 'todo')).toEqual([]);
    expect(existsSync(join(dataDir, 'removed-memories-' + new Date().toISOString().slice(0, 10) + '.md'))).toBe(false);
  });
});
