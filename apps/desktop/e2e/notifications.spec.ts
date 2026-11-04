import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Agent } from '@agent-board/daemon/protocol';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import type { AppNotification, FakeNotification } from '../src/main/notifications.ts';
import { launch, listFinishedTurns, screen, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, type LaunchOptions, pickFolderNext, removeDataDir, stopDaemon, tempDataDir, browseForZone } from './launch.ts';
import type { FakeScenario } from '@agent-board/fake-harness';
import { scratch } from './scratch.ts';

/** The notifications the app raised so far, from its fake notifier (`AGENT_BOARD_FAKE_NOTIFICATIONS`). */
const notifications = (app: ElectronApplication): Promise<AppNotification[]> =>
  app.evaluate(() => (globalThis.agentBoardNotifications ?? []).map(({ sessionId, title, body }) => ({ sessionId, title, body })));

/** Clicks the `index`th notification the app raised. */
const clickNotification = (app: ElectronApplication, index: number) =>
  app.evaluate((_electron, i) => globalThis.agentBoardNotifications![i]!.click(), index);

/** The popped-out session window, as a handle in the app's main process (undefined while there is none). */
const poppedOut = (app: ElectronApplication) =>
  app.evaluateHandle(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('popOut=')),
  );

const badge = (app: ElectronApplication) => app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount());

const agentTile = (page: Page, agent: Agent) => tile(page).and(page.locator(`[data-session-id="${agent.sessionId}"]`));

/** Starts an agent in the repo's zone and returns it. */
async function spawn(page: Page, prompt: string): Promise<Agent> {
  const before = await page.evaluate(() => window.agentBoard.agents.list());
  await spawnAgent(page, 'monorepo', prompt);
  const after = await page.evaluate(() => window.agentBoard.agents.list());
  return after.find((agent) => !before.some((known) => known.sessionId === agent.sessionId))!;
}

/** Answers the one waiting agent from the needs-you inbox. */
async function answer(page: Page, text: string): Promise<void> {
  // The inbox opens from the Needs-you pill.
  if (!(await page.getByTestId('needs-you-inbox').isVisible())) await page.getByTestId('inbox-count').click();
  const item = page.getByTestId('inbox-item');
  await item.getByLabel('Answer').fill(text);
  await item.getByRole('button', { name: 'Send' }).click();
}

/**
 * Runs `body` with the app open on a fresh repo zone whose agents run the fake claude's waiting scenario, Needs you
 * listing every finished turn, so a waiting agent notifies; or with `scenario`, as by default: explicit requests only.
 */
async function withApp(
  body: (page: Page, app: ElectronApplication, dataDir: string) => Promise<void>,
  scenario?: FakeScenario,
  options: LaunchOptions = {},
): Promise<void> {
  const setup = scratch(scenario ?? 'waiting');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, setup.env, [], options);
  try {
    if (scenario === undefined) await listFinishedTurns(page);
    await pickFolderNext(app, setup.repo);
    await browseForZone(page);
    await body(page, app, dataDir);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(setup.dir, { recursive: true, force: true });
  }
}

test('by default notifies once per explicit request, with its reason, and never of a turn ending; clicking opens the agent', async () => {
  await withApp(async (page, app) => {
    const done = await spawn(page, 'Write the handover');
    await expect(agentTile(page, done)).toHaveAttribute('data-state', /idle|waiting/);
    const flagged = await spawn(page, 'Flag: PR #12 is ready for review.');
    await expect.poll(() => notifications(app)).toEqual([{ sessionId: flagged.sessionId, title: `${flagged.name} needs you`, body: 'PR #12 is ready for review.' }]);
    await expect.poll(() => badge(app)).toBe(1);

    await clickNotification(app, 0);
    await expect(page.getByTestId('session-window')).toHaveAttribute('data-session-id', flagged.sessionId);
    await expect.poll(() => badge(app)).toBe(0);
    expect(await notifications(app)).toHaveLength(1);
  }, 'orchestrate');
});

test('with finished turns listed, notifies once when an agent starts waiting, with the inbox size on the badge; clicking opens the agent', async () => {
  await withApp(async (page, app) => {
    expect(await badge(app)).toBe(0);
    const agent = await spawn(page, 'Pick a database');

    await expect.poll(() => notifications(app)).toEqual([
      { sessionId: agent.sessionId, title: 'Pick a database is waiting for you', body: 'Which database should I use, Postgres or SQLite?' },
    ]);
    await expect.poll(() => badge(app)).toBe(1);

    await clickNotification(app, 0);
    await expect(page.getByTestId('session-window')).toHaveAttribute('data-session-id', agent.sessionId);
    await expect(screen(page)).toContainText('Which database should I use');

    // Answered, it works and then waits again: a second notification for the new state change, not one per update.
    await page.getByRole('button', { name: 'Close session window' }).click();
    await answer(page, 'SQLite');
    await expect.poll(async () => (await notifications(app)).length).toBe(2);
    expect((await notifications(app))[1]).toMatchObject({ title: 'Pick a database is waiting for you', body: 'Going with SQLite.' });

    // EOF at its prompt ends it, as Ctrl-D does: an end is no request, so it notifies of nothing.
    await page.evaluate((sessionId) => window.agentBoard.sessions.write(sessionId, '\x04'), agent.sessionId);
    await expect.poll(() => badge(app)).toBe(0);
    expect(await notifications(app)).toHaveLength(2);
  });
});

