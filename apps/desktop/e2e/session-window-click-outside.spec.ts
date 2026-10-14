import { expect, type Page } from '@playwright/test';
import { launch, SHELL_ENV, sessionWindow } from './agent-helpers.ts';
import { test, placeWithTool, removeDataDir, tempDataDir } from './launch.ts';

const dockItem = (page: Page) => page.getByTestId('dock-item');
const shellTiles = (page: Page) => page.getByTestId('shell-tile');
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());

/** Restores the window and drags its bottom-right corner in, leaving the board's right and bottom showing. */
async function shrinkWindow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Restore session window' }).click();
  const box = (await sessionWindow(page).locator('[data-edge="se"]').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y - 150, { steps: 6 });
  await page.mouse.move(x - 300, y - 300, { steps: 6 });
  await page.mouse.up();
}

test('a click on the board outside a session window minimises it, selecting what was clicked; its own menus and dialogs do not', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    // A second shell, loose at the board's bottom right, for the window to leave showing.
    const board = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await placeWithTool(window, 'New shell', { x: board.width - 160, y: 200 });
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await placeWithTool(window, 'New shell', { x: board.width - 160, y: board.height - 200 });
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const shown = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    await shrinkWindow(window);
    await expect(shellTiles(window)).toHaveCount(2);

    // A dialog opened from the window (Delete asks first while a command runs) is not outside.
    await window.getByTestId('session-terminal').click();
    await window.keyboard.type('sleep 30');
    await window.keyboard.press('Enter');
    await sessionWindow(window).getByRole('button', { name: 'Delete session' }).click();
    const confirm = window.getByRole('alertdialog', { name: 'Delete shell?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(sessionWindow(window)).toBeVisible();

    // A drag that starts inside the window and ends outside leaves it open; so does its own resize handle.
    const head = (await sessionWindow(window).locator('.session-window-head-fill').boundingBox())!;
    await window.mouse.move(head.x + 4, head.y + head.height / 2);
    await window.mouse.down();
    await window.mouse.move(board.width - 50, 60, { steps: 6 });
    await window.mouse.up();
    await expect(sessionWindow(window)).toBeVisible();

    // The empty board: the window is minimised, the session still live.
    const win = (await sessionWindow(window).boundingBox())!;
    await window.mouse.click(Math.min(board.width - 20, win.x + win.width + 20), 20);
    await expect(sessionWindow(window)).toBeHidden();
    await expect(dockItem(window).and(window.locator(`[data-shell-id="${shown}"]`))).toHaveCount(1);
    expect((await liveSessions(window)).length).toBeGreaterThan(0);

    // A tile outside: the window minimises and the tile is selected.
    await dockItem(window).and(window.locator(`[data-shell-id="${shown}"]`)).locator('.session-dock-open').click();
    await expect(sessionWindow(window)).toBeVisible();
    await window.locator(`[data-testid="shell-tile"]:not([data-shell-id="${shown}"])`).click();
    await expect(sessionWindow(window)).toBeHidden();
    await expect(window.locator('.react-flow__node.selected').getByTestId('shell-tile')).not.toHaveAttribute('data-shell-id', shown);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
