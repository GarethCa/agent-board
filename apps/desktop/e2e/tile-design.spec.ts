import { expect } from '@playwright/test';
import { test, removeDataDir, tempDataDir } from './launch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';
import { launchGallery } from './visual/shared.ts';

test.use({ viewport: null });

test("Settings › Tile design redraws every agent's tile at once, from the Settings window, and the board keeps the pick through a reload", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launchGallery(dataDir, 'light');
  try {
    const tile = window.getByTestId('tile-gallery').locator('[data-testid="agent-tile"][data-session-id="gallery-needs-permission"]');
    await expect(tile).toBeVisible();
    await expect(tile).not.toHaveAttribute('data-tile-design', /./);
    const settings = await openSettings(window, 'general.design');
    const choices = settingsSection(settings, 'Design').getByRole('group', { name: 'Tile design' });
    await expect(choices.getByRole('button', { name: 'Today’s' })).toHaveAttribute('aria-pressed', 'true');
    await choices.getByRole('button', { name: 'Porthole' }).click();
    // The board hears it from the other window, with no reload.
    await expect(tile).toHaveAttribute('data-tile-design', 'porthole');
    await expect(tile.getByTestId('porthole')).toBeVisible();
    await window.reload();
    await expect(tile).toHaveAttribute('data-tile-design', 'porthole');
    await choices.getByRole('button', { name: 'Shelf' }).click();
    await expect(tile).toHaveAttribute('data-tile-design', 'shelf');
    await expect(tile.getByTestId('tile-band')).toBeVisible();
    await expect(tile.getByTestId('porthole')).toHaveCount(0);
    await choices.getByRole('button', { name: 'Today’s' }).click();
    await expect(tile).toBeVisible();
    await expect(tile).not.toHaveAttribute('data-tile-design', /./);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
