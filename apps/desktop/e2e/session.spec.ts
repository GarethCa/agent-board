import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { isProcessAlive } from '@agent-board/daemon/pid';
import type { SessionInfo } from '@agent-board/daemon/protocol';
import { sessionItems, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir, newShell } from './launch.ts';

async function launch(dataDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await launchApp(dataDir, SHELL_ENV);
  const window = await app.firstWindow();
  await connectedDaemonPid(window);
  return { app, window };
}

const liveSessions = (page: Page): Promise<SessionInfo[]> => page.evaluate(() => window.agentBoard.sessions.list());

/** Types a command into the open session window's terminal. */
async function run(window: Page, command: string): Promise<void> {
  await window.getByTestId('session-terminal').click();
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

const screen = (window: Page) => window.getByTestId('session-terminal').locator('.xterm-rows');

test('a shell session takes input, shows output and follows the window size; closing the window leaves it running', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');

    await run(window, 'echo hello-$((40 + 2))');
    await expect(screen(window)).toContainText('hello-42');

    const [before] = await liveSessions(window);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(900, 600));
    await expect.poll(async () => (await liveSessions(window))[0]?.cols).not.toBe(before!.cols);
    const [resized] = await liveSessions(window);
    await run(window, 'stty size');
    await expect(screen(window)).toContainText(`${resized!.rows} ${resized!.cols}`);

    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await expect(await sessionItems(window)).toHaveCount(1);
    expect(isProcessAlive(resized!.pid)).toBe(true);

    await (await sessionItems(window)).getByRole('button', { name: 'Open' }).click();
    await expect(screen(window)).toContainText('hello-42');
    await run(window, 'echo again-$((6 * 7))');
    await expect(screen(window)).toContainText('again-42');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('stopping a session from its window ends the process and shows it has exited', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const [session] = await liveSessions(window);

    await sessionWindow(window).getByRole('button', { name: 'Stop' }).click();

    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'exited');
    await expect(window.getByTestId('session-window-status')).toHaveText(/exited/);
    expect(isProcessAlive(session!.pid)).toBe(false);
    expect(await liveSessions(window)).toEqual([]);
    await expect(await sessionItems(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a session that ends while its window is closed drops off the list', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(await sessionItems(window)).toHaveCount(1);
    const [session] = await liveSessions(window);

    process.kill(session!.pid, 'SIGKILL');

    await expect(await sessionItems(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('quitting and relaunching the app reattaches to a running session with its output intact', async () => {
  const dataDir = tempDataDir();
  const apps: ElectronApplication[] = [];
  try {
    const first = await launch(dataDir);
    apps.push(first.app);
    await newShell(first.window);
    await expect(sessionWindow(first.window)).toHaveAttribute('data-state', 'attached');
    await run(first.window, 'echo before-restart-$((6 * 7))');
    await expect(screen(first.window)).toContainText('before-restart-42');
    const [session] = await liveSessions(first.window);
    await first.app.close();

    expect(isProcessAlive(session!.pid)).toBe(true);
    const second = await launch(dataDir);
    apps.push(second.app);
    await expect(await sessionItems(second.window)).toHaveCount(1);
    // Its window was open when the app quit, so it opens again.
    await expect(sessionWindow(second.window)).toHaveAttribute('data-state', 'attached');

    await expect(screen(second.window)).toContainText('before-restart-42');
    await run(second.window, 'echo after-restart-$((6 * 8))');
    await expect(screen(second.window)).toContainText('after-restart-48');
    expect((await liveSessions(second.window)).map((live) => live.pid)).toEqual([session!.pid]);
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
