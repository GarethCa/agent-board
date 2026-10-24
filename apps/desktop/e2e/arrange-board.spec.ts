import { expect, type Page } from '@playwright/test';
import { launch, setClickOpens, SHELL_ENV, zoneNamed, zones } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';

/** The gap the board's arrange keeps between zones (Roomy). */
const GAP = 80;

type Rect = { x: number; y: number; width: number; height: number };

/** Each zone's layout by name, as the daemon stores it. */
const zoneLayouts = async (page: Page): Promise<Record<string, Rect>> =>
  Object.fromEntries((await zones(page)).map((zone) => [zone.name, { x: zone.x, y: zone.y, width: zone.width, height: zone.height }]));

/** Each shell's place by id, as the daemon stores it. */
const shellPlaces = (page: Page) =>
  page.evaluate(async () => Object.fromEntries((await window.agentBoard.shells.list()).map((shell) => [shell.id, shell.position && { x: shell.position.x, y: shell.position.y }])));

/** Where the board's items are, by id. */
const itemPlaces = (page: Page) => page.evaluate(async () => Object.fromEntries((await window.agentBoard.items.list()).map((item) => [item.id, { x: item.x, y: item.y }])));

/** The space between two rects, along the axis they are apart on (negative: they overlap). */
const spaceBetween = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));

test('Arrange the board lays messy zones out a gap apart with the loose shells below, never what is in them, and one undo puts it back', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    // Five zones, some on top of each other, right of the view's left edge so the pane there is empty; two shells
    // loose far off, one shell in a zone, and a sticky loose on the board.
    const seeded = await window.evaluate(async () => {
      const { zones, shells, items } = globalThis.window.agentBoard;
      const made = [];
      for (const [name, x, y, width, height] of [
        ['web', 900, 100, 700, 400],
        ['api', 1300, 300, 600, 500],
        ['docs', 2600, 50, 500, 300],
        ['ops', 950, 1200, 900, 350],
        ['misc', 2200, 1100, 400, 260],
      ] as const) {
        made.push(await zones.addUnbound({ name, x, y, width, height }));
      }
      await shells.create({ zoneId: null, position: { x: 4000, y: 3000 } });
      await shells.create({ zoneId: null, position: { x: -2000, y: 2500 } });
      const inside = await shells.create({ zoneId: made[0]!.id, position: { x: 40, y: 60 } });
      const sticky = await items.create({ kind: 'sticky', zoneId: null, x: 5000, y: -2000, width: 200, height: 200, data: { text: 'mine', color: '#fff3a3' } });
      return { inside: inside.id, sticky: sticky.id };
    });
    // Most are off the view, so not drawn: the board has them once their shells have started.
    await expect.poll(async () => Object.values(await shellPlaces(window)).filter((place) => place !== null).length).toBe(3);
    await expect(window.getByTestId('shell-tile').first()).toBeVisible();
    const before = { zones: await zoneLayouts(window), shells: await shellPlaces(window), items: await itemPlaces(window) };

    await window.locator('.react-flow__pane').click({ button: 'right', position: { x: 60, y: 600 } });
    await window.getByRole('menuitem', { name: 'Arrange the board' }).click();

    // Every zone a gap from every other, at its own size; the loose shells below them all.
    await expect
      .poll(async () => {
        const placed = Object.values(await zoneLayouts(window));
        return placed.every((a, index) => placed.slice(index + 1).every((b) => spaceBetween(a, b) >= GAP));
      })
      .toBe(true);
    const after = await zoneLayouts(window);
    for (const [name, rect] of Object.entries(after)) expect({ width: rect.width, height: rect.height }).toEqual({ width: before.zones[name]!.width, height: before.zones[name]!.height });
    const bottom = Math.max(...Object.values(after).map((rect) => rect.y + rect.height));
    const shells = await shellPlaces(window);
    for (const [id, place] of Object.entries(shells)) {
      if (id === seeded.inside) expect(place).toEqual(before.shells[id]);
      else expect(place!.y).toBeGreaterThan(bottom + GAP);
    }
    expect(await itemPlaces(window)).toEqual(before.items);

    // One undo puts every zone and shell back.
    await window.locator('.react-flow__pane').click({ position: { x: 60, y: 600 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => zoneLayouts(window)).toEqual(before.zones);
    await expect.poll(() => shellPlaces(window)).toEqual(before.shells);

    // ⇧L arranges it the same way again.
    await window.keyboard.press('Shift+L');
    await expect.poll(() => zoneLayouts(window)).toEqual(after);
    await expect.poll(() => shellPlaces(window)).toEqual(shells);

    // And from the board menu, after another undo.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => zoneLayouts(window)).toEqual(before.zones);
    await window.getByRole('button', { name: 'Board menu' }).click();
    await window.getByRole('button', { name: 'Arrange the board' }).click();
    await expect.poll(() => zoneLayouts(window)).toEqual(after);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Arrange the board keeps a zone at its own size while a tile in it is expanded, the room round that tile unsaved', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await window.evaluate(async () => {
      const { zones, shells } = globalThis.window.agentBoard;
      const small = await zones.addUnbound({ name: 'small', x: 300, y: 120, width: 320, height: 240 });
      await zones.addUnbound({ name: 'beside', x: 500, y: 200, width: 300, height: 200 });
      await shells.create({ zoneId: small.id, position: { x: 20, y: 44 } });
    });
    const before = await zoneLayouts(window);
    await window.getByTestId('shell-tile').dblclick();
    await expect(window.getByTestId('expanded-tile')).toHaveCount(1);
    // Drawn round the expanded tile, the zone is bigger than its saved size.
    await expect.poll(async () => (await zoneNamed(window, 'small').boundingBox())!.width).toBeGreaterThan(400);

    await window.locator('.react-flow__pane').click({ button: 'right', position: { x: 60, y: 700 } });
    await window.getByRole('menuitem', { name: 'Arrange the board' }).click();
    await expect.poll(async () => (await zoneLayouts(window)).beside!.x).not.toBe(before.beside!.x);
    for (const [name, rect] of Object.entries(await zoneLayouts(window))) {
      expect({ width: rect.width, height: rect.height }).toEqual({ width: before[name]!.width, height: before[name]!.height });
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Arrange the board keeps the size a zone was given since this window last saved it', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const ids = await window.evaluate(async () => {
      const { zones } = globalThis.window.agentBoard;
      const a = await zones.addUnbound({ name: 'a', x: 300, y: 120, width: 320, height: 240 });
      const b = await zones.addUnbound({ name: 'b', x: 500, y: 200, width: 300, height: 200 });
      return { a: a.id, b: b.id };
    });
    // Arranged here, so this window has saved both zones' layouts.
    await window.locator('.react-flow__pane').click({ position: { x: 60, y: 700 } });
    await window.keyboard.press('Shift+L');
    await expect.poll(async () => (await zoneLayouts(window)).b!.x).toBe(300 + 320 + GAP);
    // Then resized and moved from outside this window, as an orchestrator or another window would.
    await window.evaluate((id) => globalThis.window.agentBoard.zones.update(id, { x: 2000, y: 900, width: 700, height: 500 }), ids.b);
    await expect.poll(async () => (await zoneLayouts(window)).b).toEqual({ x: 2000, y: 900, width: 700, height: 500 });

    await window.keyboard.press('Shift+L');
    await expect.poll(async () => (await zoneLayouts(window)).b!.x).toBe(300 + 320 + GAP);
    expect((await zoneLayouts(window)).b).toMatchObject({ width: 700, height: 500 });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
