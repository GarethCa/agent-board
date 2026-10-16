import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, SHELL_ENV, spawnAgent, tile, windowKey } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Keyboard' });
const row = (page: Page, id: string) => sheet(page).locator(`[data-key="${id}"]`);
const here = (page: Page) => sheet(page).getByTestId('cheat-sheet-here');
const sections = (page: Page) => sheet(page).locator('section').evaluateAll((all) => all.map((section) => section.getAttribute('aria-label')));

test('? opens the cheat sheet for where it is pressed, ⌘/ from a terminal, and with the extended keys off neither does', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Keys please');
    await expect(tile(window)).toHaveCount(1);

    // On the board, with nothing selected: the board's sections first, and the sheet's own keys listed.
    await window.locator('.react-flow__pane').click({ position: { x: 40, y: 500 } });
    await window.keyboard.press('?');
    await expect(sheet(window)).toBeVisible();
    await expect(here(window)).toHaveText('here: board');
    expect((await sections(window)).slice(0, 3)).toEqual(['Move around', 'Make', 'Edit']);
    await expect(row(window, 'move.cheatSheet')).toBeVisible();
    await expect(row(window, 'move.cheatSheetAnywhere')).toBeVisible();
    // Typing filters it; the board's single keys stay behind it.
    await window.keyboard.type('split');
    await expect(sheet(window).getByTestId('cheat-sheet-row')).toHaveCount(2);
    await expect(window.getByTestId('sticky')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(sheet(window)).toBeHidden();
    await expect(tile(window)).toHaveCount(1);

    // With the tile selected, the tile's keys come first; ? closes it again.
    await tile(window).click({ position: { x: 40, y: 70 } });
    await window.keyboard.press('?');
    await expect(here(window)).toHaveText('here: board · tile selected');
    expect((await sections(window))[0]).toBe('This tile');
    await window.keyboard.press('?');
    await expect(sheet(window)).toBeHidden();

    // From the session window's terminal, ⌘/ (the terminal keeps ?), and again to close.
    await tile(window).dblclick({ position: { x: 40, y: 70 } });
    await expect(sessionWindow(window)).toBeVisible();
    await expect.poll(() => window.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true);
    await window.keyboard.press(windowKey('/'));
    await expect(here(window)).toHaveText('here: session window');
    expect((await sections(window))[0]).toBe('In a session window');
    await window.keyboard.press(windowKey('/'));
    await expect(sheet(window)).toBeHidden();
    await expect(sessionWindow(window)).toBeVisible();
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);

    // The setting off: the new keys are gone, ? and ⌘/ open nothing, and the sheet (from its button) leaves them out.
    await window.getByRole('button', { name: 'Board menu' }).click();
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    const setting = menu.getByRole('switch', { name: 'Extended keyboard shortcuts' });
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await window.locator('.react-flow__pane').click({ position: { x: 40, y: 500 } });
    // Each new key is pressed, then H: the board takes H (the hand) only if nothing opened over it, so the sheet staying
    // shut is seen after the key was handled, not before.
    const hand = window.getByRole('button', { name: 'Hand', exact: true });
    for (const key of ['?', windowKey('/')]) {
      await window.keyboard.press(key);
      await window.keyboard.press('h');
      await expect(hand).toHaveAttribute('aria-pressed', 'true');
      await expect(sheet(window)).toHaveCount(0);
      await window.keyboard.press('v');
      await expect(hand).toHaveAttribute('aria-pressed', 'false');
    }
    await window.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(sheet(window)).toHaveCount(1);
    await expect(row(window, 'make.note')).toBeVisible();
    await expect(row(window, 'move.cheatSheet')).toHaveCount(0);
    await expect(row(window, 'move.cheatSheetAnywhere')).toHaveCount(0);
    await expect(sheet(window)).toContainText('Extended keyboard shortcuts are off');
    await window.keyboard.press('Escape');
    await expect(sheet(window)).toBeHidden();

    // Kept: a reload reads it back off.
    await window.reload();
    await window.getByRole('button', { name: 'Board menu' }).click();
    const kept = window.getByRole('dialog', { name: 'Board menu' }).getByRole('switch', { name: 'Extended keyboard shortcuts' });
    await expect(kept).not.toBeChecked();

    // Turned back on, ? works again.
    await kept.check();
    await window.keyboard.press('Escape');
    await window.locator('.react-flow__pane').click({ position: { x: 40, y: 500 } });
    await window.keyboard.press('?');
    await expect(sheet(window)).toBeVisible();
    await expect(row(window, 'move.cheatSheet')).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
