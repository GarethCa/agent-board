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

// Every look of a steps card, in both designs: at rest, selected, its questions, a long list, empty, half size and far out.
for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const shot = `steps-gallery${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`every look of a steps card: the steps gallery, ${design}, ${theme}`, async () => {
      needsBaselines(shot);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        const gallery = window.getByTestId('steps-gallery');
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

// The quick ask on an agent's tile: its chip on asking tiles, and the ask open at each place, in both designs.
for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const shot = `quick-ask-gallery${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`the chip on an asking tile and the ask it opens: the quick ask gallery, ${design}, ${theme}`, async () => {
      needsBaselines(shot);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        const gallery = window.getByTestId('quick-ask-gallery');
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

// A steps card an agent waits on, in Needs you (the inbox's rows, the stepper open) and above its composer.
for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const shot = `needs-you-steps-gallery${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`a set to answer and a to-do in Needs you and above the composer: the Needs-you steps gallery, ${design}, ${theme}`, async () => {
      needsBaselines(shot);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {}, '#gallery-needs-you-steps');
      try {
        const gallery = window.getByTestId('needs-you-steps-gallery');
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

// A crew prefab's flow editor, in both designs: a builder and two reviewers with the loop back, and a lead's crew.
for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const shot = `prefab-editor${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`a crew prefab's flow editor: the prefab gallery, ${design}, ${theme}`, async () => {
      needsBaselines(shot);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        const gallery = window.getByTestId('prefab-gallery');
        await gallery.scrollIntoViewIfNeeded();
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

/** A memory's looks (board/items/MemoryGallery.tsx): open with entries and empty, folded to its icon, and its peek. */
const MEMORY_SHOTS = ['card', 'empty', 'icons', 'peek'];

for (const design of ['classic', 'simplified'] as const) {
  for (const { theme, suffix } of THEMES) {
    const named = (shot: string) => `memory-${shot}${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`a memory open as a card, empty, folded to its brain icon, and its peek: the memory gallery, ${design}, ${theme}`, async () => {
      needsBaselines(...MEMORY_SHOTS.map(named));
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, { design });
      try {
        const gallery = window.getByTestId('memory-gallery');
        await expect(gallery).toBeVisible();
        await expect(gallery.getByTestId('memory-icon')).toHaveCount(4);
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        for (const shot of MEMORY_SHOTS) await expect.soft(window.getByTestId(`memory-gallery-${shot}`)).toHaveScreenshot(`${named(shot)}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

/** A queue's looks (board/items/QueueGallery.tsx): open for agents, for the user and empty, folded to its icon, and its peek. */
const QUEUE_SHOTS = ['card', 'inbox', 'empty', 'icons', 'peek'];
/**
 * A queue handed on, on its own page: the user's with a Needs-you row, one no one takes from, a ticket on its taker's
 * tile, the focus view, Hand on and the drain sheet.
 */
const HAND_ON_SHOTS = ['look', 'idle', 'ticket', 'focus', 'focus-needs', 'hand', 'drain'];

for (const design of ['classic', 'simplified'] as const) {
  for (const { theme, suffix } of THEMES) {
    const named = (shot: string) => `queue-${shot}${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`a queue open as a card for agents, for you and empty, folded to its ticket icon, and its peek: the queue gallery, ${design}, ${theme}`, async () => {
      needsBaselines(...QUEUE_SHOTS.map(named));
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, { design });
      try {
        const gallery = window.getByTestId('queue-gallery');
        await expect(gallery).toBeVisible();
        await expect(gallery.getByTestId('queue-icon')).toHaveCount(4);
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        for (const shot of QUEUE_SHOTS) await expect.soft(window.getByTestId(`queue-gallery-${shot}`)).toHaveScreenshot(`${named(shot)}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

for (const design of ['classic', 'simplified'] as const) {
  for (const { theme, suffix } of THEMES) {
    const named = (shot: string) => `queue-${shot}${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`a queue handed on: Needs-you rows, no one taking, a ticket, the focus view, Hand on and the drain sheet: its gallery page, ${design}, ${theme}`, async () => {
      needsBaselines(...HAND_ON_SHOTS.map(named));
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, { design }, '#gallery-queue-hand-on');
      try {
        await expect(window.getByTestId('queue-hand-on-gallery')).toBeVisible();
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        for (const shot of HAND_ON_SHOTS) await expect.soft(window.getByTestId(`queue-gallery-${shot}`)).toHaveScreenshot(`${named(shot)}.png`, SHOT);
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}
