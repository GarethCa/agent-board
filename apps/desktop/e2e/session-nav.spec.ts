import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, setClickOpens, SHELL_ENV, tileAction, zones } from './agent-helpers.ts';
import { test, addEmptyZone, removeDataDir, tempDataDir } from './launch.ts';
import { clickClosing } from './windows.ts';

const shellTile = (page: Page, name: string) => page.getByTestId('shell-tile').filter({ hasText: name });
const count = (page: Page) => sessionWindow(page).getByTestId('session-nav-count');
const shownName = (page: Page) => sessionWindow(page).getByRole('heading');

/** Makes a shell tile named `name` in the zone (or loose, with null) at `position`, with the daemon's API. */
async function shellAt(page: Page, name: string, zoneId: string | null, position: { x: number; y: number }): Promise<void> {
  await page.evaluate(
    async ({ name, zoneId, position }) => {
      const shell = await window.agentBoard.shells.create(zoneId === null ? { zoneId: null, position } : { zoneId, position });
      await window.agentBoard.shells.setName(shell.id, name);
    },
    { name, zoneId, position },
  );
  await expect(shellTile(page, name)).toBeVisible();
}

test('a click opens a tile’s session window, which steps through its zone’s sessions in board order; Expand in place is a setting', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(window, 'Frontend');
    const zone = (await zones(window))[0]!;
    // Made out of board order: two rows of two, the second a little out of line.
    await shellAt(window, 'delta', zone.id, { x: 380, y: 215 });
    await shellAt(window, 'bravo', zone.id, { x: 380, y: 60 });
    await shellAt(window, 'charlie', zone.id, { x: 20, y: 240 });
    await shellAt(window, 'alpha', zone.id, { x: 20, y: 40 });
    await shellAt(window, 'loose-two', null, { x: zone.x + 300, y: zone.y + zone.height + 80 });
    await shellAt(window, 'loose-one', null, { x: zone.x, y: zone.y + zone.height + 80 });
    await window.getByRole('button', { name: 'Fit View' }).click();

    // A click opens its session window, with where it is in its zone.
    await shellTile(window, 'alpha').dblclick();
    await expect(sessionWindow(window)).toBeVisible();
    await expect(shownName(window)).toHaveText('alpha');
    await expect(count(window)).toHaveText('1 of 4 ·Frontend');
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);

    // › previews and shows the next one, left to right then top to bottom, in the same window.
    const next = sessionWindow(window).getByRole('button', { name: 'Next session' });
    await next.hover();
    await expect(window.getByRole('tooltip')).toContainText('Nextbravo');
    await next.click();
    await expect(shownName(window)).toHaveText('bravo');
    await expect(count(window)).toHaveText('2 of 4 ·Frontend');
    // ⌘] and ⌘[ do the same, wherever the focus is: the terminal too.
    await sessionWindow(window).getByTestId('shell-pane').first().click();
    await window.keyboard.press('ControlOrMeta+BracketRight');
    await expect(shownName(window)).toHaveText('charlie');
    await window.keyboard.press('ControlOrMeta+BracketRight');
    await expect(shownName(window)).toHaveText('delta');
    // Past the last it wraps to the first, and says so.
    await window.keyboard.press('ControlOrMeta+BracketRight');
    await expect(shownName(window)).toHaveText('alpha');
    await expect(window.getByText('Back to the first')).toBeVisible();
    await window.keyboard.press('ControlOrMeta+BracketLeft');
    await expect(shownName(window)).toHaveText('delta');
    await expect(count(window)).toHaveText('4 of 4 ·Frontend');
    // Stepping swaps what the window shows: nothing went to the dock.
    await expect(window.getByTestId('session-dock')).toHaveCount(0);
    await window.getByRole('button', { name: 'Close session window' }).click();

    // A loose session steps through the board's other loose sessions.
    await shellTile(window, 'loose-two').dblclick();
    await expect(count(window)).toHaveText('2 of 2 ·Loose');
    await sessionWindow(window).getByRole('button', { name: 'Previous session' }).click();
    await expect(shownName(window)).toHaveText('loose-one');
    await window.getByRole('button', { name: 'Close session window' }).click();

    // A session popped out into its own window is stepped past, as this window can't show it.
    await shellTile(window, 'bravo').dblclick();
    const [popped] = await Promise.all([app.waitForEvent('window'), sessionWindow(window).getByRole('button', { name: 'Pop out session window' }).click()]);
    await expect(popped.getByTestId('shell-pane')).toHaveCount(1);
    await shellTile(window, 'alpha').dblclick();
    await expect(count(window)).toHaveText('1 of 3 ·Frontend');
    await next.click();
    await expect(shownName(window)).toHaveText('charlie');
    await window.keyboard.press('ControlOrMeta+BracketLeft');
    await expect(shownName(window)).toHaveText('alpha');
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    await expect(shownName(window)).toHaveText('bravo');
    await window.getByRole('button', { name: 'Close session window' }).click();

    // With the setting changed, a click expands the tile in place, and its ⋯ menu opens the window once.
    await setClickOpens(window, 'Expand in place');
    await shellTile(window, 'alpha').dblclick();
    await expect(window.getByTestId('expanded-tile')).toBeVisible();
    await expect(sessionWindow(window)).toHaveCount(0);
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Collapse' }).click();
    await tileAction(shellTile(window, 'bravo'), 'Open window');
    await expect(shownName(window)).toHaveText('bravo');
    await window.getByRole('button', { name: 'Close session window' }).click();

    // Back on the default, the ⋯ menu expands in place once instead.
    await setClickOpens(window, 'Session window');
    await tileAction(shellTile(window, 'charlie'), 'Expand in place');
    await expect(window.getByTestId('expanded-tile')).toBeVisible();
    await expect(sessionWindow(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
