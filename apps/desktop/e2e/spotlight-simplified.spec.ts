import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { isSettingsWindow } from './settings-helpers.ts';
import { scratch } from './scratch.ts';

// ⌘K under the Simplified design: the open and minimised session windows lead, and ↵ on a minimised one restores it.

const FIND = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';

test('⌘K lists the windows first, restores a minimised one, and opens a setting at its section', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, []);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database', { name: 'Alpha' });
    await spawnAgent(window, 'monorepo', 'Pick a database', { name: 'Bravo' });

    // Alpha's window opens and is minimised, then Bravo's opens. The Simplified header has no Minimise button
    // (the dock goes with a later change), so this is done in Classic, and the design is switched after.
    await tile(window).filter({ hasText: 'Alpha' }).dblclick();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await tile(window).filter({ hasText: 'Bravo' }).dblclick();
    await expect(sessionWindow(window)).toContainText('Bravo');
    await window.evaluate(() => globalThis.window.agentBoard.design.set('simplified'));
    await expect.poll(() => window.evaluate(() => document.documentElement.dataset.design)).toBe('simplified');

    await window.keyboard.press(FIND);
    const spotlight = window.getByTestId('spotlight');
    await expect(spotlight).toBeVisible();
    const rows = spotlight.getByTestId('spotlight-row');
    await expect(spotlight.locator('.spotlight-group').first()).toHaveText('Windows');
    // The window the view shows (Bravo) is last, as ↵ on it only closes.
    await expect(rows.first()).toContainText('Alpha');
    await expect(rows.first()).toContainText('Minimised');
    await expect(rows.nth(1)).toContainText('Bravo');

    // Picking the minimised one brings its window back.
    await spotlight.getByRole('combobox').fill('alpha');
    await expect(rows.first()).toContainText('Minimised');
    await window.keyboard.press('Enter');
    await expect(spotlight).toBeHidden();
    await expect(sessionWindow(window)).toContainText('Alpha');
    // The board flew to its tile behind the window, and selected it.
    await expect(window.locator('.react-flow__node.selected').getByTestId('agent-tile')).toContainText('Alpha');

    // ⌘↵ on the other window's row does the same.
    await window.keyboard.press(FIND);
    await spotlight.getByRole('combobox').fill('bravo');
    await expect(rows.first()).toContainText('Minimised');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(sessionWindow(window)).toContainText('Bravo');

    // An action: New agent opens its dialog.
    await window.keyboard.press(FIND);
    await spotlight.getByRole('combobox').fill('new agent');
    // The action is the only row for it, the first and the active one: no "New agent named …" beside it.
    await expect(spotlight.getByTestId('spotlight-new-agent')).toHaveCount(0);
    await expect(spotlight.locator('[data-kind="action"]').first()).toContainText('New agent');
    await expect(spotlight.locator('[data-kind="action"][data-active]').first()).toContainText('New agent');
    await window.keyboard.press('Enter');
    const form = window.getByRole('dialog', { name: 'New agent' });
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Name')).toHaveValue('');
    await window.keyboard.press('Escape');

    // A setting found opens the Settings window at its section.
    await window.keyboard.press(FIND);
    await spotlight.getByRole('combobox').fill('appearance');
    const setting = spotlight.locator('[data-testid="spotlight-row"][data-kind="setting"]').first();
    await expect(setting).toBeVisible();
    const opened = window.context().waitForEvent('page');
    await setting.click();
    const settings = await opened;
    expect(isSettingsWindow(settings)).toBe(true);
    await expect(settings.getByRole('main', { name: 'General' })).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
