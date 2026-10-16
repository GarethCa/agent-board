import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { isProcessAlive } from '@agent-board/daemon/pid';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch, screen, sessionWindow, SHELL_ENV, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, browseForZone, newShell } from './launch.ts';
import { scratch } from './scratch.ts';

const dockItem = (page: Page) => page.getByTestId('dock-item');
const banner = (page: Page) => page.getByTestId('restart-banner');
const viewport = (page: Page) => page.locator('.react-flow__viewport').getAttribute('style');

/** Kills the app and its daemon at once, with no chance to tidy up, as a power cut or a crash would. */
async function killHard(app: ElectronApplication, daemonPid: number): Promise<void> {
  const appPid = app.process().pid!;
  process.kill(daemonPid, 'SIGKILL');
  process.kill(appPid, 'SIGKILL');
  for (let waited = 0; (isProcessAlive(daemonPid) || isProcessAlive(appPid)) && waited < 5_000; waited += 50) await sleep(50);
}

test('the board looks the same after the app and daemon are killed hard, and resuming brings its agent and shell back', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const appEnv = { ...env, ...SHELL_ENV };
  const apps: ElectronApplication[] = [];
  try {
    const first = await launch(dataDir, appEnv);
    apps.push(first.app);
    const { window } = first;
    await pickFolderNext(first.app, repo);
    await browseForZone(window);
    await window.getByRole('button', { name: 'Sticky' }).click();
    await expect(window.getByTestId('sticky')).toHaveCount(1);

    // An agent, moved to a place of its own in the zone, waiting on its question.
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    // `self`: this test's `window` is the board's page.
    await window.evaluate(async () => {
      const [agent] = await self.agentBoard.agents.list();
      await self.agentBoard.agents.move(agent!.sessionId, { zoneId: agent!.zoneId, x: 420, y: 260 });
    });

    // A panned and zoomed view: wheel zooms about the pointer, so two turns at two places also move it.
    const board = window.locator('.react-flow__pane');
    const box = (await board.boundingBox())!;
    await window.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await window.mouse.wheel(0, -240);
    await window.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
    await window.mouse.wheel(0, 120);

    // A shell, moved into the zone's web app, docked; and the agent's window shown.
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.keyboard.type('cd apps/web && echo here-$((40 + 2))');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('shell-pane')).toContainText('here-42');
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await tile(window).dblclick();
    await expect(screen(window)).toContainText('Which database should I use');

    // Long enough for every debounced save: the view, the windows, and the sessions' screens and folders (once their
    // output has been quiet for 2 s).
    await sleep(4_000);
    const before = {
      viewport: await viewport(window),
      tile: await tile(window).boundingBox(),
      sticky: await window.getByTestId('sticky').boundingBox(),
    };
    await killHard(first.app, await connectedDaemonPid(window));

    const second = await launch(dataDir, appEnv);
    apps.push(second.app);
    const again = second.window;

    // It looks the same: the view, the zone, the note and the tile where they were, the windows as they were left.
    await expect(tile(again)).toHaveAttribute('data-state', 'stopped-by-restart');
    expect(await viewport(again)).toBe(before.viewport);
    expect(await tile(again).boundingBox()).toEqual(before.tile);
    expect(await again.getByTestId('sticky').boundingBox()).toEqual(before.sticky);
    await expect(again.getByTestId('zone')).toHaveCount(1);
    await expect(sessionWindow(again)).toHaveAttribute('data-session-id', /.+/);
    await expect(dockItem(again)).toHaveCount(1);
    await expect(dockItem(again)).toHaveAttribute('data-placement', 'docked');
    // The agent's last output is still there, before anything is resumed.
    await expect(screen(again)).toContainText('Which database should I use');
    await expect(banner(again)).toHaveAttribute('data-count', '2');
    // In the shown window, not over its title bar.
    await expect(sessionWindow(again).getByTestId('restart-banner')).toBeVisible();
    await expect(banner(again)).toContainText(/^2 sessions stopped when your (Mac|computer) restarted/);
    const stopped = await again.evaluate(() => self.agentBoard.agents.list());
    expect(stopped.map((agent: Agent) => agent.endedAt)).toEqual([expect.any(String)]);

    // Resume all: the agent carries on its conversation, and the shell starts again where it was.
    await banner(again).getByRole('button', { name: 'Resume all' }).click();
    await expect(banner(again)).toBeHidden();
    await expect(tile(again)).not.toHaveAttribute('data-state', 'stopped-by-restart');
    await expect(screen(again)).toContainText('Which database should I use');
    await again.getByTestId('session-terminal').click();
    await again.keyboard.type('SQLite');
    await again.keyboard.press('Enter');
    await expect(screen(again)).toContainText('Done: SQLite.');

    // Near its start: a shell's dock button carries its whole folder, wider than the chip it sits in.
    await dockItem(again).getByRole('button', { name: /^Shell/ }).click({ position: { x: 16, y: 8 } });
    const pane = again.getByTestId('shell-pane');
    await expect(pane).toContainText('restored');
    await expect(pane).toContainText('here-42');
    await pane.click();
    await again.keyboard.type('pwd -P');
    await again.keyboard.press('Enter');
    await expect(pane).toContainText(`${repo}/apps/web`);
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Dismiss puts the banner away for good, and each stopped tile keeps its own Resume', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const apps: ElectronApplication[] = [];
  try {
    const first = await launch(dataDir, env);
    apps.push(first.app);
    await pickFolderNext(first.app, repo);
    await browseForZone(first.window);
    await spawnAgent(first.window, 'monorepo', 'Pick a database');
    await expect(tile(first.window)).toHaveAttribute('data-state', 'waiting');
    await killHard(first.app, await connectedDaemonPid(first.window));

    const second = await launch(dataDir, env);
    apps.push(second.app);
    await expect(banner(second.window)).toContainText(/^1 session stopped/);
    await banner(second.window).getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner(second.window)).toBeHidden();
    await second.app.close();

    const third = await launch(dataDir, env);
    apps.push(third.app);
    await expect(tile(third.window)).toHaveAttribute('data-state', 'stopped-by-restart');
    await expect(banner(third.window)).toBeHidden();
    await tile(third.window).getByTestId('resume').click();
    await expect(tile(third.window)).not.toHaveAttribute('data-state', 'stopped-by-restart');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An agent stopped by a hard kill, on the relaunched app, with its session window open. */
async function stoppedAgentWindow(dir: string, repo: string, env: Record<string, string>, dataDir: string, apps: ElectronApplication[]) {
  const window = await stoppedAgent(dir, repo, env, dataDir, apps);
  await tile(window).dblclick();
  return window;
}

/** An agent stopped by a hard kill, on the relaunched app. */
async function stoppedAgent(dir: string, repo: string, env: Record<string, string>, dataDir: string, apps: ElectronApplication[]) {
  const first = await launch(dataDir, env);
  apps.push(first.app);
  await pickFolderNext(first.app, repo);
  await browseForZone(first.window);
  await spawnAgent(first.window, 'monorepo', 'Pick a database');
  await expect(tile(first.window)).toHaveAttribute('data-state', 'waiting');
  await killHard(first.app, await connectedDaemonPid(first.window));
  const again = await launch(dataDir, env);
  apps.push(again.app);
  await expect(tile(again.window)).toHaveAttribute('data-state', 'stopped-by-restart');
  return again.window;
}

test("a stopped agent's tile keeps its stopped pill, and Resume agent in its ⋯ menu carries it on", async () => {
  const apps: ElectronApplication[] = [];
  const dataDir = tempDataDir();
  const { dir, repo, env } = scratch('waiting');
  try {
    const window = await stoppedAgent(dir, repo, env, dataDir, apps);
    const pill = tile(window).locator('.hybrid-tile-footer .ui-pill');
    await expect(pill).toHaveText('stopped');
    await expect(pill).toHaveAttribute('data-state', 'stopped-by-restart');
    await tileAction(tile(window), 'Resume agent');
    await expect(tile(window)).not.toHaveAttribute('data-state', 'stopped-by-restart');
    await expect(pill).not.toHaveText(/ended|stopped/);
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stopped agent's banner says why and offers Resume, which carries it on", async () => {
  const apps: ElectronApplication[] = [];
  const dataDir = tempDataDir();
  const { dir, repo, env } = scratch('waiting');
  try {
    const window = await stoppedAgentWindow(dir, repo, env, dataDir, apps);
    const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
    const view = sessionWindow(window).getByRole('group', { name: 'View' });
    await expect(sessionWindow(window).getByTestId('agent-blocked-banner')).toContainText('Stopped by a restart');
    await expect(composer).toHaveCount(0);
    await view.getByRole('button', { name: 'Chat' }).click();
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute('placeholder', 'Stopped by a restart');
    await sessionWindow(window).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(tile(window)).not.toHaveAttribute('data-state', 'stopped-by-restart');
    await expect(composer).toBeEnabled();
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Resume the daemon refuses shows its reason in the banner', async () => {
  const apps: ElectronApplication[] = [];
  const dataDir = tempDataDir();
  const { dir, repo, env } = scratch('waiting');
  try {
    const window = await stoppedAgentWindow(dir, repo, env, dataDir, apps);
    // Its worktree is gone, so there is nothing to resume in.
    rmSync(join(dir, 'worktrees'), { recursive: true, force: true });
    await sessionWindow(window).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(sessionWindow(window).getByTestId('agent-blocked-banner')).toContainText("can't be resumed");
    await expect(tile(window)).toHaveAttribute('data-state', 'stopped-by-restart');
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a popped-out window opens again where it was when the app quit', async () => {
  const dataDir = tempDataDir();
  const apps: ElectronApplication[] = [];
  const place = { x: 140, y: 120, width: 700, height: 460 };
  /** The bounds of the app's OS window that isn't the board. */
  const poppedBounds = (app: ElectronApplication) =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((each) => each.getTitle().startsWith('Shell'))?.getBounds());
  try {
    const first = await launch(dataDir, SHELL_ENV);
    apps.push(first.app);
    await newShell(first.window);
    await expect(sessionWindow(first.window)).toHaveAttribute('data-state', 'attached');
    const [popped] = await Promise.all([
      first.app.waitForEvent('window'),
      first.window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    await first.app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows().find((each) => each.getTitle().startsWith('Shell'))!.setBounds(bounds);
    }, place);
    await expect.poll(() => poppedBounds(first.app)).toEqual(place);
    // Long enough for the place and the windows to be saved.
    await sleep(1_000);
    await first.app.close();

    const second = await launchApp(dataDir, SHELL_ENV);
    apps.push(second);
    const board = await second.firstWindow();
    await expect(dockItem(board)).toHaveAttribute('data-placement', 'popped');
    await expect.poll(() => poppedBounds(second), { timeout: 10_000 }).toEqual(place);
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
