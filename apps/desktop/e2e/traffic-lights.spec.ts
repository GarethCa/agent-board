import { expect, type Page } from '@playwright/test';
import { launch, SHELL_ENV, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { test, browseForZone, newShell, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';
import { SAFE_MARGIN, trafficLightsBox, type ChromeFor } from '../src/shared/traffic-lights.ts';

/** The macOS traffic lights' box over the board (shared/traffic-lights.ts). Off macOS the OS frame has them. */
const LIGHTS = trafficLightsBox('board');

const headerBox = async (page: Page) => (await sessionWindow(page).locator('header').first().boundingBox())!;

/** Drags the session window's top edge up past the board's top, restoring it first so it can be resized. */
async function dragTopEdgeToTop(page: Page): Promise<void> {
  const box = (await sessionWindow(page).locator('[data-edge="n"]').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, -200, { steps: 8 });
  await page.mouse.up();
}

test('on macOS a session window never reaches under the traffic lights, windowed, and may once full screen hides them', async () => {
  test.skip(process.platform !== 'darwin', 'the traffic lights float over the page on macOS only');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(window.locator('html')).toHaveAttribute('data-chrome', 'inset');

    // Maximised, and resized up to the top edge: its header's first control sits past the lights, below their row.
    for (const resize of [false, true]) {
      if (resize) {
        await window.getByRole('button', { name: 'Restore session window' }).click();
        await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'false');
        await dragTopEdgeToTop(window);
      }
      const head = await headerBox(window);
      const first = (await sessionWindow(window).locator('header').first().getByRole('button').first().boundingBox())!;
      const clear = first.x >= LIGHTS.right || first.y >= LIGHTS.bottom;
      expect(clear, `the header's first control is at ${first.x},${first.y}, under the lights`).toBe(true);
      expect(head.y).toBeGreaterThanOrEqual(LIGHTS.bottom);
    }

    // Full screen hides the lights, and the room kept for them goes: the same drag now reaches the top. A test hook sets
    // what the main process sends, since a real full-screen transition animates and flakes on a loaded machine. It covers
    // the session window's bounds only (clearTop reads the flag): the safe zone's properties stay as the page set them.
    await window.evaluate(() => (document.documentElement.dataset.fullScreen = 'true'));
    // The page has taken it in: the bounds a drag stays inside follow the flag.
    await window.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await dragTopEdgeToTop(window);
    await expect.poll(async () => (await headerBox(window)).y).toBe(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/**
 * What the user could click or read that sits inside `kind`'s safe zone round the traffic lights (shared/traffic-lights.ts),
 * drawn on top there: controls, headings and text, each named for the failure. The zone is the lights' box and its margin.
 */
async function underTheLights(page: Page, kind: ChromeFor): Promise<string[]> {
  const box = trafficLightsBox(kind);
  const zone = { left: box.left - SAFE_MARGIN, top: box.top - SAFE_MARGIN, right: box.right + SAFE_MARGIN, bottom: box.bottom + SAFE_MARGIN };
  // The page keeps the same zone clear that this checks.
  const set = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return [style.getPropertyValue('--traffic-lights-right'), style.getPropertyValue('--traffic-lights-bottom')];
  });
  expect(set).toEqual([`${zone.right}px`, `${zone.bottom}px`]);
  return page.evaluate((zone) => {
    const CONTROLS = 'button, a[href], input, select, textarea, [contenteditable="true"], h1, h2, h3, h4, label, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="textbox"], [role="combobox"], [role="heading"], [role="option"], [role="radio"], [role="slider"]';
    const shown = (element: Element) => {
      const style = getComputedStyle(element);
      // The board's canvas pans under every corner of the window, as it is meant to: only what stays put is checked.
      return style.visibility !== 'hidden' && Number(style.opacity) > 0 && element.closest('[aria-hidden="true"], [inert], .react-flow__viewport') === null;
    };
    /** Where `rect` meets the zone, if it does, and whether `owner` is on top at that spot. */
    const overZone = (rect: DOMRect, owner: Element) => {
      const left = Math.max(rect.left, zone.left);
      const right = Math.min(rect.right, zone.right);
      const top = Math.max(rect.top, zone.top);
      const bottom = Math.min(rect.bottom, zone.bottom);
      if (right - left < 1 || bottom - top < 1) return false;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return hit !== null && (owner.contains(hit) || hit.contains(owner));
    };
    const name = (element: Element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).join('.')}` : ''} "${(element.textContent ?? '').trim().slice(0, 30)}"`;
    const found = new Set<string>();
    for (const element of document.querySelectorAll(CONTROLS)) {
      if (shown(element) && [...element.getClientRects()].some((rect) => overZone(rect, element))) found.add(name(element));
    }
    const texts = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (node) => ((node.textContent ?? '').trim() === '' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let node = texts.nextNode(); node !== null; node = texts.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || !shown(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some((rect) => overZone(rect, parent))) found.add(`text in ${name(parent)}`);
    }
    return [...found];
  }, zone);
}

const BOARD_SIZES = [
  { width: 1400, height: 900 },
  // The board's least, where the top bar folds its islands.
  { width: 640, height: 480 },
];

for (const design of ['classic', 'simplified'] as const) {
  test(`on macOS nothing to click or read sits under the traffic lights in any window, ${design}`, async () => {
    test.skip(process.platform !== 'darwin', 'the traffic lights float over the page on macOS only');
    const { repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    // The app's own default, so a double-click opens the agent's pop-up.
    const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' }, [], { design });
    /** Sizes `page`'s window to `size`, or to the least it allows, and waits for the page to take it in. */
    const sizeWindow = async (page: Page, size: { width: number; height: number } | 'least') => {
      const width = await app.evaluate(({ BrowserWindow }, { url, size }) => {
        const own = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL() === url)!;
        if (size === 'least') {
          const [width, height] = own.getMinimumSize();
          own.setSize(Math.max(width!, 400), Math.max(height!, 300));
        } else own.setContentSize(size.width, size.height);
        return own.getContentSize()[0]!;
      }, { url: page.url(), size });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    };
    /** Checks `page` at its own size and at the least it allows. */
    const atBothSizes = async (page: Page, kind: ChromeFor, what: string) => {
      expect(await underTheLights(page, kind), what).toEqual([]);
      await sizeWindow(page, 'least');
      expect(await underTheLights(page, kind), `${what}, at its least`).toEqual([]);
    };
    try {
      await window.emulateMedia({ reducedMotion: 'reduce' });
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await spawnAgent(window, 'monorepo', 'Second');
      const agentTile = tile(window).filter({ hasText: 'Pick a database' });
      const popup = window.getByTestId('agent-popup');

      for (const size of BOARD_SIZES) {
        await sizeWindow(window, size);
        expect(await underTheLights(window, 'board'), `the board at ${size.width} wide`).toEqual([]);

        // The agent's pop-up over the board.
        await agentTile.dblclick();
        await expect(popup).toBeVisible();
        expect(await underTheLights(window, 'board'), `the pop-up at ${size.width} wide`).toEqual([]);
        await popup.getByRole('button', { name: 'Back to its tile', exact: true }).click();
        await expect(popup).toHaveCount(0);
      }
      await sizeWindow(window, BOARD_SIZES[0]!);

      // Popped out into its own window.
      await agentTile.dblclick();
      const [out] = await Promise.all([app.waitForEvent('window'), popup.getByRole('button', { name: 'Pop out', exact: true }).click()]);
      await expect(out.getByTestId('session-window')).toBeVisible();
      await atBothSizes(out, 'pop-out', 'the popped-out window');

      // Settings, its sidebar open; there a double-click is set to open the agent's full screen, its session window maximised.
      const settings = await openSettings(window, 'board.opening');
      await atBothSizes(settings, 'settings', 'Settings');
      await settings.getByRole('radio', { name: 'Maximised session window' }).check();

      // The agent's full screen, the other agent's session window filling the board.
      await tile(window).filter({ hasText: 'Second' }).dblclick();
      await expect(sessionWindow(window)).toHaveAttribute('data-maximised', 'true');
      for (const size of BOARD_SIZES) {
        await sizeWindow(window, size);
        expect(await underTheLights(window, 'board'), `the agent's full screen at ${size.width} wide`).toEqual([]);
      }

      // The Overview.
      const [overview] = await Promise.all([
        window.context().waitForEvent('page'),
        app.evaluate(({ Menu }) => {
          Menu.getApplicationMenu()!
            .items.flatMap((menu) => menu.submenu?.items ?? [])
            .find((each) => each.label.endsWith('Overview'))!
            .click();
        }),
      ]);
      await expect(overview).toHaveTitle('Overview');
      await atBothSizes(overview, 'overview', 'the Overview');
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
