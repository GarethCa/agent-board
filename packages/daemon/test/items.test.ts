import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RPC_ERROR, type CreateItemParams, type ItemRemovedEvent, type ItemUpdatedEvent } from '../src/protocol.ts';
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

describe('board items over the socket', () => {
  it('creates an item, stacked above the others, and lists it', async () => {
    const client = await connectTestClient(await startTestDaemon());

    const first = await client.call('item.create', sticky());
    const second = await client.call('item.create', sticky({ x: 400 }));

    expect(first).toMatchObject({ ...sticky(), id: expect.any(String) });
    expect(first.createdAt).toBe(first.updatedAt);
    expect(second.z).toBeGreaterThan(first.z);
    expect(await client.call('item.list')).toEqual([first, second]);
  });

  it('updates only the fields in the patch, merging data keys into the data', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const item = await client.call('item.create', sticky());
    // Past the timestamps' millisecond, so a bumped updatedAt is later.
    await sleep(5);

    const moved = await client.call('item.update', { id: item.id, x: -50.5, width: 260 });
    const recoloured = await client.call('item.update', { id: item.id, data: { color: '#74c0fc' } });

    expect(moved).toMatchObject({ x: -50.5, y: 20, width: 260, height: 180, data: item.data });
    expect(recoloured.data).toEqual({ text: 'hello', color: '#74c0fc' });
    expect(Date.parse(moved.updatedAt)).toBeGreaterThan(Date.parse(item.updatedAt));
    expect(recoloured.createdAt).toBe(item.createdAt);
    expect(await client.call('item.list')).toEqual([recoloured]);
  });

  it('keeps an angle on an item, straight by default, normalised to a half-turn either way', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const straight = await client.call('item.create', sticky());
    const tilted = await client.call('item.create', sticky({ rotation: 30 }));

    const turned = await client.call('item.update', { id: straight.id, rotation: 370 });
    const back = await client.call('item.update', { id: tilted.id, rotation: -200 });
    const moved = await client.call('item.update', { id: tilted.id, x: 5 });

    expect(straight.rotation).toBe(0);
    expect(tilted.rotation).toBe(30);
    expect(turned.rotation).toBe(10);
    expect(back.rotation).toBe(160);
    expect(moved.rotation).toBe(160);
    await expect(client.call('item.update', { id: tilted.id, rotation: Number.NaN })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(client.call('item.create', sticky({ rotation: 'x' as never }))).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  it('deletes an item', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const item = await client.call('item.create', sticky());

    await client.call('item.delete', { id: item.id });

    expect(await client.call('item.list')).toEqual([]);
  });

  it('rejects unknown items, kinds and zones, bad sizes and non-object data', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const item = await client.call('item.create', sticky());
    const invalid = { code: RPC_ERROR.invalidParams };

    await expect(client.call('item.update', { id: 'missing', x: 1 })).rejects.toThrow('no board item missing');
    await expect(client.call('item.delete', { id: 'missing' })).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', sticky({ kind: 'blob' as never }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', sticky({ zoneId: 'nowhere' }))).rejects.toThrow('no zone nowhere');
    await expect(client.call('item.create', sticky({ width: 0 }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', sticky({ data: [] as never }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', sticky({ zoneId: 7 as never }))).rejects.toThrow('zoneId must be a string or null');
    await expect(client.call('item.create', sticky({ data: [] as never }))).rejects.toThrow('data must be an object');
    await expect(client.call('item.update', { id: item.id, y: Number.NaN })).rejects.toMatchObject(invalid);
    await expect(client.call('item.update', { id: item.id, zoneId: 'nowhere' })).rejects.toMatchObject(invalid);
    await expect(client.call('item.update', { id: item.id, height: -1 })).rejects.toMatchObject(invalid);
    expect(await client.call('item.list')).toEqual([item]);
  });

  it("checks data against its kind's shape, and caps its size", async () => {
    const client = await connectTestClient(await startTestDaemon());
    const item = await client.call('item.create', sticky());
    const invalid = { code: RPC_ERROR.invalidParams };

    await expect(client.call('item.create', sticky({ data: { text: 42, color: '#ffd43b' } }))).rejects.toThrow(
      'text must be a string',
    );
    await expect(client.call('item.create', sticky({ data: { text: '', color: 'url(x)' } }))).rejects.toThrow(
      'color must be #rrggbb',
    );
    await expect(client.call('item.create', sticky({ data: { color: '#ffd43b' } }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.update', { id: item.id, data: { color: 'red' } })).rejects.toMatchObject(invalid);
    await expect(client.call('item.update', { id: item.id, data: { text: 'x'.repeat(20_001) } })).rejects.toThrow(
      /text is over/,
    );
    await expect(client.call('item.update', { id: item.id, data: { extra: 'y'.repeat(70_000) } })).rejects.toThrow(
      /data is over/,
    );
    expect(await client.call('item.list')).toEqual([item]);
  });

  it('takes the id a client picks for a new item, once', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const id = '3f2c8f1e-0d7b-4c4e-9a7e-5b1f0c2d9e10';

    expect(await client.call('item.create', { ...sticky(), id })).toMatchObject({ id });
    await expect(client.call('item.create', { ...sticky(), id })).rejects.toThrow(`board item ${id} already exists`);
    await expect(client.call('item.create', { ...sticky(), id: 'not an id' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    expect(await client.call('item.list')).toHaveLength(1);
  });

  it('tells every client about each change and deletion', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);
    const other = recordEvents(await connectTestClient(daemon));

    const item = await client.call('item.create', sticky());
    const updated = await client.call('item.update', { id: item.id, data: { text: 'bye' } });
    await client.call('item.delete', { id: item.id });

    await other.waitFor((event): event is ItemRemovedEvent => event.type === 'item.removed');
    const itemEvents = other.events.filter((event) => event.type.startsWith('item.'));
    expect(itemEvents).toEqual<(ItemUpdatedEvent | ItemRemovedEvent)[]>([
      { type: 'item.updated', item },
      { type: 'item.updated', item: updated },
      { type: 'item.removed', id: item.id },
    ]);
  });

  describe('in zones', () => {
    it('keeps an item where it is on the board when it moves into a zone, out of it, or to another', async () => {
      const client = await connectTestClient(await startTestDaemon());
      const repo = tempRepo();
      const left = await client.call('zone.add', { path: repo, x: 100, y: 200 });
      const right = await client.call('zone.add', { path: repo, x: 1000, y: -100 });
      const item = await client.call('item.create', sticky({ x: 150, y: 260 }));

      const inLeft = await client.call('item.update', { id: item.id, zoneId: left.id });
      expect(inLeft).toMatchObject({ zoneId: left.id, x: 50, y: 60 });

      const inRight = await client.call('item.update', { id: item.id, zoneId: right.id });
      expect(inRight).toMatchObject({ zoneId: right.id, x: -850, y: 360 });

      const out = await client.call('item.update', { id: item.id, zoneId: null });
      expect(out).toMatchObject({ zoneId: null, x: 150, y: 260 });
    });

    it('takes x and y given with a new zone as positions in that zone', async () => {
      const client = await connectTestClient(await startTestDaemon());
      const zone = await client.call('zone.add', { path: tempRepo(), x: 100, y: 200 });
      const item = await client.call('item.create', sticky());

      const moved = await client.call('item.update', { id: item.id, zoneId: zone.id, x: 30, y: 40 });

      expect(moved).toMatchObject({ zoneId: zone.id, x: 30, y: 40 });
    });

    it('keeps an item in a zone relative to it, so it moves with the zone', async () => {
      const client = await connectTestClient(await startTestDaemon());
      const zone = await client.call('zone.add', { path: tempRepo(), x: 100, y: 200 });
      const item = await client.call('item.create', sticky({ zoneId: zone.id, x: 30, y: 40 }));

      await client.call('zone.update', { id: zone.id, x: 500, y: 500, width: zone.width, height: zone.height });

      expect(await client.call('item.list')).toEqual([item]);
    });

    it("puts a removed zone's items back on the board where they were", async () => {
      const client = await connectTestClient(await startTestDaemon());
      const zone = await client.call('zone.add', { path: tempRepo(), x: 100, y: 200 });
      const item = await client.call('item.create', sticky({ zoneId: zone.id, x: 30, y: 40 }));

      await client.call('zone.remove', { id: zone.id });

      expect(await client.call('item.list')).toEqual([
        { ...item, zoneId: null, x: 130, y: 240, updatedAt: expect.any(String) as unknown },
      ]);
    });

    it('tells every client about the items a removed zone leaves on the board', async () => {
      const daemon = await startTestDaemon();
      const client = await connectTestClient(daemon);
      const other = recordEvents(await connectTestClient(daemon));
      const zone = await client.call('zone.add', { path: tempRepo(), x: 100, y: 200 });
      const inside = await client.call('item.create', sticky({ zoneId: zone.id, x: 30, y: 40 }));
      await client.call('item.create', sticky());

      await client.call('zone.remove', { id: zone.id });

      const moved = (await client.call('item.list')).find((item) => item.id === inside.id);
      expect(moved).toMatchObject({ zoneId: null, x: 130, y: 240 });
      await other.waitFor(
        (event): event is ItemUpdatedEvent =>
          event.type === 'item.updated' && event.item.id === inside.id && event.item.zoneId === null,
      );
      expect(other.events.filter((event) => event.type === 'item.updated').at(-1)).toEqual({
        type: 'item.updated',
        item: moved,
      });
    });
  });

  it('keeps items across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    const zone = await before.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const loose = await before.call('item.create', sticky());
    const zoned = await before.call('item.create', sticky({ zoneId: zone.id, data: { text: '**bold**', color: '#ff8787' } }));
    before.close();
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir }));

    expect(await after.call('item.list')).toEqual([loose, zoned]);
  });
});

