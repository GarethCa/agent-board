import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV, zones } from './agent-helpers.ts';
import { test, removeDataDir, tempDataDir } from './launch.ts';

// A zone under the Simplified design is a project: a neutral well with a heading of its dot and name, and no tab of
// controls. Everything the Classic tab and ⋯ do is in its right-click menu, Project options › being the whole ⋯.

const project = (page: Page) => page.getByTestId('zone');
const projectMenu = (page: Page) => page.getByRole('menu', { name: /project$/ });

/** Where each shell is stored, relative to its zone, left to right. */
const shellPlaces = (page: Page) =>
  page.evaluate(async () => (await window.agentBoard.shells.list()).map((shell) => ({ x: shell.position?.x, y: shell.position?.y })).sort((a, b) => (a.x ?? 0) - (b.x ?? 0)));

/** Right-clicks the project's bare body, near its bottom right, clear of its tiles, and waits for its menu. */
async function rightClick(page: Page) {
  const box = (await project(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12, { button: 'right' });
  await expect(projectMenu(page)).toBeVisible();
}

/** Picks `row` from the project's right-click menu, and waits for the menu to go. */
async function pick(page: Page, row: string) {
  await rightClick(page);
  // A row's name runs on into its hint.
  await projectMenu(page).getByRole('menuitem', { name: new RegExp(`^${row}`) }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

test("a project's right-click menu makes terminals in it, tidies, renames, recolours and deletes it, and reaches all of ⋯", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified' });
  try {
    await window.evaluate(() => globalThis.window.agentBoard.zones.addUnbound({ name: 'Kobo', x: 0, y: 0, width: 720, height: 320 }));
    await expect(project(window)).toHaveCount(1);
    // A heading with a dot, its name and ⋯: none of the Classic tab's buttons.
    await expect(project(window).getByText('Kobo', { exact: true })).toBeVisible();
    await expect(project(window).getByRole('button', { name: 'Project options' })).toBeVisible();
    for (const gone of ['New agent', 'New shell in zone', 'Zone tracker', 'Bind zone', 'Tidy zone', 'Zone options']) {
      await expect(project(window).getByRole('button', { name: gone })).toHaveCount(0);
    }

    // New terminal here, twice: each opens its window, and its tile is in the project.
    for (let made = 1; made <= 2; made++) {
      await pick(window, 'New terminal here');
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(window.getByTestId('shell-tile')).toHaveCount(made);
    }

    // Tidy up puts two scattered tiles back in a row, at a new project's roomy spacing.
    await window.evaluate(async () => {
      const { shells, zones } = globalThis.window.agentBoard;
      const [zone] = await zones.list();
      const [first, second] = await shells.list();
      await shells.move(first!.id, { zoneId: zone!.id, x: 360, y: 150 });
      await shells.move(second!.id, { zoneId: zone!.id, x: 60, y: 120 });
    });
    await expect.poll(() => shellPlaces(window)).toEqual([
      { x: 60, y: 120 },
      { x: 360, y: 150 },
    ]);
    await pick(window, 'Tidy up');
    await expect.poll(() => shellPlaces(window)).toEqual([
      { x: 32, y: 56 },
      { x: 32 + 256 + 32, y: 56 },
    ]);

    // Rename opens its name in place.
    await pick(window, 'Rename');
    const name = window.getByRole('textbox', { name: 'Project name' });
    await name.fill('Kobo Planning');
    await name.press('Enter');
    await expect.poll(async () => (await zones(window))[0]!.name).toBe('Kobo Planning');
    await expect(project(window).getByText('Kobo Planning', { exact: true })).toBeVisible();

    // Colour ›, from the keyboard: a swatch it doesn't have, and its dot takes it.
    const before = (await zones(window))[0]!.color;
    await rightClick(window);
    await projectMenu(window).getByRole('menuitem', { name: 'Colour' }).focus();
    await window.keyboard.press('ArrowRight');
    const colours = window.getByRole('group', { name: 'Colour' });
    await expect(colours.locator('[aria-pressed="true"]')).toHaveCount(1);
    await colours.locator('[aria-pressed="false"]').first().focus();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('menu')).toHaveCount(0);
    await expect.poll(async () => (await zones(window))[0]!.color).not.toBe(before);
    const after = (await zones(window))[0]!.color;
    await expect.poll(() => project(window).evaluate((zone) => (zone as HTMLElement).style.getPropertyValue('--zone-color'))).toBe(after);

    // Project options › is the whole ⋯: its settings submenus, down to the agents' ones.
    await rightClick(window);
    await projectMenu(window).getByRole('menuitem', { name: 'Project options' }).focus();
    await window.keyboard.press('ArrowRight');
    await window.getByRole('menuitem', { name: 'Agents in this project' }).focus();
    await window.keyboard.press('ArrowRight');
    await expect(window.getByRole('menuitemradio', { name: /Board tools for new agents/ })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: /Role templates…/ })).toBeVisible();
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('menu')).toHaveCount(0);

    // Delete project… asks first, with today's confirmation; its terminals stay on the board.
    await pick(window, 'Delete project…');
    const confirm = window.getByRole('alertdialog', { name: 'Delete zone Kobo Planning?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(project(window)).toHaveCount(0);
    await expect(window.getByTestId('shell-tile')).toHaveCount(2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
