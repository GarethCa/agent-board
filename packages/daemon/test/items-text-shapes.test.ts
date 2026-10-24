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
  colorSlot: 'ink',
  wrap: false,
};
const shapeData: ShapeData = {
  shape: 'ellipse',
  fill: '#d3f9d8',
  fillSlot: 'green',
  stroke: '#2f9e44',
  strokeSlot: 'green',
  strokeWidth: 2.5,
  dashed: false,
  text: 'CI green?',
  textSize: 'body',
  fontSize: 14,
  bold: true,
  align: 'left',
  mono: true,
  attributes: '',
  methods: '',
  textColor: '#2b2a27',
  textColorSlot: 'ink',
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
    await expect(client.call('item.create', shape({ ...shapeData, align: 'justify' }))).rejects.toThrow('align must be one of');
    await expect(client.call('item.create', shape({ ...shapeData, mono: 'yes' }))).rejects.toThrow('mono must be true or false');
    await expect(client.call('item.create', shape({ ...shapeData, fontSize: 4 }))).rejects.toThrow('fontSize');
    await expect(client.call('item.create', shape({ ...shapeData, attributes: ['id'] }))).rejects.toThrow('attributes must be a string');
    // The text and its sections share one text's length, so a class is never too big to save.
    const half = '漢'.repeat(12_000);
    await expect(client.call('item.create', shape({ ...shapeData, shape: 'class', attributes: half, methods: half }))).rejects.toThrow(
      'text and sections are over 20000 characters together',
    );
    // A shape saved before these existed has none of them, and a null font size is the size S, M or L stands for.
    const old: Record<string, unknown> = { ...shapeData };
    for (const key of ['align', 'mono', 'fontSize', 'attributes', 'methods']) delete old[key];
    await client.call('item.create', shape(old));
    expect((await client.call('item.create', shape({ ...shapeData, fontSize: null }))).data.fontSize).toBeNull();
    await expect(client.call('item.update', { id: item.id, data: { strokeWidth: '2' } })).rejects.toMatchObject(
      invalid,
    );
    expect((await client.call('item.update', { id: item.id, data: { fill: null } })).data).toMatchObject({
      fill: null,
    });
    // A section's save leaves the others be, so two windows typing in two sections keep both.
    await client.call('item.update', { id: item.id, data: { shape: 'class', attributes: '+ id: string' } });
    expect((await client.call('item.update', { id: item.id, data: { methods: '+ send(text)' } })).data).toMatchObject({
      attributes: '+ id: string',
      methods: '+ send(text)',
    });
  });

  it('takes a theme colour slot, or none for a fixed colour, for each colour, and one saved before slots without them', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const fixed = await client.call('item.create', shape({ ...shapeData, stroke: '#e8590c', strokeSlot: null, fillSlot: 'tile', textColorSlot: 'accent' }));
    expect(fixed.data).toMatchObject({ strokeSlot: null, fillSlot: 'tile', textColorSlot: 'accent' });
    await expect(client.call('item.create', shape({ ...shapeData, fillSlot: 'ink' }))).rejects.toThrow('fillSlot must be one of tile, accent');
    await expect(client.call('item.create', shape({ ...shapeData, strokeSlot: 'tile' }))).rejects.toThrow('strokeSlot must be one of accent, ink');
    await expect(client.call('item.update', { id: fixed.id, data: { textColorSlot: '#2b2a27' } })).rejects.toThrow('textColorSlot must be one of');
    expect((await client.call('item.create', text({ ...textData, colorSlot: null }))).data).toMatchObject({ colorSlot: null });
    await expect(client.call('item.create', text({ ...textData, colorSlot: 'mauve' }))).rejects.toThrow('colorSlot must be one of');
    const old: Record<string, unknown> = { ...shapeData };
    for (const key of ['fillSlot', 'strokeSlot', 'textColorSlot']) delete old[key];
    expect((await client.call('item.create', shape(old))).data).toEqual(old);
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
