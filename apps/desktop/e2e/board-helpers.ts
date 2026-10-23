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
