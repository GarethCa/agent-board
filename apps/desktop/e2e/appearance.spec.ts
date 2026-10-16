import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { newShell, test, tempDataDir } from './launch.ts';

// Settings › Appearance (AO1): System, Light, Dark or a theme pack. Tests launch with
// AGENT_BOARD_APPEARANCE=light, the default when nothing was picked, so the developer's own macOS setting never shows
// through.

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const desk = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const themeSource = (app: ElectronApplication) => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);

/**
 * Launches on `dataDir` with the window's light or dark mode left to Electron, as Playwright pins it to light by
 * default, so the Appearance setting (nativeTheme.themeSource) reaches the page as it does outside tests.
 */
async function launchUnpinned(dataDir: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> {
  const launched = await launch(dataDir, env);
  await launched.window.emulateMedia({ colorScheme: null });
  return launched;
}

/**
 * The colours the terminal on `page` draws with, as xterm resolved them from the theme: its background (the block
 * cursor's text), its text, and two of its ANSI colours, read from spans with xterm's own classes in its rows.
 */
function terminalColours(page: Page) {
  return page.getByTestId('session-terminal').evaluate((pane) => {
    const rows = pane.querySelector('.xterm-rows')!;
    const probe = (className: string, property: 'color' | 'backgroundColor') => {
      const span = document.createElement('span');
      span.className = className;
      rows.append(span);
      const value = getComputedStyle(span)[property];
      span.remove();
      return value;
    };
    return {
      background: probe('xterm-cursor xterm-cursor-block', 'color'),
      text: getComputedStyle(rows).color,
      red: probe('xterm-fg-1', 'color'),
      brightBlack: probe('xterm-fg-8', 'color'),
    };
  });
}

const LIGHT_TERMINAL = { background: 'rgb(27, 26, 24)', text: 'rgb(230, 225, 214)', red: 'rgb(204, 0, 0)', brightBlack: 'rgb(85, 87, 83)' };
const DARK_TERMINAL = { background: 'rgb(18, 17, 16)', text: 'rgb(230, 225, 214)', red: 'rgb(224, 108, 108)', brightBlack: 'rgb(138, 132, 120)' };
/** Catppuccin Latte's: a light pack keeps its dark sibling's (Mocha's) well and palette, its bright black lifted to AA. */
const LATTE_TERMINAL = { background: 'rgb(17, 17, 27)', text: 'rgb(205, 214, 244)', red: 'rgb(243, 139, 168)', brightBlack: 'rgb(121, 124, 141)' };

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Board menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Board menu' })).toBeVisible();
}

test('picks Dark, Light or System in Settings, the window follows at once, and the pick outlives a restart', async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launchUnpinned(dataDir);
  try {
    await expect.poll(() => theme(window)).toBe('light');
    expect(await desk(window)).toBe('rgb(246, 244, 239)');

    await openSettings(window);
    const picker = window.getByRole('radiogroup', { name: 'Theme' });
    await expect(picker.getByRole('radio', { name: 'Light' })).toBeChecked();
    await picker.getByRole('radio', { name: 'Dark' }).check();
    await expect.poll(() => theme(window)).toBe('dark');
    expect(await desk(window)).toBe('rgb(27, 26, 25)');
    expect(await themeSource(app)).toBe('dark');
    await expect(window.getByText('Dark whatever macOS is set to.')).toBeVisible();

    // System follows macOS, live: here the window's own light or dark mode, emulated.
    await picker.getByRole('radio', { name: /System/ }).check();
    await expect.poll(() => themeSource(app)).toBe('system');
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(window)).toBe('dark');
    await expect(window.getByText('System follows macOS, which is dark right now.')).toBeVisible();
    await window.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(window)).toBe('light');
    await expect(window.getByText('System follows macOS, which is light right now.')).toBeVisible();
    await window.emulateMedia({ colorScheme: null });

    // Dark, kept: the next launch opens in it, before the daemon has answered anything.
    await picker.getByRole('radio', { name: 'Dark' }).check();
    await expect.poll(() => theme(window)).toBe('dark');
    await app.close();
    ({ app, window } = await launchUnpinned(dataDir));
    await expect.poll(() => theme(window)).toBe('dark');
    // The window itself opened on the dark desk, so it never flashed the light one before the page painted.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor())).toBe('#1B1A19');
    await openSettings(window);
    await expect(window.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' })).toBeChecked();
  } finally {
    await app.close();
  }
});

