import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

test("an agent's Schedule… puts a clock beside its tile, joined to it: the agent shows scheduled with a clock badge until the clock goes", async () => {
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
    const dialog = page.getByRole('dialog', { name: 'Clock' });
    await dialog.getByLabel(/^Cron/).fill('0 25 * * *');
    await expect(dialog.getByTestId('schedule-preview')).toContainText('hour');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByLabel(/^Cron/).fill('30 6 * * *');
    await expect(dialog.getByTestId('schedule-preview')).toContainText('06:30');
    await dialog.getByLabel('Each run sends it').fill('Check last night’s build');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    // The clock is on the board beside the tile, saying what it does.
    const clock = page.getByTestId('clock');
    await expect(clock.locator('.clock-words')).toHaveText('Daily 06:30');
    await expect(clock.getByTestId('clock-detail')).toHaveText(/^→ Check the build · next (tomorrow )?06:30$/);
    await expect(page.getByTestId('clock-tether')).toHaveCount(1);

    // Waiting for its next run, not for you: out of the inbox.
    await expect(tile(page)).toHaveAttribute('data-state', 'scheduled');
    await expect(tile(page).getByTestId('tile-clock')).toHaveText(/^ ?(tomorrow )?06:30$/);
    await expect(page.getByTestId('inbox-count')).toHaveAttribute('data-count', '0');
    const [agent] = await page.evaluate(() => window.agentBoard.agents.list());
    expect(agent!.schedule).toMatchObject({ cron: '30 6 * * *', prompt: 'Check last night’s build', enabled: true });

    // The badge selects the clock; Edit schedule… opens the clock, which can be folded to a pill and deleted.
    await tile(page).getByTestId('tile-clock').click();
    await expect(page.locator('.react-flow__node.selected').getByTestId('clock')).toHaveCount(1);
    await page.getByRole('button', { name: 'Fold clock' }).click();
    await expect(clock).toHaveAttribute('data-folded', 'true');
    await expect(clock.getByTestId('clock-soon')).toHaveText(/^(in .+|tomorrow 06:30)$/);
    await tileAction(tile(page), 'Edit schedule');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(clock).toHaveCount(0);
    await expect(tile(page).getByTestId('tile-clock')).toHaveCount(0);
    await expect(tile(page)).toHaveAttribute('data-state', 'waiting');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
