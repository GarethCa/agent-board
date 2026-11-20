import { expect } from '@playwright/test';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

// A ticket's tile, an agent tile, with its watches on: a new review to read, news its chat was told, checks failing, all four on, and its Watches menu.
for (const { theme, suffix } of THEMES) {
  test(`a ticket's watches: a new review its one ask with Read, news told to its chat, checks failing, all four on, and its Watches menu, ${theme}`, async () => {
    needsBaselines(`ticket-watches${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      const gallery = window.getByTestId('ticket-watch-gallery');
      await expect(gallery.locator('[data-ticket-tile]')).toHaveCount(4);
      await expect(window.getByTestId('ticket-watch-new-review').getByTestId('tile-state-word')).toHaveText('New review');
      await expect(window.getByTestId('ticket-watch-new-review').getByTestId('tile-act')).toHaveText('Read');
      await expect(window.getByTestId('ticket-watch-told-chat').getByTestId('tile-act')).toHaveCount(0);
      await expect(window.getByTestId('ticket-watch-checks-failing').getByTestId('tile-description')).toHaveText('Checks failing: 1 of 3 passing.');
      // All four on: the face stays an agent tile's, with no watch icons; its pull request stays in its footer.
      const crowded = window.getByTestId('ticket-watch-crowded');
      await expect(crowded.getByTestId('ticket-watch-icon')).toHaveCount(0);
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(gallery).toHaveScreenshot(`ticket-watches${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
