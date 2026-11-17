import { expect } from '@playwright/test';
import { GLANCE_STATES } from '../../src/renderer/src/board/glance-tile.ts';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

// The tiles hovered: one that wants the user (its action in its age's place), one at work, and one done.
const HOVERED = ['permission', 'working', 'done'] as const;

// An agent's tile in the Shelf design, in each glance state at rest, a few on hover, and one with characters off.
for (const { theme, suffix } of THEMES) {
  test(`an agent's tile in the Shelf design in each state: its robot peeking over the top, its name, two lines, its tags, and its state's band; Expand, More and its action on hover, ${theme}`, async () => {
    needsBaselines(
      ...GLANCE_STATES.map((state) => `shelf-tile-${state}${suffix}`),
      ...HOVERED.map((state) => `shelf-tile-${state}-hover${suffix}`),
      `shelf-tile-reviewer-working${suffix}`,
      `shelf-tile-reviewer-long${suffix}`,
      `shelf-tile-long${suffix}`,
      `shelf-tile-unsent${suffix}`,
      `shelf-tile-needs-icons${suffix}`,
    );
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      const gallery = window.getByTestId('shelf-tile-gallery');
      // One per state, two reviewers at work (one with a two-line name), one with a name on two lines and long tags, and one with a prompt row.
      await expect(gallery.getByTestId('agent-tile')).toHaveCount(GLANCE_STATES.length + 4);
      await pinFonts(window);
      const letPointer = await ignorePointer(window);
      await settle(window);
      for (const state of GLANCE_STATES) {
        const tile = window.getByTestId(`shelf-tile-${state}`);
        await expect(tile.getByTestId('agent-tile')).toHaveAttribute('data-glance', state);
        await expect(tile.getByTestId('tile-controls')).toHaveCSS('opacity', '0');
        await expect.soft(tile).toHaveScreenshot(`shelf-tile-${state}${suffix}.png`, SHOT);
      }
      // A reviewer's mark follows its word in the band, in every state, at work too, where the word says Working; no other agent has one.
      await expect(window.getByTestId('shelf-tile-review').getByTestId('tile-band').getByRole('img', { name: 'Reviewer' })).toBeVisible();
      const working = window.getByTestId('shelf-tile-reviewer-working');
      await expect(working.getByTestId('agent-tile')).toHaveAttribute('data-glance', 'working');
      await expect(working.getByRole('img', { name: 'Reviewer' })).toBeVisible();
      await expect(window.getByTestId('shelf-tile-working').getByTestId('tile-reviewer-mark')).toHaveCount(0);
      await expect.soft(working).toHaveScreenshot(`shelf-tile-reviewer-working${suffix}.png`, SHOT);
      // A two-line name leaves it in the band, never in the corner its buttons take.
      const reviewerLong = window.getByTestId('shelf-tile-reviewer-long');
      await expect(reviewerLong.getByTestId('tile-band').getByRole('img', { name: 'Reviewer' })).toBeVisible();
      await expect.soft(reviewerLong).toHaveScreenshot(`shelf-tile-reviewer-long${suffix}.png`, SHOT);
      // Its name on two lines leaves its line one, and its tags and band stay in the tile's fixed size.
      const long = window.getByTestId('shelf-tile-long');
      const meta = await long.getByTestId('tile-meta').boundingBox();
      const band = await long.getByTestId('tile-band').boundingBox();
      expect(meta!.y + meta!.height).toBeLessThanOrEqual(band!.y);
      await expect.soft(long).toHaveScreenshot(`shelf-tile-long${suffix}.png`, SHOT);
      // A first prompt typed and not sent takes the line's place, with its own buttons, above the band.
      const unsent = window.getByTestId('shelf-tile-unsent');
      await expect(unsent.getByTestId('send-unsent')).toBeVisible();
      await expect.soft(unsent).toHaveScreenshot(`shelf-tile-unsent${suffix}.png`, SHOT);
      await letPointer();
      for (const state of HOVERED) {
        const tile = window.getByTestId(`shelf-tile-${state}`);
        await tile.scrollIntoViewIfNeeded();
        await tile.getByTestId('tile-band').hover();
        await expect(tile.getByTestId('tile-controls')).toHaveCSS('opacity', '1');
        await expect.soft(tile).toHaveScreenshot(`shelf-tile-${state}-hover${suffix}.png`, SHOT);
      }
      await window.evaluate(() => {
        localStorage.setItem('agent-board.character-style', 'off');
        location.reload();
      });
      await expect(gallery.getByTestId('tile-peek')).toHaveCount(0);
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(window.getByTestId('shelf-tile-needs')).toHaveScreenshot(`shelf-tile-needs-icons${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