test('a muted agent raises no notifications but still counts on the badge, until it is unmuted', async () => {
  await withApp(async (page, app) => {
    const agent = await spawn(page, 'Pick a database');
    await expect.poll(async () => (await notifications(app)).length).toBe(1);
    await tileAction(agentTile(page, agent), 'Mute notifications');
    await expect(agentTile(page, agent)).toHaveAttribute('data-muted', 'true');
    await expect(agentTile(page, agent).getByTestId('tile-muted')).toBeVisible();
    await answer(page, 'SQLite');
    await expect(page.getByTestId('inbox-last-message')).toHaveText('Going with SQLite.');
    expect(await badge(app)).toBe(1);
    expect(await notifications(app)).toHaveLength(1);

    await tileAction(agentTile(page, agent), 'Unmute notifications');
    await expect(agentTile(page, agent)).toHaveAttribute('data-muted', 'false');
    await answer(page, 'Ship it');
    await expect.poll(async () => (await notifications(app)).at(-1)?.body).toBe('Done: Ship it.');
  });
});

test('clicking a notification after the window was closed opens a new window on the agent', async () => {
  // Elsewhere the app quits with its last window, as there's no tray to keep it reachable yet.
  test.skip(process.platform !== 'darwin', 'only macOS keeps the app running with no windows');
  await withApp(async (page, app) => {
    const agent = await spawn(page, 'Pick a database');
    await expect.poll(async () => (await notifications(app)).length).toBe(1);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect.poll(() => app.windows().length).toBe(0);
    const reopened = app.waitForEvent('window');
    await clickNotification(app, 0);

    const next = await reopened;
    await expect(next.getByTestId('session-window')).toHaveAttribute('data-session-id', agent.sessionId);
  });
});

/** The page of every window the app has open: the board, a popped-out session, Settings. */
const windowsOpen = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()));

for (const state of ['hidden', 'minimised', 'closed'] as const) {
  test(`clicking a notification with the board's window ${state} brings back the one board window on the agent, never a second`, async () => {
    // Elsewhere the app quits with its last window, as there's no tray to keep it reachable yet.
    test.skip(state === 'closed' && process.platform !== 'darwin', 'only macOS keeps the app running with no windows');
    // A hidden (headless) window can't be minimised, and `hide()` changes nothing there, so hidden then only proves one window.
    test.skip(state === 'minimised' && process.env.AGENT_BOARD_HEADED !== '1', 'needs a window the OS draws');
    await withApp(async (page, app, dataDir) => {
      const agent = await spawn(page, 'Pick a database');
      await expect.poll(async () => (await notifications(app)).length).toBe(1);
      expect(await windowsOpen(app)).toHaveLength(1);

      if (state === 'hidden') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
      if (state === 'minimised') {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
        // macOS minimises with an animation: the click must find it done.
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true);
      }
      if (state === 'closed') {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
        await expect.poll(() => windowsOpen(app)).toHaveLength(0);
      }
      const reopened = state === 'closed' ? app.waitForEvent('window') : undefined;

      // Twice, as a banner clicked again, or the Dock icon's activation arriving with the click, would.
      await clickNotification(app, 0);
      await clickNotification(app, 0);

      const board = reopened === undefined ? page : await reopened;
      await expect(board.getByTestId('session-window')).toHaveAttribute('data-session-id', agent.sessionId);
      // Exactly one window, and it is the board: no blank page, no popped-out or Settings window.
      const urls = await windowsOpen(app);
      expect(urls).toHaveLength(1);
      expect(urls[0]).not.toMatch(/popOut=|settings=/);

      const log = readFileSync(join(dataDir, 'daemon.log'), 'utf8');
      const traced = log.split('\n').filter((line) => line.includes(`notification clicked: session ${agent.sessionId}`));
      expect(traced).toHaveLength(2);
      expect(traced[0]).toContain(`board window ${state}`);
    });
  });
}

