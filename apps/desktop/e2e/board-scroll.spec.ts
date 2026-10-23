import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { GESTURE_QUIET_MS } from '../src/renderer/src/board/wheel-latch.ts';

/** The board's view: where it is panned to, and its zoom. */
async function view(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  const style = (await page.locator('.react-flow__viewport').getAttribute('style')) ?? '';
  const [x, y] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(style)!.slice(1).map(Number);
  return { x: x!, y: y!, zoom: Number(/scale\(([-\d.e]+)\)/.exec(style)![1]) };
}

/** The view once two reads in a row agree: the board has stopped moving. */
async function settledView(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await view(page));
      const settled = now === last;
      last = now;
      return settled;
    })
    .toBe(true);
  return JSON.parse(last);
}

/**
 * Fits the view to the board, and waits for the fit to land. React Flow queues a fit for a later frame, which under
 * load can come after the next wheel and put the view back. Here the fit leaves the view as it was, so the view is
 * zoomed out first, making the fit show as a change.
 */
async function fitView(page: Page): Promise<void> {
  const start = await settledView(page);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(async () => (await view(page)).zoom).toBeLessThan(start.zoom);
  const zoomedOut = await settledView(page);
  await page.getByRole('button', { name: 'Fit View' }).click();
  await expect.poll(() => view(page)).not.toEqual(zoomedOut);
  await settledView(page);
}

/** What a wheel event is made from here. */
type Wheel = { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

/** One wheel event on `target` at its middle, as the trackpad or a mouse sends it. */
const wheel = (target: Locator, init: Wheel) =>
  target.evaluate((element, options) => {
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, ...options }),
    );
  }, init);

/** The platform's command key, as Playwright names it. React Flow reads it from key presses, not from the wheel event. */
const commandName = (page: Page) => page.evaluate(() => (navigator.platform.startsWith('Mac') ? 'Meta' : 'Control'));

