import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { run } from './board-helpers.ts';
import { launch, screen, sessionWindow, SHELL_ENV, spawnAgent, tile, TURN_MS, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// The agent-board command line and its MCP server (ADR-0010), from inside sessions the app starts.

test('a shell tile runs agent-board identify and sees its own tile and zone', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const [zone] = await zones(window);

    await run(window, 'agent-board identify');

    await expect(screen(window)).toContainText('(a shell tile)', { timeout: TURN_MS });
    await expect(screen(window)).toContainText(`zone:${zone!.id.slice(0, 4)}  monorepo`);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent sets its status with agent-board status set (after the MCP set_status), and its tile shows it in place of its task, without the percentage once its turn has ended', async () => {
  const { dir, repo, env } = scratch('board');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Moving session ids to the daemon');

    // Its CLI commands each start the app's executable as Node: a turn's worth of time, not a moment's. It set 10% and
    // 20% mid-turn; its turn over, the tile keeps the summary and drops the percentage.
    // The task reads the same, so the title (which has the status in it) says the status is set first.
    await expect(tile(window).getByTestId('tile-description')).toHaveAttribute('title', /Task: Moving session ids to the daemon$/, { timeout: TURN_MS });
    await expect(tile(window).getByTestId('tile-description')).toHaveText('Moving session ids to the daemon', { timeout: TURN_MS });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent that ends turns while its gate runs, then hands off, shows Finished on its tile', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Gate in the background');

    await expect(tile(window).getByTestId('tile-finished')).toHaveText('Finished', { timeout: TURN_MS });
    await expect(tile(window).getByTestId('tile-finished')).toHaveAttribute('title', /^Says its work is finished/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
