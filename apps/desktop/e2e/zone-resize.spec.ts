import { expect, type Locator, type Page } from '@playwright/test';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { launch, SHELL_ENV } from './agent-helpers.ts';
import { addEmptyZone, newShellInZone, removeDataDir, stopDaemon, tempDataDir, test } from './launch.ts';

type Point = { x: number; y: number };

/** The one zone's layout, as the daemon stores it. */
const storedZone = (page: Page) =>
  page.evaluate(async () => {
    const [zone] = await window.agentBoard.zones.list();
    return { id: zone!.id, x: zone!.x, y: zone!.y, width: zone!.width, height: zone!.height };
  });

/** Whether the zone is selected. */
const isSelected = (zone: Locator) => zone.evaluate((element) => element.closest('.react-flow__node')!.classList.contains('selected'));

/** How many screen pixels a board pixel is. */
const scaleOf = async (zone: Locator): Promise<number> => (await settledBox(zone)).width / Number(await zone.getAttribute('data-width'));

/** How many rows its shelves sit in. */
const shelfRows = (zone: Locator) => zone.getByTestId('shelf').evaluateAll((shelves) => new Set(shelves.map((shelf) => shelf.getBoundingClientRect().top)).size);

/** Whether the shell's tile is selected. */
const tileSelected = (tile: Locator) => tile.evaluate((element) => element.closest('.react-flow__node')!.classList.contains('selected'));

/** A press at `at` that wobbles a pixel or two on the way, as a hand on a trackpad does. */
async function wobblyPress(page: Page, at: Point): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 2, at.y + 1);
  await page.mouse.up();
}

/** A wobbly press on the zone's well, on a point of it checked first to be the zone itself, nothing in it. */
async function wobblyClick(page: Page, zone: Locator): Promise<void> {
  const box = await settledBox(zone);
  const candidates = [0.1, 0.5, 0.9].flatMap((across) => [box.height - 30, box.height / 2].map((down) => ({ x: box.x + box.width * across, y: box.y + down })));
  const at = await page.evaluate((points) =>
    points.find(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest('.react-flow__node-zone') !== null && hit?.closest('.react-flow__node-tile, .shelf-card, .shelf-row, .shelf-chip, .cluster, button') === null;
    }),
  candidates);
  expect(at, 'a point of bare zone').toBeDefined();
  await wobblyPress(page, at!);
}

/** Drags the middle of the selected zone's `edge` handle by `by` board pixels at `scale`. */
async function dragEdge(page: Page, zone: Locator, edge: 'right' | 'bottom', by: Point, scale: number): Promise<void> {
  const handle = zone.locator(`.react-flow__resize-control.line.${edge}`);
  await expect(handle).toBeVisible();
  const from = centreOf(await settledBox(handle));
  await drag(page, from, { x: from.x + by.x * scale, y: from.y + by.y * scale });
}

/**
 * Drags the selected zone's right edge far in, past what it holds, and checks it stops at the least and stays there:
 * fitted into view first, as widened it can reach past the window's edge.
 */
async function narrowToLeast(page: Page, zone: Locator, wider: number): Promise<number> {
  await page.getByRole('button', { name: 'Fit View' }).click();
  const scale = await scaleOf(zone);
  const edge = centreOf(await settledBox(zone.locator('.react-flow__resize-control.line.right')));
  const left = (await settledBox(zone)).x;
  await drag(page, edge, { x: left + 150 * scale, y: edge.y });
  await expect.poll(async () => (await storedZone(page)).width).toBeLessThan(wider);
  const least = (await storedZone(page)).width;
  await expect(zone).toHaveAttribute('data-width', String(least));
  // Dragged further in, it goes no narrower.
  await dragEdge(page, zone, 'right', { x: -100, y: 0 }, scale);
  await expect(zone).toHaveAttribute('data-width', String(least));
  expect((await storedZone(page)).width).toBe(least);
  return least;
}

