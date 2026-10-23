import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, setClickOpens, zoneNamed, SHELL_ENV, showDetails, spawnAgent, tile } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

const expandedTile = (page: import('@playwright/test').Page) => page.getByTestId('expanded-tile');

test('a click selects a tile and a double-click opens it, as the setting says; a double-click on the title opens too; a slow click on it renames; Enter opens', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Open me');
    await expect(tile(window)).toHaveCount(1);
    const node = window.locator('.react-flow__node').filter({ has: tile(window) });

    // The click on the title that selects the tile renames nothing, however long it waits.
    const title = tile(window).locator('.hybrid-tile-name');
    await title.click();
    await window.waitForTimeout(900);
    await expect(window.getByTestId('rename-field')).toHaveCount(0);

    // One click selects, and opens nothing.
    await tile(window).click({ position: { x: 20, y: 60 } });
    await expect(node).toHaveClass(/selected/);
    await expect(sessionWindow(window)).toBeHidden();
    await expect(expandedTile(window)).toHaveCount(0);

    // A double-click on its title opens the session window; it renames nothing, even after the rename's wait.
    await title.dblclick();
    await expect(sessionWindow(window)).toBeVisible();
    await window.waitForTimeout(900);
    await expect(window.getByTestId('rename-field')).toHaveCount(0);
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();

    // Selected already, a click on the title and a pause renames it, as in Finder.
    await title.click();
    await expect(window.getByTestId('rename-field')).toBeFocused();
    await window.getByTestId('rename-field').press('Escape');
    await expect(sessionWindow(window)).toBeHidden();

    // A click on the title and then Enter, inside the wait: the window opens and no field opens behind it.
    await title.click();
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toBeVisible();
    await window.waitForTimeout(900);
    await expect(window.getByTestId('rename-field')).toHaveCount(0);
    await window.getByRole('button', { name: 'Close session window' }).click();

    // A double-click whose second click lands just below the title (on the tile) renames nothing.
    const head = (await title.boundingBox())!;
    await window.mouse.click(head.x + 8, head.y + head.height / 2);
    await window.mouse.click(head.x + 8, head.y + head.height + 12);
    await window.waitForTimeout(900);
    await expect(window.getByTestId('rename-field')).toHaveCount(0);
    if (await sessionWindow(window).isVisible()) await window.getByRole('button', { name: 'Close session window' }).click();

    // Select, wait, then press and drag: no rename.
    await window.waitForTimeout(900);
    const box = (await title.boundingBox())!;
    await window.mouse.move(box.x + 4, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + 40, box.y + box.height / 2 + 30, { steps: 5 });
    await window.mouse.up();
    await window.waitForTimeout(900);
    await expect(window.getByTestId('rename-field')).toHaveCount(0);

    // A double-click on the tile opens its session window; Enter does the same.
    await tile(window).dblclick({ position: { x: 20, y: 60 } });
    await expect(sessionWindow(window)).toBeVisible();
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await tile(window).click({ position: { x: 20, y: 60 } });
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toBeVisible();
    await window.getByRole('button', { name: 'Close session window' }).click();

    // With Expand in place, the double-click (and Enter) expand the tile instead.
    await setClickOpens(window, 'Expand in place');
    await tile(window).click({ position: { x: 20, y: 60 } });
    await expect(expandedTile(window)).toHaveCount(0);
    await tile(window).dblclick({ position: { x: 20, y: 60 } });
    await expect(expandedTile(window)).toHaveCount(1);
    await expect(sessionWindow(window)).toBeHidden();
    // Enter on a selected tile expands it too, and Enter in a window open over the board opens nothing else.
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await tile(window).click({ position: { x: 20, y: 60 } });
    await window.keyboard.press('Enter');
    await expect(expandedTile(window)).toHaveCount(1);
    await expect(sessionWindow(window)).toBeHidden();
    await expandedTile(window).getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await showDetails(sessionWindow(window));
    await sessionWindow(window).getByText('Details').first().click();
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window)).toHaveCount(1);
    await expect(expandedTile(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell tile opens on a double-click on its title, and renames on a click on it once selected, then a pause', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(window, 'G1');
    await zoneNamed(window, 'G1').getByRole('button', { name: 'New shell in zone' }).click();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const shellTitle = window.getByTestId('shell-tile').locator('.hybrid-tile-name');
    await shellTitle.dblclick();
    await expect(sessionWindow(window)).toBeVisible();
    await window.waitForTimeout(900);
    await expect(window.getByTestId('rename-field')).toHaveCount(0);
    await window.getByRole('button', { name: 'Close session window' }).click();
    // Opened by the double-click, it is selected: a click on its title and a pause renames it.
    await shellTitle.click();
    await expect(window.getByTestId('rename-field')).toBeFocused();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
