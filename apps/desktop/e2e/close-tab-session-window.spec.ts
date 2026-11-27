import { rmSync } from 'node:fs';
import { expect, type ElectronApplication } from '@playwright/test';
import { launch, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// File › Close Tab (⌘W) with a session window shown on the board closes that window, wherever the focus is in the
// board's window, and never the board's window. A synthetic key press doesn't reach a native menu accelerator, so the
// item is clicked as the menu bar does.

/** File's item labelled `label`: whether it is on, and its accelerator. */
const fileItem = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, label) => {
    const item = Menu.getApplicationMenu()!.items.find((each) => each.label === 'File')?.submenu?.items.find((each) => each.label === label);
    return item && { enabled: item.enabled, accelerator: item.accelerator ?? null };
  }, label);

const clickFileItem = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, label) => {
    Menu.getApplicationMenu()!.items.find((each) => each.label === 'File')!.submenu!.items.find((each) => each.label === label)!.click();
  }, label);

const boardWindows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((each) => each.isVisible()).length);

test("⌘W closes the session window opened from an expanded tile's Maximise, not the board's window", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Close me');
    await setClickOpens(window, 'Expand in place');
    const windows = await boardWindows(app);

    // Maximise, then ⌘W at once: the focus is still where the click left it, outside the session window's panes.
    await tile(window).dblclick({ position: { x: 20, y: 60 } });
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await clickFileItem(app, 'Close Tab');
    await expect(sessionWindow(window)).toHaveCount(0);
    expect(window.isClosed()).toBe(false);
    expect(await boardWindows(app)).toBe(windows);

    // Closed, the tile is back expanded, as it was when the window opened.
    await expect(window.getByTestId('expanded-tile')).toBeVisible();

    // Open again: Close Tab is on, so a real ⌘W goes to it, and Close Window keeps only ⇧⌘W.
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await expect.poll(() => fileItem(app, 'Close Tab')).toMatchObject({ enabled: true, accelerator: 'CommandOrControl+W' });
    if (process.platform === 'darwin') await expect.poll(async () => (await fileItem(app, 'Close Window'))?.accelerator).toBe('Command+Shift+W');
    await clickFileItem(app, 'Close Tab');
    await expect(sessionWindow(window)).toHaveCount(0);
    expect(window.isClosed()).toBe(false);

    // The focus in the agent's own terminal, a tab with no close: Close Tab closes the window, not the board's.
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await sessionWindow(window).locator('.xterm').first().click();
    await clickFileItem(app, 'Close Tab');
    await expect(sessionWindow(window)).toHaveCount(0);
    expect(window.isClosed()).toBe(false);

    // With no session window open, Close Tab is off and ⌘W closes the board's window, as before.
    await expect.poll(async () => (await fileItem(app, 'Close Tab'))?.enabled).toBe(false);
    if (process.platform === 'darwin') await expect.poll(async () => (await fileItem(app, 'Close Window'))?.accelerator).toBe('Command+W');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
