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

    // Its worker starts, and its CLI command starts the app's executable as Node: a turn's worth of time each.
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

test('an orchestrator wires itself to its worker and hands off along the edge: its token says an agent made it and when it delivered, and what it carried is a click away', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const lead = 'Wire a worker: Review it';
    await spawnAgent(window, 'monorepo', lead);
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    // It starts its workers and waits on their turns: a turn's worth of time each.
    const edge = window.getByTestId('flow-edge');
    await expect(edge).toHaveCount(1, { timeout: 4 * TURN_MS });
    // Its token says who made it, and, at the worker's end, when it delivered.
    const token = window.getByTestId('rail-token');
    await expect(token.locator('.rail-token-body')).toHaveAttribute('title', `Made by ${lead}, an orchestrator`);
    await expect(token.getByTestId('rail-token-note')).toHaveText(/^delivered \d\d:\d\d$/, { timeout: 2 * TURN_MS });

    await token.locator('.rail-token-open').click();
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

test('an orchestrator scatters its crew about its zone, then arranges it: itself first, then a cluster with an agent note, the implementer and its reviewer side by side', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const lead = 'Arrange a messy crew';
    await spawnAgent(window, 'monorepo', lead);
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    // Each CLI command starts the app's executable as Node: a turn's worth of time each.
    await expect(tile(window)).toHaveCount(3, { timeout: 4 * TURN_MS });
    await expect(window.getByTestId('flow-edge')).toHaveCount(1, { timeout: 4 * TURN_MS });
    const box = async (name: string) => (await agentTile(window, name).boundingBox())!;
    // Arranged: the reviewer level with its implementer and to its right, both in a row below the lead, none overlapping.
    await expect
      .poll(
        async () => {
          const [me, impl, review] = await Promise.all([box(lead), box('impl'), box('review')]);
          return {
            row: Math.round(review.y - impl.y),
            reviewRight: review.x > impl.x + impl.width,
            implBelowLead: impl.y > me.y + me.height,
            // The lead lines up with its units' stickies; the implementer comes after the sticky.
            implAfterSticky: impl.x > me.x,
          };
        },
        { timeout: 4 * TURN_MS },
      )
      .toEqual({ row: 0, reviewRight: true, implBelowLead: true, implAfterSticky: true });
    // The unit starts with an agent note by the lead, saying where each of its agents stands.
    const sticky = window.getByTestId('agent-note').filter({ hasText: /impl.*review/s });
    await expect(sticky).toHaveCount(1);
    expect((await sticky.boundingBox())!.x + (await sticky.boundingBox())!.width).toBeLessThan((await box('impl')).x);

    // Its Activity tab lists the moves and the arrange, newest first.
    await agentTile(window, lead).dblclick();
    await sessionWindow(window).getByRole('tab', { name: 'Activity' }).click();
    const lines = sessionWindow(window).getByTestId('activity-line');
    await expect(lines.nth(0)).toContainText('arranged monorepo');
    await expect(lines.filter({ hasText: /^.*moved impl/ })).toHaveCount(1);
    await expect(lines.filter({ hasText: /^.*moved review/ })).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
