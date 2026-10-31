import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { removeDataDir, test, tempDataDir } from './launch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// Show technical details: under the Simplified design, one switch in Settings and in View › Show Technical Details adds
// the technical layer back: a bit tagged `data-technical-detail` shows only while it is on. It is kept for the next
// launch, and the menu item and the switch follow each other. Classic never sees it, and shows every tagged bit.
// Electron menus are clicked through `app.applicationMenu`; the menu bar itself is the OS's.

/** Whether the root is marked as showing the technical layer. */
const marked = (page: Page) => page.evaluate(() => 'technical' in document.documentElement.dataset);

/** View › Show Technical Details as the menu bar has it now: whether it shows and is ticked. */
const menuItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()!.items.find((menu) => menu.label === 'View')!;
    const item = view.submenu!.items.find((entry) => entry.label === 'Show Technical Details')!;
    return { visible: item.visible, checked: item.checked, accelerator: item.accelerator ?? null };
  });

/** Picks View › Show Technical Details, as the menu bar does: Electron ticks or unticks it, then calls its click. */
const pickMenuItem = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()!.items.find((menu) => menu.label === 'View')!;
    view.submenu!.items.find((entry) => entry.label === 'Show Technical Details')!.click();
  });

/**
 * Adds a technical bit tagged as later work tags it, with a `display` of its own that the hiding rule must beat, and
 * returns it.
 */
const taggedBit = async (page: Page) => {
  await page.evaluate(() => {
    const bit = document.createElement('span');
    bit.dataset.technicalDetail = '';
    bit.dataset.testid = 'tagged-technical-bit';
    bit.style.display = 'inline-block';
    bit.textContent = 'main';
    document.body.append(bit);
  });
  return page.getByTestId('tagged-technical-bit');
};

/** Settings › General › Design, in the Settings window. */
const designSection = async (page: Page) => settingsSection(await openSettings(page, 'general.design'), 'Design');

test('under the Simplified design, Show technical details turns on in Settings or the View menu, each follows the other, and it is kept for the next launch', async () => {
  const dataDir = tempDataDir();
  try {
    const first = await launch(dataDir, {}, [], { design: 'simplified' });
    try {
      expect(await marked(first.window)).toBe(false);
      expect(await menuItem(first.app)).toEqual({ visible: true, checked: false, accelerator: null });
      const bit = await taggedBit(first.window);
      await expect(bit).toBeHidden();

      const toggle = (await designSection(first.window)).getByRole('switch', { name: 'Show technical details' });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect.poll(() => marked(first.window)).toBe(true);
      await expect.poll(async () => (await menuItem(first.app)).checked).toBe(true);
      await expect(bit).toBeVisible();

      await pickMenuItem(first.app);
      await expect(toggle).not.toBeChecked();
      await expect.poll(() => marked(first.window)).toBe(false);
      await expect(bit).toBeHidden();
      expect((await menuItem(first.app)).checked).toBe(false);

      await pickMenuItem(first.app);
      await expect(toggle).toBeChecked();
      await expect.poll(() => marked(first.window)).toBe(true);
    } finally {
      await first.app.close();
    }

    const second = await launch(dataDir, {});
    try {
      expect(await marked(second.window)).toBe(true);
      expect((await menuItem(second.app)).checked).toBe(true);
    } finally {
      await second.app.close();
    }
  } finally {
    await removeDataDir(dataDir);
  }
});

test('under Classic, the switch and the menu item are not there, the root is never marked and tagged bits show, even with the switch kept on', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {}, [], { technical: true });
  try {
    expect(await marked(window)).toBe(false);
    expect((await menuItem(app)).visible).toBe(false);
    // Classic shows a tagged bit whatever the switch says.
    await expect(await taggedBit(window)).toBeVisible();
    const menu = await designSection(window);
    await expect(menu.getByRole('switch', { name: 'Use the Simplified design' })).toBeAttached();
    await expect(menu.getByRole('switch', { name: 'Show technical details' })).toHaveCount(0);

    // Turning the Simplified design on brings the kept switch back, marked at once in the open window.
    await menu.getByRole('switch', { name: 'Use the Simplified design' }).click();
    await expect.poll(() => marked(window)).toBe(true);
    await expect.poll(async () => (await menuItem(app)).visible).toBe(true);
    await expect(menu.getByRole('switch', { name: 'Show technical details' })).toBeChecked();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
