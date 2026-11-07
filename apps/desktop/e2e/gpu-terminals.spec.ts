import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launch, sessionWindow, setClickOpens, SHELL_ENV } from './agent-helpers.ts';
import { pan } from './bench-helpers.ts';
import { boardZoom, canvasOnScreen, expectSharp, run, settledBox, viewSettled, zoomUntil } from './board-helpers.ts';
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

/** A window that paints as a Retina display does, with the app's own renderer choice. */
const RETINA_ENV = { ...GPU_ENV, AGENT_BOARD_TEST_DEVICE_SCALE: '2' };

/** A shell tile expanded in place, drawing with WebGL. */
async function expandedShell(window: Page): Promise<Locator> {
  await setClickOpens(window, 'Expand in place');
  await newShell(window);
  await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
  await window.getByRole('button', { name: 'Close session window' }).click();
  await window.getByTestId('shell-tile').dblclick();
  const tile = window.getByTestId('expanded-tile');
  await expect(xterm(tile)).toHaveAttribute('data-renderer', 'webgl');
  return tile;
}

test('at a device pixel ratio of 2 an expanded terminal draws one canvas pixel to a device pixel at every zoom, and the zoom never resizes its session', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    const tile = await expandedShell(window);
    const terminal = tile.getByTestId('session-terminal');
    expect((await canvasOnScreen(terminal)).dpr).toBe(2);
    await expectSharp(terminal);
    const size = async () => {
      const [session] = await window.evaluate(() => globalThis.window.agentBoard.sessions.list());
      return { cols: session!.cols, rows: session!.rows };
    };
    const before = await size();
    const drawnAt100 = (await canvasOnScreen(terminal)).pixels.width;

    await zoomUntil(window, tile, 'Zoom In', (zoom) => zoom > 1.4);
    await expectSharp(terminal);
    // More pixels, not the same ones stretched.
    expect((await canvasOnScreen(terminal)).pixels.width).toBeGreaterThan(drawnAt100 * 1.3);
    await expectFitted(window, tile);

    await zoomUntil(window, tile, 'Zoom Out', (zoom) => zoom < 0.7);
    await expectSharp(terminal);
    expect((await canvasOnScreen(terminal)).pixels.width).toBeLessThan(drawnAt100 * 0.75);
    await expectFitted(window, tile);

    // Panned to wherever the corner lands, it moves back onto a whole device pixel with no redraw needed.
    await pan(window, 33, 17);
    await settledBox(tile);
    await expectSharp(terminal);
    expect(await size()).toEqual(before);

    // On the DOM renderer it gives all of that back, and draws at the zoom by itself.
    const settings = await openSettings(window, 'advanced.terminals');
    await settings.getByRole('switch', { name: 'GPU-accelerated terminals' }).click();
    await expect(xterm(tile)).toHaveAttribute('data-renderer', 'dom');
    expect(await terminal.locator('.xterm-screen').evaluate((screen: HTMLElement) => screen.style.transform)).toBe('');
    await expectFitted(window, tile);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('at a device pixel ratio of 2 a terminal of an odd number of columns has no canvas a pixel wider than its grid, in the session window', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'webgl');
    const terminal = window.getByTestId('session-terminal');
    const parities = new Set<number>();
    const columns = async () => (await window.evaluate(() => globalThis.window.agentBoard.sessions.list()))[0]!.cols;
    // Two window widths a column apart, so one has an odd number of columns: half of an odd canvas width rounds to a whole CSS pixel.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
    await expectFitted(window, window);
    for (const step of [0, 8]) {
      const before = await columns();
      if (step > 0) {
        await app.evaluate(({ BrowserWindow }, content) => BrowserWindow.getAllWindows()[0]!.setContentSize(content, 800), 1280 + step);
        await expect.poll(columns).toBe(before + 1);
      }
      await expectFitted(window, window);
      await expectSharp(terminal);
      const { pixels } = await canvasOnScreen(terminal);
      // A whole number of pixels in each cell: no pixel added to fit the CSS size.
      expect(pixels.width % (await columns())).toBe(0);
      parities.add((await columns()) % 2);
    }
    expect(parities).toEqual(new Set([0, 1]));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('dragging across a word in a WebGL terminal selects exactly that word, zoomed in and out, as its cells are whole device pixels', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    const tile = await expandedShell(window);
    const terminal = tile.getByTestId('session-terminal');
    await terminal.click();
    // Far enough along the row that a grid drawn short of its layout would miss the word if the mapping ignored it.
    await run(window, "clear; printf '%61s%s\\n' '' target-word");

    const selectAt = async () => {
      await settledBox(tile);
      await expectSharp(terminal);
      const [session] = await window.evaluate(() => globalThis.window.agentBoard.sessions.list());
      const screen = (await terminal.locator('.xterm-screen').boundingBox())!;
      const cell = { width: screen.width / session!.cols, height: screen.height / session!.rows };
      const y = screen.y + cell.height / 2;
      await window.mouse.move(screen.x + cell.width * 61.25, y);
      await window.mouse.down();
      await window.mouse.move(screen.x + cell.width * 66, y, { steps: 5 });
      await window.mouse.move(screen.x + cell.width * 71.75, y, { steps: 5 });
      await window.mouse.up();
      return terminal.locator('.xterm').evaluate((element) => {
        const data = new DataTransfer();
        element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, cancelable: true, bubbles: true }));
        return data.getData('text/plain');
      });
    };

    await zoomUntil(window, tile, 'Zoom In', (zoom) => zoom > 1.1);
    expect(await selectAt()).toBe('target-word');
    await zoomUntil(window, tile, 'Zoom Out', (zoom) => zoom < 0.7);
    expect(await selectAt()).toBe('target-word');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('at a device pixel ratio of 2 split panes of a fractional width keep their cells at 100% and stay sharp', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const whole = window.getByTestId('session-terminal');
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'webgl');
    await expectSharp(whole);
    const cell = async (terminal: Locator) => {
      const [session] = await window.evaluate(() => globalThis.window.agentBoard.sessions.list());
      return (await canvasOnScreen(terminal)).pixels.height / session!.rows;
    };
    const unsplit = await cell(whole);
    await window.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Split horizontally' }).click();
    const panes = window.getByTestId('shell-pane');
    await expect(panes).toHaveCount(2);
    // Half of an odd width is a fractional pane: a window a pixel wider gives one if this one doesn't.
    let fractional = false;
    for (const width of [1281, 1282]) {
      const used = () => panes.first().locator('.xterm').evaluate((element) => parseFloat(getComputedStyle(element).width));
      const before = await used();
      await app.evaluate(({ BrowserWindow }, content) => BrowserWindow.getAllWindows()[0]!.setContentSize(content, 800), width);
      await expect.poll(used).not.toBe(before);
      if ((await used()) % 1 === 0) continue;
      fractional = true;
      for (const pane of [panes.first(), panes.nth(1)]) {
        const terminal = pane.getByTestId('session-terminal');
        await expectSharp(terminal);
        // The same cells as the unsplit pane, at 100%.
        expect(await cell(terminal)).toBe(unsplit);
      }
      break;
    }
    expect(fractional).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('at a device pixel ratio of 2 a session window opening draws once, not for the passing scale of its animation', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    await window.evaluate(() => {
      (globalThis as unknown as { rasters: number }).rasters = 0;
      new PerformanceObserver((list) => {
        (globalThis as unknown as { rasters: number }).rasters += list.getEntriesByName('terminal.raster').length;
      }).observe({ type: 'measure' });
    });
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(xterm(window)).toHaveAttribute('data-renderer', 'webgl');
    await expectSharp(window.getByTestId('session-terminal'));
    await window.waitForTimeout(400);
    expect(await window.evaluate(() => (globalThis as unknown as { rasters: number }).rasters)).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('at a device pixel ratio of 2 a zoomed tile moved with no pan, zoom or drag goes back onto the device pixels', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    const tile = await expandedShell(window);
    const terminal = tile.getByTestId('session-terminal');
    await zoomUntil(window, tile, 'Zoom Out', (zoom) => zoom < 0.7);
    await expectSharp(terminal);
    // What an arrange or an undo does to the tile's node, to a place that lands off the device pixels.
    await tile.evaluate((element) => {
      const node = element.closest<HTMLElement>('.react-flow__node')!;
      node.style.transform = `${node.style.transform} translate(0.37px, 0.61px)`;
    });
    await expectSharp(terminal);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('at a device pixel ratio of 2 a tile unmounted out of view, the board zoomed, and remounted by panning back draws for the new zoom', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, RETINA_ENV);
  try {
    const tile = await expandedShell(window);
    await expectSharp(tile.getByTestId('session-terminal'));
    const outOfView = async () =>
      (await tile.count()) === 0 ||
      tile.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right < 0 || rect.left > globalThis.window.innerWidth;
      });
    let panned = 0;
    for (; panned < 40 && !(await outOfView()); panned++) await pan(window, 200, 0);
    expect(await outOfView()).toBe(true);
    await window.getByRole('button', { name: 'Zoom In' }).click();
    await viewSettled(window);
    for (let back = 0; back < 60 && (await outOfView()); back++) await pan(window, -200, 0);
    await expect(tile).toBeVisible();
    await settledBox(tile);
    expect(await boardZoom(window)).toBeGreaterThan(1.1);
    await expectSharp(tile.getByTestId('session-terminal'));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
