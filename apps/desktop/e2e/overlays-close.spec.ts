import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, spawnAgent, stopAnimationEvents, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/**
 * Moves the pointer to a corner of the window, off every control, so a hover-opened overlay closes. A tooltip lets the
 * pointer cross over to it after it leaves the control, and closes on a move outside that path: the second move.
 */
async function pointerAway(window: Page): Promise<void> {
  await window.mouse.move(4, 4, { steps: 4 });
  await window.mouse.move(2, 2);
}

/** The pointer onto `target`'s middle, from away, so it counts as a fresh hover. */
async function hover(window: Page, target: Locator): Promise<void> {
  await pointerAway(window);
  await target.hover();
}

/** Each match's `data-state`: none when every one has left the page, and what a lingering one says when not. */
function states(overlay: Locator): Promise<(string | null)[]> {
  return overlay.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-state')));
}

test('a popover, a tooltip and a hover card closed before their fade has been seen to start leave the page at once, and open again', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });

    // On a busy machine an overlay can close before the page has told it its fade started. Here no animation event
    // reaches anything, so every overlay is in that state.
    await stopAnimationEvents(window);

    // A popover: closed, it is gone at once, and the next click opens it and it stays open.
    const boardMenu = window.getByRole('button', { name: 'Board menu' });
    const popover = window.locator('.ui-popover');
    await boardMenu.click();
    await expect(popover).toBeVisible();
    await window.keyboard.press('Escape');
    await expect.poll(() => states(popover)).toEqual([]);
    await expect(boardMenu).toHaveAttribute('aria-expanded', 'false');
    await boardMenu.click();
    await expect(popover).toBeVisible();
    await expect(boardMenu).toHaveAttribute('aria-expanded', 'true');
    await window.keyboard.press('Escape');
    await expect.poll(() => states(popover)).toEqual([]);

    // A tooltip: the pointer gone, so is it; back, it shows again. Only the "gone" check guards a hover overlay: one
    // left mounted would open again on the same node, so its reopening passes either way.
    const tooltip = window.locator('.ui-tooltip');
    await hover(window, boardMenu);
    await expect(tooltip).toBeVisible();
    await pointerAway(window);
    await expect.poll(() => states(tooltip)).toEqual([]);
    await hover(window, boardMenu);
    await expect(tooltip).toBeVisible();

    // A hover card, the same.
    const card = window.locator('.ui-hover-card');
    await hover(window, tile(window));
    await expect(card).toBeVisible();
    await pointerAway(window);
    await expect.poll(() => states(card)).toEqual([]);
    await hover(window, tile(window));
    await expect(card).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