test('one click on a zone’s well selects it, wobbling or not, a click on its tile the tile, and its edges drag; on shelves and in clusters too, which reflow as it resizes and keep the size it is let go at, after Arrange and a restart', async () => {
  const dataDir = tempDataDir();
  let { app, window: page } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(page, 'Resized');
    let zone = page.getByTestId('zone');
    // A tile in it, so the zone's well is clicked with a tile nearby.
    await newShellInZone(page);
    await page.getByRole('button', { name: 'Close session window' }).click();
    const shell = page.getByTestId('shell-tile');
    await expect(shell).toHaveCount(1);
    const pane = page.locator('.react-flow__pane');
    await page.getByRole('button', { name: 'Fit View' }).click();
    await page.getByRole('button', { name: 'Zoom Out' }).click();
    const scale = await scaleOf(zone);

    // A plain zone: a press that wobbles selects it, and moves nothing; one on its tile selects the tile instead.
    const placed = await storedZone(page);
    await pane.click({ position: { x: 20, y: 300 } });
    await expect.poll(() => isSelected(zone)).toBe(false);
    await wobblyPress(page, centreOf(await settledBox(shell)));
    await expect.poll(() => tileSelected(shell)).toBe(true);
    expect(await isSelected(zone)).toBe(false);
    await wobblyClick(page, zone);
    await expect.poll(() => isSelected(zone)).toBe(true);
    expect(await tileSelected(shell)).toBe(false);
    expect(await storedZone(page)).toEqual(placed);
    // Its right edge then drags it wider.
    await dragEdge(page, zone, 'right', { x: 120, y: 0 }, scale);
    await expect.poll(async () => (await storedZone(page)).width).toBeGreaterThan(placed.width + 60);
    expect(await storedZone(page)).toMatchObject({ x: placed.x, y: placed.y });
    // On status shelves, and narrow, its shelves sit in more than one row: drawn as wide as they need, if wider.
    await page.evaluate(async (id) => {
      const [stored] = await window.agentBoard.zones.list();
      await window.agentBoard.zones.update(id, { x: stored!.x, y: stored!.y, width: 720, height: 480 });
      await window.agentBoard.zones.configure(id, { layoutMode: 'shelves' });
    }, placed.id);
    await expect(zone.getByTestId('shelves')).toHaveCount(1);
    await expect.poll(async () => Number(await zone.getAttribute('data-width'))).toBeGreaterThanOrEqual(720);
    await expect.poll(() => shelfRows(zone)).toBeGreaterThan(1);

    // A click on its well selects it; its right edge drags it wider, and the four shelves come into one row as it goes.
    await pane.click({ position: { x: 20, y: 300 } });
    await expect.poll(() => isSelected(zone)).toBe(false);
    await wobblyClick(page, zone);
    await expect.poll(() => isSelected(zone)).toBe(true);
    const handle = zone.locator('.react-flow__resize-control.line.right');
    await expect(handle).toBeVisible();
    const from = centreOf(await settledBox(handle));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 300 * scale, from.y, { steps: 12 });
    // Mid-drag, not yet let go.
    await expect.poll(() => shelfRows(zone)).toBe(1);
    await page.mouse.move(from.x + 500 * scale, from.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await storedZone(page)).width).toBeGreaterThan(1100);
    const wide = await storedZone(page);
    await expect(zone).toHaveAttribute('data-width', String(wide.width));
    expect(await shelfRows(zone)).toBe(1);

    // Its bottom edge drags too, and what it is let go at is what it keeps.
    await dragEdge(page, zone, 'bottom', { x: 0, y: 120 }, scale);
    await expect.poll(async () => (await storedZone(page)).height).toBeGreaterThan(wide.height + 60);
    const tall = await storedZone(page);
    expect(tall.width, 'a bottom edge drag leaves the width as it was').toBe(wide.width);
    await expect(zone).toHaveAttribute('data-height', String(tall.height));

    // Dragged far narrower than its shelves go, it stops at the least they fit in, in rows again, and keeps it.
    const least = await narrowToLeast(page, zone, wide.width);
    await expect.poll(() => shelfRows(zone)).toBeGreaterThan(1);
    const kept = await storedZone(page);

    // Arranging the board leaves its size as it was.
    await page.getByRole('button', { name: 'Board menu' }).click();
    await page.getByRole('button', { name: 'Arrange the board' }).click();
    await expect(zone).toHaveAttribute('data-width', String(least));
    expect(await storedZone(page)).toMatchObject({ width: kept.width, height: kept.height });

    // So does a restart: stored and drawn at it.
    await app.close();
    await stopDaemon(dataDir);
    ({ app, window: page } = await launch(dataDir, SHELL_ENV));
    zone = page.getByTestId('zone');
    await expect(zone.getByTestId('shelves')).toHaveCount(1);
    expect(await storedZone(page)).toMatchObject({ width: kept.width, height: kept.height });
    await expect(zone).toHaveAttribute('data-width', String(kept.width));
    await expect(zone).toHaveAttribute('data-height', String(kept.height));

    // In clusters, laned by unit of work: its edges drag it wider and back in, to the least its lanes fit in.
    await page.evaluate(async (id) => window.agentBoard.zones.configure(id, { layoutMode: 'clusters' }), kept.id);
    await expect(zone.getByTestId('shelves')).toHaveCount(0);
    await page.getByRole('button', { name: 'Fit View' }).click();
    await page.getByRole('button', { name: 'Zoom Out' }).click();
    const clusterScale = await scaleOf(zone);
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await wobblyClick(page, zone);
    await expect.poll(() => isSelected(zone)).toBe(true);
    const before = await storedZone(page);
    await dragEdge(page, zone, 'right', { x: 200, y: 0 }, clusterScale);
    await expect.poll(async () => (await storedZone(page)).width).toBeGreaterThan(before.width + 100);
    const widened = await storedZone(page);
    await expect(zone).toHaveAttribute('data-width', String(widened.width));
    await narrowToLeast(page, zone, widened.width);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
