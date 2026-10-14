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
      .poll(async () => Math.round((((await savedFrame(window)) as { width: number } | null)?.width ?? 0) * (await inBoard(window)).board.width))
      .toBe(Math.round(resized.width));
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

/** The session window's box inside its offset parent, the board area, from the board's top-left. */
const inBoard = (page: Page) =>
  sessionWindow(page).evaluate((node) => {
    const element = node as HTMLElement;
    const parent = element.offsetParent as HTMLElement;
    const probe = document.createElement('div');
    probe.style.width = 'var(--window-gutter)';
    document.body.append(probe);
    const gutter = probe.getBoundingClientRect().width;
    probe.remove();
    return { board: { width: parent.clientWidth, height: parent.clientHeight }, left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight, gutter };
  });

for (const viewport of [{ width: 1280, height: 800 }, { width: 2560, height: 1440 }]) {
  test(`at ${viewport.width}×${viewport.height} the session window fills the board to its margin, remembers a resize, and Fill-by-double-click returns it`, async () => {
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, SHELL_ENV);
    try {
      await window.setViewportSize(viewport);
      await newShell(window);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');
      // Settled: the window eases in as it opens. Within the gutter of the board's sides and top, and no more than the dock's row short below.
      await expect.poll(async () => (await inBoard(window)).width).toBeGreaterThan(viewport.width - 3 * 24 - 2);
      const full = await inBoard(window);
      expect(full.left).toBeLessThanOrEqual(full.gutter + 1);
      expect(full.top).toBeLessThanOrEqual(full.gutter + 80);
      expect(full.board.width - (full.left + full.width)).toBeLessThanOrEqual(full.gutter + 1);
      expect(full.board.height - (full.top + full.height)).toBeLessThanOrEqual(full.gutter + 80);
      expect(full.height).toBeGreaterThan(viewport.height * 0.8);

      // Resized, closed and reopened, it keeps the size.
      await window.getByRole('button', { name: 'Restore session window' }).click();
      await dragCorner(window, 'se', -100, -80);
      await expect.poll(async () => (await inBoard(window)).width).toBeLessThan(full.width - 80);
      const resized = await inBoard(window);
      await expect
        .poll(async () => Math.round((((await savedFrame(window)) as { width: number } | null)?.width ?? 0) * (await inBoard(window)).board.width))
        .toBe(Math.round(resized.width));
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(sessionWindow(window)).toHaveCount(0);
      await window.getByTestId('shell-tile').first().dblclick();
      await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'false');
      await expect.poll(async () => Math.round((await inBoard(window)).width)).toBe(Math.round(resized.width));

      // Double-clicking empty header space fills it again.
      await sessionWindow(window).locator('.session-window-head-fill').dblclick();
      await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');
      await expect.poll(async () => Math.round((await inBoard(window)).width)).toBe(Math.round(full.width));
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}

test('a resized window keeps its share of the board when the app window grows, and a maximised one stays maximised across a restart', async () => {
  const dataDir = tempDataDir();
  let current = await launch(dataDir, SHELL_ENV);
  try {
    let { window } = current;
    await window.setViewportSize({ width: 1280, height: 800 });
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Restore session window' }).click();
    // Dragged to about half the board's width.
    const start = await inBoard(window);
    await dragCorner(window, 'se', start.board.width / 2 - start.width - start.left, 0);
    await expect.poll(async () => (await inBoard(window)).width / (await inBoard(window)).board.width).toBeLessThan(0.55);
    const share = (await inBoard(window)).width / (await inBoard(window)).board.width;
    await expect.poll(async () => ((await savedFrame(window)) as { width: number } | null)?.width ?? 0).toBeCloseTo(share, 2);

    // A bigger app window: it is still about that share of the board.
    await window.setViewportSize({ width: 2560, height: 1440 });
    await expect.poll(async () => (await inBoard(window)).board.width).toBeGreaterThan(2400);
    await expect
      .poll(async () => {
        const now = await inBoard(window);
        return now.width / now.board.width;
      })
      .toBeCloseTo(share, 1);

    // Maximised, it is still maximised after a restart.
    await window.getByRole('button', { name: 'Maximise session window' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');
    await expect.poll(async () => JSON.stringify(await savedFrame(window))).toContain('"maximised":true');
    await current.app.close();
    current = await launch(dataDir, SHELL_ENV);
    window = current.window;
    await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');
  } finally {
    await current.app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
