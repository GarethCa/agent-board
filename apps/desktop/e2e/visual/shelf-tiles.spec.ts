import { expect } from '@playwright/test';
import { GLANCE_STATES } from '../../src/renderer/src/board/glance-tile.ts';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

// Whether every shown child of a band ends before its action starts, and the action ends inside it (true when it has no action).
function clearOfAction(band: Element): boolean {
  const action = band.querySelector('.shelf-tile-act');
  if (action === null) return true;
  const { left: start, right: end } = action.getBoundingClientRect();
  if (end > band.getBoundingClientRect().right + 0.5) return false;
  const corner = action.parentElement!;
  return [...band.children].filter((each) => each !== corner && getComputedStyle(each).display !== 'none').every((each) => each.getBoundingClientRect().right <= start + 0.5);
}

// Whether every shown child of a band ends inside it.
function inside(band: Element): boolean {
  const end = band.getBoundingClientRect().right + 0.5;
  return [...band.children].filter((each) => getComputedStyle(each).display !== 'none').every((each) => each.getBoundingClientRect().right <= end);
}

// The tiles hovered: one that wants the user (its action in its age's place), one at work, and one done.
const HOVERED = ['permission', 'working', 'done'] as const;

// An agent's tile in the Shelf design, in each glance state at rest, a few on hover, and one with characters off.
for (const { theme, suffix } of THEMES) {
  test(`an agent's tile in the Shelf design in each state: its robot peeking over the top, its name, the whole of its line, and its state's band with its tags; Expand, More and its action on hover, ${theme}`, async () => {
    needsBaselines(
      ...GLANCE_STATES.map((state) => `shelf-tile-${state}${suffix}`),
      ...HOVERED.map((state) => `shelf-tile-${state}-hover${suffix}`),
      `shelf-tile-reviewer-working${suffix}`,
      `shelf-tile-reviewer-long${suffix}`,
      `shelf-tile-long${suffix}`,
      `shelf-tile-scheduled-full${suffix}`,
      `shelf-tile-unsent${suffix}`,
      `shelf-tile-needs-icons${suffix}`,
    );
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      const gallery = window.getByTestId('shelf-tile-gallery');
      // One per state, two reviewers at work (one with a long name), one with a long name, a line at the cap and long tags, a reviewer with the fullest band, and one with a prompt row.
      await expect(gallery.getByTestId('agent-tile')).toHaveCount(GLANCE_STATES.length + 5);
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
      // A long name leaves it in the band, never in the corner its buttons take.
      const reviewerLong = window.getByTestId('shelf-tile-reviewer-long');
      await expect(reviewerLong.getByTestId('tile-band').getByRole('img', { name: 'Reviewer' })).toBeVisible();
      await expect.soft(reviewerLong).toHaveScreenshot(`shelf-tile-reviewer-long${suffix}.png`, SHOT);
      // A long name and a line at the cap: the whole line shows in its box above the band, and its tags ride in the band.
      const long = window.getByTestId('shelf-tile-long');
      const line = long.getByTestId('tile-line');
      const [box, band] = await Promise.all([line.boundingBox(), long.getByTestId('tile-band').boundingBox()]);
      expect(box!.y + box!.height).toBeLessThanOrEqual(band!.y);
      expect(await line.evaluate((each) => ({ length: each.textContent!.length, over: each.hasAttribute('data-over'), spills: each.scrollHeight - each.clientHeight <= 2 }))).toEqual({ length: 120, over: false, spills: true });
      await expect(long.getByTestId('tile-band').getByTestId('tile-pr')).toBeVisible();
      await expect.soft(long).toHaveScreenshot(`shelf-tile-long${suffix}.png`, SHOT);
      // The fullest band: a reviewer's mark, a ticket, a PR, a repo and a schedule. Its times shorten with an ellipsis, inside the band.
      const full = window.getByTestId('shelf-tile-scheduled-full');
      const times = await full.getByTestId('tile-band').evaluate((band) => {
        const age = band.querySelector<HTMLElement>('[data-testid="tile-times"]')!;
        return { inside: age.getBoundingClientRect().right <= band.getBoundingClientRect().right + 0.5, ellipsis: getComputedStyle(age).textOverflow, text: age.textContent };
      });
      expect(times).toMatchObject({ inside: true, ellipsis: 'ellipsis', text: expect.stringContaining('next run') });
      // At rest its action, hidden, stands out of the band's way, and all the band shows ends inside it.
      expect(await full.getByTestId('tile-band').evaluate(inside)).toBe(true);
      await expect.soft(full).toHaveScreenshot(`shelf-tile-scheduled-full${suffix}.png`, SHOT);
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
        // Its action keeps its own room in the band: nothing shown there runs under it.
        expect(await tile.getByTestId('tile-band').evaluate(clearOfAction)).toBe(true);
        await expect.soft(tile).toHaveScreenshot(`shelf-tile-${state}-hover${suffix}.png`, SHOT);
      }
      // The fullest band on hover: its action still has its own room.
      await full.scrollIntoViewIfNeeded();
      await full.getByTestId('tile-band').hover();
      await expect(full.getByTestId('tile-controls')).toHaveCSS('opacity', '1');
      expect(await full.getByTestId('tile-band').evaluate(clearOfAction)).toBe(true);
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
