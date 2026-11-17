import { expect, type Locator, type Page } from '@playwright/test';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { launch, SHELL_ENV } from './agent-helpers.ts';
import { addEmptyZone, newShellInZone, removeDataDir, stopDaemon, tempDataDir, test } from './launch.ts';

type Point = { x: number; y: number };

/** The one zone's layout and lanes area, as the daemon stores them. */
const storedZone = (page: Page) =>
  page.evaluate(async () => {
    const [zone] = await window.agentBoard.zones.list();
    return { id: zone!.id, x: zone!.x, y: zone!.y, width: zone!.width, height: zone!.height, lanes: zone!.lanes };
  });

/** Each shell's saved place in its zone, by id. */
const shellPlaces = (page: Page) =>
  page.evaluate(async () => (await window.agentBoard.shells.list()).map((shell) => ({ id: shell.id, x: shell.position?.x ?? 0, y: shell.position?.y ?? 0 })));

/** How many screen pixels a board pixel is. */
const scaleOf = async (zone: Locator): Promise<number> => (await settledBox(zone)).width / Number(await zone.getAttribute('data-width'));

/** A press on a point of the zone's well checked first to be the zone itself, nothing in it: it selects the zone. */
async function selectZone(page: Page, zone: Locator): Promise<void> {
  const box = await settledBox(zone);
  const candidates = [0.1, 0.5, 0.9].flatMap((across) => [box.height - 30, box.height / 2].map((down) => ({ x: box.x + box.width * across, y: box.y + down })));
  const at = await page.evaluate((points) =>
    points.find(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest('.react-flow__node-zone') !== null && hit?.closest('.react-flow__node-tile, .shelf-card, .shelf-row, .shelf-chip, .cluster, .zone-lanes-handle, button') === null;
    }),
  candidates);
  expect(at, 'a point of bare zone').toBeDefined();
  await page.mouse.click(at!.x, at!.y);
  await expect.poll(() => zone.evaluate((element) => element.closest('.react-flow__node')!.classList.contains('selected'))).toBe(true);
}

/** Scrolls the board until `target`'s middle is about the window's, clear of the islands round its edges. */
async function bringToMiddle(page: Page, target: Locator): Promise<void> {
  const middle = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  for (let tries = 0; tries < 8; tries += 1) {
    const at = centreOf(await settledBox(target));
    const off = { x: at.x - middle.x, y: at.y - middle.y };
    if (Math.hypot(off.x, off.y) < 40) return;
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.wheel(off.x, off.y);
  }
  const at = centreOf(await settledBox(target));
  expect(Math.hypot(at.x - middle.x, at.y - middle.y), 'scrolled to the middle of the window').toBeLessThan(200);
}

/** Arms the toolbar's shell tool: Classic's New shell, or the Simplified design's New terminal under More to start. */
async function armShellTool(page: Page): Promise<void> {
  if ((await page.locator('html').getAttribute('data-design')) === 'simplified') {
    await page.getByRole('button', { name: 'More to start' }).click();
    await page.getByRole('menuitem', { name: 'New terminal' }).click();
  } else await page.getByRole('button', { name: 'New shell', exact: true }).click();
  await expect(page.getByTestId('board-tool')).toBeVisible();
}

/** Where board point `at`, relative to the zone, is on screen. */
const onScreen = async (zone: Locator, at: Point): Promise<Point> => {
  const box = await settledBox(zone);
  const scale = await scaleOf(zone);
  return { x: box.x + at.x * scale, y: box.y + at.y * scale };
};

