import { expect, type Locator, type Page } from '@playwright/test';
import { connectDaemon, type DaemonClient } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/** Runs `use` with a client of the daemon serving `dataDir`, closed after: to read what the daemon has stored. */
export async function withDaemon<T>(dataDir: string, use: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = await connectDaemon(daemonPaths(dataDir).socket);
  try {
    return await use(client);
  } finally {
    client.close();
  }
}

/** The element's box once it has stopped moving, e.g. after a viewport animation. */
export async function settledBox(locator: Locator): Promise<Box> {
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await locator.boundingBox());
      const settled = box === last;
      last = box;
      return settled;
    })
    .toBe(true);
  return JSON.parse(last);
}

export const centreOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Drags with the mouse from `from` to `to` in `steps` moves, holding the `hold` key (such as Shift) throughout if given. */
export async function drag(window: Page, from: Point, to: Point, { steps = 12, hold }: { steps?: number; hold?: string } = {}): Promise<void> {
  if (hold !== undefined) await window.keyboard.down(hold);
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(to.x, to.y, { steps });
  await window.mouse.up();
  if (hold !== undefined) await window.keyboard.up(hold);
}

/** Types a line into whatever has the keyboard, a terminal usually, and presses Enter. */
export async function run(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/**
 * Waits until `read` gives the same answer twice running, `every` ms apart: until what it reads (the view, the board's
 * layout) has stopped moving.
 */
export async function untilStill(read: () => Promise<string>, { every = 400, timeout }: { every?: number; timeout?: number } = {}): Promise<void> {
  let last: string | undefined;
  await expect
    .poll(
      async () => {
        const now = await read();
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [every], ...(timeout === undefined ? {} : { timeout }) },
    )
    .toBe(true);
}

/** The board's view, as React Flow transforms it: a pan or zoom changes it. */
export const viewTransform = (page: Page): Promise<string> =>
  page.locator('.react-flow__viewport').evaluate((viewport) => (viewport as HTMLElement).style.transform);

/**
 * Waits for the view to stop moving once tiles have expanded: it follows a tile that opened past the edge when its
 * opening time is over, so a click or a measure before then can land where the view is about to leave.
 */
export async function viewSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="expanded-tile"][data-opening]')).toHaveCount(0);
  await untilStill(() => viewTransform(page));
}

/** How the WebGL canvas in `terminal` lands on the screen's device pixels now. */
export const canvasOnScreen = (terminal: Locator) =>
  terminal.evaluate((pane) => {
    const canvas = pane.querySelector<HTMLCanvasElement>('.xterm-screen > canvas:not([class*="-layer"])')!;
    const box = pane.querySelector('.xterm-screen')!.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio;
    return { dpr, pixels: { width: canvas.width, height: canvas.height }, onScreen: { width: box.width * dpr, height: box.height * dpr }, corner: { x: box.left * dpr, y: box.top * dpr } };
  });

/**
 * `terminal` draws for the zoom on the screen it is on, its corner on a whole device pixel: each canvas pixel covers one
 * device pixel, or within an eighth of one where the zoomed cell is not a whole number of them (half a device pixel on a
 * cell of four or more). A terminal gets there a moment after the board comes to rest, so a shot of one waits for this
 * first.
 */
export async function expectSharp(terminal: Locator, { soft = false } = {}): Promise<void> {
  await expect
    .configure({ soft })
    .poll(async () => {
      const { pixels, onScreen, corner } = await canvasOnScreen(terminal);
      const stretch = Math.max(Math.abs(onScreen.width / pixels.width - 1), Math.abs(onScreen.height / pixels.height - 1));
      const offCorner = Math.max(Math.abs(corner.x - Math.round(corner.x)), Math.abs(corner.y - Math.round(corner.y)));
      return stretch <= 0.125 && offCorner < 0.05 ? 'sharp' : `canvas ${pixels.width}×${pixels.height}, on screen ${onScreen.width}×${onScreen.height} at ${corner.x}, ${corner.y}`;
    }, { timeout: 5_000 })
    .toBe('sharp');
}

/** The board's zoom, from its viewport's transform. */
export const boardZoom = (page: Page) => page.locator('.react-flow__viewport').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);

/** Zooms the board with its button until `done`, each click waiting for `tile` to stop moving. */
export async function zoomUntil(page: Page, tile: Locator, button: 'Zoom In' | 'Zoom Out', done: (zoom: number) => boolean): Promise<void> {
  for (let i = 0; i < 16 && !done(await boardZoom(page)); i++) {
    await page.getByRole('button', { name: button }).click();
    await settledBox(tile);
  }
  expect(done(await boardZoom(page))).toBe(true);
}

/** Turns on the board's tethers with the View popover's switch, as a user does: they are off by default. */
export async function showTethers(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'View', exact: true }).click();
  const view = page.getByRole('dialog', { name: 'View', exact: true });
  await view.getByRole('switch', { name: 'Tethers' }).check();
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
}

/**
 * The room a note's body has that its text leaves empty, as it is drawn: none, if the note is as tall as the text it
 * shows. Read with a line budget's cap lifted, as a body stops at that cap however much room it has.
 */
export const emptyFoot = (body: Locator) => (): Promise<number> =>
  body.evaluate((element: HTMLElement) => {
    element.style.maxHeight = 'none';
    const room = element.offsetHeight;
    element.style.maxHeight = '';
    element.style.flex = '0 0 auto';
    const own = element.offsetHeight;
    element.style.flex = '';
    return room - own;
  });
