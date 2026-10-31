import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, SHELL_ENV, spawnAgent, tile, tileAction, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// Orchestrators on the board: a zone that lets its agents orchestrate, the crew frame or from chips
// that show who started whom, and the orchestrator's Activity tab.

/** The tile of the agent named `name`. */
const agentTile = (window: Page, name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });

/** Picks how the board shows an orchestrator's agents, in the Settings window's Board › Crews. */
async function setCrewLook(window: Page, look: 'In a crew frame' | 'With a “from” chip' | 'Off'): Promise<void> {
  const settings = await openSettings(window, 'board.crews');
  const choice = settingsSection(settings, 'Crews').getByRole('radiogroup', { name: 'Agents an orchestrator starts' }).getByRole('radio', { name: look });
  await choice.check();
  await expect(choice).toBeChecked();
}

test('an orchestrator in a zone that lets it starts two workers: they sit in its crew frame, or carry from chips, or neither, and its Activity tab lists them', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
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

    // The zoom bar's View popover turns both off, and the choice is saved; ⇧C cycles on to frames again.
    await window.getByRole('button', { name: 'View', exact: true }).click();
    const view = window.getByRole('dialog', { name: 'View', exact: true });
    await view.getByRole('group', { name: 'Crews' }).getByRole('button', { name: 'Off' }).click();
    await expect(frame).toHaveCount(0);
    await expect(window.getByTestId('from-chip')).toHaveCount(0);
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('crewLook'))).toBe('off');
    await window.keyboard.press('Escape');
    await expect(view).toBeHidden();
    await window.keyboard.press('Shift+C');
    await expect(frame).toHaveCount(1);
    await expect(window.getByTestId('from-chip')).toHaveCount(0);

    // Settings has the same choice: Off there is checked in the popover too, and the other way round.
    await setCrewLook(window, 'Off');
    await expect(frame).toHaveCount(0);
    await window.getByRole('button', { name: 'View', exact: true }).click();
    await expect(view.getByRole('group', { name: 'Crews' }).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Escape');
    await expect(view).toBeHidden();

    await lead.dblclick();
    await sessionWindow(window).getByRole('tab', { name: 'Activity' }).click();
    const lines = sessionWindow(window).getByTestId('activity-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText('started worker two');
    await expect(lines.nth(1)).toContainText('started worker one');

    // Off is kept across a restart: the crew comes back with no frame and no chip.
    await app.close();
    const again = await launch(dataDir, { ...env, ...SHELL_ENV });
    app = again.app;
    window = again.window;
    await expect(tile(window)).toHaveCount(3);
    await expect(window.getByTestId('crew-frame')).toHaveCount(0);
    await expect(window.getByTestId('from-chip')).toHaveCount(0);
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('crewLook'))).toBe('off');
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
    await expect(token.getByTestId('rail-token-note')).toHaveText(/^delivered \d\d:\d\d( [AP]M)?$/, { timeout: 2 * TURN_MS });

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

test('an orchestrator scatters its crew about its zone, then arranges it: itself first, then a lane with its implementer and its reviewer side by side, then an agent note', async () => {
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
            // The lead lines up with its lanes' labels; the implementer comes after the label.
            implAfterLabel: impl.x > me.x,
          };
        },
        { timeout: 4 * TURN_MS },
      )
      .toEqual({ row: 0, reviewRight: true, implBelowLead: true, implAfterLabel: true });
    // The lane ends with an agent note by the lead, saying where each of its agents stands: in view once the view
    // fits the zone, as the board draws only what is in view.
    await window.getByRole('button', { name: /^Fit view/ }).click();
    const note = window.getByTestId('agent-note').filter({ hasText: /impl.*review/s });
    await expect(note).toHaveCount(1);
    const [noteBox, review] = [(await note.boundingBox())!, await box('review')];
    expect(noteBox.x).toBeGreaterThan(review.x + review.width);
    expect(Math.abs(noteBox.y - review.y)).toBeLessThan(review.height);

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

test('an orchestrator expanded in place, arranging by itself, starts its crew below it in lanes beside their labels, none under it', async () => {
  // A turn to start, three agents started by the CLI, and an arrange after each: the waits below, and a turn to spare.
  test.setTimeout(11 * TURN_MS);
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const lead = 'Arrange by itself, then start three';
    await spawnAgent(window, 'monorepo', lead);
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const leadTile = agentTile(window, lead);
    await expect(leadTile).toHaveAttribute('data-state', 'waiting', { timeout: 2 * TURN_MS });
    await tileAction(leadTile, 'Expand in place');
    await expect(window.getByTestId('expanded-tile')).toHaveCount(1);
    const me = (await agents(window)).find((agent) => agent.spawnedBy === null)!;
    await window.evaluate((sessionId) => globalThis.window.agentBoard.sessions.write(sessionId, 'go\r'), me.sessionId);

    // Each CLI command starts the app's executable as Node: a turn's worth of time each.
    await expect.poll(async () => (await agents(window)).length, { timeout: 4 * TURN_MS }).toBe(4);
    // The board draws only what is in view, and the lead expanded fills it: fit, then the crew are tiles beside it.
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await expect(tile(window)).toHaveCount(3);
    const box = async (name: string) => (await agentTile(window, name).boundingBox())!;
    await expect
      .poll(
        async () => {
          const [open, ...crew] = await Promise.all([window.getByTestId('expanded-tile').boundingBox().then((each) => each!), box('one'), box('two'), box('three')]);
          return {
            // Below it, each lane's tile beside its label rather than out past the expanded tile's width.
            below: crew.every((each) => each.y >= open.y + open.height),
            besideLabels: crew.every((each) => each.x > open.x && each.x < open.x + open.width / 2),
            apart: crew.every((each, index) => crew.slice(index + 1).every((other) => each.y + each.height <= other.y || other.y + other.height <= each.y)),
          };
        },
        { timeout: 4 * TURN_MS },
      )
      .toEqual({ below: true, besideLabels: true, apart: true });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
