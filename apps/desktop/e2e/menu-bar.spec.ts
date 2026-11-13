import { rmSync } from 'node:fs';
import { expect, type ElectronApplication } from '@playwright/test';
import { launch, SHELL_ENV, spawnAgent, tile, zoneNamed, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, runDesign, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The menu bar: its items press the board's keys and show what is selected. Electron menus are clicked
// through `app.applicationMenu`, as the menu bar itself is the OS's; the menu is rebuilt as the window reports, so each
// look reads it again.

/** The item at `path` in the menu bar, as data: its label, sublabel, whether it is enabled, and its rows' labels. */
const menuItem = (app: ElectronApplication, path: readonly string[]) =>
  app.evaluate(({ Menu }, path) => {
    let items = Menu.getApplicationMenu()!.items;
    let item: Electron.MenuItem | undefined;
    for (const label of path) {
      item = items.find((each) => each.label === label);
      items = item?.submenu?.items ?? [];
    }
    return item && { label: item.label, sublabel: item.sublabel, enabled: item.enabled, rows: items.map((each) => each.label) };
  }, path);

/** Picks the item at `path`, as the menu bar does. */
const pick = (app: ElectronApplication, path: readonly string[]) =>
  app.evaluate(({ Menu }, path) => {
    let items = Menu.getApplicationMenu()!.items;
    let item: Electron.MenuItem | undefined;
    for (const label of path) {
      item = items.find((each) => each.label === label);
      items = item?.submenu?.items ?? [];
    }
    item!.click();
  }, path);

test('File › New Sticky Note puts a note on the board as N does, and the Project menu is the selected zone’s menu', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    // Its board key is the grey line under it, never an accelerator.
    await expect.poll(() => menuItem(app, ['File', 'New Sticky Note'])).toMatchObject({ sublabel: 'Board key: N', enabled: true });
    await pick(app, ['File', 'New Sticky Note']);
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).map((item) => item.kind)).toEqual(['sticky']);

    // Nothing selected: the Project menu says so.
    expect((await menuItem(app, ['Project']))?.rows[0]).toBe('Select a project on the board');
    const zone = await window.evaluate(() => globalThis.window.agentBoard.zones.addUnbound({ name: 'web', x: 200, y: 200, width: 600, height: 400 }));
    await zoneNamed(window, 'web').getByTestId('zone-tab').getByText('web', { exact: true }).click();
    await expect.poll(async () => (await menuItem(app, ['Project']))?.rows).toContain('Colour');

    // A row picked in the menu bar runs as it does in the zone's ⋯ menu.
    await pick(app, ['Project', 'Colour', 'Amber']);
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.zones.list())).find((each) => each.id === zone.id)?.color).toBe('#f59f00');

    // Project › Arrange the Board, with its ⇧L behind Extended shortcuts: a zone on top of another is moved off it.
    await window.evaluate(() => globalThis.window.agentBoard.zones.addUnbound({ name: 'api', x: 300, y: 300, width: 600, height: 400 }));
    await expect(zoneNamed(window, 'api')).toBeVisible();
    await expect.poll(() => menuItem(app, ['Project', 'Arrange the Board'])).toMatchObject({ enabled: true });
    await pick(app, ['Project', 'Arrange the Board']);
    await expect
      .poll(async () => {
        const [a, b] = await zones(window);
        return a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y;
      })
      .toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Agent › Settings › Rename opens the selected agent’s name for editing, as its ⋯ menu does', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Rename me');
    await expect(tile(window)).toHaveCount(1);
    expect((await menuItem(app, ['Agent']))?.rows[0]).toBe('Select an agent on the board');

    await tile(window).locator('.hybrid-tile-name').click();
    // Classic's tile menu has Rename under Agent ▸, which the menu bar names This agent.
    const settings = runDesign() === 'simplified' ? ['Agent', 'Settings'] : ['Agent', 'This agent'];
    await expect.poll(async () => (await menuItem(app, settings))?.rows).toContain('Rename');
    await pick(app, [...settings, 'Rename']);
    await expect(window.getByTestId('rename-field')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
