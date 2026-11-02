import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, SHELL_ENV, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { isSettingsWindow, openSettings, settingsSection } from './settings-helpers.ts';

// The Simplified toolbar's usage island: "5h 86% · wk 41%" before Needs you, when Settings › Usage shows usage on the
// board, with the bars, % used, % left and refill times a click away.

test('under the Simplified design usage is figures in the top-right island, before Needs you, and a click opens the bars', async () => {
  const { dir, repo, env } = scratch('output');
  const now = Math.round(Date.now() / 1000);
  const rateLimits = { five_hour: { used_percentage: 86, resets_at: now + 3600 }, seven_day: { used_percentage: 41, resets_at: now + 3 * 86_400 } };
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV, FAKE_HARNESS_RATE_LIMITS: JSON.stringify(rateLimits) }, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Write the code');
    await expect(tile(window)).toHaveAttribute('data-state', /waiting|idle/, { timeout: TURN_MS });

    // The reading has arrived, and nothing shows: the switch is off until the user turns it on.
    const island = window.getByTestId('usage-island');
    await expect(island).toHaveCount(0);
    await expect(window.getByTestId('usage-pill')).toHaveCount(0);
    const first = await openSettings(window, 'usage.plan');
    await settingsSection(first, 'Plan usage').getByRole('switch', { name: 'Show usage on the board' }).click();
    await expect(first.getByText('in the toolbar, before Needs you')).toBeVisible();

    // On, the figures lead the top-right island, before Needs you; the zoom controls no longer carry them.
    await expect(island).toHaveText('5h 86% · wk 41%');
    await expect(island).toHaveAccessibleName('5h 86% · wk 41%, plan usage');
    const topRight = window.locator('.island-top-right');
    await expect(topRight.getByRole('button').first()).toHaveAttribute('data-testid', 'usage-island');
    await expect(topRight.getByTestId('inbox-count')).toBeVisible();
    await expect(window.getByTestId('usage-pill')).toHaveCount(0);

    // A narrower window never lets the island reach the creation toolbar: the figures give way first.
    const room = () =>
      window.evaluate(() => document.querySelector('.island-top-right')!.getBoundingClientRect().left - document.querySelector('.island-top-centre')!.getBoundingClientRect().right);
    for (const width of [1400, 1240, 1239, 1140, 1139, 1100, 1050, 960, 959, 840, 839]) {
      await window.setViewportSize({ width, height: 800 });
      expect(await room(), `the islands' room at ${width}px`).toBeGreaterThanOrEqual(8);
    }
    await window.setViewportSize({ width: 1400, height: 900 });

    // A click opens the bars, with each window's % used, % left and refill time, and no running-low card.
    await island.click();
    const popover = window.getByRole('dialog', { name: 'Allowance' });
    await expect(popover).toContainText('5-hour');
    await expect(popover).toContainText('86% used');
    await expect(popover).toContainText('14% left');
    await expect(popover).toContainText('Weekly');
    await expect(popover).toContainText('41% used');
    await expect(popover).toContainText('59% left');
    await expect(popover.getByText(/^refills /)).toHaveCount(2);
    await expect(popover).toContainText('Read');
    await expect(island).not.toHaveClass(/is-hot/);

    // Usage settings… opens the Settings window on its Usage page, and closes the popover.
    const settings = await openSettings(window, 'alerts');
    expect(isSettingsWindow(settings)).toBe(true);
    await expect(settings.getByRole('main', { name: 'Usage' })).toHaveCount(0);
    await popover.getByRole('button', { name: 'Usage settings…' }).click();
    await expect(settings.getByRole('main', { name: 'Usage' })).toBeVisible();
    await expect(popover).toHaveCount(0);

    // Turning it off in Settings takes it off the board at once.
    await settingsSection(settings, 'Plan usage').getByRole('switch', { name: 'Show usage on the board' }).click();
    await expect(island).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
