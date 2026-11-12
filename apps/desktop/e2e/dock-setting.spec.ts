import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV, windowKey } from './agent-helpers.ts';
import { openSettings } from './settings-helpers.ts';
import { classicOnly, newShell, removeDataDir, tempDataDir, test } from './launch.ts';

// Settings › Board › Opening tiles › Dock: Show everything (the default), Only what I pin, or Off. Whatever the dock leaves out is
// still found in ⌘K's Windows group.

const dockItems = (page: Page) => page.getByTestId('dock-item');
const spotlight = (page: Page) => page.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
const SPOTLIGHT_KEY = windowKey('k');

/** Opens a shell's window and minimises it; resolves with the shell's id. */
async function minimisedShell(page: Page): Promise<string> {
  await newShell(page);
  await expect(sessionWindow(page)).toHaveAttribute('data-state', 'attached');
  const id = (await sessionWindow(page).getAttribute('data-shell-id'))!;
  await page.getByRole('button', { name: 'Minimise session window' }).click();
  await expect(sessionWindow(page)).toBeHidden();
  return id;
}

/** The rows of ⌘K's Windows group, with the window's name and where it is. */
async function windowRows(page: Page) {
  await page.keyboard.press(SPOTLIGHT_KEY);
  await expect(spotlight(page)).toBeVisible();
  await expect(spotlight(page).locator('.spotlight-group').first()).toHaveText('Windows');
  return spotlight(page).getByTestId('spotlight-row').filter({ hasText: 'Minimised' });
}

test.beforeEach(() => classicOnly());

test('Show everything keeps every minimised window in the dock, with no pin to be seen, and ⌘K adds no Windows group', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const id = await minimisedShell(window);
    await expect(dockItems(window)).toHaveCount(1);
    await expect(window.getByRole('button', { name: /^Unpin / })).toHaveCount(0);
    await window.keyboard.press(SPOTLIGHT_KEY);
    await expect(spotlight(window)).toBeVisible();
    await expect(spotlight(window).locator('.spotlight-group').filter({ hasText: 'Windows' })).toHaveCount(0);
    await window.keyboard.press('Escape');
    await dockItems(window).locator('.session-dock-open').click();
    await expect(sessionWindow(window)).toHaveAttribute('data-shell-id', id);
    await expect(window.getByRole('button', { name: 'Pin to the dock' })).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Off hides the dock; a minimised window is found in ⌘K and restored from it', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { dock: 'off' });
  try {
    // Minimising with no dock says where the window went: the button's tooltip, and a toast, once.
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Minimise session window' }).hover();
    await expect(window.getByRole('tooltip')).toContainText('Find it in ⌘K or Window › Minimised');
    const id = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await expect(window.getByText('Minimised: ⌘K or Window › Minimised brings it back')).toBeVisible();
    await expect(window.getByTestId('session-dock')).toHaveCount(0);
    const rows = await windowRows(window);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Minimised');
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toHaveAttribute('data-shell-id', id);
    // No pin to offer where there is no dock.
    await expect(window.getByRole('button', { name: 'Pin to the dock' })).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Only what I pin keeps pinned windows in the dock and lists the others in ⌘K', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { dock: 'pinned' });
  try {
    // Not pinned: minimised, it is not in the dock.
    const plain = await minimisedShell(window);
    await expect(dockItems(window)).toHaveCount(0);

    // Pinned from its window's header, it stays in the dock once minimised.
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const kept = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    await window.getByRole('button', { name: 'Pin to the dock' }).click();
    await expect(window.getByRole('button', { name: 'Unpin from the dock' })).toHaveAttribute('aria-pressed', 'true');
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(dockItems(window)).toHaveCount(1);
    await expect(dockItems(window)).toHaveAttribute('data-shell-id', kept);

    // The unpinned one is in ⌘K's Windows group; the pinned one, in the dock, is not.
    const rows = await windowRows(window);
    await expect(rows).toHaveCount(1);
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toHaveAttribute('data-shell-id', plain);
    await window.getByRole('button', { name: 'Minimise session window' }).click();

    // Unpinned from the dock, a window leaves it.
    await dockItems(window).getByRole('button', { name: /^Unpin / }).click();
    await expect(dockItems(window)).toHaveCount(0);

    // A live switch to Off, and back to Show everything, which shows both again.
    await window.evaluate(() => globalThis.window.agentBoard.dock.set('off'));
    await expect(window.locator('html')).toHaveAttribute('data-dock', 'off');
    await window.evaluate(() => globalThis.window.agentBoard.dock.set('all'));
    await expect(window.locator('html')).not.toHaveAttribute('data-dock');
    await expect(dockItems(window)).toHaveCount(2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a pinned window keeps its pin when it is switched to: step to it, minimise it, and it is in the dock', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { dock: 'pinned' });
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const pinned = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    await window.getByRole('button', { name: 'Pin to the dock' }).click();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(dockItems(window)).toHaveCount(1);
    await minimisedShell(window);
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    // Stepping to the pinned one (the loose shells are one group) swaps it into this window.
    for (let step = 0; step < 3 && (await sessionWindow(window).getAttribute('data-shell-id')) !== pinned; step++) {
      await window.getByRole('button', { name: 'Next session' }).click();
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    }
    await expect(sessionWindow(window)).toHaveAttribute('data-shell-id', pinned);
    await expect(window.getByRole('button', { name: 'Unpin from the dock' })).toHaveAttribute('aria-pressed', 'true');
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(dockItems(window).and(window.locator(`[data-shell-id="${pinned}"]`))).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('the Window menu lists a minimised window under Minimised, and a pick restores it', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { dock: 'off' });
  try {
    const id = await minimisedShell(window);
    const pick = () =>
      app.evaluate(({ Menu }) => {
        const items = Menu.getApplicationMenu()!.items.find((item) => item.label === 'Window')!.submenu!.items;
        const heading = items.findIndex((item) => item.label === 'Minimised');
        if (heading < 0) return null;
        const entry = items[heading + 1]!;
        entry.click();
        return entry.label;
      });
    // The menu is rebuilt when the board reports its minimised windows.
    await expect.poll(pick).not.toBeNull();
    await expect(sessionWindow(window)).toHaveAttribute('data-shell-id', id);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('the pick is in Settings, applies live, and is remembered', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const settings = await openSettings(window, 'board.opening');
    const dock = settings.getByRole('group', { name: 'Dock' });
    await expect(dock.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await dock.getByRole('button', { name: 'Pinned only' }).click();
    await expect(dock.getByRole('button', { name: 'Pinned only' })).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('html')).toHaveAttribute('data-dock', 'pinned');
  } finally {
    await app.close();
  }
  const again = await launch(dataDir, SHELL_ENV);
  try {
    await expect(again.window.locator('html')).toHaveAttribute('data-dock', 'pinned');
  } finally {
    await again.app.close();
    await removeDataDir(dataDir);
  }
});
