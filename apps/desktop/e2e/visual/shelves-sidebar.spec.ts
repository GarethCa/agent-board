import { expect } from '@playwright/test';
import { removeDataDir, tempDataDir, test } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

/**
 * An agent's sidebar from the gallery (session/ShelvesGallery.tsx): a busy agent and a quiet one with the shelves open on
 * the page, the page styled by the agent, the page at 200px, a page of links and a note with a failing pull request, and
 * Made, Crew and Setup, and a page that is the one shelf. In both designs, light and dark.
 */
const ROWS = ['open', 'rail', 'shelves'] as const;

for (const design of ['classic', 'simplified'] as const) {
  for (const { theme, suffix } of THEMES) {
    const prefix = design === 'simplified' ? 'simplified-' : '';
    const shots = ROWS.map((row) => `${prefix}agent-shelves-${row}${suffix}`);
    test(`an agent's sidebar: its shelves open on its page, ${design}, ${theme}`, async () => {
      needsBaselines(...shots);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, { design });
      try {
        // Its own page of the gallery, so the other galleries never move it, nor it them.
        await window.evaluate(() => {
          location.hash = '#gallery-agent-sidebar';
          location.reload();
        });
        const gallery = window.getByTestId('shelves-gallery');
        await expect(gallery).toBeVisible();
        await expect(gallery.getByTestId('agent-shelves')).toHaveCount(17);
        await expect(gallery.getByTestId('agent-shelves-peek')).toHaveCount(5);
        if (design === 'classic') await pinFonts(window);
        else await window.evaluate(() => document.fonts.ready);
        await ignorePointer(window);
        await settle(window);
        for (const [index, row] of ROWS.entries()) {
          await expect.soft(window.getByTestId(`shelves-gallery-${row}`)).toHaveScreenshot(`${shots[index]}.png`, SHOT);
        }
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

test("hovering a crew row's record shows its x beside its status, never over it", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launchGallery(dataDir, 'light');
  try {
    await window.evaluate(() => {
      location.hash = '#gallery-agent-sidebar';
      location.reload();
    });
    for (const frame of ['shelves-crew', 'shelves-crew-narrow']) {
      const row = window.getByTestId(frame).getByTestId('details-record').first();
      await row.hover();
      const remove = row.getByRole('button', { name: 'Delete record' });
      await expect(remove).toHaveCSS('opacity', '1');
      const status = (await row.locator('.agent-shelves-pill, .agent-shelves-dot').boundingBox())!;
      expect(status.x + status.width).toBeLessThanOrEqual((await remove.boundingBox())!.x + 1);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
