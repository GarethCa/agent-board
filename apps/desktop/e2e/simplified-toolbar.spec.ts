import { expect, type Page } from '@playwright/test';
import { launch, SHELL_ENV } from './agent-helpers.ts';
import { test, tempDataDir } from './launch.ts';

// The Simplified design's islands keep their places with fewer buttons in each: Draw and New agent menus reach every
// tool the Classic toolbar has, View holds the grid and the minimap, and the minimap is off until it is turned on.

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Create' });
const boardTool = (page: Page) => page.getByTestId('board-tool');

/** Picks `item` from the menu `opener` opens, and waits for the menu to finish leaving, which still takes Esc and presses. */
async function pick(page: Page, opener: string, item: string | RegExp) {
  await toolbar(page).getByRole('button', { name: opener }).click();
  await page.getByRole('menuitem', { name: item }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

const draw = (page: Page, item: string) => pick(page, 'Draw', item);

test('the Simplified toolbar: Draw reaches every drawing tool and Box select, View turns on the minimap, and top right is Needs you, the Captain and Settings', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified' });
  try {
    const names = () => toolbar(window).getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent));
    await expect.poll(names).toEqual(['Select', 'Hand', 'Draw', 'New agent', 'More to start']);
    await expect(toolbar(window).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');

    await draw(window, 'Text');
    await expect(boardTool(window)).toHaveAttribute('data-tool', 'text');
    await expect(toolbar(window).getByRole('button', { name: 'Draw' })).toHaveAttribute('aria-pressed', 'true');
    // A menu row arms its tool, even one already armed: it is no toggle.
    await draw(window, 'Text');
    await expect(boardTool(window)).toHaveAttribute('data-tool', 'text');
    await window.keyboard.press('Escape');
    await expect(boardTool(window)).toHaveCount(0);

    // Shape opens the shape picker under Draw, as S does.
    await draw(window, 'Shape');
    await expect(boardTool(window)).toHaveAttribute('data-tool', 'shape');
    await expect(window.getByRole('dialog', { name: 'Shapes' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(boardTool(window)).toHaveCount(0);
    await expect(window.getByRole('dialog', { name: 'Shapes' })).toBeHidden();
    // S from the board, as a user presses it: focus is on the board, not where the picker left it.
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.click(pane.x + pane.width - 20, pane.y + pane.height / 2);
    await window.keyboard.press('s');
    await expect(window.getByRole('dialog', { name: 'Shapes' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(boardTool(window)).toHaveCount(0);

    await draw(window, 'Zone');
    await expect(boardTool(window)).toHaveAttribute('data-tool', 'zone');
    await window.keyboard.press('Escape');
    await expect(boardTool(window)).toHaveCount(0);

    await draw(window, 'Box select');
    await expect(window.locator('.board')).toHaveAttribute('data-mode', 'box');
    await toolbar(window).getByRole('button', { name: 'Select' }).click();
    await expect(window.locator('.board')).toHaveAttribute('data-mode', 'select');

    await draw(window, 'Sticky note');
    await expect(window.getByTestId('sticky')).toHaveCount(1);
    await window.keyboard.press('Escape');

    const newAgent = toolbar(window).getByRole('button', { name: 'New agent' });
    await newAgent.click();
    await expect(newAgent).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Escape');

    // The minimap is off until View turns it on; the grid's switch is beside it, and the zoom bar has neither button.
    const zoom = window.getByRole('group', { name: 'Zoom' });
    await expect(zoom.getByRole('button', { name: 'Minimap' })).toHaveCount(0);
    await expect(zoom.getByRole('button', { name: 'Snap to grid' })).toHaveCount(0);
    await expect(window.locator('.board-minimap')).toHaveCount(0);
    await zoom.getByRole('button', { name: 'View', exact: true }).click();
    const view = window.getByRole('dialog', { name: 'View' });
    await view.getByRole('switch', { name: 'Minimap' }).click();
    await expect(window.locator('.board-minimap')).toBeVisible();
    const grid = view.getByRole('switch', { name: 'Snap to grid' });
    const snapped = await grid.isChecked();
    await grid.click();
    await expect(grid).toBeChecked({ checked: !snapped });
    await window.keyboard.press('Escape');

    // Top right: Needs you, the Captain in the pirate hat, and the sliders that open Settings.
    const topRight = window.locator('.island-top-right');
    await expect(topRight.getByRole('button')).toHaveCount(3);
    await expect(window.getByTestId('inbox-count')).toHaveText('Needs you');
    await expect(window.getByTestId('master-button').getByTestId('captain')).toBeVisible();
    await expect(topRight.getByRole('button', { name: 'Settings' })).toBeVisible();

    // A narrower window keeps the Captain and its word while the islands have room, as a laptop's does: the toolbar is
    // narrower than Classic's, so it gives way later. Never under the creation toolbar.
    const captain = window.getByTestId('master-button');
    const label = captain.locator('.master-button-label');
    /** The room between the creation toolbar and the top-right island, px. */
    const room = () =>
      window.evaluate(() => document.querySelector('.island-top-right')!.getBoundingClientRect().left - document.querySelector('.island-top-centre')!.getBoundingClientRect().right);
    // Each breakpoint's edges, so a wider toolbar or island fails here before the two touch.
    for (const [width, word] of [[1050, true], [920, true], [919, false], [800, false]] as const) {
      await window.setViewportSize({ width, height: 800 });
      await expect(captain).toBeVisible();
      await expect(label).toBeVisible({ visible: word });
      expect(await room(), `the islands' room at ${width}px`).toBeGreaterThanOrEqual(8);
    }
  } finally {
    await app.close();
  }
});

for (const technical of [false, true]) {
  test(`with technical details ${technical ? 'on' : 'off'}, the Simplified New agent menu reaches the Shell tool, as a new terminal`, async () => {
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified', technical });
    try {
      await toolbar(window).getByRole('button', { name: 'More to start' }).click();
      await expect(window.getByRole('menuitem')).toHaveText([/New agent/, /New terminal/]);
      await window.keyboard.press('Escape');
      await expect(window.getByRole('menu')).toHaveCount(0);

      await pick(window, 'More to start', /New terminal/);
      await expect(boardTool(window)).toHaveAttribute('data-tool', 'shell');
      await window.keyboard.press('Escape');
      await expect(boardTool(window)).toHaveCount(0);

      await pick(window, 'More to start', /New agent/);
      await expect(toolbar(window).getByRole('button', { name: 'New agent' })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await app.close();
    }
  });
}
