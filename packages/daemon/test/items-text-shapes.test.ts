import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { daemonPaths } from '../src/paths.ts';
import { RPC_ERROR, type CreateItemParams, type ShapeData, type TextData } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

const textData: TextData = {
  text: 'Sprint 12',
  size: 'h1',
  fontSize: 32,
  minHeight: 0,
  bold: true,
  italic: false,
  align: 'left',
  color: '#2b2a27',
  wrap: false,
};
const shapeData: ShapeData = {
  shape: 'ellipse',
  fill: '#d3f9d8',
  stroke: '#2f9e44',
  strokeWidth: 2.5,
  dashed: false,
  text: 'CI green?',
  textSize: 'body',
  bold: true,
  textColor: '#2b2a27',
};
const text = (data: Record<string, unknown> = { ...textData }): CreateItemParams => ({
  kind: 'text',
  zoneId: null,
  x: 1,
  y: 2,
  width: 300,
  height: 40,
  data,
});
const shape = (data: Record<string, unknown> = { ...shapeData }): CreateItemParams => ({
  kind: 'shape',
  zoneId: null,
  x: 10,
  y: 20,
  width: 240,
  height: 140,
  data,
});

describe('text and shape board items', () => {
  it("round-trips each kind's data, through updates and a restart", async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const client = await connectTestClient(first);

    const heading = await client.call('item.create', text());
    const box = await client.call('item.create', shape());
    const restyled = await client.call('item.update', {
      id: heading.id,
      data: { size: 'h2', italic: true, align: 'center' },
    });
    const noFill = await client.call('item.update', {
      id: box.id,
      data: { fill: null, shape: 'diamond', dashed: true },
    });
    client.close();
    await first.stop();

    expect(heading.data).toEqual(textData);
    expect(box.data).toEqual(shapeData);
    expect(restyled.data).toEqual({ ...textData, size: 'h2', italic: true, align: 'center' });
    expect(noFill.data).toEqual({ ...shapeData, fill: null, shape: 'diamond', dashed: true });
    const after = await connectTestClient(await startTestDaemon({ dataDir }));
    expect(await after.call('item.list')).toEqual([restyled, noFill]);
  });

  it('rejects text data of the wrong shape', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const invalid = { code: RPC_ERROR.invalidParams };
    const item = await client.call('item.create', text());

    await expect(client.call('item.create', text({ ...textData, size: 'h6' }))).rejects.toThrow('size must be one of');
    await expect(client.call('item.create', text({ ...textData, fontSize: 2 }))).rejects.toThrow('fontSize');
    await expect(client.call('item.create', text({ ...textData, fontSize: '16' }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', text({ ...textData, minHeight: -1 }))).rejects.toThrow('minHeight');
    await expect(client.call('item.create', text({ ...textData, align: 'justify' }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', text({ ...textData, color: 'red' }))).rejects.toThrow(
      'color must be #rrggbb',
    );
    await expect(client.call('item.create', text({ ...textData, bold: 'yes' }))).rejects.toThrow(
      'bold must be true or false',
    );
    await expect(client.call('item.create', text({ text: 'only text' }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.update', { id: item.id, data: { text: 'x'.repeat(20_001) } })).rejects.toThrow(
      /text is over/,
    );
    expect(await client.call('item.list')).toEqual([item]);
  });

  it('rejects shape data of the wrong shape, and takes a fill of none', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const invalid = { code: RPC_ERROR.invalidParams };
    const item = await client.call('item.create', shape());

    await expect(client.call('item.create', shape({ ...shapeData, shape: 'star' }))).rejects.toThrow(
      'shape must be one of',
    );
    await expect(client.call('item.create', shape({ ...shapeData, fill: 'green' }))).rejects.toThrow(
      'fill must be #rrggbb or null',
    );
    await expect(client.call('item.create', shape({ ...shapeData, stroke: null }))).rejects.toMatchObject(invalid);
    await expect(client.call('item.create', shape({ ...shapeData, strokeWidth: -1 }))).rejects.toThrow('strokeWidth');
    await expect(client.call('item.update', { id: item.id, data: { strokeWidth: '2' } })).rejects.toMatchObject(
      invalid,
    );
    expect((await client.call('item.update', { id: item.id, data: { fill: null } })).data).toMatchObject({
      fill: null,
    });
  });

  it('takes the diagram shapes, today\'s four under their old names', async () => {
    const client = await connectTestClient(await startTestDaemon());
    for (const type of ['rectangle', 'rounded', 'ellipse', 'diamond', 'database', 'cloud', 'actor', 'fork-join', 'circle-connector']) {
      expect((await client.call('item.create', shape({ ...shapeData, shape: type }))).data.shape).toBe(type);
    }
  });

  it('keeps a shape of a kind it doesn\'t know through edits that leave the kind be, so a newer app finds it as it was', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const box = await (await connectTestClient(first)).call('item.create', shape());
    await first.stop();
    // As a newer app may have left it.
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.prepare('UPDATE board_items SET data = ? WHERE id = ?').run(JSON.stringify({ ...shapeData, shape: 'hologram' }), box.id);
    db.close();

    const client = await connectTestClient(await startTestDaemon({ dataDir }));
    expect((await client.call('item.list'))[0]?.data.shape).toBe('hologram');
    const edited = await client.call('item.update', { id: box.id, data: { text: 'Still here' } });
    expect(edited.data).toMatchObject({ shape: 'hologram', text: 'Still here' });
    // Still checked as a shape: a bad patch is refused.
    await expect(client.call('item.update', { id: box.id, data: { strokeWidth: -1 } })).rejects.toThrow('strokeWidth');
    // Undo and redo send the whole item back, its kind with it: the stored kind round-trips, another unknown one doesn't.
    const undone = await client.call('item.update', { id: box.id, data: { ...edited.data, text: 'CI green?' } });
    expect(undone.data).toMatchObject({ shape: 'hologram', text: 'CI green?' });
    const redone = await client.call('item.update', { id: box.id, data: { ...undone.data, text: 'Still here' } });
    expect(redone.data).toMatchObject({ shape: 'hologram', text: 'Still here' });
    await expect(client.call('item.update', { id: box.id, data: { shape: 'teleporter' } })).rejects.toThrow('shape must be one of');
    expect((await client.call('item.update', { id: box.id, data: { shape: 'cloud' } })).data.shape).toBe('cloud');
    await expect(client.call('item.update', { id: box.id, data: { shape: 'hologram' } })).rejects.toThrow('shape must be one of');
  });
});
