import { launch } from '../agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines } from './shared.ts';
import { expect } from '@playwright/test';

test.use({ viewport: null });

// The creation toolbar's add menus, open: Classic's More to add (Steps, Memory, Queue) and the Simplified design's Draw
// (its tools, a separator, then the same three). Each at the usual width, and at the narrowest width where its islands
// still clear one another (below it the board menu island overlaps the toolbar, as it does on main, so no shot pins that).
const DESIGNS = [
  { design: 'classic' as const, opener: 'More to add', shot: 'add-menu-classic', narrow: 1270 },
  { design: 'simplified' as const, opener: 'Draw', shot: 'add-menu-simplified', narrow: 1100 },
];

for (const { design, opener, shot, narrow } of DESIGNS) {
  for (const { width, suffix } of [
    { width: VIEWPORT.width, suffix: '' },
    { width: narrow, suffix: '-narrow' },
  ]) {
    test(`the ${design} add menu open, ${width} px wide`, async () => {
      needsBaselines(`${shot}${suffix}`);
      const dataDir = tempDataDir();
      const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design });
      try {
        await window.setViewportSize({ width, height: VIEWPORT.height });
        await pinFonts(window);
        await window.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name: opener }).click();
        await expect(window.getByRole('menuitem', { name: 'Queue' })).toBeVisible();
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(window).toHaveScreenshot(`${shot}${suffix}.png`, { ...SHOT, clip: { x: 0, y: 0, width, height: 300 } });
        await restorePointer();
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}