describe('issue cards', () => {
  const card = (data: Record<string, unknown>): CreateItemParams => ({
    kind: 'issue',
    zoneId: null,
    x: 0,
    y: 0,
    width: 240,
    height: 120,
    data,
  });
  const issue = {
    provider: 'linear',
    id: 'ACME-58',
    title: 'Movable sessions between zones',
    url: 'https://linear.app/acme/issue/ACME-58/movable-sessions',
    state: 'In Progress',
  };

  it("keeps a snapshot of the issue: its tracker, ID, title, link and state", async () => {
    const client = await connectTestClient(await startTestDaemon());
    expect((await client.call('item.create', card(issue))).data).toEqual(issue);
  });

  it('refuses a card with no issue ID, an unknown tracker or a link that is not https', async () => {
    const client = await connectTestClient(await startTestDaemon());
    await expect(client.call('item.create', card({ ...issue, id: '' }))).rejects.toThrow(/issue card's id/);
    await expect(client.call('item.create', card({ ...issue, provider: 'jira' }))).rejects.toThrow(/issue card's provider/);
    await expect(client.call('item.create', card({ ...issue, url: 'http://x' }))).rejects.toThrow(/issue card's url/);
    await expect(client.call('item.create', card({ ...issue, title: 3 }))).rejects.toThrow(/issue card's title/);
  });
});

describe('agent notes', () => {
  const note = (data: Record<string, unknown>): CreateItemParams => ({ kind: 'agent-note', zoneId: null, x: 0, y: 0, width: 272, height: 140, data });
  const written = {
    text: '**Round 2**\n\n- fixing `R1`',
    agent: { sessionId: 'abc', name: 'Master Orchestrator', harness: 'claude', role: 'orchestrator' },
    writtenAt: '2026-10-15T14:02:00.000Z',
    editedByUser: false,
  };

  it('keeps its markdown, the agent that wrote it as it was then, when, and whether the user has edited it', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const item = await client.call('item.create', note(written));
    expect(item.data).toEqual(written);
    expect((await client.call('item.update', { id: item.id, data: { text: 'Mine now', editedByUser: true } })).data).toMatchObject({ text: 'Mine now', editedByUser: true });
    // What a later answer adds, such as the question it answers, is kept.
    expect((await client.call('item.create', note({ ...written, asked: "What's risky here?" }))).data).toMatchObject({ asked: "What's risky here?" });
  });

  it('refuses one with no text, no agent, or a bad edited mark', async () => {
    const client = await connectTestClient(await startTestDaemon());
    await expect(client.call('item.create', note({ ...written, text: 3 }))).rejects.toThrow(/agent note's text/);
    await expect(client.call('item.create', note({ ...written, agent: undefined }))).rejects.toThrow(/agent note's agent/);
    await expect(client.call('item.create', note({ ...written, agent: { ...written.agent, name: 7 } }))).rejects.toThrow(/agent note's agent/);
    await expect(client.call('item.create', note({ ...written, writtenAt: 9 }))).rejects.toThrow(/agent note's writtenAt/);
    await expect(client.call('item.create', note({ ...written, editedByUser: 'yes' }))).rejects.toThrow(/agent note's editedByUser/);
  });
});