test('the wheel pans the board in any direction, a pinch or the command key with the wheel zooms, and a terminal keeps its own scroll and text size', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await fitView(window);
    const pane = window.locator('.react-flow__pane');

    // Scroll pans both ways at once and leaves the zoom alone.
    let before = await view(window);
    await wheel(pane, { deltaX: 40, deltaY: 60 });
    await expect.poll(async () => (await view(window)).x).toBeLessThan(before.x);
    const after = await view(window);
    expect(after.y).toBeLessThan(before.y);
    expect(after.zoom).toBe(before.zoom);

    // Shift turns a vertical scroll horizontal. macOS does that itself, sending the delta as horizontal already.
    before = after;
    const mac = await window.evaluate(() => navigator.platform.startsWith('Mac'));
    await wheel(pane, mac ? { deltaX: 60, shiftKey: true } : { deltaY: 60, shiftKey: true });
    await expect.poll(async () => (await view(window)).x).toBeLessThan(before.x);
    expect((await view(window)).y).toBe(before.y);

    // A pinch is a wheel with Ctrl, and zooms in on a negative delta.
    before = await view(window);
    await wheel(pane, { deltaY: -50, ctrlKey: true });
    await expect.poll(async () => (await view(window)).zoom).toBeGreaterThan(before.zoom);

    // The command key with the wheel zooms too.
    before = await view(window);
    const key = await commandName(window);
    await window.keyboard.down(key);
    await wheel(pane, { deltaY: 50 });
    await window.keyboard.up(key);
    await expect.poll(async () => (await view(window)).zoom).toBeLessThan(before.zoom);

    // Over a terminal the wheel is the terminal's: the board stays put.
    await tileAction(tile(window), 'Expand in place');
    const terminal = window.getByTestId('expanded-tile').getByTestId('session-terminal');
    await expect(terminal).toBeVisible();
    // The view moves to show it only once it has finished opening (a double-click's second click may come until then),
    // so wait for that: the tile may have stopped animating before the view starts to move.
    await expect(window.getByTestId('expanded-tile')).not.toHaveAttribute('data-opening');
    // The tile animates in and the view eases to it: wait for both to stop.
    let last = '';
    await expect
      .poll(async () => {
        const now = JSON.stringify([await terminal.boundingBox(), await view(window)]);
        const settled = now === last;
        last = now;
        return settled;
      })
      .toBe(true);
    before = await view(window);
    await wheel(terminal, { deltaX: 40, deltaY: 60 });
    await wheel(terminal, { deltaY: -50, ctrlKey: true });
    await window.evaluate(() => new Promise(requestAnimationFrame));
    expect(await view(window)).toEqual(before);

    // The command key with + - 0 sizes the terminal text, refitting it, and leaves the board's view alone.
    const rows = () => terminal.locator('.xterm-rows > div').count();
    // The height of a row, unscaled by the board's zoom, grows with the font.
    const rowHeight = () => terminal.locator('.xterm-rows > div').first().evaluate((row) => (row as HTMLElement).offsetHeight);
    await terminal.click();
    // Start from the theme's size, once the row height has stopped changing.
    await window.keyboard.press(`${key}+0`);
    let lastHeight = 0;
    await expect
      .poll(async () => {
        const now = await rowHeight();
        const same = now === lastHeight;
        lastHeight = now;
        return same;
      })
      .toBe(true);
    const start = { font: await rowHeight(), rows: await rows() };
    await window.keyboard.press(`${key}+=`);
    await expect.poll(rowHeight).toBeGreaterThan(start.font);
    await expect.poll(rows).toBeLessThan(start.rows);
    await window.keyboard.press(`${key}+-`);
    await window.keyboard.press(`${key}+-`);
    await expect.poll(rowHeight).toBeLessThan(start.font);
    await window.keyboard.press(`${key}+0`);
    await expect.poll(rowHeight).toBe(start.font);
    await expect.poll(rows).toBe(start.rows);

    // A pinch over it does the same.
    await wheel(terminal, { deltaY: -100, ctrlKey: true });
    await expect.poll(rowHeight).toBeGreaterThan(start.font);
    expect(await view(window)).toEqual(before);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Wheel events dispatched in one task, so they are one gesture whatever the load: each on the first element its selector finds. */
const burst = (page: Page, events: [selector: string, init: Wheel][]) =>
  page.evaluate((list) => {
    for (const [selector, init] of list) {
      const element = document.querySelector(selector)!;
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, ...init }));
    }
  }, events);

test('a wheel gesture stays with the surface it started on: a pan from the bare board carries over a terminal, a scroll from a terminal does not pan', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tileAction(tile(window), 'Expand in place');
    await expect(window.getByTestId('expanded-tile').getByTestId('session-terminal')).toBeVisible();
    await expect(window.getByTestId('expanded-tile')).not.toHaveAttribute('data-opening');
    const pane = '.react-flow__pane';
    const terminal = '[data-testid="session-terminal"]';
    const pan: Wheel = { deltaX: 40, deltaY: 60 };

    // The first event on the bare board (it moves nothing), the second over the terminal: one gesture, so the board pans.
    // Only the second has a vertical delta, so the board moving in y shows it reached the board through the terminal.
    const before = await settledView(window);
    await burst(window, [[pane, { deltaX: 0, deltaY: 0 }], [terminal, pan]]);
    await expect.poll(async () => (await view(window)).y).not.toBe(before.y);

    // After a pause longer than the quiet gap a gesture that starts in the terminal is the terminal's, and the bare board
    // under it does not pan.
    await window.waitForTimeout(GESTURE_QUIET_MS * 3);
    const still = await settledView(window);
    await burst(window, [[terminal, pan], [pane, pan]]);
    await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await view(window)).toEqual(still);

    // The same wheel on the bare board, as a gesture of its own, does pan: the check above can fail.
    await window.waitForTimeout(GESTURE_QUIET_MS * 3);
    await burst(window, [[pane, pan]]);
    await expect.poll(async () => (await view(window)).x).not.toBe(still.x);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
