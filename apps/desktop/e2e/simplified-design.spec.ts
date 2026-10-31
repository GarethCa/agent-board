import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { newShell, test, tempDataDir } from './launch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// Settings › Simplified design: off by default, and every open window switches at once when it is turned on or off,
// with no reload. Under it a theme pack waits, and the app's own theme shows in the pack's mode.

const design = (page: Page) => page.evaluate(() => document.documentElement.dataset.design ?? null);
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const desk = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** The font an open terminal draws its rows in: xterm's own option, which it doesn't take from CSS. */
const terminalFont = (page: Page) => page.getByTestId('session-terminal').first().evaluate((pane) => getComputedStyle(pane.querySelector('.xterm-rows')!).fontFamily);
/** Marks the page, so a later check can tell it was never reloaded: a reload loses the mark. */
const mark = (page: Page) => page.evaluate(() => Object.assign(globalThis, { simplifiedDesignMark: true }));
const marked = (page: Page) => page.evaluate(() => 'simplifiedDesignMark' in globalThis);

const CLASSIC_DESK = 'rgb(246, 244, 239)';
const SIMPLIFIED_DESK = 'rgb(243, 243, 245)';

test('turning on the Simplified design in Settings switches the board and a popped-out window at once, and turning it off brings Classic back', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const [popped] = await Promise.all([app.waitForEvent('window'), window.getByRole('button', { name: 'Pop out session window' }).click()]);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');

    // Classic leaves no mark on either window.
    expect(await design(window)).toBeNull();
    expect(await design(popped)).toBeNull();
    expect(await desk(window)).toBe(CLASSIC_DESK);
    expect(await terminalFont(popped)).toContain('JetBrains Mono');
    await mark(window);
    await mark(popped);

    const settings = await openSettings(window, 'general.design');
    const toggle = settingsSection(settings, 'Design').getByRole('switch', { name: 'Use the Simplified design' });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => design(window)).toBe('simplified');
    await expect.poll(() => design(popped)).toBe('simplified');
    expect(await desk(window)).toBe(SIMPLIFIED_DESK);
    // The open terminal follows too, under the app's own theme, where data-theme stays as it was.
    await expect.poll(() => terminalFont(popped)).toContain('SF Mono');

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => design(window)).toBeNull();
    await expect.poll(() => design(popped)).toBeNull();
    expect(await desk(window)).toBe(CLASSIC_DESK);
    await expect.poll(() => terminalFont(popped)).toContain('JetBrains Mono');
    expect(await marked(window)).toBe(true);
    expect(await marked(popped)).toBe(true);
  } finally {
    await app.close();
  }
});

test('opened in the Simplified design, a theme pack waits: the app’s own theme shows in its mode, and the pack is back under Classic', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { AGENT_BOARD_APPEARANCE: 'catppuccin-latte' }, [], { design: 'simplified' });
  try {
    expect(await design(window)).toBe('simplified');
    expect(await theme(window)).toBe('light');
    expect(await desk(window)).toBe(SIMPLIFIED_DESK);
    // The window opened on the Simplified desk too, so it never flashed the Classic one.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor())).toBe('#F3F3F5');

    await window.evaluate(() => globalThis.window.agentBoard.design.set('classic'));
    await expect.poll(() => theme(window)).toBe('catppuccin-latte');
    expect(await design(window)).toBeNull();
  } finally {
    await app.close();
  }
});

test('the Simplified empty board offers three starter cards that each do what Classic’s empty board does', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified' });
  try {
    const board = window.getByTestId('empty-board');
    await expect(board.getByRole('button')).toHaveText([/Add a repo zone/, /Group/, /New agent/]);

    // Add a repo zone opens Add zone on its GitHub tab.
    await board.getByRole('button', { name: /Add a repo zone/ }).click();
    const popover = window.getByRole('dialog', { name: 'Add zone' });
    await expect(popover.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // Group opens it on the Group tab.
    await board.getByRole('button', { name: /Group/ }).click();
    await expect(popover.getByRole('tab', { name: 'Group' })).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // New agent arms the toolbar's Agent tool, as its own button does.
    const agentTool = window.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name: 'New agent' });
    await expect(agentTool).toHaveAttribute('aria-pressed', 'false');
    await board.getByRole('button', { name: /New agent/ }).click();
    await expect(agentTool).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close();
  }
});
