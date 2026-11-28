import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** The top bar's islands: the board menu, the creation toolbar and the Needs-you island. */
const TOP_BAR = ['.island-top-left', '.create-toolbar', '.island-top-right'] as const;

/** Each pair of the top bar's islands that overlap, and any island that reaches past the window's edges, by name. */
function clashes(page: Page): Promise<string[]> {
  return page.evaluate((selectors) => {
    const boxes = selectors.map((selector) => ({ selector, rect: document.querySelector(selector)!.getBoundingClientRect() }));
    const found: string[] = [];
    for (const [index, a] of boxes.entries()) {
      if (a.rect.left < 0 || a.rect.right > innerWidth) found.push(`${a.selector} past the window's edge`);
      for (const b of boxes.slice(index + 1)) {
        const apart = a.rect.right <= b.rect.left || b.rect.right <= a.rect.left || a.rect.bottom <= b.rect.top || b.rect.bottom <= a.rect.top;
        if (!apart) found.push(`${a.selector} over ${b.selector}`);
      }
    }
    return found;
  }, [...TOP_BAR]);
}

for (const design of ['classic', 'simplified'] as const) {
  test(`no top-bar island overlaps another in the narrowest window, with a zone and two agents waiting, ${design}`, async () => {
    const { repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, env, [], { design });
    try {
      await window.emulateMedia({ reducedMotion: 'reduce' });
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await spawnAgent(window, 'monorepo', 'Second');
      for (const width of [900, 640]) {
        const set = await app.evaluate(({ BrowserWindow }, { url, width }) => {
          const own = BrowserWindow.getAllWindows().find((each) => each.webContents.getURL() === url)!;
          own.setContentSize(width, 480);
          return own.getContentSize()[0]!;
        }, { url: window.url(), width });
        await expect.poll(() => window.evaluate(() => innerWidth)).toBe(set);
        // The folds follow a frame after the resize: poll until they settle clear.
        await expect.poll(() => clashes(window), { message: `the top bar at ${set} wide` }).toEqual([]);
        // On macOS the traffic lights push the board menu in: at the least width the Simplified toolbar fits only on a row of
        // its own, while Classic's, every fold taken, still fits between the islands.
        if (process.platform === 'darwin') {
          const folds = await window.locator('.board').getAttribute('data-folds');
          expect(folds?.split(' ').includes('row'), `the toolbar on its own row at ${set} wide (${folds})`).toBe(set === 640 && design === 'simplified');
        }
      }

      // A session window over the board starts below the toolbar's row, as it does below the islands', on macOS.
      await tile(window).filter({ hasText: 'Pick a database' }).dblclick();
      await expect(sessionWindow(window)).toBeVisible();
      if (process.platform === 'darwin') {
        await expect
          .poll(async () => {
            const toolbar = (await window.locator('.create-toolbar').boundingBox())!;
            const shown = (await sessionWindow(window).boundingBox())!;
            return shown.y >= toolbar.y + toolbar.height;
          }, { message: 'the session window below the toolbar' })
          .toBe(true);
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
