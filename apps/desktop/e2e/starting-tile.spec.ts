import { expect } from '@playwright/test';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

/** Makes `git worktree add` in `repo` take `seconds` longer, as on a slow disk: its checkout hook sleeps. */
function slowCheckout(repo: string, seconds: number): void {
  const hook = join(repo, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\nsleep ${seconds}\n`);
  chmodSync(hook, 0o755);
}

test('a new agent is on the board at once, shows its steps and its harness starting, then turns into a live tile', async () => {
  const { dir, repo, env } = scratch('output');
  slowCheckout(repo, 2);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_START_DELAY_MS: '3000' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Pick a cache for the job queue', { started: false });
    // The dialog closed and the start's tile is there while git is still making the worktree: no agent yet.
    const start = window.getByTestId('start-tile');
    await expect(start).toBeVisible();
    await expect(tile(window)).toHaveCount(0);
    await expect(start).toHaveAttribute('data-start', 'starting');
    await expect(start).toContainText('Pick a cache for the job queue');
    await expect(start.getByTestId('start-steps')).toContainText('creating worktree…');

    // Its session runs: the agent's own tile, still dashed, lists what was done and shows its harness starting.
    const agent = tile(window);
    await expect(agent).toHaveAttribute('data-start', 'starting', { timeout: 10_000 });
    await expect(start).toHaveCount(0);
    await expect(agent.getByTestId('start-steps')).toContainText(/worktree pick-a-cache/);
    await expect(agent.getByTestId('start-steps')).toContainText('starting Claude…');
    await expect(agent.getByTestId('start-output')).toHaveText('claude is starting');

    // Once its first hook comes, it is a normal live tile with its task.
    await expect(agent).not.toHaveAttribute('data-start', /.*/, { timeout: TURN_MS });
    await expect(agent.getByTestId('tile-description')).toContainText('Pick a cache for the job queue');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a harness that exits as it starts leaves its tile with the error, Retry and Delete', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_START_FAIL: 'ANTHROPIC_API_KEY not set' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Pick a cache');
    const agent = tile(window);
    await expect(agent).toHaveAttribute('data-start', 'failed', { timeout: 10_000 });
    await expect(agent.getByTestId('start-steps')).toContainText('claude exited (code 1)');
    await expect(agent.getByTestId('start-error')).toHaveText('ANTHROPIC_API_KEY not set');
    await expect(agent.getByRole('button', { name: 'Retry' })).toBeVisible();

    await agent.getByRole('button', { name: 'Delete' }).click();
    // Deleted at once, or after a confirm, whichever the board asks for.
    const confirm = window.getByRole('alertdialog');
    await expect.poll(async () => (await agent.count()) === 0 || (await confirm.isVisible())).toBe(true);
    if (await confirm.isVisible()) await confirm.getByRole('button', { name: /^Delete/ }).click();
    await expect(agent).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
