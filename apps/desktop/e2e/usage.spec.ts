import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, SHELL_ENV, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, runDesign, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// Plan usage: the reading a Claude agent's status line posts, and the switch that shows it on the board.

test("Settings › Usage shows the usage a Claude agent's status line read, and can show it beside the zoom controls", async () => {
  const { dir, repo, env } = scratch('output');
  const now = Math.round(Date.now() / 1000);
  const rateLimits = { five_hour: { used_percentage: 86, resets_at: now + 3600 }, seven_day: { used_percentage: 41, resets_at: now + 3 * 86_400 } };
  const simplified = runDesign() === 'simplified';
  const dataDir = tempDataDir();
  const first = await launch(dataDir, { ...env, ...SHELL_ENV, FAKE_HARNESS_RATE_LIMITS: JSON.stringify(rateLimits) });
  let app = first.app;
  const window = first.window;
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const pill = window.getByTestId('usage-pill');
    // No reading before any Claude agent has run.
    await expect(pill).toHaveCount(0);

    await spawnAgent(window, 'monorepo', 'Write the code');
    await expect(tile(window)).toHaveAttribute('data-state', /waiting|idle/, { timeout: TURN_MS });

    // Settings › Usage: the reading, and the switch that shows it on the board.
    const settings = await openSettings(window, 'usage.plan');
    const plan = settingsSection(settings, 'Plan usage');
    await expect(plan.locator('.usage-detail')).toContainText('86%');
    await expect(plan.locator('.usage-detail')).toContainText('41%');
    // The reading has arrived, and the pill is still nowhere: off by default, not in the toolbar, not in the corner.
    await expect(pill).toHaveCount(0);
    const onBoard = plan.getByRole('switch', { name: 'Show usage on the board' });
    await expect(onBoard).not.toBeChecked();
    await onBoard.click();
    await expect(onBoard).toBeChecked();
    expect(await window.evaluate(() => globalThis.window.agentBoard.view.get('usageOnBoard'))).toBe(true);
    // On, the pill sits first in the zoom island, bottom right, and not in the toolbar. Under the Simplified design it is
    // the figures in the top-right island instead, and the zoom island has none.
    if (simplified) {
      await expect(window.getByTestId('usage-island')).toHaveText('5h 86% · wk 41%');
      await expect(window.getByRole('group', { name: 'Zoom' }).getByTestId('usage-pill')).toHaveCount(0);
    } else {
      await expect(pill).toHaveAccessibleName('Plan usage: 5-hour window 86%, 7-day window 41%');
      await expect(pill).toHaveClass(/is-hot/);
      await expect(window.getByRole('group', { name: 'Zoom' }).getByTestId('usage-pill')).toHaveCount(1);
      await expect(window.getByRole('toolbar', { name: 'Create' }).getByTestId('usage-pill')).toHaveCount(0);
    }

    // The switch is kept: a relaunch on the same data shows it again.
    await app.close();
    const again = await launch(dataDir, { ...env, ...SHELL_ENV });
    app = again.app;
    await expect(simplified ? again.window.getByTestId('usage-island') : again.window.getByRole('group', { name: 'Zoom' }).getByTestId('usage-pill')).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
