import { describe, expect, it } from 'vitest';
import { RPC_ERROR } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

describe('view state', () => {
  it('keeps a JSON value per key across a daemon restart, and forgets one set to null', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    expect(await before.call('view.get', { key: 'viewport' })).toBeNull();

    await before.call('view.set', { key: 'viewport', value: { x: -120.5, y: 40, zoom: 0.75 } });
    await before.call('view.set', { key: 'windows', value: [{ id: 'a', placement: 'docked' }] });
    await before.call('view.set', { key: 'windows', value: null });
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir }));
    expect(await after.call('view.get', { key: 'viewport' })).toEqual({ x: -120.5, y: 40, zoom: 0.75 });
    expect(await after.call('view.get', { key: 'windows' })).toBeNull();
  });

  it('refuses a bad key, a missing value, and a value over 64 KiB', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const refused = { code: RPC_ERROR.invalidParams };

    await expect(client.call('view.set', { key: '', value: 1 })).rejects.toMatchObject(refused);
    await expect(client.call('view.set', { key: 'x'.repeat(65), value: 1 })).rejects.toMatchObject(refused);
    await expect(client.call('view.set', { key: 'viewport' } as never)).rejects.toMatchObject(refused);
    await expect(client.call('view.set', { key: 'big', value: 'x'.repeat(64 * 1024) })).rejects.toMatchObject({
      ...refused,
      message: expect.stringContaining('64 KiB'),
    });
    await expect(client.call('view.get', {} as never)).rejects.toMatchObject(refused);
  });
});