test('a second launch on the same data dir exits and brings the running app\'s one board forward', async () => {
  await withApp(async (_page, app) => {
    await app.evaluate(({ app: electronApp }) => {
      (globalThis as { secondLaunches?: number }).secondLaunches = 0;
      electronApp.on('second-instance', () => ((globalThis as { secondLaunches?: number }).secondLaunches! += 1));
    });
    const { execPath, env } = await app.evaluate(() => ({ execPath: process.execPath, env: { ...process.env } as Record<string, string> }));
    const entry = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath());
    const second = spawnProcess(execPath, [entry], { env: { ...env, ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    second.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    // A second instance that kept running would hang here: give it a few seconds, and always end it.
    const stuck = setTimeout(() => second.kill('SIGKILL'), 15_000);
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve)).finally(() => {
      clearTimeout(stuck);
      second.kill('SIGKILL');
    });
    expect(code).toBe(0);
    expect(stderr).toContain('already running');
    await expect.poll(() => app.evaluate(() => (globalThis as { secondLaunches?: number }).secondLaunches)).toBe(1);
    const urls = await windowsOpen(app);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toMatch(/popOut=|settings=/);
  });
});

test('after the daemon goes away, the app reconnects by itself and catches up: the badge is right, and a restart raises no notification', async () => {
  await withApp(async (page, app, dataDir) => {
    await spawn(page, 'Pick a database');
    await expect.poll(() => badge(app)).toBe(1);
    const before = (await notifications(app)).length;

    // Its session goes with the daemon, so the daemon the app starts again finds it stopped by restart. The board's
    // restart banner says so; one notification per stopped agent would only add noise.
    await stopDaemon(dataDir);

    await expect
      .poll(async () => (await page.evaluate(() => window.agentBoard.agents.list())).map((each) => each.state), { timeout: 10_000 })
      .toEqual(['stopped-by-restart']);
    await expect.poll(() => badge(app)).toBe(0);
    expect((await notifications(app)).length).toBe(before);
  });
});

test("clicking the notification of an agent whose session window is popped out brings that window forward", async () => {
  await withApp(async (page, app) => {
    await spawn(page, 'Pick a database');
    await expect.poll(async () => (await notifications(app)).length).toBe(1);
    await clickNotification(app, 0);
    await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: 'Pop out session window' }).click()]);
    const poppedOutMinimised = async () => (await poppedOut(app)).evaluate((window) => window?.isMinimized());
    if (process.env.AGENT_BOARD_HEADED === '1') {
      // Shown once it has loaded; a hidden window can't be minimised.
      await expect.poll(async () => (await poppedOut(app)).evaluate((window) => window?.isVisible())).toBe(true);
      await (await poppedOut(app)).evaluate((window) => window!.minimize());
    } else {
      // Headless, as e2e runs, the window is never shown, so it can't be minimised for real: it says it is until restored.
      await (await poppedOut(app)).evaluate((window) => {
        let minimised = true;
        window!.isMinimized = () => minimised;
        window!.restore = () => void (minimised = false);
      });
    }
    await expect.poll(poppedOutMinimised).toBe(true);

    await clickNotification(app, 0);

    await expect.poll(poppedOutMinimised).toBe(false);
    // The board keeps it in its dock as out, rather than showing a second copy.
    await expect(page.getByTestId('session-window')).toHaveCount(0);
  });
});

/** The banners the app raised so far as they are drawn, with what they list under Options. */
const banners = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis.agentBoardNotifications ?? []).map(({ title, subtitle, body, answers }: FakeNotification) => ({ title, subtitle, body, answers })));

test('under the Simplified design, a question’s banner lists its answers and picking one answers it, once', async () => {
  await withApp(
    async (page, app) => {
      const agent = await spawn(page, 'Ask: Which cache should the product pages use? | Redis | CDN only');
      await expect.poll(() => banners(app)).toEqual([
        {
          title: agent.name,
          subtitle: 'Question',
          body: 'Which cache should the product pages use?',
          answers: ['Redis', 'CDN only'],
        },
      ]);

      await app.evaluate(() => globalThis.agentBoardNotifications![0]!.answer(1));

      await expect.poll(() => badge(app)).toBe(0);
      expect(await banners(app)).toHaveLength(1);
      // The answer picked, "CDN only", is what reached the agent.
      await clickNotification(app, 0);
      // Whether its window opens on the chat or the terminal, it says so.
      await expect(page.getByTestId('session-window')).toContainText('The user answered: CDN only');
    },
    'orchestrate',
    { design: 'simplified' },
  );
});

test('under the Simplified design, a permission banner offers nothing to answer with: it opens the agent', async () => {
  await withApp(
    async (page, app) => {
      const agent = await spawn(page, 'Run the tests');
      await expect.poll(async () => (await banners(app)).length).toBe(1);
      expect((await banners(app))[0]).toMatchObject({ title: agent.name, subtitle: 'Permission', answers: [] });

      await clickNotification(app, 0);
      await expect(page.getByTestId('session-window')).toHaveAttribute('data-session-id', agent.sessionId);
    },
    'permission',
    { design: 'simplified' },
  );
});