test('picks a theme pack in Settings, under its family and credit, and the window, its mode and its mark follow', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launchUnpinned(dataDir);
  try {
    await expect.poll(() => theme(window)).toBe('light');
    await openSettings(window);
    const catppuccin = window.getByRole('radiogroup', { name: 'Catppuccin' });
    await expect(window.getByText('Catppuccin · MIT · github.com/catppuccin/catppuccin')).toBeVisible();
    await expect(catppuccin.getByRole('radio')).toHaveCount(4);
    await catppuccin.getByRole('radio', { name: /Catppuccin Mocha/ }).check();
    await expect.poll(() => theme(window)).toBe('catppuccin-mocha');
    expect(await desk(window)).toBe('rgb(24, 24, 37)');
    expect(await themeSource(app)).toBe('dark');
    await expect(window.getByText('Catppuccin Mocha whatever macOS is set to.')).toBeVisible();
    await expect(window.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' })).not.toBeChecked();
    // Every dark theme takes the mark's dark colourway, not only the app's own.
    await expect(window.getByTestId('board-menu').getByTestId('brand-mark').locator('.brand-mark-dark')).toBeVisible();

    // Each family is a radio group of its own: Tab reaches it, and its arrow keys stay within it.
    await catppuccin.getByRole('radio', { name: /Catppuccin Mocha/ }).focus();
    await window.keyboard.press('ArrowUp');
    await expect(catppuccin.getByRole('radio', { name: /Catppuccin Macchiato/ })).toBeFocused();
    await expect.poll(() => theme(window)).toBe('catppuccin-macchiato');
    await window.keyboard.press('Tab');
    await expect(window.getByRole('radiogroup', { name: 'Rosé Pine' }).getByRole('radio').first()).toBeFocused();
    await expect.poll(() => theme(window)).toBe('catppuccin-macchiato');

    // A light pack puts the windows in light mode.
    await window.getByRole('radiogroup', { name: 'Rosé Pine' }).getByRole('radio', { name: /Rosé Pine Dawn/ }).check();
    await expect.poll(() => theme(window)).toBe('rose-pine-dawn');
    expect(await themeSource(app)).toBe('light');
    await expect(window.getByTestId('board-menu').getByTestId('brand-mark').locator('.brand-mark-light')).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the terminal takes the theme's well and palette, live, and a popped-out window follows a pick made on the board", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launchUnpinned(dataDir, SHELL_ENV);
  const pick = (appearance: 'light' | 'dark' | 'catppuccin-latte') =>
    window.evaluate((value) => globalThis.window.agentBoard.appearance.set(value), appearance);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect.poll(() => terminalColours(window)).toEqual(LIGHT_TERMINAL);

    await pick('dark');
    await expect.poll(() => theme(window)).toBe('dark');
    await expect.poll(() => terminalColours(window)).toEqual(DARK_TERMINAL);

    // A light theme pack's terminal is still dark: its dark sibling's well and palette.
    await pick('catppuccin-latte');
    await expect.poll(() => terminalColours(window)).toEqual(LATTE_TERMINAL);
    await pick('dark');

    // Popped out, it opens in the theme picked, and follows the next pick, made in the board's window.
    const [popped] = await Promise.all([app.waitForEvent('window'), window.getByRole('button', { name: 'Pop out session window' }).click()]);
    await popped.emulateMedia({ colorScheme: null });
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    await expect.poll(() => theme(popped)).toBe('dark');
    await expect.poll(() => terminalColours(popped)).toEqual(DARK_TERMINAL);
    await pick('light');
    await expect.poll(() => theme(popped)).toBe('light');
    await expect.poll(() => terminalColours(popped)).toEqual(LIGHT_TERMINAL);
    await expect.poll(() => theme(window)).toBe('light');
  } finally {
    await app.close();
  }
});

test("the board menu shows the app's mark, in the dark colourway in the dark theme, and the empty board its plain mark", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launchUnpinned(dataDir);
  const pick = (appearance: 'light' | 'dark') => window.evaluate((value) => globalThis.window.agentBoard.appearance.set(value), appearance);
  /** Whether `img` is shown and its file loaded (the page's CSP refuses anything but the app's own files). */
  const loaded = (img: Locator) => img.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0);
  const mark = window.getByTestId('board-menu').getByTestId('brand-mark');
  try {
    await expect(mark.locator('.brand-mark-light')).toBeVisible();
    await expect(mark.locator('.brand-mark-dark')).toBeHidden();
    await expect.poll(() => loaded(mark.locator('.brand-mark-light'))).toBe(true);
    expect(await mark.boundingBox()).toMatchObject({ width: 30, height: 30 });
    const plain = window.getByTestId('empty-board').locator('img.brand-mark');
    await expect(plain).toBeVisible();
    await expect.poll(() => loaded(plain)).toBe(true);

    await pick('dark');
    await expect(mark.locator('.brand-mark-dark')).toBeVisible();
    await expect(mark.locator('.brand-mark-light')).toBeHidden();
    await expect.poll(() => loaded(mark.locator('.brand-mark-dark'))).toBe(true);
  } finally {
    await app.close();
  }
});
