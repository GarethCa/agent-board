import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launch, sessionWindow, setClickOpens, SHELL_ENV } from './agent-helpers.ts';
import { pan } from './bench-helpers.ts';
import { run, settledBox } from './board-helpers.ts';
import { test, newShell, removeDataDir, tempDataDir } from './launch.ts';
import { openSettings } from './settings-helpers.ts';

/** The app's own renderer choice, where every other spec keeps to the DOM renderer to read the terminal's rows. */
const GPU_ENV = { ...SHELL_ENV, AGENT_BOARD_TERMINAL_RENDERER: 'auto' };

const xterm = (scope: Page | Locator) => scope.getByTestId('session-terminal').locator('.xterm');
const rows = (scope: Page | Locator) => scope.getByTestId('session-terminal').locator('.xterm-rows');

/** Loses the WebGL context of the terminal in `scope`, as a GPU reset or Chromium's cap on contexts does. */
const loseContext = (scope: Page | Locator) =>
  xterm(scope).evaluate((element) => {
    // The renderer's own canvas, not its link layer's (a 2D one, marked as a layer).
    const canvas = element.querySelector<HTMLCanvasElement>('.xterm-screen > canvas:not([class*="-layer"])')!;
    (canvas.getContext('webgl2') as WebGL2RenderingContext).getExtension('WEBGL_lose_context')!.loseContext();
  });

/**
 * Whether the terminal in `scope` is fitted to its pane for the renderer it draws with now, and the session sized to
 * match: its grid (the session's columns) neither runs past the pane nor stops more than two cells and a scrollbar short.
 * The two renderers size cells differently (the DOM one to the glyph's fractional width, WebGL to whole device pixels),
 * so a terminal fitted under one and drawn by the other is clipped or falls short.
 */
async function expectFitted(page: Page, scope: Page | Locator): Promise<void> {
  await expect
    .poll(async () => {
      const [session] = await page.evaluate(() => globalThis.window.agentBoard.sessions.list());
      const { inner, screen } = await scope.getByTestId('session-terminal').evaluate((pane) => {
        const style = getComputedStyle(pane);
        return {
          inner: pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          screen: (pane.querySelector('.xterm-screen') as HTMLElement).offsetWidth,
        };
      });
      const cell = screen / session!.cols;
      return inner - screen >= 0 && inner - screen < 2 * cell + 20 ? 'fitted' : `pane ${inner}, grid ${screen} (${session!.cols} columns)`;
    })
    .toBe('fitted');
}

test('a terminal draws with WebGL, and when its context is lost goes back to the DOM renderer at once, its text kept and still taking input', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, GPU_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'webgl');
    // The WebGL renderer draws no rows of text in the page.
    await expect(rows(window)).toHaveCount(0);
    await expectFitted(window, window);
    await window.getByTestId('session-terminal').click();
    await run(window, 'echo before-$((40 + 2))');

    await loseContext(window);
    // Not the addon's few seconds of waiting for the context to come back: the DOM renderer draws what was there.
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'dom', { timeout: 1_000 });
    await expect(rows(window)).toContainText('before-42');
    await expect(xterm(window).locator('canvas')).toHaveCount(0);
    // Refitted for the DOM renderer's wider cells: nothing clipped at the right.
    await expectFitted(window, window);

    await run(window, 'echo after-$((40 + 3))');
    await expect(rows(window)).toContainText('after-43');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('GPU-accelerated terminals, in Settings › Advanced › Terminals, turned off puts the open terminals on the DOM renderer, and on again back on WebGL', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, GPU_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByTestId('session-terminal').click();
    await run(window, 'echo kept-$((40 + 2))');
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'webgl');

    const settings = await openSettings(window, 'advanced.terminals');
    const gpu = settings.getByRole('switch', { name: 'GPU-accelerated terminals' });
    await expect(gpu).toBeChecked();
    await gpu.click();
    await expect(gpu).not.toBeChecked();
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'dom');
    // The same terminal, redrawn: nothing was rebuilt.
    await expect(rows(window)).toContainText('kept-42');
    await expectFitted(window, window);

    await gpu.click();
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'webgl');
    await expectFitted(window, window);
    expect(await window.evaluate(() => globalThis.window.agentBoard.view.get('gpuTerminals'))).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/** One channel of each pixel down a column of the board's window, at CSS `x`, from `top` to `bottom`, as Electron captures it. */
