import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, setClickOpens, SHELL_ENV, showDetails, spawnAgent, tile } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

const expandedTile = (page: import('@playwright/test').Page) => page.getByTestId('expanded-tile');

test('a click selects a tile and a double-click opens it, as the setting says; the title still renames; Enter opens', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Open me');
    await expect(tile(window)).toHaveCount(1);
    const node = window.locator('.react-flow__node').filter({ has: tile(window) });

    // One click selects, and opens nothing.
    await tile(window).click({ position: { x: 20, y: 60 } });
    await expect(node).toHaveClass(/selected/);
    await expect(sessionWindow(window)).toBeHidden();
    await expect(expandedTile(window)).toHaveCount(0);

    // A double-click on its title renames; it doesn't open it.
    await tile(window).locator('.hybrid-tile-name').dblclick();
    await expect(window.getByTestId('rename-field')).toBeFocused();
    await window.getByTestId('rename-field').press('Escape');
    await expect(sessionWindow(window)).toBeHidden();

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
