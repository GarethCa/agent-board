import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, tile, zoneNamed, zones, SHELL_ENV } from './agent-helpers.ts';
import { addEmptyZone, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

test('Delete zone asks, ⌘Z brings the group back as it was with its tiles in it, and ⇧⌘Z deletes it again', async () => {
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(page, 'G1', 'Teal');
    const [made] = await zones(page);
    await page.evaluate((id) => window.agentBoard.zones.setLook(id, { fillOpacity: 12 }), made!.id);
    await zoneNamed(page, 'G1').getByRole('button', { name: 'New shell in zone' }).click();
    await page.getByRole('button', { name: 'Close session window' }).click();
    const shell = page.getByTestId('shell-tile');
    await expect(shell).toHaveCount(1);
    const [before] = await zones(page);
    const sticky = await page.evaluate(
      (zoneId) => window.agentBoard.items.create({ kind: 'sticky', zoneId, x: 300, y: 200, width: 160, height: 120, data: { text: 'note', color: '#fff3a3' } }),
      before!.id,
    );
    const placed = (await page.evaluate(() => window.agentBoard.shells.list()))[0]!;

    const dissolve = async () => {
      await zoneNamed(page, 'G1').getByRole('button', { name: 'Zone options' }).click();
      await page.getByRole('menuitem', { name: 'Delete zone…' }).click();
    };

    // Cancelled, nothing happens.
    await dissolve();
    const confirm = page.getByRole('alertdialog', { name: 'Delete zone G1?' });
    await expect(confirm).toContainText('⌘Z brings it back');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(await zones(page)).toEqual([before]);

    // Confirmed: the group goes, the tile stays loose.
    await dissolve();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(zoneNamed(page, 'G1')).toHaveCount(0);
    expect(await zones(page)).toEqual([]);
    await expect(shell).toHaveCount(1);

    // ⌘Z: the same group, with its id, colour and fill, and the tile back in it where it was.
    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, 'G1')).toHaveCount(1);
    const [after] = await zones(page);
    expect(after).toMatchObject({ id: before!.id, name: 'G1', color: before!.color, fillOpacity: 12, x: before!.x, y: before!.y, width: before!.width, height: before!.height });
    await expect
      .poll(async () => (await page.evaluate(() => window.agentBoard.shells.list()))[0])
      .toMatchObject({ zoneId: before!.id, position: placed.position });

    await expect
      .poll(async () => (await page.evaluate(() => window.agentBoard.items.list())).find((item) => item.id === sticky.id))
      .toMatchObject({ zoneId: before!.id, x: 300, y: 200 });

    // ⇧⌘Z: deleted again.
    await page.keyboard.press('Meta+Shift+Z');
    await expect(zoneNamed(page, 'G1')).toHaveCount(0);
    expect((await page.evaluate(() => window.agentBoard.shells.list()))[0]!.zoneId).toBeNull();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('an empty group asks too, and ⌘Z brings it back', async () => {
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(page, 'G1');
    const [before] = await zones(page);
    await zoneNamed(page, 'G1').getByRole('button', { name: 'Zone options' }).click();
    await page.getByRole('menuitem', { name: 'Delete zone…' }).click();
    await page.getByRole('alertdialog', { name: 'Delete zone G1?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(zoneNamed(page, 'G1')).toHaveCount(0);

    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, 'G1')).toHaveCount(1);
    // Made again, so its createdAt is new; everything the user set is as it was.
    expect(await zones(page)).toEqual([{ ...before, createdAt: expect.any(String) }]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('undoing a delete brings back an agent tile, the default repo and the connectors on the group; a group with only a connector asks too', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    await addEmptyZone(page, 'G1');
    const [made] = await zones(page);
    await page.evaluate(({ id, path }) => window.agentBoard.zones.setDefaultRepo(id, path), { id: made!.id, path: repo });
    // With a default repo, New agent starts one at once.
    await zoneNamed(page, 'G1').getByRole('button', { name: 'New agent' }).click();
    await expect(tile(page)).toHaveCount(1);
    const sticky = await page.evaluate(
      () => window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 900, y: 100, width: 160, height: 120, data: { text: 'note', color: '#fff3a3' } }),
    );
    const connector = await page.evaluate(
      ({ zoneId, itemId }) => window.agentBoard.connectors.create({ from: { type: 'zone', id: zoneId, side: 'right' }, to: { type: 'item', id: itemId, side: 'left' } }),
      { zoneId: made!.id, itemId: sticky.id },
    );
    const [before] = await zones(page);
    const [agent] = await agents(page);
    expect(before!.defaultRepo).not.toBeNull();

    await zoneNamed(page, 'G1').getByRole('button', { name: 'Zone options' }).click();
    await page.getByRole('menuitem', { name: 'Delete zone…' }).click();
    await page.getByRole('alertdialog', { name: 'Delete zone G1?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(zoneNamed(page, 'G1')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.agentBoard.connectors.list())).toEqual([]);

    await page.keyboard.press('Meta+Z');
    await expect(zoneNamed(page, 'G1')).toHaveCount(1);
    const [after] = await zones(page);
    expect(after).toMatchObject({ id: before!.id, defaultRepo: before!.defaultRepo });
    await expect.poll(async () => (await agents(page))[0]?.zoneId).toBe(before!.id);
    expect((await agents(page))[0]!.sessionId).toBe(agent!.sessionId);
    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.connectors.list())).map((known) => known.id)).toEqual([connector.id]);

    // Redone, the connector goes again; and undone once more it is back.
    await page.keyboard.press('Meta+Shift+Z');
    await expect(zoneNamed(page, 'G1')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.agentBoard.connectors.list())).toEqual([]);
    await page.keyboard.press('Meta+Z');
    await expect.poll(async () => (await page.evaluate(() => window.agentBoard.connectors.list())).length).toBe(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a group with nothing but a connector asks before it is deleted', async () => {
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(page, 'G1');
    const sticky = await page.evaluate(
      () => window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 900, y: 100, width: 160, height: 120, data: { text: 'note', color: '#fff3a3' } }),
    );
    const [zone] = await zones(page);
    await page.evaluate(
      ({ zoneId, itemId }) => window.agentBoard.connectors.create({ from: { type: 'zone', id: zoneId, side: 'right' }, to: { type: 'item', id: itemId, side: 'left' } }),
      { zoneId: zone!.id, itemId: sticky.id },
    );
    await zoneNamed(page, 'G1').getByRole('button', { name: 'Zone options' }).click();
    await page.getByRole('menuitem', { name: 'Delete zone…' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Delete zone G1?' })).toContainText('connectors');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