test('a zone on shelves keeps a lanes area of its own, sized by its corners, and a tile put in the free area outside it stays there, through Arrange and a restart', async () => {
  const dataDir = tempDataDir();
  let { app, window: page } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(page, 'Laned');
    let zone = page.getByTestId('zone');
    await newShellInZone(page);
    await page.getByRole('button', { name: 'Close session window' }).click();
    await expect(page.getByTestId('shell-tile')).toHaveCount(1);
    const placed = await storedZone(page);
    expect(placed.lanes, 'its lanes fill it, to begin with').toBeNull();
    await page.evaluate(async (id) => {
      const [stored] = await window.agentBoard.zones.list();
      await window.agentBoard.zones.update(id, { x: stored!.x, y: stored!.y, width: 1400, height: 900 });
      await window.agentBoard.zones.configure(id, { layoutMode: 'shelves' });
    }, placed.id);
    await expect(zone.getByTestId('shelves')).toHaveCount(1);
    await page.getByRole('button', { name: 'Fit View' }).click();
    // Clear of the islands at the window's corners.
    await page.getByRole('button', { name: 'Zoom Out' }).click();

    // Selected, its lanes area shows its dashed edge round the whole zone, with a handle at each corner.
    const area = zone.getByTestId('zone-lanes-area');
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await expect(area).toHaveCount(0);
    await selectZone(page, zone);
    await expect(area).toBeVisible();
    await expect(area.getByTestId('zone-lanes-handle')).toHaveCount(4);
    await expect(area).toHaveAttribute('data-width', '1400');

    // Its bottom-right corner drags the lanes area in, the zone as it was; the shelves reflow into it.
    const handle = area.locator('[data-corner="bottom-right"]');
    await bringToMiddle(page, handle);
    const scale = await scaleOf(zone);
    const corner = centreOf(await settledBox(handle));
    const hit = await page.evaluate(({ x, y }) => {
      const chain: string[] = [];
      for (let element = document.elementFromPoint(x, y); element !== null && chain.length < 8; element = element.parentElement)
        chain.push(`${element.tagName}.${element.getAttribute('class') ?? ''}`);
      return chain.join(' < ');
    }, corner);
    expect(hit, 'the corner handle is what is under the pointer').toContain('zone-lanes-handle');
    await drag(page, corner, { x: corner.x - 600 * scale, y: corner.y - 300 * scale });
    await expect.poll(async () => Number(await area.getAttribute('data-width')), 'the lanes area drawn narrower').toBeLessThan(1000);
    await expect.poll(async () => (await storedZone(page)).lanes?.width ?? 1400).toBeLessThan(1000);
    const laned = await storedZone(page);
    expect(laned).toMatchObject({ width: 1400, height: 900, lanes: { x: 0, y: 0 } });
    await expect(area).toHaveAttribute('data-width', String(laned.lanes!.width));
    const lanes = laned.lanes!;

    // Its tiles are still laid out in it: the first shell, and a new one slotted in the zone after the shrink. The board
    // draws only what is on screen, so the lanes area is brought to the middle first, its tiles with it.
    await bringToMiddle(page, area);
    const inLanes = async (tile: Locator) => {
      const box = await tile.boundingBox();
      const edge = await area.boundingBox();
      if (box === null || edge === null) return false;
      return box.x >= edge.x - 2 && box.y >= edge.y - 2 && box.x + box.width <= edge.x + edge.width + 2 && box.y + box.height <= edge.y + edge.height + 2;
    };
    const [first] = await shellPlaces(page);
    await expect.poll(() => inLanes(page.locator(`.react-flow__node[data-id="shell:${first!.id}"]`)), 'the first shell on a shelf').toBe(true);
    await newShellInZone(page);
    await page.getByRole('button', { name: 'Close session window' }).click();
    await expect(page.getByTestId('shell-tile')).toHaveCount(2);
    const second = (await shellPlaces(page)).find((shell) => shell.id !== first!.id)!;
    await selectZone(page, zone);
    await expect.poll(() => inLanes(page.locator(`.react-flow__node[data-id="shell:${second.id}"]`)), 'a new shell on a shelf').toBe(true);
    expect((await storedZone(page)).lanes, 'its lanes area as it was').toEqual(lanes);

    // A shell put down in the free area, right of the lanes, stays where it was put.
    const drop = await onScreen(zone, { x: lanes.x + lanes.width + 200, y: 500 });
    await armShellTool(page);
    await page.mouse.click(drop.x, drop.y);
    await page.getByRole('button', { name: 'Close session window' }).click();
    await expect(page.getByTestId('shell-tile')).toHaveCount(3);
    const free = async () => (await shellPlaces(page)).find((shell) => shell.id !== first!.id && shell.id !== second.id);
    await expect.poll(free, 'a shell saved in the free area').toBeDefined();
    const put = (await free())!;
    expect(put.x, 'put right of the lanes area').toBeGreaterThanOrEqual(lanes.x + lanes.width);
    await expect.poll(async () => (await page.evaluate(async () => (await window.agentBoard.zones.list())[0]!.free)), 'marked free').toEqual([`shell:${put.id}`]);
    const freeTile = page.locator(`.react-flow__node[data-id="shell:${put.id}"]`);
    const putOnScreen = await settledBox(freeTile);
    const zoneBox = await settledBox(zone);

    // Arranging the board leaves it, and the lanes area, as they were.
    await page.getByRole('button', { name: 'Board menu' }).click();
    await page.getByRole('button', { name: 'Arrange the board' }).click();
    await expect.poll(free).toEqual(put);
    expect((await storedZone(page)).lanes).toEqual(lanes);
    const after = await settledBox(zone);
    const tileAfter = await settledBox(freeTile);
    expect(Math.abs(tileAfter.x - after.x - (putOnScreen.x - zoneBox.x))).toBeLessThan(2);
    expect(Math.abs(tileAfter.y - after.y - (putOnScreen.y - zoneBox.y))).toBeLessThan(2);

    // So does a restart: its lanes area saved, drawn when it is selected, and the shell still in the free area.
    await app.close();
    await stopDaemon(dataDir);
    ({ app, window: page } = await launch(dataDir, SHELL_ENV));
    zone = page.getByTestId('zone');
    await expect(zone.getByTestId('shelves')).toHaveCount(1);
    expect((await storedZone(page)).lanes).toEqual(lanes);
    expect((await shellPlaces(page)).find((shell) => shell.id === put.id)).toEqual(put);
    await page.getByRole('button', { name: 'Fit View' }).click();
    // Clear of the islands at the window's corners.
    await page.getByRole('button', { name: 'Zoom Out' }).click();
    await selectZone(page, zone);
    await expect(zone.getByTestId('zone-lanes-area')).toHaveAttribute('data-width', String(lanes.width));
  } finally {
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});
