import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS, migrate } from '../src/migrate.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

const OFF_BOARD = MIGRATIONS.findIndex((migration) => migration.name === 'doc_cards_off_board');

/** A board's database as it was before docs were kept off the board: a document card, a plan card on a ticket's board, a sticky, and a connector from the document card to the sticky. */
function boardBefore(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  migrate(db, MIGRATIONS.slice(0, OFF_BOARD));
  const insert = db.prepare('INSERT INTO board_items (id, kind, zone_id, ticket, x, y, width, height, z, rotation, data) VALUES (?, ?, NULL, ?, 0, 0, 200, 120, 1, 0, ?)');
  insert.run('doc', 'document', null, '{}');
  insert.run('plan', 'plan', 'chat', '{}');
  insert.run('note', 'sticky', null, '{"text":"mine","color":"#fff3a3"}');
  db.prepare(
    "INSERT INTO connectors (id, from_type, from_id, from_side, to_type, to_id, to_side, style, start_end, end_end) VALUES ('line', 'item', 'doc', 'right', 'item', 'note', 'left', 'straight', 'none', 'arrow')",
  ).run();
  return db;
}

const ids = (db: DatabaseSync, table: string) => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((row) => row.id);

describe('taking document and plan cards off the board', () => {
  it('deletes every document and plan card, on ticket boards too, with the connectors drawn to them, and nothing else', () => {
    const db = boardBefore(join(tempDataDir(), 'agent-board.db'));
    onTestFinished(() => db.close());
    expect(ids(db, 'board_items')).toEqual(['doc', 'note', 'plan']);
    migrate(db);
    expect(ids(db, 'board_items')).toEqual(['note']);
    expect(ids(db, 'connectors')).toEqual([]);
  });

  it('runs once, as the daemon starts: a card the user brings back with the setting stays through the next start', async () => {
    const dataDir = tempDataDir();
    boardBefore(join(dataDir, 'agent-board.db')).close();
    const first = await startTestDaemon({ dataDir });
    const client = await connectTestClient(first);
    expect((await client.call('item.list')).map((item) => item.kind)).toEqual(['sticky']);
    await client.call('settings.set', { placeDocTiles: true });
    const card = await client.call('item.create', { kind: 'document', zoneId: null, x: 300, y: 0, width: 260, height: 180, data: { documentId: 'd1', agent: { sessionId: 'gone', name: 'Writer', harness: 'claude', role: null }, title: 'Release plan', format: 'markdown', collapsed: false } });
    client.close();
    await first.stop();
    const again = await startTestDaemon({ dataDir });
    const next = await connectTestClient(again);
    expect((await next.call('item.list')).map((item) => item.id)).toContain(card.id);
  });
});
