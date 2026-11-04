import { expect } from '@playwright/test';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

test.use({ viewport: null });

for (const { theme, suffix } of THEMES) {
  test(`every agent state has its look: the tile and character galleries, ${theme}`, async () => {
    needsBaselines(`tile-states${suffix}`, `character-gallery${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      await expect(window.getByTestId('character-gallery')).toBeVisible();
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(window.getByTestId('tile-gallery')).toHaveScreenshot(`tile-states${suffix}.png`, SHOT);
      await expect.soft(window.getByTestId('character-gallery')).toHaveScreenshot(`character-gallery${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

// A shape's colours are the theme's: each slot's fill and outline, and a fixed colour, in a dark pack and another.
for (const theme of ['catppuccin-mocha', 'gruvbox-dark']) {
  test(`shapes in every theme colour and a fixed one: the shape colours gallery, ${theme}`, async () => {
    needsBaselines(`gallery-shape-colours-${theme}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme, 'dark');
    try {
      const gallery = window.getByTestId('gallery-shape-colours');
      await expect(gallery).toBeVisible();
      await pinFonts(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(gallery).toHaveScreenshot(`gallery-shape-colours-${theme}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

/** The component gallery's sections (ui/ComponentGallery.tsx), each shot on its own so a change names its primitive. */
const GALLERY_SECTIONS = ['buttons', 'fields', 'overlays', 'labels', 'dialog', 'empty', 'window', 'chrome', 'shapes'];

for (const { theme, suffix } of THEMES) {
  test(`every primitive in every state: the component gallery, ${theme}`, async () => {
    needsBaselines(...GALLERY_SECTIONS.map((section) => `gallery-${section}${suffix}`));
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme);
    try {
      await expect(window.getByTestId('component-gallery')).toBeVisible();
      // Not pinned: the app bundles its fonts, so these shots guard them too, and they render the same on any machine.
      const fontsLoaded = await window.evaluate(async () => {
        await document.fonts.ready;
        return ['13px "Bricolage Grotesque Variable"', '11.5px "JetBrains Mono Variable"'].every((font) => document.fonts.check(font));
      });
      expect(fontsLoaded, 'the bundled fonts loaded').toBe(true);
      await ignorePointer(window);
      await settle(window);
      for (const section of GALLERY_SECTIONS) {
        await expect.soft(window.getByTestId(`gallery-${section}`)).toHaveScreenshot(`gallery-${section}${suffix}.png`, SHOT);
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

// The Simplified design's first baselines, `simplified-` before each name: the same primitives restyled by its tokens.
// Its type is the system's (SF Pro and SF Mono on macOS), so these shots are as machine-bound as the system's fonts.
for (const { theme, suffix } of THEMES) {
  test(`every primitive in every state in the Simplified design: the component gallery, ${theme}`, async () => {
    needsBaselines(...GALLERY_SECTIONS.map((section) => `simplified-gallery-${section}${suffix}`));
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme, undefined, { design: 'simplified' });
    try {
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect(window.getByTestId('component-gallery')).toBeVisible();
      // Its tokens took: the system's type, not the bundled Bricolage. A machine without SF Pro still mismatches the shots.
      expect(await window.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('-apple-system');
      await window.evaluate(() => document.fonts.ready);
      await ignorePointer(window);
      await settle(window);
      for (const section of GALLERY_SECTIONS) {
        await expect.soft(window.getByTestId(`gallery-${section}`)).toHaveScreenshot(`simplified-gallery-${section}${suffix}.png`, SHOT);
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

// The characters in the Simplified design, with the Captain at each of the sizes it is drawn at.
for (const { theme, suffix } of THEMES) {
  test(`every character pose and the Captain in the Simplified design: the character gallery, ${theme}`, async () => {
    needsBaselines(`simplified-character-gallery${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme, undefined, { design: 'simplified' });
    try {
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      const gallery = window.getByTestId('character-gallery');
      await expect(gallery.getByTestId('captain')).toHaveCount(4);
      await window.evaluate(() => document.fonts.ready);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(gallery).toHaveScreenshot(`simplified-character-gallery${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

// The six statuses in the Simplified design, each as icons and words and as characters.
for (const { theme, suffix } of THEMES) {
  test(`every status, as icons and words and as characters, in the Simplified design: the status marks, ${theme}`, async () => {
    needsBaselines(`simplified-status-marks${suffix}`);
    const dataDir = tempDataDir();
    const { app, window } = await launchGallery(dataDir, theme, undefined, { design: 'simplified' });
    try {
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      const marks = window.getByTestId('status-marks');
      await expect(marks.getByTestId('status-mark')).toHaveCount(12);
      await window.evaluate(() => document.fonts.ready);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(marks).toHaveScreenshot(`simplified-status-marks${suffix}.png`, SHOT);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
