import { expect, type Locator } from '@playwright/test';
import { openSubmenu } from '../agent-helpers.ts';
import { test, removeDataDir, tempDataDir } from '../launch.ts';
import { ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines, THEMES, launchGallery } from './shared.ts';

// An agent tile's own menu, from its ⋯, in both designs: its next step first, the groups after, and Run open to show
// Interrupt and Stop session kept apart from Delete.
for (const { theme, suffix } of THEMES) {
  for (const design of ['classic', 'simplified'] as const) {
    const shot = `agent-tile-menu${design === 'simplified' ? '-simplified' : ''}${suffix}`;
    test(`an agent tile's menu, its next step first and Run open: ${design}, ${theme}`, async () => {
      needsBaselines(shot);
      const dataDir = tempDataDir();
      const { app, window } = await launchGallery(dataDir, theme, undefined, design === 'simplified' ? { design } : {});
      try {
        // An agent asking for permission, so the menu leads with Go to its question.
        const tile: Locator =
          design === 'simplified'
            ? window.getByTestId('simplified-tile-waiting').getByTestId('agent-tile')
            : window.getByTestId('tile-gallery').locator('[data-testid="agent-tile"][data-session-id="gallery-needs-permission"]');
        await tile.scrollIntoViewIfNeeded();
        await tile.hover();
        await tile.getByRole('button', { name: 'More' }).click();
        // The gallery draws menus of its own; this is the tile's, the one ending in Delete agent.
        const menu = window.getByRole('menu').filter({ has: window.getByRole('menuitem', { name: 'Delete agent' }) });
        await expect(menu.getByRole('menuitem').first()).toContainText('Go to its question');
        await openSubmenu(window, 'Run');
        // Its row says what it does; the gallery's own Stop session row has no hint.
        await expect(window.getByRole('menuitem', { name: 'Stop session End its session' })).toBeVisible();
        await pinFonts(window);
        await ignorePointer(window);
        await settle(window);
        // The tile's menu and its Run group, drawn over the gallery wherever it scrolled to.
        const run = window.getByRole('menu').filter({ has: window.getByRole('menuitem', { name: 'Stop session End its session' }) });
        const [main, sub] = [(await menu.boundingBox())!, (await run.boundingBox())!];
        const left = Math.min(main.x, sub.x) - 8;
        const top = Math.min(main.y, sub.y) - 8;
        const clip = { x: left, y: top, width: Math.max(main.x + main.width, sub.x + sub.width) + 8 - left, height: Math.max(main.y + main.height, sub.y + sub.height) + 8 - top };
        await expect.soft(window).toHaveScreenshot(`${shot}.png`, { ...SHOT, clip });
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}
