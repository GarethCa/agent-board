import { expect, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, SHELL_ENV, spawnAgent, tile, tileAction, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

// Orchestrators on the board: agents that orchestrate, the crew frame that shows who started whom
// while the orchestrator is focused, and the orchestrator's Activity tab.

/** The tile of the agent named `name`. */
const agentTile = (window: Page, name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });

test('an orchestrator in any zone starts two workers: their crew frame shows while it is hovered or selected, the rest dims, and its Activity tab lists them', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    // Every agent may orchestrate: the zone's menu has no switch for it.
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
    await expect(window.getByRole('menuitem', { name: /board MCP/ })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: /orchestrat|start and manage agents/i })).toHaveCount(0);
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
    // A session of the user's own, in no crew.
    await spawnAgent(window, 'monorepo', 'Tidy the docs');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(4);
    const stranger = window.locator('[data-testid="agent-tile"]:not([data-crew])');
    await expect(stranger).toHaveCount(1);

    // At rest the frame is there, round the crew, but not shown, and nothing dims.
    const frame = window.getByTestId('crew-frame');
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute('data-members', ids.join(' '));
    await expect(frame).toContainText(/'s crew$/);
    await expect(frame).toHaveCSS('opacity', '0');
    await expect(window.getByTestId('from-chip')).toHaveCount(0);
    await expect(stranger).toHaveCSS('opacity', '1');

    // Hovering the orchestrator shows its frame, lights its crew and dims the user's own session.
    await lead.hover();
    await expect(frame).toHaveAttribute('data-focused', 'true');
    await expect(frame).toHaveCSS('opacity', '1');
    for (const member of [lead, ...workers]) await expect(member).toHaveAttribute('data-crew-lit', 'true');
    await expect(stranger).toHaveCSS('opacity', '0.4');
    await stranger.hover();
    await expect(frame).toHaveCSS('opacity', '0');
    await expect(stranger).toHaveCSS('opacity', '1');

    // Selected, it keeps them shown after the pointer leaves, until it is unselected.
    await lead.click();
    await stranger.hover();
    await expect(frame).toHaveCSS('opacity', '1');
    await expect(stranger).toHaveCSS('opacity', '0.4');
    await window.keyboard.press('Escape');
    await expect(frame).toHaveCSS('opacity', '0');
    await expect(stranger).toHaveCSS('opacity', '1');

    // The View popover has no crew row now; its Tethers switch is off by default and saved, as Settings shows.
    await window.getByRole('button', { name: 'View', exact: true }).click();
    const view = window.getByRole('dialog', { name: 'View', exact: true });
    await expect(view.getByRole('group', { name: 'Crews' })).toHaveCount(0);
    const tethers = view.getByRole('switch', { name: 'Tethers' });
    await expect(tethers).not.toBeChecked();
    await tethers.check();
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('tethers'))).toBe(true);
    await window.keyboard.press('Escape');
    await expect(view).toBeHidden();
    const settings = await openSettings(window, 'board.connections');
    await expect(settingsSection(settings, 'Connections').getByRole('switch', { name: 'Show tethers' })).toBeChecked();
    await settings.close();

    await lead.dblclick();
    await sessionWindow(window).getByRole('tab', { name: 'Activity' }).click();
    const lines = sessionWindow(window).getByTestId('activity-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText('started worker two');
    await expect(lines.nth(1)).toContainText('started worker one');

    // Tethers on is kept across a restart; the crew comes back framed, the frame still waiting for focus.
    await app.close();
    const again = await launch(dataDir, { ...env, ...SHELL_ENV });
    app = again.app;
    window = again.window;
    await expect(tile(window)).toHaveCount(4);
    await expect(window.getByTestId('crew-frame')).toHaveCount(1);
    await expect(window.getByTestId('crew-frame')).toHaveCSS('opacity', '0');
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('tethers'))).toBe(true);
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

test("under the Simplified design an orchestrator's worker that ends its turn on a question reads Working, not Needs you, and offers no Answer button", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV }, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Lead a worker that asks back');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(2, { timeout: 2 * TURN_MS });
    const worker = agentTile(window, 'worker asking');
    // Its turn ended asking, at its prompt: its orchestrator answers, so the user is not asked.
    await expect(worker).toHaveAttribute('data-state', /^(idle|waiting)$/, { timeout: 2 * TURN_MS });
    await expect(worker).toHaveAttribute('data-status', 'working');
    await expect(worker.locator('[data-testid="tile-action"][data-prominent]')).toHaveCount(0);
    await expect(worker).toContainText('With ');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("under the Simplified design an orchestrator's worker with an open pull request reads Working, not Needs you, with no Review changes button", async () => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [] });
  const { dir, repo, env } = scratch('orchestrate');
  // gh finds an agent's pull requests in the repo its worktree's remote names.
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV, AGENT_BOARD_GH: github.gh, AGENT_BOARD_PULL_REQUEST_POLL_MS: '200' }, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    const worker = agentTile(window, 'worker one');
    await expect(worker).toHaveAttribute('data-state', /^(idle|waiting)$/, { timeout: 2 * TURN_MS });

    // It opens a pull request, as a loose agent would: its orchestrator takes it, so the user is not asked to review.
    const [crewMember] = (await agents(window)).filter((each) => each.name === 'worker one');
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [
        {
          repo: 'acme/app',
          number: 41,
          title: 'Fix the flaky test',
          headRefName: crewMember!.branch,
          headRefOid: 'b'.repeat(40),
          state: 'OPEN',
          isDraft: false,
          body: '',
          statusCheckRollup: [],
          files: [],
          comments: [],
          reviewComments: [],
        },
      ],
    });
    await expect.poll(async () => (await agents(window)).find((each) => each.name === 'worker one')?.pullRequests.some((pr) => pr.state === 'open')).toBe(true);
    await expect(worker).toHaveAttribute('data-status', 'working');
    await expect(worker.locator('[data-testid="tile-action"][data-prominent]')).toHaveCount(0);
    await expect(worker).not.toContainText('Review changes');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
