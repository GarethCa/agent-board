import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, openSubmenu, spawnAgent, tile, TURN_MS } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, needsBaselines } from './shared.ts';

test.use({ viewport: null });

// In both designs: the tile menu's Pin expanded, in Arrange (Classic's Board), and the header of a tile pinned
// expanded, its pin shown on as Unpin, where Collapse was, and its window buttons greyed until it is unpinned.
for (const design of ['classic', 'simplified'] as const) {
  const suffix = design === 'simplified' ? '-simplified' : '';
  test(`an agent pinned expanded: its menu row and its header, ${design}`, async () => {
    needsBaselines(`pinned-expanded-menu${suffix}`, `pinned-expanded-header${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, design === 'simplified' ? { design } : {});
    try {
      await window.setViewportSize(VIEWPORT);
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Fix checkout flake');
      await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

      await tile(window).hover();
      await tile(window).getByRole('button', { name: 'More' }).click();
      const menu = window.getByRole('menu').filter({ has: window.getByRole('menuitem', { name: 'Delete agent' }) });
      const group = await openSubmenu(window, design === 'simplified' ? 'Arrange' : 'Board');
      await expect(group.getByRole('menuitem', { name: /^Pin expanded/ })).toBeVisible();
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      const [main, sub] = [(await menu.boundingBox())!, (await group.boundingBox())!];
      const left = Math.min(main.x, sub.x) - 8;
      const top = Math.min(main.y, sub.y) - 8;
      const clip = { x: left, y: top, width: Math.max(main.x + main.width, sub.x + sub.width) + 8 - left, height: Math.max(main.y + main.height, sub.y + sub.height) + 8 - top };
      await expect.soft(window).toHaveScreenshot(`pinned-expanded-menu${suffix}.png`, { ...SHOT, clip });
      await restorePointer();

      await group.getByRole('menuitem', { name: /^Pin expanded/ }).click();
      const expanded = window.getByTestId('expanded-tile');
      await expect(expanded).toHaveAttribute('data-pinned', 'true');
      await expect(expanded.getByRole('button', { name: 'Unpin' })).toBeVisible();
      await window.mouse.move(4, 4);
      await pinRandomText(window);
      await ignorePointer(window);
      await settle(window);
      await expect.soft(expanded.locator('.expanded-tile-head')).toHaveScreenshot(`pinned-expanded-header${suffix}.png`, SHOT);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
      await removeDataDir(dataDir);
    }
  });
}
