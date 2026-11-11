import { expect, type ElectronApplication, type Locator } from '@playwright/test';
import { launch, sessionWindow, setClickOpens } from '../agent-helpers.ts';
import { canvasOnScreen, expectSharp, run, settledBox, zoomUntil } from '../board-helpers.ts';
import { newShell, removeDataDir, tempDataDir, test } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines } from './shared.ts';

test.use({ viewport: null });

// A shell expanded in place, drawn by each renderer, at 100% and zoomed in: what its text and a block of colour look
// like with the GPU (the default) and without it, side by side. Every other shot keeps to the DOM renderer and masks
// the terminal's text.
// The pinned render profile turns the GPU off, which leaves no WebGL: the WebGL shots keep the rest of it.
// The GPU rasterises the glyph atlas's text a little differently run to run (a few hundred pixels of a shot's edges),
// so the WebGL shots allow half a percent; a blank pane, a misfitted grid or seams between rows are far more.
const RENDERERS = [
  { renderer: 'webgl', env: 'auto', args: RENDER_ARGS.filter((arg) => arg !== '--disable-gpu'), match: { maxDiffPixelRatio: 0.005 } },
  { renderer: 'dom', env: 'dom', args: RENDER_ARGS, match: { maxDiffPixels: SHOT.maxDiffPixels } },
] as const;

/**
 * A shot of `terminal` (its top left, `size` if given), as the board's window last composited it. Playwright's own
 * captures, clipped or with animations stopped, catch the WebGL canvas cleared (it isn't kept between frames).
 */
async function shoot(app: ElectronApplication, terminal: Locator, size?: { width: number; height: number }): Promise<Buffer> {
  const box = (await terminal.boundingBox())!;
  const rect = { x: Math.round(Math.max(0, box.x)), y: Math.round(Math.max(0, box.y)), width: Math.round(size?.width ?? box.width), height: Math.round(size?.height ?? box.height) };
  const png = await app.evaluate(async ({ BrowserWindow }, area) => {
    const board = BrowserWindow.getAllWindows().find((each) => !each.webContents.getURL().includes('settings='))!;
    return (await board.webContents.capturePage(area)).toPNG().toString('base64');
  }, rect);
  return Buffer.from(png, 'base64');
}

/** The same render profile as the WebGL shots, but a window that paints as a Retina display does: the real ratio, not an emulated one. */
const RETINA_ARGS = RENDER_ARGS.filter((arg) => arg !== '--disable-gpu' && !arg.startsWith('--force-device-scale-factor'));

