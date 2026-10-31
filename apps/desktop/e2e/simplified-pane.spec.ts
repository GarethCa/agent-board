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

test('the pane resizes on its edge from either side, keeps its width across a switch and a reopen, and leaves the islands their room', async () => {
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
    await expect.poll(() => window.evaluate(() => document.documentElement.style.getPropertyValue('--master-panel-width'))).toBe('460px');
    const zoomIn = (await window.getByRole('button', { name: 'Zoom in' }).boundingBox())!;
    expect(zoomIn.x + zoomIn.width).toBeLessThanOrEqual((await pane.boundingBox())!.x);

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
