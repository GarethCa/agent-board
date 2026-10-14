import { expect, type Page } from '@playwright/test';
import { launch, screen, SHELL_ENV, sessionWindow } from './agent-helpers.ts';
import { test, newShell, removeDataDir, tempDataDir } from './launch.ts';

const size = async (page: Page) => (await sessionWindow(page).boundingBox())!;
const savedFrame = (page: Page) => page.evaluate(() => window.agentBoard.view.get('windowFrame'));
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());

async function dragCorner(page: Page, corner: 'se' | 'nw', dx: number, dy: number): Promise<void> {
  const box = (await sessionWindow(page).locator(`[data-edge="${corner}"]`).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test('the session window resizes from a corner and refits its terminal, maximises and restores, and keeps its size across a restart', async () => {
  const dataDir = tempDataDir();
  let current = await launch(dataDir, SHELL_ENV);
  try {
    let { window } = current;
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    // Filling the board until resized.
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');

    // Restore, then drag the bottom-right corner in: smaller window, fewer columns and rows.
    await window.getByRole('button', { name: 'Restore session window' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'false');
    const restored = await size(window);
    const [before] = await liveSessions(window);
    await dragCorner(window, 'se', -120, -90);
    await expect.poll(async () => (await size(window)).width).toBeLessThan(restored.width - 100);
    const resized = await size(window);
    expect(resized.height).toBeLessThan(restored.height - 70);
    await expect.poll(async () => (await liveSessions(window))[0]?.cols).toBeLessThan(before!.cols);
    await expect.poll(async () => (await liveSessions(window))[0]?.rows).toBeLessThan(before!.rows);

    // Maximise fills the board; Restore goes back to the size it had.
    await window.getByRole('button', { name: 'Maximise session window' }).click();
    await expect.poll(async () => (await size(window)).width).toBeGreaterThan(resized.width + 100);
    await window.getByRole('button', { name: 'Restore session window' }).click();
    await expect.poll(async () => Math.round((await size(window)).width)).toBe(Math.round(resized.width));

    // Double-clicking empty header space toggles it too: a real double-click on the gap, which hit-testing must reach.
    await sessionWindow(window).locator('.session-window-head-fill').dblclick();
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');
    await sessionWindow(window).locator('.session-window-head-fill').dblclick();
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'false');

    // The size outlives a restart: once it has been saved, which is a moment after it changes.
    await expect
      .poll(async () => JSON.stringify(await savedFrame(window)))
      .toContain(`"width":${Math.round(resized.width)}`);
    await current.app.close();
    current = await launch(dataDir, SHELL_ENV);
    window = current.window;
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'false');
    // Settled: the window eases in as it opens.
    await expect.poll(async () => Math.round((await size(window)).width)).toBe(Math.round(resized.width));
    await expect(screen(window)).toBeVisible();
  } finally {
    await current.app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
