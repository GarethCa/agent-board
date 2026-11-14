import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, screen, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, stopDaemon, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

// Claude's TUI draws in the terminal's alternate screen and, as it exits, leaves it for a line on how to resume. A
// paused agent's window shows the screen it had with that line under it, not the line alone, after a restart too; waking
// it shows the live session in its place.

const RESUME = 'Resume this session with';

/** The window header's one state button, Pause or Wake, among its controls. */
const controls = (window: Page) => sessionWindow(window).locator('.session-window-head').getByTestId('shelf-controls');
const status = (window: Page) => window.getByTestId('session-window-status');

async function openWindow(window: Page): Promise<void> {
  await tile(window).dblclick();
  await expect(sessionWindow(window)).toBeVisible();
}

/** How many times `text` shows in the session window's terminal. */
async function shown(window: Page, text: string): Promise<number> {
  return (await screen(window).innerText()).split(text).length - 1;
}

test("a paused agent's window shows the last screen it drew, after a restart too, and waking it shows the live session", async () => {
  const { dir, repo, env } = scratch('output');
  const fullscreen = { ...env, FAKE_HARNESS_FULLSCREEN: '1', FAKE_HARNESS_IDLE_NOTIFY_MS: '600000' };
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, fullscreen);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Run the tests');
    await openWindow(window);
    await expect(screen(window)).toContainText('All tests pass.');
    await expect(tile(window)).toHaveAttribute('data-state', 'idle');

    // Paused, its session ends; its window keeps the screen it had, read-only, with the line on how to resume under it.
    await controls(window).getByRole('button', { name: 'Pause' }).click();
    await expect(status(window)).toHaveText('paused');
    await expect(screen(window)).toContainText(RESUME);
    await expect(screen(window)).toContainText('> Run the tests');
    await expect(screen(window)).toContainText('All tests pass.');
    expect(await shown(window, RESUME)).toBe(1);

    // The app and its daemon both go: the window, open as the app quit, opens again on the same screen.
    await app.close();
    await stopDaemon(dataDir);
    ({ app, window } = await launch(dataDir, fullscreen));
    await expect(sessionWindow(window)).toBeVisible();
    await expect(status(window)).toHaveText('paused');
    await expect(screen(window)).toContainText(RESUME);
    await expect(screen(window)).toContainText('All tests pass.');

    // Woken, the live session takes the window: its terminal starts afresh, so the frozen screen's line on how to
    // resume goes, and the conversation it draws again shows once, not under the frozen one, and stays once.
    await controls(window).getByRole('button', { name: 'Wake' }).click();
    await expect(status(window)).not.toHaveText('paused');
    await expect(controls(window).getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(screen(window)).not.toContainText(RESUME);
    await expect(screen(window)).toContainText('All tests pass.');
    await window.waitForTimeout(1_000);
    expect(await shown(window, 'All tests pass.')).toBe(1);
    await expect(screen(window)).not.toContainText(RESUME);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
