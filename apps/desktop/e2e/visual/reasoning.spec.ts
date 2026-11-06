import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, listFinishedTurns, pickInChip, spawnAgent, tile, TURN_MS, zoneControl, zoneNamed } from '../agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, needsBaselines, THEMES } from './shared.ts';

test.use({ viewport: null });

// A reasoning effort where it is picked: New agent's Reasoning chip with a level, and a running agent's ⋯ › Reasoning,
// its levels saying what the outer ones cost. Its badges on tiles are in the tile gallery's shots.
test('the Reasoning chip with a level picked, and a running agent’s Reasoning submenu', async () => {
  needsBaselines('new-agent-reasoning', 'agent-menu-reasoning');
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  await listFinishedTurns(window);
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'New agent' }).click();
    const form = window.getByRole('dialog', { name: 'New agent' });
    await expect(form.getByRole('button', { name: 'Reasoning: Default' })).toHaveText('Reasoning');
    await pickInChip(form, 'Reasoning', 'High');
    await expect(form.getByRole('button', { name: 'Reasoning: High' })).toHaveText('High reasoning');
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(form).toHaveScreenshot('new-agent-reasoning.png', SHOT);
    await restorePointer();
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toBeHidden();

    await tile(window).getByRole('button', { name: 'More' }).click();
    await window.getByRole('menuitem', { name: /^Reasoning/ }).focus();
    await window.keyboard.press('ArrowRight');
    await expect(window.getByRole('menuitem', { name: /^Max/ })).toBeVisible();
    await pinRandomText(window);
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('body')).toHaveScreenshot('agent-menu-reasoning.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Under the Simplified design the chip is a technical detail: New agent's sheet with Show technical details on.
for (const { theme, suffix } of THEMES) {
  const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
  test(`New agent's chips as a Simplified sheet with technical details, ${theme}`, async () => {
    needsBaselines(`simplified-new-agent-technical${suffix}`);
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { design: 'simplified', technical: true });
    try {
      await window.setViewportSize(VIEWPORT);
      await window.emulateMedia({ colorScheme: theme });
      await pinFonts(window);
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await zoneControl(window, 'monorepo', 'New agent', 'New agent');
      const form = window.getByRole('dialog', { name: 'New agent' });
      await pickInChip(form, 'Reasoning', 'Extra high');
      await pinRandomText(window);
      const restorePointer = await ignorePointer(window);
      await settle(window);
      await expect.soft(form).toHaveScreenshot(`simplified-new-agent-technical${suffix}.png`, SHOT);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