const column = (app: ElectronApplication, x: number, top: number, bottom: number): Promise<number[]> =>
  app.evaluate(async ({ BrowserWindow }, rect) => {
    // The board's window, not the Settings window a test may have opened.
    const board = BrowserWindow.getAllWindows().find((each) => !each.webContents.getURL().includes('settings='))!;
    const image = await board.webContents.capturePage(rect);
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    // Four bytes a pixel, the middle of each row of the capture.
    return Array.from({ length: height }, (_, y) => bitmap[(y * width + Math.floor(width / 2)) * 4]!);
  }, { x: Math.round(x), y: Math.round(top), width: 1, height: Math.round(bottom - top) });

/** The board's zoom, from its viewport's transform. */
const boardZoom = (page: Page) => page.locator('.react-flow__viewport').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);

test('a block of colour in an expanded tile at a zoom other than 100% has no lines between its rows, where the DOM renderer draws them', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, GPU_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.getByTestId('shell-tile').dblclick();
    const tile = window.getByTestId('expanded-tile');
    await expect(xterm(tile)).toHaveAttribute('data-renderer', 'webgl');
    await tile.getByTestId('session-terminal').click();
    // Claude's block for a message the user typed: 24-bit white on grey 55, six rows of it from the top.
    await run(window, "clear; for n in 1 2 3 4 5 6; do printf '\\033[48;2;55;55;55m\\033[38;2;255;255;255m %-60s\\033[0m\\n' \"row $n\"; done");
    for (let i = 0; i < 12 && (await boardZoom(window)) > 0.8; i++) {
      await window.getByRole('button', { name: 'Zoom Out' }).click();
      await settledBox(tile);
    }
    expect(await boardZoom(window)).toBeLessThan(0.95);

    /** Down a column inside the block, right of its text: from the middle of its first row to the middle of its fifth. */
    const blockColumn = async () => {
      const [session] = await window.evaluate(() => globalThis.window.agentBoard.sessions.list());
      const screen = (await tile.getByTestId('session-terminal').locator('.xterm-screen').boundingBox())!;
      const row = screen.height / session!.rows;
      return column(app, screen.x + (screen.width * 40) / session!.cols, screen.y + row / 2, screen.y + row * 4.5);
    };
    // The block's own grey (55), not the terminal's background: a blank canvas would be even too.
    await expect.poll(async () => [...new Set(await blockColumn())]).toEqual([55]);

    // The same block drawn by the DOM renderer has a darker line at every row's edge.
    const settings = await openSettings(window, 'advanced.terminals');
    await settings.getByRole('switch', { name: 'GPU-accelerated terminals' }).click();
    await expect(xterm(tile)).toHaveAttribute('data-renderer', 'dom');
    await expect.poll(async () => new Set(await blockColumn()).size).toBeGreaterThan(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('an expanded pane panned out of view and back comes back on WebGL, and its session keeps its size throughout', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, GPU_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.getByTestId('shell-tile').dblclick();
    const tile = window.getByTestId('expanded-tile');
    await expect(xterm(tile)).toHaveAttribute('data-renderer', 'webgl');
    await expectFitted(window, tile);
    const cols = async () => (await window.evaluate(() => globalThis.window.agentBoard.sessions.list()))[0]!.cols;
    const before = await cols();

    // Out of view, then back by as much. The board stops drawing a tile once it is out of view, so this mostly checks
    // the unmount and the remount; a terminal kept, out of view, is the pool's unit tests'.
    // Out of view: past the window's edge, or no longer drawn at all, as the board draws only what is in view.
    const outOfView = async () =>
      (await tile.count()) === 0 ||
      tile.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right < 0 || rect.left > globalThis.window.innerWidth;
      });
    let panned = 0;
    for (; panned < 40 && !(await outOfView()); panned++) await pan(window, 200, 0);
    expect(await outOfView()).toBe(true);
    // Still drawn, out of view, it keeps its context while the budget has room, so nothing refits.
    if ((await tile.count()) > 0) await expect(xterm(tile)).toHaveAttribute('data-renderer', 'webgl');
    expect(await cols()).toBe(before);
    for (let back = 0; back < panned; back++) await pan(window, -200, 0);
    await expect(xterm(tile)).toHaveAttribute('data-renderer', 'webgl');
    await expectFitted(window, tile);
    expect(await cols()).toBe(before);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
