import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, listFinishedTurns, spawnAgent, tile, TURN_MS } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { scratch } from '../scratch.ts';
import { viewTransform } from '../board-helpers.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { openSettings } from '../settings-helpers.ts';
import { BOARD_BACKGROUND_LABELS, BOARD_BACKGROUNDS } from '../../src/renderer/src/board/board-background.ts';
import { SHOT, THEMES, needsBaselines } from './shared.ts';

test.use({ viewport: null });

// Settings › General › Appearance › Board background (a CSS pattern behind the board each): the picker with every swatch,
// and the board with each one, behind a zone with an agent's tile, a note and a line of text, so each shows it stays
// quiet behind them.

/** The file a background's shot is saved as. */
const shotName = (background: string, suffix: string, design = '') => `board-background-${design}${background}${suffix}`;

for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`every board background, and the picker for them, ${theme}`, async () => {
    needsBaselines('board-background-picker' + suffix, ...BOARD_BACKGROUNDS.map((each) => shotName(each, suffix)));
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance }, RENDER_ARGS);
    await listFinishedTurns(window);
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await window.evaluate(async () => {
        const { items } = globalThis.window.agentBoard;
        await items.create({ kind: 'sticky', zoneId: null, x: 120, y: 60, width: 220, height: 140, data: { text: '**Ship Friday**\n\n- checkout fix\n- cache decision', color: '#fff3a3' } });
        await items.create({ kind: 'text', zoneId: null, x: 300, y: 690, width: 300, height: 50, data: { text: 'Launch week', size: 'h1', bold: true, italic: false, align: 'left', color: '#2b2a27', wrap: false } });
      });
      await expect(window.getByTestId('sticky')).toHaveCount(1);
      await window.addStyleTag({ content: '.hybrid-tile { rotate: 0deg !important; }' });
      await pinFonts(window);
      await pinRandomText(window);

      const settings = await openSettings(window, 'general.appearance');
      await settings.emulateMedia({ colorScheme: theme });
      await expect.poll(() => settings.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(settings);
      const picker = settings.getByRole('group', { name: 'Board background' }).first();
      await expect(picker.getByRole('radio')).toHaveCount(BOARD_BACKGROUNDS.length);
      await expect(picker.getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
      let restorePointer = await ignorePointer(settings);
      await settle(settings);
      await expect.soft(picker).toHaveScreenshot(`board-background-picker${suffix}.png`, SHOT);
      await restorePointer();

      for (const background of BOARD_BACKGROUNDS) {
        await picker.getByRole('radio', { name: BOARD_BACKGROUND_LABELS[background].name }).click();
        // The board hears the change from the other window.
        await expect(window.locator('.board').locator('[data-board-background], .react-flow__background')).toHaveCount(1);
        if (background !== 'standard') await expect(window.locator('.board [data-board-background]')).toHaveAttribute('data-board-background', background);
        restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(window.locator('.board')).toHaveScreenshot(`${shotName(background, suffix)}.png`, SHOT);
        await restorePointer();
      }
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The Simplified design draws its desk plain; a chosen pattern still shows over it.
  test(`a board background under the Simplified design, ${theme}`, async () => {
    needsBaselines(shotName('lines', suffix, 'simplified-'));
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance }, RENDER_ARGS, { design: 'simplified' });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await expect(window.locator('html')).toHaveAttribute('data-design', 'simplified');
      await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await pinFonts(window);
      const settings = await openSettings(window, 'general.appearance');
      await settings.getByRole('radio', { name: 'Lines' }).click();
      await expect(window.locator('.board [data-board-background="lines"]')).toHaveCount(1);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(window.locator('.board')).toHaveScreenshot(`${shotName('lines', suffix, 'simplified-')}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close().catch(() => {});
      await removeDataDir(dataDir);
    }
  });
}

// A moving pattern follows the viewport: its offset and cell scale are the board's pan and zoom, and it is left out when
// zoomed far out. (The shots above are all at the default view, which is also the CSS defaults.)
test('a moving board background follows pan and zoom, and is left out zoomed far out', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RENDER_ENV, RENDER_ARGS);
  try {
    await window.setViewportSize(VIEWPORT);
    const settings = await openSettings(window, 'general.appearance');
    await settings.getByRole('radio', { name: 'Lines' }).click();
    const backdrop = window.locator('.board [data-board-background="lines"]');
    await expect(backdrop).toHaveCount(1);

    /** The board's view, from its viewport's transform. */
    const view = async () => {
      const [, x, y, zoom] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(await viewTransform(window))!.map(Number) as [number, number, number, number];
      return { x, y, zoom };
    };
    /** The pattern's own, from the variables it was given. */
    const pattern = () => backdrop.evaluate((element) => ['--backdrop-x', '--backdrop-y', '--backdrop-zoom'].map((name) => parseFloat(element.style.getPropertyValue(name))));
    const follows = async () => {
      const { x, y, zoom } = await view();
      await expect.poll(pattern).toEqual([x, y, zoom].map((value) => expect.closeTo(value, 2)));
    };

    await follows();
    // Pan with the Hand tool.
    const before = await view();
    await window.getByRole('button', { name: /^Hand/ }).click();
    const box = (await window.locator('.board').boundingBox())!;
    // From bare board, clear of the empty board's starter card in the middle.
    const [fromX, fromY] = [box.x + 200, box.y + box.height - 180];
    await window.mouse.move(fromX, fromY);
    await window.mouse.down();
    await window.mouse.move(fromX + 120, fromY + 60, { steps: 6 });
    await window.mouse.up();
    await expect.poll(async () => (await view()).x).toBeCloseTo(before.x + 120, 0);
    await follows();
    // Zoom in a step.
    await window.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await view()).zoom).toBeGreaterThan(before.zoom);
    await follows();
    // Far out, the pattern is left out; back in, it returns.
    await expect(async () => {
      await window.getByRole('button', { name: 'Zoom out' }).click();
      expect((await view()).zoom).toBeLessThan(0.3);
    }).toPass({ timeout: 15_000 });
    await expect(backdrop).toHaveCount(0);
    await expect(async () => {
      await window.getByRole('button', { name: 'Zoom in' }).click();
      expect((await view()).zoom).toBeGreaterThanOrEqual(0.3);
    }).toPass({ timeout: 15_000 });
    await expect(backdrop).toHaveCount(1);
    await follows();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
