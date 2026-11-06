import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launch, sessionWindow, setClickOpens } from '../agent-helpers.ts';
import { run, settledBox } from '../board-helpers.ts';
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

const boardZoom = (window: Page) => window.locator('.react-flow__viewport').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);

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
      let restorePointer = await ignorePointer(window);
      await settle(window);
      expect.soft(await shoot(app, terminal)).toMatchSnapshot(`${shots[0]}.png`, match);
      await restorePointer();

      for (let i = 0; i < 12 && (await boardZoom(window)) < 1.4; i++) {
        await window.getByRole('button', { name: 'Zoom In' }).click();
        await settledBox(tile);
      }
      expect(await boardZoom(window)).toBeGreaterThan(1.4);
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
