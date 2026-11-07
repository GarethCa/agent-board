import { expect } from '@playwright/test';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

const DESIGNS = [
  { design: 'classic', tag: '' },
  { design: 'simplified', tag: '-simplified' },
] as const;

for (const { design, tag } of DESIGNS) {
  for (const { theme, suffix } of THEMES) {
    test(`every pose in every style, and the setting that picks one: ${design}, ${theme}`, async () => {
      const shots = [`character-styles${tag}${suffix}`, `character-setting${tag}${suffix}`];
      needsBaselines(...shots);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, { design }, '#gallery-characters');
      try {
        await expect(window.getByTestId('character-styles')).toBeVisible();
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        await expect.soft(window.getByTestId('character-styles')).toHaveScreenshot(`${shots[0]}.png`, SHOT);
        await expect.soft(window.getByRole('group', { name: 'Characters' })).toHaveScreenshot(`${shots[1]}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });

    for (const style of ['pebble', 'pixel', 'off']) {
      test(`an agent's tile with its character as ${style}: ${design}, ${theme}`, async () => {
        const shot = `character-tile-${style}${tag}${suffix}`;
        needsBaselines(shot);
        const dataDir = tempDataDir();
        const { app, window } = await launchGallery(dataDir, theme, undefined, { design });
        try {
          await window.evaluate((picked) => {
            localStorage.setItem('agent-board.character-style', picked);
            location.reload();
          }, style);
          const gallery = window.getByTestId(design === 'simplified' ? 'calm-tile-gallery' : 'tile-gallery');
          await expect(gallery).toBeVisible();
          await pinFonts(window);
          await ignorePointer(window);
          await settle(window);
          await expect.soft(gallery).toHaveScreenshot(`${shot}.png`, SHOT);
        } finally {
          await app.close();
          await removeDataDir(dataDir);
        }
      });
    }
  }
}
