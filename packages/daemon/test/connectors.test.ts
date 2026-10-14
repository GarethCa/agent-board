import { describe, expect, it } from 'vitest';
import {
  RPC_ERROR,
  type ConnectorRemovedEvent,
  type ConnectorUpdatedEvent,
  type CreateConnectorParams,
  type CreateItemParams,
} from '../src/protocol.ts';
import { DatabaseSync } from 'node:sqlite';
import { daemonPaths } from '../src/paths.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const sticky = (overrides: Partial<CreateItemParams> = {}): CreateItemParams => ({
  kind: 'sticky',
  zoneId: null,
  x: 10,
  y: 20,
  width: 200,
  height: 180,
  data: { text: 'hello', color: '#ffd43b' },
  ...overrides,
});

const between = (from: string, to: string, overrides: Partial<CreateConnectorParams> = {}): CreateConnectorParams => ({
  from: { type: 'item', id: from, side: 'right' },
  to: { type: 'item', id: to, side: 'left' },
  ...overrides,
});

async function twoStickies() {
  const daemon = await startTestDaemon();
  const client = await connectTestClient(daemon);
  const a = await client.call('item.create', sticky());
  const b = await client.call('item.create', sticky({ x: 400 }));
  return { daemon, client, a, b };
}

describe('connectors over the socket', () => {
  it('creates a connector with the default look, and lists it', async () => {
    const { client, a, b } = await twoStickies();

    const connector = await client.call('connector.create', between(a.id, b.id));

    expect(connector).toMatchObject({
      id: expect.any(String),
      from: { type: 'item', id: a.id, side: 'right' },
      to: { type: 'item', id: b.id, side: 'left' },
      style: 'curved',
      startEnd: 'none',
      endEnd: 'arrow',
      color: null,
      label: '',
    });
    expect(connector.createdAt).toBe(connector.updatedAt);
    expect(await client.call('connector.list')).toEqual([connector]);
  });

  it('changes only the fields given, and tells every client', async () => {
    const { daemon, client, a, b } = await twoStickies();
    const other = recordEvents(await connectTestClient(daemon));
    const connector = await client.call('connector.create', between(a.id, b.id));

    const updated = await client.call('connector.update', {
      id: connector.id,
      label: 'depends on',
      style: 'elbow',
      endEnd: 'dot',
      color: '#3b5bdb',
    });

    expect(updated).toMatchObject({ label: 'depends on', style: 'elbow', startEnd: 'none', endEnd: 'dot', color: '#3b5bdb' });
    expect(updated.from).toEqual(connector.from);
    expect(await client.call('connector.update', { id: connector.id, color: null })).toMatchObject({ color: null });
    await other.waitFor(
      (event): event is ConnectorUpdatedEvent => event.type === 'connector.updated' && event.connector.label === 'depends on',
    );
  });

  it('deletes a connector and tells every client', async () => {
    const { daemon, client, a, b } = await twoStickies();
    const other = recordEvents(await connectTestClient(daemon));
    const connector = await client.call('connector.create', between(a.id, b.id));

    await client.call('connector.delete', { id: connector.id });

    expect(await client.call('connector.list')).toEqual([]);
    await other.waitFor(
      (event): event is ConnectorRemovedEvent => event.type === 'connector.removed' && event.id === connector.id,
    );
  });

  it('rejects unknown ends and values, a connector to itself, and a bad id', async () => {
    const { client, a, b } = await twoStickies();
    const invalid = { code: RPC_ERROR.invalidParams };

    await expect(client.call('connector.create', between(a.id, 'missing'))).rejects.toThrow('no item missing');
    await expect(client.call('connector.create', between(a.id, a.id))).rejects.toThrow('to itself');
    await expect(client.call('connector.create', between(a.id, b.id, { style: 'zigzag' as never }))).rejects.toMatchObject(invalid);
    await expect(client.call('connector.create', between(a.id, b.id, { endEnd: 'star' as never }))).rejects.toMatchObject(invalid);
    await expect(client.call('connector.create', between(a.id, b.id, { color: 'red' }))).rejects.toMatchObject(invalid);
    await expect(client.call('connector.create', between(a.id, b.id, { label: 'x'.repeat(501) }))).rejects.toMatchObject(invalid);
    await expect(client.call('connector.create', between(a.id, b.id, { id: 'no spaces' }))).rejects.toMatchObject(invalid);
    await expect(
      client.call('connector.create', { ...between(a.id, b.id), from: { type: 'blob', id: a.id, side: 'top' } } as never),
    ).rejects.toMatchObject(invalid);
    await expect(
      client.call('connector.create', { ...between(a.id, b.id), from: { type: 'item', id: a.id, side: 'middle' } } as never),
    ).rejects.toMatchObject(invalid);
    await expect(client.call('connector.update', { id: 'missing', label: 'x' })).rejects.toThrow('no connector missing');
    await expect(client.call('connector.delete', { id: 'missing' })).rejects.toMatchObject(invalid);
    expect(await client.call('connector.list')).toEqual([]);
  });

  describe('cascade', () => {
    it('deletes a connector when an item at either end is deleted, and keeps the others', async () => {
      const { client, a, b } = await twoStickies();
      const c = await client.call('item.create', sticky({ x: 800 }));
      await client.call('connector.create', between(a.id, b.id));
      await client.call('connector.create', between(c.id, a.id));
      const kept = await client.call('connector.create', between(b.id, c.id));

      await client.call('item.delete', { id: a.id });

      expect(await client.call('connector.list')).toEqual([kept]);
      await client.call('item.delete', { id: c.id });
      expect(await client.call('connector.list')).toEqual([]);
    });

    it('deletes a connector when its zone or shell tile is deleted', async () => {
      const { client, a } = await twoStickies();
      const zone = await client.call('zone.add', { path: tempRepo(), x: 500, y: 500 });
      const shell = await client.call('shell.create', { zoneId: zone.id });
      await client.call('connector.create', {
        from: { type: 'item', id: a.id, side: 'bottom' },
        to: { type: 'shell', id: shell.id, side: 'top' },
      });
      await client.call('connector.create', {
        from: { type: 'zone', id: zone.id, side: 'left' },
        to: { type: 'item', id: a.id, side: 'right' },
      });

      await client.call('shell.delete', { shellId: shell.id });
      expect(await client.call('connector.list')).toEqual([expect.objectContaining({ from: expect.objectContaining({ type: 'zone' }) })]);

      await client.call('zone.remove', { id: zone.id });
      expect(await client.call('connector.list')).toEqual([]);
    });
  });

  it('deletes a connector when an external session at its end is deleted', async () => {
    const dataDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ dataDir }));
    const note = await client.call('item.create', sticky());
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.exec("INSERT INTO external_sessions (id, harness, session_id, cwd, state) VALUES ('claude:s1', 'claude', 's1', '/w', 'idle')");
    await client.call('connector.create', {
      from: { type: 'external', id: 'claude:s1', side: 'left' },
      to: { type: 'item', id: note.id, side: 'right' },
    });

    db.exec("DELETE FROM external_sessions WHERE id = 'claude:s1'");
    db.close();

    expect(await client.call('connector.list')).toEqual([]);
  });

  it('keeps connectors across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const client = await connectTestClient(first);
    const a = await client.call('item.create', sticky());
    const b = await client.call('item.create', sticky({ x: 400 }));
    const connector = await client.call('connector.create', between(a.id, b.id, { label: 'kept' }));
    client.close();
    await first.stop();

    const again = await connectTestClient(await startTestDaemon({ dataDir }));

    expect(await again.call('connector.list')).toEqual([connector]);
  });
});
