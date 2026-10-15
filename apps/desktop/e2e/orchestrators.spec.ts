import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, SHELL_ENV, spawnAgent, tile, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// Orchestrators on the board: a zone that lets its agents orchestrate (AZ3), the crew frame or from chips
// that show who started whom (BA2, BA3), and the orchestrator's Activity tab (BB1).

/** The tile of the agent named `name`. */
const agentTile = (window: Page, name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });

/** Picks how the board shows an orchestrator's agents, from the board menu's Settings, and closes the menu again. */
async function setCrewLook(window: Page, look: 'In a crew frame' | 'With a “from” chip'): Promise<void> {
  const panel = window.getByRole('dialog', { name: 'Board menu' });
  if (!(await panel.isVisible())) await window.getByRole('button', { name: 'Board menu' }).dispatchEvent('click');
  const choice = panel.getByRole('radiogroup', { name: 'Agents an orchestrator starts' }).getByRole('radio', { name: look });
  await choice.check();
  await expect(choice).toBeChecked();
  await window.keyboard.press('Escape');
  await expect(panel).toBeHidden();
}

test('an orchestrator in a zone that lets it starts two workers: they sit in its crew frame, or carry from chips, and its Activity tab lists them', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    // On for a new zone: its menu offers to stop it.
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
    await expect(window.getByRole('menuitem', { name: 'Stop agents orchestrating' })).toBeVisible();
    await window.keyboard.press('Escape');

    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    // Its MCP call and CLI command each start the app's executable as Node: a turn's worth of time each.
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    const lead = window.locator('[data-testid="agent-tile"][data-orchestrator]');
    await expect(lead).toHaveCount(1);
    await expect(lead.getByTestId('crew-count')).toHaveText('2');
    const workers = [agentTile(window, 'worker one'), agentTile(window, 'worker two')];
    const ids = await Promise.all(workers.map((worker) => worker.getAttribute('data-session-id')));
    const frame = window.getByTestId('crew-frame');
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute('data-members', ids.join(' '));
    await expect(frame).toContainText(/'s crew$/);
    await expect(window.getByTestId('from-chip')).toHaveCount(0);

    await setCrewLook(window, 'With a “from” chip');
    await expect(frame).toHaveCount(0);
    await expect(window.getByTestId('from-chip')).toHaveCount(2);
    await workers[0]!.getByTestId('from-chip').hover();
    for (const member of [lead, ...workers]) await expect(member).toHaveAttribute('data-crew-lit', '');

    await lead.dblclick();
    await sessionWindow(window).getByRole('tab', { name: 'Activity' }).click();
    const lines = sessionWindow(window).getByTestId('activity-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText('started worker two');
    await expect(lines.nth(1)).toContainText('started worker one');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an orchestrator wires itself to its worker and hands off along the edge: dashed as agent-made, with when it delivered, and what it carried a click away', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const lead = 'Wire a worker: Review it';
    await spawnAgent(window, 'monorepo', lead);
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    // Its MCP calls each start the app's executable as Node: a turn's worth of time each.
    const edge = window.getByTestId('flow-edge');
    await expect(edge).toHaveCount(1, { timeout: 4 * TURN_MS });
    await expect(edge).toHaveAttribute('data-agent-made', 'true');
    await expect(edge.locator('title')).toHaveText(`Made by ${lead}, an orchestrator`);
    // Between tiles this close its label is a marker: hovered, it shows the label and when it delivered.
    await expect(edge).toHaveAttribute('data-collapsed', 'true');
    await edge.locator('.flow-edge-trigger-dot').hover();
    const delivered = window.getByTestId('flow-edge-delivered');
    await expect(delivered.locator('text')).toHaveText(/^delivered \d\d:\d\d$/, { timeout: 2 * TURN_MS });

    await delivered.click();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules.getByTestId('edge-rules-made-by')).toHaveText(`Made by ${lead}, an orchestrator. You can change or delete it like any other.`);
    await expect(rules.getByTestId('edge-rules-delivered')).toHaveText('Review it');

    // Its Activity tab lists the worker it started, the edge it made and the hand-off.
    await agentTile(window, lead).dblclick();
    await sessionWindow(window).getByRole('tab', { name: 'Activity' }).click();
    const lines = sessionWindow(window).getByTestId('activity-line');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0)).toContainText('handed off to worker');
    await expect(lines.nth(1)).toContainText('added an edge into worker');
    await expect(lines.nth(2)).toContainText('started worker');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
