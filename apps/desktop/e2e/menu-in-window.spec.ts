import { expect, type Locator, type Page } from '@playwright/test';
import { launch, SHELL_ENV } from './agent-helpers.ts';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { addEmptyZone, removeDataDir, tempDataDir, test } from './launch.ts';

// A zone's ⋯ opens wholly inside the window wherever the zone is, its menu drags by its head and never out of the
// window or under the traffic lights, and stays inside as the window shrinks or the board pans.

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/** The gap a menu keeps from the window's edges (ui/placement.ts). */
const EDGE = 8;

const SIZE = { width: 1100, height: 720 };

/** Moves the zone named `name` so its ⋯ sits at `at` on screen, by its stored place. */
async function putOptionsAt(page: Page, name: string, options: Locator, at: Point): Promise<void> {
  const now = centreOf(await settledBox(options));
  const scale = await page.locator('.react-flow__viewport').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
  await page.evaluate(
    async ({ name, by }) => {
      const zone = (await window.agentBoard.zones.list()).find((one) => one.name === name)!;
      await window.agentBoard.zones.update(zone.id, { x: zone.x + by.x, y: zone.y + by.y, width: zone.width, height: zone.height });
    },
    { name, by: { x: Math.round((at.x - now.x) / scale), y: Math.round((at.y - now.y) / scale) } },
  );
  await expect.poll(async () => distance(centreOf(await settledBox(options)), at)).toBeLessThan(4);
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The corner kept clear round the traffic lights, read as the app reads it: undefined where there are none. */
async function lightsZone(page: Page): Promise<{ right: number; bottom: number } | undefined> {
  const zone = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { right: Number.parseFloat(style.getPropertyValue('--traffic-lights-right')), bottom: Number.parseFloat(style.getPropertyValue('--traffic-lights-bottom')) };
  });
  return zone.right > 0 && zone.bottom > 0 ? zone : undefined;
}

/** Fails unless `box` is wholly inside the window, `EDGE` px in, and clear of the traffic lights where they are drawn. */
async function expectInside(page: Page, box: Box, what: string): Promise<void> {
  await expect(page.getByRole('menu'), `${what}: still open`).toBeVisible();
  const { width, height } = page.viewportSize()!;
  expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(EDGE - 1);
  expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(EDGE - 1);
  expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(width - EDGE + 1);
  expect(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(height - EDGE + 1);
  const lights = await lightsZone(page);
  if (lights !== undefined) expect(box.x >= lights.right - 1 || box.y >= lights.bottom - 1, `${what}: clear of the traffic lights`).toBe(true);
}

test("a zone's menu opens inside the window at its edges, drags by its head and stays inside", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await window.setViewportSize(SIZE);
    await addEmptyZone(window, 'Edge');
    const options = window.getByRole('button', { name: /^(Zone|Project) options$/ });
    const menu = window.getByRole('menu');

    // At every edge, the bottom-right corner and in the top-left beside the traffic lights, its menu opens wholly
    // inside and clear of them.
    const places: Array<[string, Point]> = [
      ['top-left corner, beside the traffic lights', { x: 40, y: 14 }],
      ['top edge', { x: SIZE.width / 2, y: 14 }],
      ['right edge', { x: SIZE.width - 14, y: SIZE.height / 2 }],
      ['bottom edge', { x: SIZE.width / 2, y: SIZE.height - 14 }],
      ['bottom-right corner', { x: SIZE.width - 14, y: SIZE.height - 14 }],
      // Its tab cut by the window's edge, ⋯ half out of sight.
      ['right edge, half past it', { x: SIZE.width - 4, y: SIZE.height / 3 }],
      ['bottom edge, half past it', { x: SIZE.width / 3, y: SIZE.height - 4 }],
    ];
    for (const [where, at] of places) {
      await window.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await putOptionsAt(window, 'Edge', options, at);
      // By the keys, as along the top the toolbar's islands lie over the button.
      await options.focus();
      await window.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      await expectInside(window, await settledBox(menu), `opened at the ${where}`);
    }

    // Left where it opened as its button goes up out of the window, it stays inside.
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await putOptionsAt(window, 'Edge', options, { x: 400, y: 260 });
    await options.click();
    await expect(menu).toBeVisible();
    await putOptionsAt(window, 'Edge', options, { x: 400, y: -40 });
    await expectInside(window, await settledBox(menu), 'its button gone out of the top');
    await putOptionsAt(window, 'Edge', options, { x: 400, y: 260 });

    // Dragged by its head, it moves; dragged far past the window's corner, it stops inside it.
    const head = menu.locator('.ui-menu-head');
    await expect(head).toHaveText('Edge');
    const before = await settledBox(menu);
    const grip = centreOf(await settledBox(head));
    await drag(window, grip, { x: grip.x - 300, y: grip.y });
    const moved = await settledBox(menu);
    expect(Math.round(moved.x - before.x)).toBe(-300);
    expect(Math.round(moved.y - before.y)).toBe(0);
    await expectInside(window, moved, 'dragged left');

    let from = centreOf(await settledBox(head));
    await drag(window, from, { x: SIZE.width - 2, y: SIZE.height - 2 });
    await expectInside(window, await settledBox(menu), 'dragged past the bottom-right corner');

    from = centreOf(await settledBox(head));
    await drag(window, from, { x: 2, y: 2 });
    await expectInside(window, await settledBox(menu), 'dragged past the top-left corner');
    await expect(menu, 'a drag is not a click outside').toBeVisible();

    // Its zone moves back into the middle (a zone wholly out of sight is not drawn, and its menu closes with it), and
    // the window shrinks under the dragged menu: it is fitted in again.
    await putOptionsAt(window, 'Edge', options, { x: 400, y: 260 });
    from = centreOf(await settledBox(head));
    await drag(window, from, { x: SIZE.width - 20, y: SIZE.height - 20 });
    await window.setViewportSize({ width: 860, height: 560 });
    await expectInside(window, await settledBox(menu), 'after the window shrank');

    // The board pans under it: it stays inside.
    await window.mouse.move(200, 300);
    await window.mouse.wheel(150, 100);
    await expectInside(window, await settledBox(menu), 'after the board panned');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
