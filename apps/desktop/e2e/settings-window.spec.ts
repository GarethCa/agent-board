import { expect } from '@playwright/test';
import { launch, windowKey } from './agent-helpers.ts';
import { test, tempDataDir, removeDataDir } from './launch.ts';
import { isSettingsWindow, openSettings, settingsSection } from './settings-helpers.ts';
import { SETTINGS_CONTROLS, SETTINGS_GROUPS, sectionOf, type SettingsControl } from '../src/renderer/src/chrome/settings-ia.ts';

// The Settings window: its own OS window beside the board, with a sidebar of seven groups, opened by the board menu's
// Settings… row, the gear, and on macOS the app menu's Settings… (⌘,). It reopens on the pane it last showed.

test('Settings… opens the Settings window on General, and it reopens on the pane it last showed', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    // The board menu's Settings… row, which closes the menu.
    await window.getByRole('button', { name: 'Board menu' }).click();
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    const [settings] = await Promise.all([window.context().waitForEvent('page'), menu.getByRole('button', { name: /^Settings…/ }).click()]);
    await expect(menu).toBeHidden();
    const sidebar = settings.getByRole('navigation', { name: 'Settings' });
    await expect(sidebar).toBeVisible();
    await expect(settings).toHaveTitle('Settings');
    await expect(settings.getByRole('main', { name: 'General' })).toBeVisible();
    // Seven groups, General open on its sections and the rest closed.
    const groups = sidebar.locator('.settings-group-head');
    await expect(groups).toHaveText(SETTINGS_GROUPS.map((group, index) => (index === 0 ? group.name : `${group.name}${group.sections.length}`)));
    await expect(sidebar.getByRole('button', { name: 'General' })).toHaveAttribute('aria-expanded', 'true');

    // A closed group opens to its sections and shows its page; a section in it shows that page at the section.
    await sidebar.getByRole('button', { name: /^Usage/ }).click();
    await expect(settings.getByRole('main', { name: 'Usage' })).toBeVisible();
    await sidebar.getByRole('list', { name: 'Usage' }).getByRole('button', { name: 'Pacing' }).click();
    await expect(sidebar.getByRole('button', { name: 'Pacing' })).toHaveAttribute('aria-current', 'page');
    await expect(settingsSection(settings, 'Pacing')).toBeInViewport();
    // An open group closes again, keeping its page.
    await sidebar.getByRole('button', { name: 'General' }).click();
    await expect(sidebar.getByRole('button', { name: /^General/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar.getByRole('list', { name: 'General' })).toBeHidden();

    // Closed, and opened again: on Usage › Pacing, where it was.
    await settings.close();
    await expect.poll(() => window.context().pages().filter(isSettingsWindow).length).toBe(0);
    const [again] = await Promise.all([
      window.context().waitForEvent('page'),
      process.platform === 'darwin'
        ? // The click is what the menu bar does when ⌘, is pressed: a synthetic key event doesn't reach the native menu.
          app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0]!.submenu!.items.find((item) => item.label === 'Settings…')!.click())
        : window.getByRole('button', { name: 'Settings', exact: true }).click(),
    ]);
    await expect(again.getByRole('main', { name: 'Usage' })).toBeVisible();
    await expect(again.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Pacing' })).toHaveAttribute('aria-current', 'page');

    // Asked again while open, it comes forward on the pane asked for, and no second window opens.
    await openSettings(window, 'advanced.webTabs');
    await expect(settingsSection(again, 'Web tabs')).toBeInViewport();
    expect(window.context().pages().filter(isSettingsWindow)).toHaveLength(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('every control is in the section its home names, and a change in the window reaches the board at once', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const settings = await openSettings(window);
    // In the section's box, never its heading, which can read the same as a control's label.
    const drawn = (control: SettingsControl) => settingsSection(settings, sectionOf(control.home)!.name).locator('.settings-box').getByText(control.label).first();
    for (const group of SETTINGS_GROUPS) {
      await openSettings(window, group.id);
      for (const control of SETTINGS_CONTROLS.filter((each) => each.home.startsWith(`${group.id}.`))) {
        // Under Classic, a Simplified-only control isn't drawn at all.
        if (control.simplifiedOnly) await expect(drawn(control), `${control.id} not in ${control.home} under Classic`).toHaveCount(0);
        else await expect(drawn(control), `${control.id} in ${control.home}`).toBeVisible();
      }
    }

    // Show connections None in the window: the board's View popover, which sets the same, says None at once.
    await openSettings(window, 'board.connections');
    await settingsSection(settings, 'Connections').getByRole('button', { name: 'None' }).click();
    await window.getByRole('button', { name: 'View', exact: true }).click();
    const view = window.getByRole('dialog', { name: 'View' });
    await expect(view.getByRole('group', { name: 'Connections' }).getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Escape');
    await expect(view).toBeHidden();

    // Under the Simplified design, the Simplified-only controls are drawn in their homes too.
    await openSettings(window, 'general.design');
    const simplified = settingsSection(settings, 'Design').getByRole('switch', { name: 'Use the Simplified design' });
    await simplified.click();
    await expect(simplified).toBeChecked();
    for (const control of SETTINGS_CONTROLS.filter((each) => each.simplifiedOnly)) {
      await openSettings(window, control.home);
      await expect(drawn(control), `${control.id} in ${control.home}`).toBeVisible();
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("under the Simplified design, Show each agent's status as Characters is kept as picked", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {}, [], { design: 'simplified' });
  try {
    const settings = await openSettings(window, 'general.design');
    const look = settingsSection(settings, 'Design').getByRole('group', { name: "Show each agent's status as" });
    await expect(look.getByRole('button', { name: 'Icons and words' })).toHaveAttribute('aria-pressed', 'true');
    await look.getByRole('button', { name: 'Characters' }).click();
    await expect(look.getByRole('button', { name: 'Characters' })).toHaveAttribute('aria-pressed', 'true');
    await expect(look.getByRole('button', { name: 'Icons and words' })).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('searching settings filters the sidebar across groups, and ⌘K opens the window at a setting it finds', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const settings = await openSettings(window, 'usage');
    const sidebar = settings.getByRole('navigation', { name: 'Settings' });
    const search = sidebar.getByRole('searchbox', { name: 'Search settings' });

    // A section's name finds it, in its group, and the page shows it whole under its place.
    await search.fill('appearance');
    await expect(settings.getByRole('heading', { level: 1 })).toHaveText('Search');
    await expect(sidebar.locator('.settings-group-head')).toHaveText(['General']);
    await expect(sidebar.getByRole('list', { name: 'General' }).getByRole('button')).toHaveText(['Appearance2']);
    const page = settings.getByRole('main', { name: 'Search' });
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('2 results for “appearance”');
    await expect(page.getByRole('region', { name: 'General › Appearance' }).getByRole('group', { name: 'Mode' }).last()).toBeVisible();

    // Case and accents aside, the matches in the page are painted.
    await search.fill('PÀTH');
    await expect(sidebar.getByRole('list', { name: 'Advanced' }).getByRole('button')).toHaveText(['Programs2']);
    await expect.poll(() => settings.evaluate(() => CSS.highlights.get('settings-search')?.size ?? 0)).toBeGreaterThanOrEqual(4);

    // A control's other words find it across groups; nothing matching says so; Esc ends the search.
    await search.fill('spacing');
    await expect(sidebar.getByRole('list', { name: 'Board' }).getByRole('button')).toHaveText(['Tidying1']);
    await search.fill('zzzz');
    await expect(sidebar.getByText('No settings match.')).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(settings.getByRole('main', { name: 'Usage' })).toBeVisible();

    // A section picked from the search opens in its group, and the search ends.
    await search.fill('appear');
    await sidebar.getByRole('button', { name: /^Appearance/ }).click();
    await expect(search).toHaveValue('');
    await expect(settings.getByRole('main', { name: 'General' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page');
    await expect(settingsSection(settings, 'Appearance')).toBeInViewport();

    // ⌘K on the board lists settings too: Appearance, picked, brings the window forward at that section.
    await openSettings(window, 'advanced');
    await window.bringToFront();
    await window.keyboard.press(windowKey('k'));
    const switcher = window.getByRole('dialog', { name: 'Jump to a session or zone' });
    await window.keyboard.type('appearance');
    const row = switcher.getByRole('option', { name: /Appearance/ });
    await expect(row).toContainText('Settings · General');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Enter');
    await expect(switcher).toHaveCount(0);
    await expect(settings.getByRole('main', { name: 'General' })).toBeVisible();
    await expect(settingsSection(settings, 'Appearance')).toBeInViewport();
    expect(window.context().pages().filter(isSettingsWindow)).toHaveLength(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
