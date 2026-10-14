import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/** Deletes the first agent the way the CLI or an orchestrator does: not from its window's controls. */
const deleteFromOutside = async (page: Page) => {
  const [agent] = await agents(page);
  await page.evaluate((id) => window.agentBoard.agents.delete(id, true), agent!.sessionId);
};

test('an agent deleted from outside its window takes its shown, docked and popped-out window with it', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'First');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');

    // Shown on the board.
    await tile(window).dblclick();
    await expect(sessionWindow(window)).toBeVisible();
    await deleteFromOutside(window);
    await expect(sessionWindow(window)).toHaveCount(0);
    await expect(tile(window)).toHaveCount(0);

    // Docked.
    await spawnAgent(window, 'monorepo', 'Second');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(window.getByTestId('dock-item')).toHaveCount(1);
    await deleteFromOutside(window);
    await expect(window.getByTestId('dock-item')).toHaveCount(0);

    // Popped out.
    await spawnAgent(window, 'monorepo', 'Third');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();
    const [popped] = await Promise.all([app.waitForEvent('window'), window.getByRole('button', { name: 'Pop out session window' }).click()]);
    await expect(window.getByTestId('dock-item')).toHaveAttribute('data-placement', 'popped');
    await deleteFromOutside(window);
    await expect.poll(() => popped.isClosed()).toBe(true);
    await expect(window.getByTestId('dock-item')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
