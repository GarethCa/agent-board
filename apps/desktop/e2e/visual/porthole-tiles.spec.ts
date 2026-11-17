import { expect } from '@playwright/test';
import { GLANCE_STATES } from '../../src/renderer/src/board/glance-tile.ts';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

// The tiles hovered: one that wants the user (its action in its age's place), one at work, and one done.
const HOVERED = ['permission', 'working', 'done'] as const;
// The tiles shot again with characters off: their status glyph in the porthole.
const ICONS = ['needs', 'working', 'failed'] as const;

// An agent's tile in the Porthole design, in each glance state at rest, a reviewer at work, with the most to fit, a few on hover, and a few with characters off.
for (const { theme, suffix } of THEMES) {
  test(`an agent's tile in the Porthole design in each state: its robot in a ringed window, its name and state, one line, its ticket and age; Expand, More and its action on hover, ${theme}`, async () => {
    needsBaselines(
      ...GLANCE_STATES.map((state) => `porthole-tile-${state}${suffix}`),
      `porthole-tile-reviewer-working${suffix}`,
      `porthole-tile-reviewer-long${suffix}`,
      `porthole-tile-long${suffix}`,
      ...HOVERED.map((state) => `porthole-tile-${state}-hover${suffix}`),
      ...ICONS.map((state) => `porthole-tile-${state}-icons${suffix}`),
    );
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      const gallery = window.getByTestId('porthole-tile-gallery');
      await expect(gallery.getByTestId('agent-tile')).toHaveCount(GLANCE_STATES.length + 3);
      await pinFonts(window);
      const letPointer = await ignorePointer(window);
      await settle(window);
      for (const state of GLANCE_STATES) {
        const tile = window.getByTestId(`porthole-tile-${state}`);
        await expect(tile.getByTestId('agent-tile')).toHaveAttribute('data-glance', state);
        await expect.soft(tile).toHaveScreenshot(`porthole-tile-${state}${suffix}.png`, SHOT);
      }
      // A reviewer's tile has no dashed outline: its word and glyph say In review.
      const reviewer = window.getByTestId('porthole-tile-review').getByTestId('agent-tile');
      await expect(reviewer).toHaveAttribute('data-reviewer', 'true');
      await expect(reviewer).not.toHaveCSS('outline-style', 'dashed');
      // A reviewer's mark, after its state word, says it reviews in every state, at work too, where its word says Working; no other agent has one.
      await expect(reviewer.getByRole('img', { name: 'Reviewer' })).toBeVisible();
      const working = window.getByTestId('porthole-tile-reviewer-working');
      await expect(working.getByTestId('agent-tile')).toHaveAttribute('data-glance', 'working');
      await expect(working.getByRole('img', { name: 'Reviewer' })).toBeVisible();
      // It follows the state word on its row, however the name wraps, clear of the corner its buttons take on hover.
      const reviewerLong = window.getByTestId('porthole-tile-reviewer-long');
      for (const tile of [working, reviewerLong]) {
        const [mark, word, tray] = await Promise.all([tile.getByTestId('tile-reviewer-mark'), tile.getByTestId('tile-state'), tile.getByTestId('tile-controls')].map((each) => each.boundingBox()));
        expect(Math.abs(mark!.y + mark!.height / 2 - (word!.y + word!.height / 2))).toBeLessThanOrEqual(2);
        expect(mark!.x).toBeGreaterThan(word!.x + word!.width);
        // Clear of the tray means the two boxes don't meet: wholly left of it, or wholly below it.
        expect(mark!.x + mark!.width <= tray!.x || mark!.y >= tray!.y + tray!.height).toBe(true);
      }
      await expect(window.getByTestId('porthole-tile-working').getByTestId('tile-reviewer-mark')).toHaveCount(0);
      await expect.soft(working).toHaveScreenshot(`porthole-tile-reviewer-working${suffix}.png`, SHOT);
      await expect.soft(reviewerLong).toHaveScreenshot(`porthole-tile-reviewer-long${suffix}.png`, SHOT);
      // A name on two lines, a long line, ticket, PR and repo: the line gives up lines, and the foot stays inside the tile's padding.
      const long = window.getByTestId('porthole-tile-long');
      const fit = await long.getByTestId('agent-tile').evaluate((tile) => {
        const inner = tile.getBoundingClientRect().bottom - parseFloat(getComputedStyle(tile).paddingBottom);
        const meta = tile.querySelector('[data-testid="tile-meta"]')!.getBoundingClientRect();
        const line = tile.querySelector<HTMLElement>('[data-testid="tile-line"]')!;
        return { inner, metaBottom: meta.bottom, lines: Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)) };
      });
      expect(fit.metaBottom).toBeLessThanOrEqual(fit.inner + 0.5);
      expect(fit.lines).toBeGreaterThanOrEqual(1);
      expect(fit.lines).toBeLessThanOrEqual(2);
      await expect.soft(long).toHaveScreenshot(`porthole-tile-long${suffix}.png`, SHOT);
      await letPointer();
      for (const state of HOVERED) {
        const tile = window.getByTestId(`porthole-tile-${state}`);
        await tile.scrollIntoViewIfNeeded();
        await tile.getByTestId('porthole').hover();
        await expect(tile.getByTestId('tile-controls')).toHaveCSS('opacity', '1');
        await expect.soft(tile).toHaveScreenshot(`porthole-tile-${state}-hover${suffix}.png`, SHOT);
      }
      await window.evaluate(() => {
        localStorage.setItem('agent-board.character-style', 'off');
        location.reload();
      });
      await expect(gallery.getByTestId('porthole').first()).toHaveAttribute('data-look', 'icons');
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      for (const state of ICONS) {
        await expect.soft(window.getByTestId(`porthole-tile-${state}`)).toHaveScreenshot(`porthole-tile-${state}-icons${suffix}.png`, SHOT);
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
