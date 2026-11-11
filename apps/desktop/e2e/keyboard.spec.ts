import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile, windowKey } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Keyboard' });
const row = (page: Page, id: string) => sheet(page).locator(`[data-key="${id}"]`);
const here = (page: Page) => sheet(page).getByTestId('cheat-sheet-here');
/** What the board has saved under a view key: it saves a moment after a change, so a reload must wait for it. */
const saved = (page: Page, key: string) => page.evaluate((each) => globalThis.window.agentBoard.view.get(each), key);
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
    const settings = await openSettings(window, 'general.keyboard');
    const setting = settingsSection(settings, 'Keyboard').getByRole('switch', { name: 'Extended keyboard shortcuts' });
    await expect(setting).toBeChecked();
    await setting.uncheck();
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

    // Kept: a reload reads it back off. Once what it reads back is saved: the closed session window would otherwise come
    // back open, and its first click on the board's chrome only minimises it.
    await expect.poll(() => saved(window, 'windows')).toEqual([]);
    await expect.poll(() => saved(window, 'keyboard.extendedShortcuts')).toBe(false);
    await window.reload();
    await expect(tile(window)).toHaveCount(1);
    await expect(sessionWindow(window)).toHaveCount(0);
    const reopened = await openSettings(window, 'general.keyboard');
    const kept = settingsSection(reopened, 'Keyboard').getByRole('switch', { name: 'Extended keyboard shortcuts' });
    await expect(kept).not.toBeChecked();

    // Turned back on, ? works again.
    await kept.check();
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

/** Whether the focus is somewhere, by a test run in the page. */
const focusIn = (page: Page, selector: string) => page.evaluate((each) => document.activeElement?.closest(each) !== null && document.activeElement !== null, selector);
/** Whether the focus is on the board tile of the one agent: its node, which stays as its window or expanded tile goes. */
const onAgentTile = (page: Page) => page.evaluate(() => document.activeElement?.matches('.react-flow__node') === true && document.activeElement.querySelector('[data-testid="agent-tile"]') !== null);

test('⌘J leaves the terminal for the header, ↵ goes back, Esc there and ⌘Esc anywhere leave it for its tile, F6 steps regions; with the extended keys off, none do', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Way out');
    await expect(tile(window)).toHaveCount(1);
    const inTerminal = () => window.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true);
    const head = sessionWindow(window).locator('.session-window-head');

    // A session window: ⌘J to its header, ↵ back into the terminal.
    await tile(window).dblclick({ position: { x: 40, y: 70 } });
    await expect(sessionWindow(window)).toBeVisible();
    await expect.poll(inTerminal).toBe(true);
    await window.keyboard.press(windowKey('j'));
    await expect(head).toBeFocused();
    await window.keyboard.press('Enter');
    await expect.poll(inTerminal).toBe(true);
    // F6 to the next region, ⇧F6 back into the terminal.
    await window.keyboard.press('F6');
    await expect.poll(inTerminal).toBe(false);
    await expect.poll(() => focusIn(window, '.session-window')).toBe(true);
    await window.keyboard.press('Shift+F6');
    await expect.poll(inTerminal).toBe(true);
    // Esc in the terminal is the terminal's; from the header it minimises the window, the focus on its tile.
    await window.keyboard.press('Escape');
    await expect(sessionWindow(window)).toBeVisible();
    await window.keyboard.press(windowKey('j'));
    await window.keyboard.press('Escape');
    await expect(sessionWindow(window)).toBeHidden();
    await expect.poll(() => onAgentTile(window)).toBe(true);
    // ⌘Esc does it from the terminal.
    await window.getByTestId('dock-item').getByRole('button').first().click();
    await expect(sessionWindow(window)).toBeVisible();
    await sessionWindow(window).locator('.xterm').click();
    await expect.poll(inTerminal).toBe(true);
    await window.keyboard.press(windowKey('Escape'));
    await expect(sessionWindow(window)).toBeHidden();
    await expect.poll(() => onAgentTile(window)).toBe(true);
    await window.getByTestId('dock-item').getByRole('button').first().click();
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);

    // An expanded tile: ⌘J to its header, Esc collapses it, the focus on its tile.
    await setClickOpens(window, 'Expand in place');
    const expanded = window.getByTestId('expanded-tile');
    await tile(window).dblclick({ position: { x: 40, y: 70 } });
    await expect(expanded).toBeVisible();
    await expanded.locator('.xterm').click();
    await expect.poll(inTerminal).toBe(true);
    await window.keyboard.press(windowKey('j'));
    await expect(expanded.locator('.expanded-tile-head')).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(expanded).toHaveCount(0);
    await expect(tile(window)).toHaveCount(1);
    await expect.poll(() => onAgentTile(window)).toBe(true);

    // The setting off: as before, the terminal keeps ⌘J, F6 and ⌘Esc, and the tile stays expanded.
    const settings = await openSettings(window, 'general.keyboard');
    await settingsSection(settings, 'Keyboard').getByRole('switch', { name: 'Extended keyboard shortcuts' }).uncheck();
    await settings.close();
    await tile(window).dblclick({ position: { x: 40, y: 70 } });
    await expect(expanded).toBeVisible();
    await expanded.locator('.xterm').click();
    await expect.poll(inTerminal).toBe(true);
    for (const key of [windowKey('j'), 'F6', windowKey('Escape'), 'Escape']) await window.keyboard.press(key);
    await expect.poll(inTerminal).toBe(true);
    await expect(expanded).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a control mounts its tooltip when the pointer or the focus first comes, on the same button, and keeps its label', async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const button = window.getByRole('button', { name: 'Board menu' });
    const tooltip = window.locator('.ui-tooltip');
    await expect(button).toBeVisible();
    // Marks the button's element, to tell afterwards that waking its tooltip did not replace it.
    await button.evaluate((element: HTMLElement) => Object.assign(element, { wokenFrom: 'first' }));
    await expect(tooltip).toHaveCount(0);

    // The focus coming to it (as Tab does) shows the hint at once, and the focus stays on the same button.
    await button.evaluate((element: HTMLElement) => element.focus());
    await expect(tooltip).toHaveText(/Zones, agents and settings/);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-describedby', /.+/);
    await button.evaluate((element: HTMLElement) => element.blur());
    await expect(tooltip).toHaveCount(0);

    // The pointer resting on a button that was never focused or hovered shows it too.
    await window.mouse.move(700, 500);
    await button.hover();
    await expect(tooltip).toHaveText(/Zones, agents and settings/);

    await expect(button).toHaveAccessibleName('Board menu');
    expect(await button.evaluate((element: HTMLElement) => (element as HTMLElement & { wokenFrom?: string }).wokenFrom)).toBe('first');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Esc closes the board menu with the focus back on its button, whose tooltip stays shut over its open menu", async () => {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const button = window.getByRole('button', { name: 'Board menu' });
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    await button.dispatchEvent('click');
    await expect(menu).toBeVisible();
    // As the focus comes back to the button a moment after the menu last closed, by when it may be open again.
    await button.evaluate((element: HTMLElement) => element.focus());
    await expect(button).toBeFocused();
    await expect(window.locator('.ui-tooltip')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // Shut, the button's tooltip shows on focus as ever.
    await button.evaluate((element: HTMLElement) => element.blur());
    await button.evaluate((element: HTMLElement) => element.focus());
    await expect(window.locator('.ui-tooltip')).toHaveText(/Zones, agents and settings/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
