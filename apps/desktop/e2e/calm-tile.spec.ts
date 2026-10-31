import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

// An agent's tile under the Simplified design is a calm tile: its window controls always shown along its top edge, one
// grey line, its status, and a filled button only while it needs the user.

const CONTROLS = ['Fold to a chip', 'Expand', 'Pop out', 'More', 'Close agent'];

const chip = (page: Page) => page.locator('[data-testid="agent-tile"][data-folded]');
const filled = (card: Locator) => card.locator('[data-testid="tile-action"][data-prominent]');

/** Each window control is shown at rest, with nothing hovered, at full strength unless disabled, and 24px square on the board. */
async function controlsAtRest(card: Locator): Promise<void> {
  const controls = card.getByTestId('tile-controls');
  for (const name of CONTROLS) {
    const button = controls.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    if (await button.isEnabled()) await expect(button).toHaveCSS('opacity', '1');
    // Measured in the board's own pixels, whatever its zoom.
    expect(await button.evaluate((element) => [(element as HTMLElement).offsetWidth, (element as HTMLElement).offsetHeight]), name).toEqual([24, 24]);
  }
}

test('an agent that needs permission shows its window controls at rest, inside the tile even at its least width, and one filled button', async () => {
  const { dir, repo, env } = scratch('permission');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.mouse.move(0, 0);
    await spawnAgent(window, 'monorepo', 'Clean the build');
    const card = tile(window);
    await expect(card).toHaveAttribute('data-state', 'needs-permission', { timeout: TURN_MS });
    await expect(card).toHaveAttribute('data-status', 'needs-you');
    await expect(card.getByTestId('status-mark')).toHaveText('Needs you');
    await expect(card.getByTestId('tile-line')).toBeVisible();
    // No Classic state pill or footer badges: the status is the mark.
    await expect(card.locator('.ui-pill')).toHaveCount(0);
    await controlsAtRest(card);
    await expect(filled(card)).toHaveCount(1);
    await expect(filled(card)).toHaveText('Review & allow');
    // A live agent doesn't fold: only a closed one does.
    await expect(card.getByRole('button', { name: 'Fold to a chip' })).toBeDisabled();
    // Its technical layer stays out until Show technical details adds it.
    await expect(card.getByTestId('tile-technical')).toBeHidden();

    // At the least tile width, 200px, all five controls still sit inside the tile, beside its name.
    await card.evaluate((element) => ((element as HTMLElement).style.width = '200px'));
    const inside = await card.evaluate((element) => {
      const edge = element.getBoundingClientRect();
      return [...element.querySelectorAll('[data-testid="tile-controls"] button')].map((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= edge.left && box.right <= edge.right - 1 && box.width >= 24;
      });
    });
    expect(inside).toEqual([true, true, true, true, true]);
    await expect(card.locator('.hybrid-tile-name')).toBeVisible();
    await card.evaluate((element) => ((element as HTMLElement).style.width = ''));

    // Expand opens it in place, and Collapse brings the tile back.
    await card.getByRole('button', { name: 'Expand', exact: true }).click();
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toBeVisible();
    await expanded.getByRole('button', { name: 'Collapse' }).click();
    await expect(expanded).toBeHidden();
    await controlsAtRest(tile(window));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent whose last message asks fills Answer; Close asks before stopping it, and its closed tile has no filled button and folds to a chip, by Fold or Close, never deleted', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    const card = tile(window);
    await expect(card).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    // Its turn ended on a question: it needs you, and Answer is the one filled button.
    await expect(card).toHaveAttribute('data-status', 'needs-you');
    await controlsAtRest(card);
    await expect(filled(card)).toHaveText('Answer');

    // Close asks first; cancelled, the agent runs on.
    await card.getByRole('button', { name: 'Close agent' }).click();
    const ask = window.getByRole('alertdialog', { name: 'Stop agent?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    const [agent] = await agents(window);
    expect(agent!.endedAt).toBeNull();

    // Confirmed, it stops; once its session is closed it folds to a chip.
    await card.getByRole('button', { name: 'Close agent' }).click();
    await ask.getByRole('button', { name: 'Stop agent' }).click();
    await expect.poll(async () => (await agents(window))[0]!.endedAt).not.toBeNull();
    await window.evaluate(async (id) => {
      const { agents, sessions } = globalThis.window.agentBoard;
      for (let tries = 0; tries < 100; tries++) {
        const shell = (await agents.list()).find((each) => each.sessionId === id)?.shellSessionId;
        if (shell) return void (await sessions.kill(shell));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }, agent!.sessionId);
    await expect(chip(window)).toHaveCount(1);

    // Unfolded, it asks nothing more: no filled button, and its Fold control folds it again.
    await chip(window).click();
    await expect(chip(window)).toHaveCount(0);
    await expect(tile(window)).not.toHaveAttribute('data-status', 'needs-you');
    await expect(filled(tile(window))).toHaveCount(0);
    const fold = tile(window).getByRole('button', { name: 'Fold to a chip' });
    await expect(fold).toBeEnabled();
    await fold.click();
    await expect(chip(window)).toHaveCount(1);

    // Close on a closed agent folds it too: it never deletes.
    await chip(window).click();
    await tile(window).getByRole('button', { name: 'Close agent' }).click();
    await expect(chip(window)).toHaveCount(1);
    expect(await agents(window)).toHaveLength(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
