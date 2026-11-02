import { expect } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { test, tempDataDir, removeDataDir } from './launch.ts';

// The board menu keeps Agents and shells closed behind its heading until it is opened, and Settings last.

test('the board menu starts with Agents and shells closed, search opens it, and the choice is remembered', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    const fold = menu.getByRole('button', { name: /^Agents and shells/ });
    const open = async () => {
      if (!(await menu.isVisible())) await window.getByRole('button', { name: 'Board menu' }).click();
      await expect(menu).toBeVisible();
    };
    await open();
    await expect(fold).toHaveText(/Agents and shells \(0\)/);
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByText('Nothing running')).toHaveCount(0);

    // Typing in the menu's search opens it to show what matches, without remembering that as the choice.
    const search = menu.getByRole('searchbox', { name: 'Find a zone or agent' });
    await search.fill('zzz');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByText('Nothing matches').or(menu.getByText('Nothing running'))).toBeVisible();
    await search.fill('');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');

    // Opening it is remembered across the menu closing and opening.
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await open();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');

    // Quick settings and Settings… come last, under the zones and the agents and shells.
    const y = async (name: RegExp | string, role: 'button' | 'region' = 'button') => (await menu.getByRole(role, { name }).first().boundingBox())!.y;
    expect(await y('Quick settings', 'region')).toBeGreaterThan(await y(/^Agents and shells/));
    expect(await y(/^Settings…/)).toBeGreaterThan(await y('Quick settings', 'region'));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
