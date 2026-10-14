import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

test('an agent given a cron schedule shows scheduled with a clock badge for its next run, until its schedule is removed', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(page);
    await spawnAgent(page, 'monorepo', 'Check the build');
    // Its turn is over and Claude has said it's idle at its prompt.
    await expect(tile(page)).toHaveAttribute('data-state', 'waiting');

    await tileAction(tile(page), 'Schedule');
    const dialog = page.getByRole('dialog', { name: 'Schedule' });
    await dialog.getByLabel(/Cron schedule/).fill('0 25 * * *');
    await expect(dialog.getByTestId('schedule-preview')).toContainText('hour');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByLabel(/Cron schedule/).fill('30 6 * * *');
    await expect(dialog.getByTestId('schedule-preview')).toContainText('06:30');
    await dialog.getByLabel('Each run sends it').fill('Check last night’s build');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    // Waiting for its next run, not for you: out of the inbox.
    await expect(tile(page)).toHaveAttribute('data-state', 'scheduled');
    await expect(tile(page).getByTestId('tile-clock')).toHaveText(/^ ?(tomorrow )?06:30$/);
    await expect(page.getByTestId('inbox-count')).toHaveAttribute('data-count', '0');
    const [agent] = await page.evaluate(() => window.agentBoard.agents.list());
    expect(agent!.schedule).toMatchObject({ cron: '30 6 * * *', prompt: 'Check last night’s build', enabled: true });

    await tile(page).getByTestId('tile-clock').click();
    await dialog.getByRole('button', { name: 'Remove schedule' }).click();
    await expect(tile(page).getByTestId('tile-clock')).toHaveCount(0);
    await expect(tile(page)).toHaveAttribute('data-state', 'waiting');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
