import { expect, type Locator, type Page } from '@playwright/test';
import { SETTINGS_GROUPS } from '../src/renderer/src/chrome/settings-ia.ts';
import { PARTS_TO_TURN_ON, type TileShows } from '../src/renderer/src/board/tile-shows.ts';
import { runDesign } from './launch.ts';

/** Whether `page` is the Settings window's. */
export const isSettingsWindow = (page: Page) => page.url().includes('settings=');

/**
 * Opens the Settings window from `window` (the board or any other window of the app), or brings it forward, at `pane`
 * (`group` or `group.section`) if given, and resolves with its page once it has drawn. As Settings… elsewhere in the app
 * does; the board menu's row and the app menu's item are checked in settings-window.spec.ts.
 */
export async function openSettings(window: Page, pane?: string): Promise<Page> {
  const context = window.context();
  const existing = context.pages().find(isSettingsWindow);
  const opened = existing === undefined ? context.waitForEvent('page') : undefined;
  await window.evaluate((asked) => globalThis.window.agentBoard.setup.openSettings(asked), pane);
  const settings = existing ?? (await opened!);
  await expect(settings.getByRole('navigation', { name: 'Settings' })).toBeVisible();
  if (pane !== undefined) {
    const [group] = pane.split('.');
    await expect(settings.getByRole('main', { name: SETTINGS_GROUPS.find((each) => each.id === group)!.name })).toBeVisible();
  }
  return settings;
}

/** A section of the Settings window's page, by its heading: "Notifications", "Plan usage". */
export const settingsSection = (settings: Page, name: string): Locator => settings.getByRole('region', { name, exact: true });

/**
 * Turns `parts` of the Classic tile back on in Settings › Board › Agent tiles, then closes Settings, for a spec about a
 * part the quiet tile leaves off (its chips, its pill, its bubble). The board hears the change as from another window.
 */
export async function showTileParts(window: Page, parts: (keyof TileShows)[]): Promise<void> {
  // The Simplified tile has no such parts: its specs read it as it is.
  if (runDesign() === 'simplified') return;
  const settings = await openSettings(window, 'board.tiles');
  const section = settingsSection(settings, 'Agent tiles');
  for (const part of parts) {
    const toggle = section.getByRole('switch', { name: PARTS_TO_TURN_ON.find((each) => each.part === part)!.label });
    await toggle.click();
    await expect(toggle).toBeChecked();
  }
  await settings.close();
}
