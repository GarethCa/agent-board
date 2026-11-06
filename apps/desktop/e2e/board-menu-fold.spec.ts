import { expect } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { addEmptyZone, test, tempDataDir, removeDataDir } from './launch.ts';

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

    // Zones is the one section open on first use; Help and Quick settings start folded.
    await expect(menu.getByRole('button', { name: /^Zones/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button', { name: 'Help', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('button', { name: 'Quick settings' })).toHaveAttribute('aria-expanded', 'false');

    // A folded section stays folded after the menu is reopened, and an open one stays open; each is its own.
    const zones = menu.getByRole('button', { name: /^Zones/ });
    const help = menu.getByRole('button', { name: 'Help', exact: true });
    await zones.click();
    await help.click();
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await open();
    await expect(zones).toHaveAttribute('aria-expanded', 'false');
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button', { name: 'Quick settings' })).toHaveAttribute('aria-expanded', 'false');
    await help.click();
    await zones.click();

    // Quick settings and Settings… come last, under the zones and the agents and shells.
    const y = async (name: RegExp | string, role: 'button' | 'region' = 'button') => (await menu.getByRole(role, { name }).first().boundingBox())!.y;
    await menu.getByRole('button', { name: 'Quick settings' }).click();
    expect(await y('Quick settings', 'region')).toBeGreaterThan(await y(/^Agents and shells/));
    expect(await y(/^Settings…/)).toBeGreaterThan(await y('Quick settings', 'region'));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a search opens a folded Zones only while a zone matches, and never changes what was remembered', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    await addEmptyZone(window, 'alpha');
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    const zones = menu.getByRole('button', { name: /^Zones/ });
    const search = menu.getByRole('searchbox', { name: 'Find a zone or agent' });
    const open = async () => {
      if (!(await menu.isVisible())) await window.getByRole('button', { name: 'Board menu' }).click();
      await expect(menu).toBeVisible();
    };
    await open();
    await zones.click();
    await expect(zones).toHaveAttribute('aria-expanded', 'false');

    // A match opens it, and its row shows.
    await search.fill('alph');
    await expect(zones).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button', { name: /^alpha/ })).toBeVisible();
    // Clearing the search folds it again, as it was left; so does the menu closing and opening.
    await search.fill('');
    await expect(zones).toHaveAttribute('aria-expanded', 'false');
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await open();
    await expect(zones).toHaveAttribute('aria-expanded', 'false');

    // A search that matches no zone leaves it folded.
    await search.fill('zzz');
    await expect(zones).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
