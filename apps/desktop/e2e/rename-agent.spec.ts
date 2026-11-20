import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, SHELL_ENV, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// One agent renaming another's tile: the new name shows at once, and the tile's hover card says who renamed it, when,
// and what it was called. The fake claude's `ask-plan` scenario does the renaming with the board MCP's `rename`.

/** The tile of the agent named `name`. */
const agentTile = (window: Page, name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });

test("an agent renames another agent's tile: the new name shows, and its hover card says who renamed it and what it was", async () => {
  const { dir, repo, env } = scratch('ask-plan');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the docs', { name: 'Docs' });
    const closeWindow = async () => {
      if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    };
    await closeWindow();
    await spawnAgent(window, 'monorepo', 'Rename: Docs | Docs writer', { name: 'Lead' });
    await closeWindow();

    const renamed = agentTile(window, 'Docs writer');
    await expect(renamed).toHaveCount(1, { timeout: 2 * TURN_MS });
    await expect(agentTile(window, 'Docs')).toHaveCount(0);
    await renamed.hover();
    await expect(window.getByTestId('tile-details')).toContainText(/Renamed by Lead, \d\d:\d\d \(was Docs\)/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
