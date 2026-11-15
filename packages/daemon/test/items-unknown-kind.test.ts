import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { daemonPaths } from '../src/paths.ts';
import { RPC_ERROR, type BoardItem } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

/** A board item of a kind this daemon doesn't know, as a newer app may have left it. */
async function boardWithUnknownItem(): Promise<{ client: Awaited<ReturnType<typeof connectTestClient>>; item: BoardItem; data: Record<string, unknown> }> {
  const dataDir = tempDataDir();
  const first = await startTestDaemon({ dataDir });
  const made = await (await connectTestClient(first)).call('item.create', { kind: 'sticky', zoneId: null, x: 10, y: 20, width: 200, height: 180, data: { text: 'x', color: '#fff3bf' } });
  await first.stop();
  const data = { owner: 'some.mod', kind: 'gauge', version: 3, payload: { needle: 0.4, nested: [1, 2, { a: null }] } };
  const db = new DatabaseSync(daemonPaths(dataDir).database);
  db.prepare('UPDATE board_items SET kind = ?, data = ? WHERE id = ?').run('mod', JSON.stringify(data), made.id);
  db.close();
  const client = await connectTestClient(await startTestDaemon({ dataDir }));
  const item = (await client.call('item.list')).find((each) => each.id === made.id)!;
  return { client, item, data };
}

describe('a board item of a kind the daemon does not know', () => {
  it('is listed with its kind and data as stored', async () => {
    const { item, data } = await boardWithUnknownItem();
    expect(item.kind).toBe('mod');
    expect(item.data).toEqual(data);
  });

  it('moves and resizes, its data untouched', async () => {
    const { client, item, data } = await boardWithUnknownItem();
    const moved = await client.call('item.update', { id: item.id, x: 300, y: 400, width: 320, height: 120, z: 5 });
    expect(moved).toMatchObject({ kind: 'mod', x: 300, y: 400, width: 320, height: 120, data });
    expect((await client.call('item.list')).find((each) => each.id === item.id)?.data).toEqual(data);
  });

  it("refuses a change to its data, as it can't check it, and keeps the data", async () => {
    const { client, item, data } = await boardWithUnknownItem();
    await expect(client.call('item.update', { id: item.id, data: { payload: 'gone' } })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect((await client.call('item.list')).find((each) => each.id === item.id)?.data).toEqual(data);
  });

  it('can be deleted', async () => {
    const { client, item } = await boardWithUnknownItem();
    await client.call('item.delete', { id: item.id });
    expect((await client.call('item.list')).some((each) => each.id === item.id)).toBe(false);
  });
});