for (const { renderer, env, args, match } of RENDERERS) {
  test(`a shell expanded in place, its terminal drawn by the ${renderer} renderer, at 100% and zoomed in`, async () => {
    const shots = [`terminal-${renderer}`, `terminal-${renderer}-zoomed-in`];
    needsBaselines(...shots);
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', PS1: '$ ', AGENT_BOARD_TERMINAL_RENDERER: env }, args);
    try {
      await window.setViewportSize(VIEWPORT);
      await pinFonts(window);
      await setClickOpens(window, 'Expand in place');
      await newShell(window);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await window.getByTestId('shell-tile').dblclick();
      const tile = window.getByTestId('expanded-tile');
      const terminal = tile.getByTestId('session-terminal');
      await expect(terminal.locator('.xterm')).toHaveAttribute('data-renderer', renderer);
      await terminal.click();
      // A message block in 24-bit colour, as Claude draws one, then plain and coloured text; the cursor hidden, as it
      // blinks on the canvas, where Playwright's caret hiding can't reach it.
      await run(
        window,
        "clear; for n in 1 2 3; do printf '\\033[48;2;55;55;55m\\033[38;2;255;255;255m %-48s\\033[0m\\n' \"a message the user typed, row $n\"; done; " +
          "printf '\\n  plain text after it, and \\033[32mgreen\\033[0m, \\033[1mbold\\033[0m and \\033[31mred\\033[0m\\n\\033[?25l'",
      );
      await settledBox(tile);
      if (renderer === 'webgl') await expectSharp(terminal, { soft: true });
      let restorePointer = await ignorePointer(window);
      await settle(window);
      expect.soft(await shoot(app, terminal)).toMatchSnapshot(`${shots[0]}.png`, match);
      await restorePointer();

      await zoomUntil(window, tile, 'Zoom In', (zoom) => zoom > 1.4);
      if (renderer === 'webgl') await expectSharp(terminal, { soft: true });
      restorePointer = await ignorePointer(window);
      await settle(window);
      // The top left of the pane, where its text starts, at the board's zoom.
      expect.soft(await shoot(app, terminal, { width: 640, height: 220 })).toMatchSnapshot(`${shots[1]}.png`, match);
      await restorePointer();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

/** The width of `png`, and the red, green and blue of its device pixels at each point, or `off the window` for a point outside it. */
const pixelsOf = (app: ElectronApplication, png: Buffer, points: { x: number; y: number }[]) =>
  app.evaluate(({ nativeImage }, { data, points }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const colours = points.map(({ x, y }) => {
      const [px, py] = [Math.round(x), Math.round(y)];
      if (px < 0 || py < 0 || px >= width || py >= height) return 'off the window';
      const at = (py * width + px) * 4;
      return `${bitmap[at + 2]},${bitmap[at + 1]},${bitmap[at]}`;
    });
    return { width, colours };
  }, { data: png.toString('base64'), points });

// Cells hold whole device pixels, so a zoomed grid is a little narrower than its layout: its rows still have to reach as far as they do at 100%.
test('at a device pixel ratio of 2 rows coloured to the full width reach the right edge of the grid at every zoom, and the bottom edge stays the terminal background', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', PS1: '$ ', AGENT_BOARD_TERMINAL_RENDERER: 'auto', AGENT_BOARD_TEST_DEVICE_SCALE: '2' }, RETINA_ARGS);
  try {
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), VIEWPORT);
    await pinFonts(window);
    await setClickOpens(window, 'Expand in place');
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.getByTestId('shell-tile').dblclick();
    const tile = window.getByTestId('expanded-tile');
    const terminal = tile.getByTestId('session-terminal');
    await expect(terminal.locator('.xterm')).toHaveAttribute('data-renderer', 'webgl');
    await terminal.click();
    // Row 0 in 24-bit colour by an erase, as Claude draws a message; row 1 inverse to its last column, as a status bar is.
    await run(window, "clear; printf '\\033[48;2;55;55;55m\\033[K\\033[0m\\n'; printf '\\033[7m%*s\\033[0m\\n' $(tput cols) ''; printf '\\033[?25l'");
    await settledBox(tile);

    const layout = await terminal.locator('.xterm-screen').evaluate((screen) => ({ width: (screen as HTMLElement).offsetWidth, height: (screen as HTMLElement).offsetHeight }));
    const [sessionSize] = (await window.evaluate(() => globalThis.window.agentBoard.sessions.list())) as { cols: number; rows: number }[];
    // A zoomed-in pane can run past the window's bottom; the zooms that keep it inside must still check the bottom edge.
    let bottomsChecked = 0;
    const check = async (label: string) => {
      await expectSharp(terminal, { soft: true });
      const restore = await ignorePointer(window);
      await settle(window);
      const png = await shoot(app, terminal);
      const { zoom, box, now } = await terminal.locator('.xterm-screen').evaluate((screen) => {
        const element = screen as HTMLElement;
        const xterm = element.closest<HTMLElement>('.xterm')!;
        return {
          zoom: xterm.getBoundingClientRect().width / parseFloat(getComputedStyle(xterm).width),
          box: element.getBoundingClientRect().toJSON() as DOMRect,
          now: { width: element.offsetWidth, height: element.offsetHeight },
        };
      });
      expect.soft(now, `${label}: a zoom changes no layout`).toEqual(layout);
      const [session] = await window.evaluate(() => globalThis.window.agentBoard.sessions.list());
      expect.soft(session!.rows, `${label}: a zoom changes no rows`).toBe(sessionSize!.rows);
      expect.soft(session!.cols, `${label}: a zoom changes no columns`).toBe(sessionSize!.cols);
      const { pixels, dpr } = await canvasOnScreen(terminal);
      const rowHeight = pixels.height / session!.rows / dpr;
      const pane = (await terminal.boundingBox())!;
      const origin = { x: Math.round(Math.max(0, pane.x)), y: Math.round(Math.max(0, pane.y)) };
      const scale = (await pixelsOf(app, png, [])).width / Math.round(pane.width);
      const inPng = (x: number, y: number) => ({ x: (x - origin.x) * scale, y: (y - origin.y) * scale });
      const right = box.left + layout.width * zoom - 2 / scale;
      const bottom = box.top + layout.height * zoom - 2 / scale;
      const { colours } = await pixelsOf(app, png, [
        inPng(box.left + 40, box.top + rowHeight / 2),
        inPng(right, box.top + rowHeight / 2),
        inPng(box.left + 40, box.top + rowHeight * 1.5),
        inPng(right, box.top + rowHeight * 1.5),
        inPng(box.left + 40, box.top + rowHeight * 8),
        inPng(box.left + 40, bottom),
        // Away from the corners, where the pane's resize handle and the board's controls lie over it.
        inPng(box.left + (layout.width * zoom) / 2, bottom),
      ]);
      for (const at of [0, 1, 2, 3, 4]) expect(colours[at], `${label}: sample ${at} is inside the shot`).not.toBe('off the window');
      expect.soft(colours[0], `${label}: the coloured row is drawn`).toBe('55,55,55');
      expect.soft(colours[1], `${label}: the coloured row reaches the right edge`).toBe(colours[0]);
      expect.soft(colours[3], `${label}: the inverse row reaches the right edge`).toBe(colours[2]);
      for (const [at, name] of [[5, 'bottom edge'], [6, 'middle of the bottom edge']] as const) {
        if (colours[at] === 'off the window') continue;
        bottomsChecked++;
        expect.soft(colours[at], `${label}: the ${name} is the terminal's background`).toBe(colours[4]);
      }
      await restore();
    };

    await zoomUntil(window, tile, 'Zoom In', (zoom) => zoom > 1.4);
    await check('zoom 1.44');
    for (const below of [1.1, 0.9, 0.75, 0.6, 0.5]) {
      await zoomUntil(window, tile, 'Zoom Out', (zoom) => zoom < below);
      await check(`zoom under ${below}`);
    }
    expect(bottomsChecked, 'the bottom edge was inside the shot at some zoom').toBeGreaterThan(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

// A device pixel ratio of 2, and zooms either side of 100%: WebGL's text stays as sharp as at 100%, and so do the zooms where
// a cell is not a whole number of device pixels. A canvas stretched by the board's zoom shows here, as it doesn't at a ratio of 1.
test('a shell expanded in place, its terminal drawn by WebGL at a device pixel ratio of 2, at several zooms, and in the session window', async () => {
  const shots = ['terminal-webgl-dpr2-window', 'terminal-webgl-dpr2', 'terminal-webgl-dpr2-zoomed-in', 'terminal-webgl-dpr2-zoomed-out', 'terminal-webgl-dpr2-right-edge'];
  needsBaselines(...shots);
  const match = { maxDiffPixelRatio: 0.005 };
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0', PS1: '$ ', AGENT_BOARD_TERMINAL_RENDERER: 'auto', AGENT_BOARD_TEST_DEVICE_SCALE: '2' }, RETINA_ARGS);
  try {
    // Not setViewportSize, whose override puts the page back on a ratio of 1.
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), VIEWPORT);
    await pinFonts(window);
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const inWindow = window.getByTestId('session-terminal');
    await expect(inWindow.locator('.xterm')).toHaveAttribute('data-renderer', 'webgl');
    expect(await window.evaluate(() => devicePixelRatio)).toBe(2);
    await inWindow.click();
    await run(window, "clear; printf '\\033[48;2;55;55;55m\\033[38;2;255;255;255m %-48s\\033[K\\033[0m\\n' 'a message the user typed'; printf '\\n  plain text, \\033[32mgreen\\033[0m, \\033[1mbold\\033[0m and \\033[31mred\\033[0m\\n\\033[?25l'");
    await expectSharp(inWindow, { soft: true });
    const restorePointer = await ignorePointer(window);
    await settle(window);
    expect.soft(await shoot(app, inWindow, { width: 480, height: 100 })).toMatchSnapshot(`${shots[0]}.png`, match);
    await restorePointer();

    await window.getByRole('button', { name: 'Close session window' }).click();
    await setClickOpens(window, 'Expand in place');
    await window.getByTestId('shell-tile').dblclick();
    const tile = window.getByTestId('expanded-tile');
    const terminal = tile.getByTestId('session-terminal');
    await expect(terminal.locator('.xterm')).toHaveAttribute('data-renderer', 'webgl');
    await settledBox(tile);
    const shot = async (name: string) => {
      await expectSharp(terminal, { soft: true });
      const restore = await ignorePointer(window);
      await settle(window);
      expect.soft(await shoot(app, terminal, { width: 480, height: 100 })).toMatchSnapshot(`${name}.png`, match);
      await restore();
    };
    await shot(shots[1]!);
    await zoomUntil(window, tile, 'Zoom In', (zoom) => zoom > 1.4);
    await shot(shots[2]!);
    await zoomUntil(window, tile, 'Zoom Out', (zoom) => zoom < 0.7);
    await shot(shots[3]!);
    // The whole pane where rounding costs a ratio of 2 the most: what its right edge looks like beside a row coloured to its full width.
    await zoomUntil(window, tile, 'Zoom Out', (zoom) => zoom < 0.6);
    await expectSharp(terminal, { soft: true });
    const restore = await ignorePointer(window);
    await settle(window);
    expect.soft(await shoot(app, terminal)).toMatchSnapshot(`${shots[4]}.png`, match);
    await restore();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
