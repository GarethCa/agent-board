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
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent sets its status with agent-board status set (after the MCP set_status), and its tile shows it in place of its task', async () => {
  const { dir, repo, env } = scratch('board');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    await spawnAgent(window, 'monorepo', 'Moving session ids to the daemon');

    // Its MCP calls and CLI commands each start the app's executable as Node: a turn's worth of time, not a moment's.
    await expect(tile(window).getByTestId('tile-description')).toHaveText('Moving session ids to the daemon · 20%', { timeout: TURN_MS });
    await expect(tile(window).getByTestId('tile-description')).toHaveAttribute('title', /Task: Moving session ids to the daemon$/);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
