import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

const view = (page: Page) => page.locator('.react-flow__viewport').evaluate((viewport) => (viewport as HTMLElement).style.transform);

const zoneButton = (page: Page, name: string) => page.getByRole('group', { name: 'Zones' }).getByRole('button', { name });
const tileNamed = (page: Page, name: string) => tile(page).filter({ hasText: name });
const dockItemNamed = (page: Page, name: string) => page.getByTestId('dock-item').filter({ hasText: name });

test('with a session window maximised, a click on a zone button only minimises it and the dock keeps working; a window opened from a compact tile leaves it compact', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await expect(window.getByTestId('zone')).toHaveCount(1);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await spawnAgent(window, 'monorepo', 'Second');
    await addEmptyZone(window, 'Elsewhere');
    await window.getByRole('button', { name: 'Fit View' }).click();
    // Reduced motion makes a jump instant, so a click that did take the view somewhere has moved it by the time it is read.
    await window.emulateMedia({ reducedMotion: 'reduce' });

    // The second session is docked; the first is maximised.
    await tileNamed(window, 'Second').dblclick();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(dockItemNamed(window, 'Second')).toHaveAttribute('data-placement', 'docked');
    await tileNamed(window, 'Pick a database').dblclick();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');

    // A click on a zone button minimises the window and does not also take the view to that zone.
    const before = await view(window);
    await zoneButton(window, 'Elsewhere').click();
    await expect(dockItemNamed(window, 'Pick a database')).toHaveAttribute('data-placement', 'docked');
    expect(await view(window)).toBe(before);

    // With nothing maximised, the same button does take the view there.
    await zoneButton(window, 'Elsewhere').click();
    await expect.poll(() => view(window)).not.toBe(before);

    // The dock keeps working while a window is maximised: its item swaps the window shown, and its close button works.
    // The jump left the tiles out of view.
    await window.getByRole('button', { name: 'Fit View' }).click();
    await tileNamed(window, 'Pick a database').dblclick();
    await expect(sessionWindow(window)).toContainText('Pick a database');
    await dockItemNamed(window, 'Second').getByRole('button', { name: /Second/ }).first().click();
    await expect(sessionWindow(window)).toContainText('Second');
    await expect(dockItemNamed(window, 'Pick a database')).toHaveAttribute('data-placement', 'docked');
    await dockItemNamed(window, 'Pick a database').getByRole('button', { name: 'Close Pick a database' }).click();
    await expect(window.getByTestId('dock-item')).toHaveCount(0);

    // Windows opened from compact tiles leave them compact.
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(2);
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);

    // Nothing is left swallowing clicks: a zone button works at once.
    await window.getByRole('button', { name: 'Fit View' }).click();
    const fitted = await view(window);
    await zoneButton(window, 'Elsewhere').click();
    await expect.poll(() => view(window)).not.toBe(fitted);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
