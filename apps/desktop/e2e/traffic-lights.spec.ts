import { expect, type Page } from '@playwright/test';
import { launch, SHELL_ENV, sessionWindow } from './agent-helpers.ts';
import { test, newShell, removeDataDir, tempDataDir } from './launch.ts';

/** The macOS traffic lights' box over the board, from main/chrome.ts: at x 16 and y 30, 56 by 16. Off macOS the OS frame has them. */
const LIGHTS = { left: 16, top: 30, right: 72, bottom: 46 };

const headerBox = async (page: Page) => (await sessionWindow(page).locator('header').first().boundingBox())!;

/** Drags the session window's top edge up past the board's top, restoring it first so it can be resized. */
async function dragTopEdgeToTop(page: Page): Promise<void> {
  const box = (await sessionWindow(page).locator('[data-edge="n"]').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, -200, { steps: 8 });
  await page.mouse.up();
}

test('on macOS a session window never reaches under the traffic lights, windowed, and may once full screen hides them', async () => {
  test.skip(process.platform !== 'darwin', 'the traffic lights float over the page on macOS only');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(window.locator('html')).toHaveAttribute('data-chrome', 'inset');

    // Maximised, and resized up to the top edge: its header's first control sits past the lights, below their row.
    for (const resize of [false, true]) {
      if (resize) {
        await window.getByRole('button', { name: 'Restore session window' }).click();
        await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'false');
        await dragTopEdgeToTop(window);
      }
      const head = await headerBox(window);
      const first = (await sessionWindow(window).locator('header').first().getByRole('button').first().boundingBox())!;
      const clear = first.x >= LIGHTS.right || first.y >= LIGHTS.bottom;
      expect(clear, `the header's first control is at ${first.x},${first.y}, under the lights`).toBe(true);
      expect(head.y).toBeGreaterThanOrEqual(LIGHTS.bottom);
    }

    // Full screen hides the lights, and the room kept for them goes: the same drag now reaches the top. A test hook sets
    // what the main process sends, since a real full-screen transition animates and flakes on a loaded machine.
    await window.evaluate(() => (document.documentElement.dataset.fullScreen = 'true'));
    // The page has taken it in: the bounds a drag stays inside follow the flag.
    await window.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await dragTopEdgeToTop(window);
    await expect.poll(async () => (await headerBox(window)).y).toBe(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
