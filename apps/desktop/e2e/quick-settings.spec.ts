import { expect } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { test, tempDataDir, removeDataDir } from './launch.ts';
import { openSettings } from './settings-helpers.ts';

// The board menu's Quick settings: each control reads and writes the same setting as its row in the Settings window.

test('each quick setting shows and changes the value its Settings row shows, and back', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const settings = await openSettings(window);
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    const quick = menu.getByTestId('quick-settings');
    // The menu closes when the Settings window takes the focus, so it is opened again whenever it is wanted.
    const reopen = async () => {
      await window.bringToFront();
      if (!(await quick.isVisible())) await window.getByRole('button', { name: 'Board menu' }).click();
      await expect(quick).toBeVisible();
    };
    await reopen();

    // Appearance: the segmented control and Settings › General › Appearance's Mode are one setting.
    const mode = (name: string) => quick.getByRole('group', { name: 'Appearance' }).getByRole('button', { name });
    const settingsMode = (name: string) => settings.getByRole('group', { name: 'Mode' }).getByRole('button', { name });
    // The app starts in a fixed mode under test, so set one from Settings and see the menu follow, then back.
    await settingsMode('Light').click();
    await expect(mode('Light')).toHaveAttribute('aria-pressed', 'true');
    await mode('Dark').click();
    await expect(mode('Dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(settingsMode('Dark')).toHaveAttribute('aria-pressed', 'true');
    // Keyboard: Tab to the next option and Enter picks it (Dark to System).
    await mode('Dark').focus();
    await window.keyboard.press('Tab');
    await window.keyboard.press('Enter');
    await expect(mode('System')).toHaveAttribute('aria-pressed', 'true');
    await expect(settingsMode('System')).toHaveAttribute('aria-pressed', 'true');

    // Show usage on the board.
    const usage = quick.getByRole('switch', { name: 'Show usage on the board' });
    await expect(usage).not.toBeChecked();
    await usage.check();
    await openSettings(window, 'usage');
    await reopen();
    await expect(settings.getByRole('switch', { name: 'Show usage on the board' })).toBeChecked();
    await usage.uncheck();
    await expect(settings.getByRole('switch', { name: 'Show usage on the board' })).not.toBeChecked();

    // Simplified design, and Show technical details, which is there only while it is on.
    const simplified = quick.getByRole('switch', { name: 'Simplified design' });
    const technical = quick.getByRole('switch', { name: 'Show technical details' });
    await expect(technical).toHaveCount(0);
    await simplified.check();
    await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
    await expect(technical).not.toBeChecked();
    await technical.check();
    await openSettings(window, 'general');
    await reopen();
    await expect(settings.getByRole('switch', { name: 'Show technical details' })).toBeChecked();
    await technical.uncheck();
    await expect(settings.getByRole('switch', { name: 'Show technical details' })).not.toBeChecked();
    // Keyboard: Space toggles a focused switch.
    await simplified.focus();
    await window.keyboard.press('Space');
    await expect(window.locator('html')).not.toHaveAttribute('data-design', 'simplified');
    await expect(technical).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
