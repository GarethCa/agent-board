import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { run } from './board-helpers.ts';
import { launch, screen, sessionWindow, SHELL_ENV, spawnAgent, tile, TURN_MS, zones } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// Pacing work by plan usage: the reading a Claude agent's status line posts, each zone's priority, and the switch that
// lets the Captain hold work, off until the user turns it on.

test("Settings › Usage shows the usage a Claude agent's status line read, and can show it beside the zoom controls; a zone takes a priority; the user turns pacing on in Settings › Usage, and overrides a hold", async () => {
  const { dir, repo, env } = scratch('output');
  const now = Math.round(Date.now() / 1000);
  const rateLimits = { five_hour: { used_percentage: 86, resets_at: now + 3600 }, seven_day: { used_percentage: 41, resets_at: now + 3 * 86_400 } };
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

    // Each zone is Normal until the user picks another priority on its tab.
    const zone = window.getByTestId('zone');
    await zone.getByRole('button', { name: 'Priority: Normal' }).click();
    await window.getByRole('menuitemradio', { name: 'Low' }).click();
    await expect(zone.getByRole('button', { name: 'Priority: Low' })).toBeVisible();
    expect((await zones(window))[0]!.priority).toBe('low');

    // Settings › Usage: the thresholds, and under them the switch, off until the user turns it on.
    const settings = await openSettings(window, 'usage.plan');
    const plan = settingsSection(settings, 'Plan usage');
    const thresholds = settingsSection(settings, 'Thresholds');
    const pacingSection = settingsSection(settings, 'Pacing');
    await expect(plan.locator('.usage-detail')).toContainText('86%');
    await expect(plan.locator('.usage-detail')).toContainText('41%');
    // The reading has arrived, and the pill is still nowhere: off by default, not in the toolbar, not in the corner.
    await expect(pill).toHaveCount(0);
    const onBoard = plan.getByRole('switch', { name: 'Show usage on the board' });
    await expect(onBoard).not.toBeChecked();
    await onBoard.click();
    await expect(onBoard).toBeChecked();
    expect(await window.evaluate(() => globalThis.window.agentBoard.view.get('usageOnBoard'))).toBe(true);
    await expect(thresholds.getByRole('slider', { name: '5-hour window: Only High zones start new agents at' })).toHaveValue('80');
    await expect(thresholds.getByRole('slider', { name: "5-hour window: Low zones' idle agents may be paused at" })).toHaveValue('95');
    await expect(thresholds.getByRole('slider', { name: '7-day window: Only High zones start new agents at' })).toHaveValue('90');
    const pacing = pacingSection.getByRole('switch', { name: 'Let the Captain pace work by usage' });
    await expect(pacing).not.toBeChecked();
    await expect(pacingSection.getByRole('note')).toContainText('It never interrupts a turn');
    await pacing.click();
    await expect(pacing).toBeChecked();
    expect((await window.evaluate(() => globalThis.window.agentBoard.flowEdges.settings())).usagePacing).toBe(true);

    // On, the pill sits first in the zoom island, bottom right, and not in the toolbar.
    await expect(pill).toHaveAccessibleName('Plan usage: 5-hour window 86%, 7-day window 41%');
    await expect(pill).toHaveClass(/is-hot/);
    await expect(window.getByRole('group', { name: 'Zoom' }).getByTestId('usage-pill')).toHaveCount(1);
    await expect(window.getByRole('toolbar', { name: 'Create' }).getByTestId('usage-pill')).toHaveCount(0);

    // A hold, placed from a shell on the board as the user's side would, shows on the zone's tab with Override.
    await zone.getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const [bound] = await zones(window);
    await run(window, `agent-board usage hold zone:${bound!.id.slice(0, 4)}`);
    await expect(screen(window)).toContainText('5h at 86%, zone low priority', { timeout: TURN_MS });
    await window.getByRole('button', { name: 'Minimise session window' }).click();

    const held = zone.getByRole('button', { name: 'Priority: Low, held for usage' });
    await expect(held).toBeVisible();
    await held.click();
    await window.getByRole('menuitem', { name: /Override/ }).click();
    await expect(zone.getByRole('button', { name: 'Priority: Low' })).toBeVisible();
    expect((await zones(window))[0]!.usageHold).toBeNull();

    // The switch is kept: a relaunch on the same data shows the pill in the Zoom group again.
    await app.close();
    const again = await launch(dataDir, { ...env, ...SHELL_ENV });
    app = again.app;
    await expect(again.window.getByRole('group', { name: 'Zoom' }).getByTestId('usage-pill')).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
