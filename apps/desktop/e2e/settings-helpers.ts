import { expect, type Locator, type Page } from '@playwright/test';
import { SETTINGS_GROUPS } from '../src/renderer/src/chrome/settings-ia.ts';

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
