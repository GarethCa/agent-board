import { expect, type Page } from '@playwright/test';
import { launch, screen, SHELL_ENV, sessionWindow, showDetails } from './agent-helpers.ts';
import { test, newShell, removeDataDir, tempDataDir } from './launch.ts';

const strip = (page: Page) => sessionWindow(page).locator('.session-details');
const handle = (page: Page) => sessionWindow(page).getByTestId('details-handle');
const stripWidth = async (page: Page) => Math.round((await strip(page).boundingBox())!.width);
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());

async function dragHandle(page: Page, dx: number): Promise<void> {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('the details strip resizes on its handle: terminal columns follow, below the minimum it collapses to the rail, double-click resets, and the width outlasts a restart', async () => {
  const dataDir = tempDataDir();
  let current = await launch(dataDir, SHELL_ENV);
  try {
    let { window } = current;
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    // The strip opens collapsed to its icon rail; the rail's Show details opens it at the default width.
    await expect(strip(window)).toHaveClass(/session-details-rail/);
    await showDetails(sessionWindow(window));
    await expect(handle(window)).toHaveAttribute('role', 'separator');
    // Settled: the window eases in as it opens.
    await expect.poll(() => stripWidth(window)).toBe(316);
    const initial = 316;
    const [before] = await liveSessions(window);

    // Dragging the handle in narrows the strip and gives the terminal more columns.
    await dragHandle(window, -80);
    await expect.poll(() => stripWidth(window)).toBe(initial - 80);
    await expect(handle(window)).toHaveAttribute('aria-valuenow', String(initial - 80));
    await expect.poll(async () => (await liveSessions(window))[0]?.cols).toBeGreaterThan(before!.cols);

    // Out again, and the arrow keys step it.
    await dragHandle(window, 120);
    await expect.poll(() => stripWidth(window)).toBe(initial + 40);
    await handle(window).focus();
    await window.keyboard.press('ArrowLeft');
    await expect.poll(() => stripWidth(window)).toBe(initial + 40 - 16);

    // Never past half the window.
    await dragHandle(window, 2000);
    const half = Math.floor((await sessionWindow(window).locator('.session-window-body').boundingBox())!.width / 2);
    await expect.poll(() => stripWidth(window)).toBe(half);

    // Pulled below the minimum it collapses to the icon rail; dragging out from the rail opens it again.
    await dragHandle(window, -2000);
    await expect(strip(window)).toHaveClass(/session-details-rail/);
    await dragHandle(window, 300);
    await expect(strip(window)).not.toHaveClass(/session-details-rail/);
    await expect.poll(() => stripWidth(window)).toBeGreaterThan(250);

    // Double-click on the handle goes back to the default width.
    await dragHandle(window, -60);
    await handle(window).dblclick();
    await expect.poll(() => stripWidth(window)).toBe(initial);

    // The width outlives a restart.
    await dragHandle(window, -50);
    await expect.poll(() => stripWidth(window)).toBe(initial - 50);
    await window.waitForTimeout(500);
    await current.app.close();
    current = await launch(dataDir, SHELL_ENV);
    window = current.window;
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    // Each window opens collapsed; ⌘I opens it at the remembered width.
    await expect(strip(window)).toHaveClass(/session-details-rail/);
    await window.keyboard.press('ControlOrMeta+i');
    await expect(strip(window)).not.toHaveClass(/session-details-rail/);
    await expect.poll(() => stripWidth(window)).toBe(initial - 50);
    await expect(screen(window)).toBeVisible();
  } finally {
    await current.app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
