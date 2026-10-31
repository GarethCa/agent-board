import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { test, addEmptyZone, removeDataDir, tempDataDir } from './launch.ts';
import { settingsSection } from './settings-helpers.ts';

/** Where each shell is stored, relative to its zone, in the order they were made. */
const shellPlaces = (page: Page) =>
  page.evaluate(async () => (await window.agentBoard.shells.list()).map((shell) => ({ x: shell.position?.x, y: shell.position?.y })).sort((a, b) => (a.x ?? 0) - (b.x ?? 0)));
const zoneSpacing = (page: Page) => page.evaluate(async () => (await window.agentBoard.zones.list())[0]!.spacing);

test("a zone's ▾ picks its spacing, tidies it at once, and keeps it across a restart", async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(window, 'Crew');
    const zone = window.getByTestId('zone');
    for (let made = 1; made <= 2; made++) {
      await zone.getByRole('button', { name: 'New shell in zone' }).click();
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(window.getByTestId('shell-tile')).toHaveCount(made);
    }

    // A new zone is roomy.
    await zone.getByRole('button', { name: 'Tidy and spacing' }).click();
    const menu = window.getByRole('menu');
    await expect(menu.getByRole('menuitemradio', { name: /Roomy/ })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitem', { name: /Default for new zones… Roomy · Settings/ })).toBeVisible();

    // Compact: kept on the zone, and the zone tidied at it, its padding 12 px and its tiles on the 16 px dots.
    await menu.getByRole('menuitemradio', { name: /Compact/ }).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => zoneSpacing(window)).toBe('compact');
    await expect.poll(() => shellPlaces(window)).toEqual([
      { x: 12, y: 36 },
      { x: 12 + 256 + 16, y: 36 },
    ]);

    // Drawn at the size it was tidied to: the tiles' bottom, then compact's 8 px tile gap and 12 px padding.
    await expect(zone).toHaveAttribute('data-height', String(36 + 136 + 8 + 12));
    await expect.poll(async () => (await window.evaluate(async () => (await globalThis.window.agentBoard.zones.list())[0]!.height))).toBe(36 + 136 + 8 + 12);

    // One undo puts the spacing back with the tiles, where a roomy zone slotted them; one redo picks it again.
    await window.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => zoneSpacing(window)).toBe('roomy');
    await expect.poll(() => shellPlaces(window)).toEqual([
      { x: 32, y: 56 },
      { x: 32 + 256 + 32, y: 56 },
    ]);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => zoneSpacing(window)).toBe('compact');
    await expect.poll(() => shellPlaces(window)).toEqual([
      { x: 12, y: 36 },
      { x: 12 + 256 + 16, y: 36 },
    ]);

    // Its default for new zones is in the Settings window, under Board › Tidying.
    await zone.getByRole('button', { name: 'Tidy and spacing' }).click();
    await expect(menu.getByRole('menuitemradio', { name: /Compact/ })).toHaveAttribute('aria-checked', 'true');
    const [settings] = await Promise.all([app.waitForEvent('window'), menu.getByRole('menuitem', { name: /Default for new zones/ }).click()]);
    await expect(settingsSection(settings, 'Tidying')).toBeVisible();
    await expect(settingsSection(settings, 'Tidying').locator('.ui-segmented[aria-label="Arrange spacing"]')).toBeVisible();

    await app.close();
    ({ app, window } = await launch(dataDir, SHELL_ENV));
    await expect(window.getByTestId('zone')).toHaveCount(1);
    expect(await zoneSpacing(window)).toBe('compact');
    await window.getByTestId('zone').getByRole('button', { name: 'Tidy and spacing' }).click();
    await expect(window.getByRole('menu').getByRole('menuitemradio', { name: /Compact/ })).toHaveAttribute('aria-checked', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
