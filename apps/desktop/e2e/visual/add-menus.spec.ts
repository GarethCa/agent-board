import { launch } from '../agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines } from './shared.ts';
import { expect } from '@playwright/test';

test.use({ viewport: null });

// The creation toolbar's add menus, open: Classic's More to add (Steps, Queue) and the Simplified design's Draw
// (its tools, a separator, then the same two). Each at the usual width, and at the narrowest width where its toolbar
// still shows every tool (narrower, Classic's drawing tools fold into Draw: the shots below).
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

// Narrower, Classic's toolbar can't keep clear of the islands either side, so its drawing tools fold into one Draw menu
// rather than the islands meeting, and then words give way: every tool is still a click or a Tab away. At 1100 px, at
// 900 px with Draw open, and at 640 px, the narrowest the window goes.
test('the classic toolbar folded into Draw, 1100, 900 and 640 px wide', async () => {
  needsBaselines('toolbar-classic-1100', 'toolbar-classic-900', 'toolbar-classic-640');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'classic' });
  try {
    await pinFonts(window);
    const toolbar = window.getByRole('toolbar', { name: 'Create' });
    const draw = toolbar.getByRole('button', { name: 'Draw' });
    /** The room between the toolbar and the island either side of it, in px. */
    const gaps = () =>
      window.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return [rect('.create-toolbar').left - rect('.island-top-left').right, rect('.island-top-right').left - rect('.create-toolbar').right];
      });
    for (const width of [1100, 900, 640]) {
      await window.setViewportSize({ width, height: VIEWPORT.height });
      await expect(draw).toBeVisible();
      await expect(toolbar.getByRole('button', { name: 'Sticky note' })).toBeHidden();
      await expect.poll(async () => Math.min(...(await gaps())), { message: `the islands' room at ${width} px` }).toBeGreaterThanOrEqual(14);
      if (width === 900) {
        await draw.focus();
        await window.keyboard.press('Enter');
        await expect(window.getByRole('menuitem', { name: 'Zone' })).toBeVisible();
      }
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window).toHaveScreenshot(`toolbar-classic-${width}.png`, { ...SHOT, clip: { x: 0, y: 0, width, height: width === 900 ? 360 : 80 } });
      await restorePointer();
      if (width === 900) await window.keyboard.press('Escape');
    }
    // S opens the shape picker under Draw, as the Shape tool it folded away would under itself.
    await window.keyboard.press('s');
    const picker = window.getByRole('dialog', { name: 'Shapes' });
    await expect(picker).toBeVisible();
    const [under, button] = [(await picker.boundingBox())!, (await draw.boundingBox())!];
    expect(under.y).toBeGreaterThanOrEqual(button.y + button.height);
    expect(under.x).toBeLessThan(button.x + button.width);
    expect(under.x + under.width).toBeGreaterThan(button.x);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
