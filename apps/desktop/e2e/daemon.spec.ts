import { expect, type ElectronApplication } from '@playwright/test';
import { isProcessAlive } from '@agent-board/daemon/pid';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

test('launching the app starts the daemon once, and a second instance reuses it', async () => {
  const dataDir = tempDataDir();
  const apps: ElectronApplication[] = [];
  try {
    const env = { AGENT_BOARD_DAEMON_IDLE_TIMEOUT_MS: '500' };
    const first = await launchApp(dataDir, env);
    apps.push(first);
    const pid = await connectedDaemonPid(await first.firstWindow());
    expect(pid).not.toBe(first.process().pid);

    const second = await launchApp(dataDir, env);
    apps.push(second);
    expect(await connectedDaemonPid(await second.firstWindow())).toBe(pid);

    // The daemon outlives the first app, and goes once no client and no session is left.
    await first.close();
    expect(isProcessAlive(pid)).toBe(true);
    await second.close();
    await expect.poll(() => isProcessAlive(pid), { timeout: 10_000 }).toBe(false);
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test('a daemon that cannot start is reported in the window with its reason, without a long wait, and the board can retry', async () => {
  const dataDir = tempDataDir();
  // A database from a newer build: the daemon refuses it at startup.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${dataDir}/agent-board.db`);
  db.exec('PRAGMA user_version = 99');
  db.close();
  const app = await launchApp(dataDir);
  try {
    const status = (await app.firstWindow()).getByTestId('daemon-status');
    await expect(status).toHaveAttribute('data-state', 'error', { timeout: 5_000 });
    await expect(status).toContainText('newer than this daemon knows');

    // The board says it could not load, and loads once the daemon can start.
    const window = await app.firstWindow();
    await expect(window.getByRole('alert')).toContainText('Could not load the board');
    const fixed = new DatabaseSync(`${dataDir}/agent-board.db`);
    fixed.exec('PRAGMA user_version = 0');
    fixed.close();
    await window.getByRole('button', { name: 'Retry' }).click();
    await expect(window.getByRole('button', { name: 'Zone', exact: true })).toBeVisible();
    await expect(window.getByRole('alert')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
