import { expect, type Locator, type Page } from '@playwright/test';
import { launch, listFinishedTurns, MASTER_KEY, spawnAgent, SHELL_ENV, TURN_MS, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The Simplified design's Needs you and Captain buttons open one docked pane, each on its own side; a second click on
// the open side closes it, and the other button switches the side without closing.

test('Needs you opens the pane on its list and the Captain on its chat; each toggles its own side closed, and the other switches it', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await listFinishedTurns(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

    const pane = window.getByTestId('master-panel');
    const needsYou = window.getByTestId('inbox-count');
    const captain = window.getByTestId('master-button');
    await expect(pane).toHaveCount(0);

    // Needs you: the list, no popover, the button pressed.
    await needsYou.click();
    await expect(pane).toHaveAttribute('data-side', 'needs-you');
    await expect(pane.getByTestId('needs-you-inbox')).toBeVisible();
    await expect(pane.getByTestId('inbox-item')).toHaveCount(1);
    await expect(pane.getByRole('heading', { name: 'Needs you' })).toHaveCount(1);
    await expect(needsYou).toHaveAttribute('aria-pressed', 'true');
    await expect(captain).toHaveAttribute('aria-pressed', 'false');

    // The Captain switches the side: the same pane, now its chat (no Captain yet, so it offers to start one).
    await captain.click();
    await expect(pane).toHaveCount(1);
    await expect(pane).toHaveAttribute('data-side', 'captain');
    await expect(pane.getByTestId('needs-you-inbox')).toHaveCount(0);
    await expect(pane.getByTestId('master-start')).toBeVisible();
    await expect(pane.getByTestId('captain')).toBeVisible();
    await expect(captain).toHaveAttribute('aria-pressed', 'true');
    await expect(needsYou).toHaveAttribute('aria-pressed', 'false');

    // A second click on the open side closes the pane, from either side.
    await captain.click();
    await expect(pane).toHaveCount(0);
    await needsYou.click();
    await expect(pane).toHaveAttribute('data-side', 'needs-you');
    await needsYou.click();
    await expect(pane).toHaveCount(0);

    // ⌘⇧M opens the Captain's side, from the list too; the pane's own Close shuts it.
    await needsYou.click();
    await window.keyboard.press(MASTER_KEY);
    await expect(pane).toHaveAttribute('data-side', 'captain');
    await pane.getByRole('button', { name: 'Close' }).click();
    await expect(pane).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('under Classic the Needs-you pill still opens its popover, and the Captain its panel with its sections', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await window.getByTestId('inbox-count').click();
    await expect(window.getByTestId('needs-you-inbox')).toBeVisible();
    await expect(window.getByTestId('master-panel')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.getByTestId('master-button').click();
    await expect(window.getByTestId('master-panel')).not.toHaveAttribute('data-side', /.+/);
    await expect(window.getByTestId('master-panel')).toBeVisible();
    await window.getByTestId('master-button').click();
    await expect(window.getByTestId('master-panel')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

async function dragDown(window: Page, handle: Locator, dy: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x, y + dy / 2, { steps: 4 });
  await window.mouse.move(x, y + dy, { steps: 4 });
  await window.mouse.up();
}

async function drag(window: Page, handle: Locator, dx: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx / 2, y, { steps: 4 });
  await window.mouse.move(x + dx, y, { steps: 4 });
  await window.mouse.up();
}

test('the pane resizes on its edge from either side, keeps its width across a switch and a reopen', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified' });
  try {
    const pane = window.getByTestId('master-panel');
    const handle = window.getByTestId('master-panel-handle');
    const width = async () => Math.round((await pane.boundingBox())!.width);
    await window.getByTestId('inbox-count').click();
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect.poll(width).toBe(360);

    // Dragged on the list side: wider, with the handle clear of the header and the zoom bar making room for it.
    await drag(window, handle, -100);
    await expect.poll(width).toBe(460);
    await expect(handle).toHaveAttribute('aria-valuenow', '460');
    await expect(handle).toHaveAccessibleName('Resize the pane');

    // The Captain's side is the same pane, as wide; a close and a reopen keep it.
    await window.getByTestId('master-button').click();
    await expect(pane).toHaveAttribute('data-side', 'captain');
    await expect.poll(width).toBe(460);
    await expect(handle).toHaveAccessibleName('Resize the Captain’s panel');
    await drag(window, handle, 80);
    await expect.poll(width).toBe(380);
    await window.getByTestId('master-button').click();
    await expect(pane).toHaveCount(0);
    await window.getByTestId('inbox-count').click();
    await expect.poll(width).toBe(380);
    await handle.dblclick();
    await expect.poll(width).toBe(360);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('switching the design off with the list open leaves the Classic Captain panel one click from closed', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified' });
  try {
    const pane = window.getByTestId('master-panel');
    await window.getByTestId('inbox-count').click();
    await expect(pane).toHaveAttribute('data-side', 'needs-you');
    await window.evaluate(() => globalThis.window.agentBoard.design.set('classic'));
    await expect(window.locator('html')).not.toHaveAttribute('data-design', 'simplified');
    await expect(pane).toBeVisible();
    await expect(pane).not.toHaveAttribute('data-side', /.+/);
    await window.getByTestId('master-button').click();
    await expect(pane).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

const controlsOf = async (window: Page) => {
  const box = async (locator: Locator) => ((await locator.count()) === 0 ? null : locator.first().boundingBox());
  return { zoom: await box(window.locator('.island-bottom-right')), minimap: await box(window.locator('.board-minimap')) };
};

for (const design of ['classic', 'simplified'] as const) {
  for (const minimap of [true, false]) {
    test(`${design}, minimap ${minimap ? 'on' : 'off'}: the docked pane runs full height over the zoom bar and the minimap, drags up to end a gap above them, and they stay exactly where they were`, async () => {
      const dataDir = tempDataDir();
      const { app, window } = await launch(dataDir, SHELL_ENV, [], { design });
      try {
        // Classic shows the minimap and Simplified hides it until the View menu turns it on; set the one wanted.
        const shown = (await window.locator('.board-minimap').count()) > 0;
        if (shown !== minimap) {
          if (design === 'simplified') {
            await window.getByRole('button', { name: 'View', exact: true }).click();
            await window.getByRole('switch', { name: 'Minimap' }).click();
            await window.keyboard.press('Escape');
          } else {
            await window.getByRole('button', { name: 'Minimap' }).click();
          }
        }
        await expect(window.locator('.board-minimap')).toHaveCount(minimap ? 1 : 0);
        const before = await controlsOf(window);
        expect(before.zoom).not.toBeNull();
        const gap = await window.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-dock-gap')));
        const inset = await window.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--island-inset')));
        const top = Math.min(...[before.zoom, before.minimap].flatMap((box) => (box ? [box.y] : [])));
        const pane = window.getByTestId('master-panel');
        const bottomHandle = window.getByTestId('master-panel-bottom-handle');
        const bottomOf = async () => {
          const box = (await pane.boundingBox())!;
          return box.y + box.height;
        };
        const buttons = design === 'simplified' ? ['inbox-count', 'master-button'] : ['master-button'];
        for (const id of buttons) {
          await window.getByTestId(id).click();
          await expect(pane).toBeVisible();
          // By default it runs the window's full height, over the zoom bar, and they stay where they were.
          const windowBottom = await window.evaluate(() => document.documentElement.clientHeight);
          expect(Math.abs((await bottomOf()) - (windowBottom - inset))).toBeLessThanOrEqual(2);
          expect(await bottomOf()).toBeGreaterThan(before.zoom!.y);
          expect(await controlsOf(window)).toEqual(before);
          await expect(bottomHandle).toHaveAttribute('role', 'separator');
          // Its bottom edge drags up to end above the controls.
          await dragDown(window, bottomHandle, -(windowBottom - top + 40));
          await expect.poll(async () => top - (await bottomOf())).toBeGreaterThanOrEqual(gap - 1);
          expect(await controlsOf(window)).toEqual(before);
          // Closed and reopened, it is where it was left; a double-click goes back to full height, and again to just above the controls.
          const left = await bottomOf();
          await window.getByTestId(id).click();
          await expect(pane).toHaveCount(0);
          await window.getByTestId(id).click();
          expect(await bottomOf()).toBe(left);
          await bottomHandle.dblclick();
          await expect.poll(async () => Math.abs((await bottomOf()) - (windowBottom - inset))).toBeLessThanOrEqual(2);
          await bottomHandle.dblclick();
          await expect.poll(async () => top - (await bottomOf())).toBeGreaterThanOrEqual(gap - 1);
          // The arrow keys resize it: Down gives the height back.
          const before2 = await bottomOf();
          await bottomHandle.focus();
          await window.keyboard.press('ArrowDown');
          await expect.poll(bottomOf).toBeGreaterThan(before2);
          // Back to full height for the next button, and closing moves nothing.
          await bottomHandle.dblclick();
          await window.getByTestId(id).click();
          await expect(pane).toHaveCount(0);
          expect(await controlsOf(window)).toEqual(before);
        }
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

test('at the least window height the Captain’s pane still shows its Start button', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV, [], { design: 'simplified' });
  try {
    await window.setViewportSize({ width: 1280, height: 480 });
    await window.getByRole('button', { name: 'View', exact: true }).click();
    await window.getByRole('switch', { name: 'Minimap' }).click();
    await window.keyboard.press('Escape');
    await window.getByTestId('master-button').click();
    await expect(window.getByTestId('master-start')).toBeVisible();
    const pane = (await window.getByTestId('master-panel').boundingBox())!;
    const start = await window.getByTestId('master-start').boundingBox();
    expect(start).not.toBeNull();
    expect(start!.y + start!.height).toBeLessThanOrEqual(pane.y + pane.height);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
