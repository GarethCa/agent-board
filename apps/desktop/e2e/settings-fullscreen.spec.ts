import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { test, tempDataDir, removeDataDir } from './launch.ts';
import { isSettingsWindow, openSettings } from './settings-helpers.ts';

// With the board in macOS full screen, Settings opens over it, a child window on the board's Space; otherwise it is the
// window of its own it always was.

/** What the app's windows are: whether each is full screen and which window is its parent, by title. */
const windowsOf = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((each) => ({
      title: each.getTitle(),
      fullScreen: each.isFullScreen(),
      parentTitle: each.getParentWindow()?.getTitle() ?? null,
    })),
  );

const setBoardFullScreen = async (app: ElectronApplication, on: boolean) => {
  await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows().find((each) => each.getTitle() !== 'Settings')!.setFullScreen(value), on);
  await expect.poll(async () => (await windowsOf(app)).find((each) => each.title !== 'Settings')?.fullScreen).toBe(on);
};

const settingsAndBoard = async (app: ElectronApplication) => {
  const all = await windowsOf(app);
  return { board: all.find((each) => each.title !== 'Settings')!, settings: all.find((each) => each.title === 'Settings') };
};

// A real full screen shows the window and takes a Space, which headless mode promises never to do (main/background.ts),
// so the default run has the main process count the board as full screen instead (AGENT_BOARD_TEST_FULL_SCREEN, never
// in a packaged build); the real thing is the headed test below (`AGENT_BOARD_HEADED=1`).
test('with the board counted as full screen, Settings opens as a child of it, and switches kind as that changes', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  const pretend = (on: boolean) => app.evaluate((_, value) => void (process.env.AGENT_BOARD_TEST_FULL_SCREEN = value ? '1' : '0'), on);
  const press = (page: Page) =>
    page.keyboard.press('Escape').catch((error: unknown) => {
      if (!page.isClosed()) throw error;
    });
  try {
    // A window of its own, until the board is full screen: then the same ask replaces it with a child of the board.
    const own = await openSettings(window, 'usage');
    expect((await settingsAndBoard(app)).settings!.parentTitle).toBeNull();
    await pretend(true);
    const [over] = await Promise.all([window.context().waitForEvent('page'), window.evaluate(() => globalThis.window.agentBoard.setup.openSettings('advanced.webTabs'))]);
    await expect(over.getByRole('navigation', { name: 'Settings' })).toBeVisible();
    await expect.poll(() => own.isClosed()).toBe(true);
    expect(window.context().pages().filter(isSettingsWindow)).toHaveLength(1);
    const { board, settings } = await settingsAndBoard(app);
    expect(settings!.parentTitle).toBe(board.title);

    // The app menu's Settings… (⌘,) brings that overlay forward: no second window.
    if (process.platform === 'darwin') {
      // Counted in the main process as the click returns, where a second window is already there, not as a page event.
      const count = await app.evaluate(({ Menu, BrowserWindow }) => {
        Menu.getApplicationMenu()!.items[0]!.submenu!.items.find((item) => item.label === 'Settings…')!.click();
        return BrowserWindow.getAllWindows().filter((each) => each.getTitle() === 'Settings').length;
      });
      expect(count).toBe(1);
    }

    // One Esc closes it, even with a switch focused (only text fields take Esc first).
    await openSettings(window, 'agents.links');
    const toggle = over.getByRole('switch', { name: 'Clickable links from Claude' });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    // Out of full screen, Settings is a window of its own again.
    await press(over);
    await expect.poll(() => window.context().pages().filter(isSettingsWindow).length).toBe(0);
    await pretend(false);
    await openSettings(window);
    expect((await settingsAndBoard(app)).settings!.parentTitle).toBeNull();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('headed: with the board in real full screen, Settings opens over it, never in a Space of its own', async () => {
  test.skip(process.env.AGENT_BOARD_HEADED !== '1', 'real full screen needs AGENT_BOARD_HEADED=1');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    await setBoardFullScreen(app, true);
    const settings = await openSettings(window, 'usage');
    await expect(settings.getByRole('main', { name: 'Usage' })).toBeVisible();
    const [board, over] = [(await windowsOf(app)).find((each) => each.title !== 'Settings')!, (await windowsOf(app)).find((each) => each.title === 'Settings')!];
    expect(board.fullScreen).toBe(true);
    expect(over.fullScreen).toBe(false);
    expect(over.parentTitle).toBe(board.title);

    // Asked again, at another row: the same overlay, no second window.
    await openSettings(window, 'advanced.webTabs');
    expect(window.context().pages().filter(isSettingsWindow)).toHaveLength(1);

    // Esc closes it.
    // The key can close the window before Playwright hears back, which rejects it; that's only a failure if it stays open.
    await settings.keyboard.press('Escape').catch((error: unknown) => {
      if (!settings.isClosed()) throw error;
    });
    await expect.poll(() => window.context().pages().filter(isSettingsWindow).length).toBe(0);

    // Out of full screen: a window of its own again, with no parent.
    await setBoardFullScreen(app, false);
    const own = await openSettings(window);
    expect(isSettingsWindow(own)).toBe(true);
    expect((await windowsOf(app)).find((each) => each.title === 'Settings')!.parentTitle).toBeNull();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
