import { expect } from '@playwright/test';
import { connectDaemon, ensureDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import { isProcessAlive } from '@agent-board/daemon/pid';
import { spawnDetachedDaemon } from '@agent-board/daemon/spawn';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test, daemonEntry, launchApp, removeDataDir, tempDataDir } from './launch.ts';

const OLD_BUILD = { sha: '0000000', date: '2026-01-01T00:00:00Z' };
const electronBinary = createRequire(import.meta.url)('electron') as string;

/** Starts the built daemon claiming another build, as one left running across an upgrade would, and returns its pid. */
async function startOldDaemon(dataDir: string): Promise<number> {
  const paths = daemonPaths(dataDir);
  const client = await ensureDaemon({
    socketPath: paths.socket,
    start: () =>
      spawnDetachedDaemon({
        command: electronBinary,
        args: [daemonEntry, 'daemon', '--data-dir', dataDir],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          AGENT_BOARD_FAKE_DAEMON_BUILD: JSON.stringify(OLD_BUILD),
          AGENT_BOARD_HOOK_SHIM: join(dataDir, 'bin', 'agent-board-hook'),
        },
        logPath: paths.log,
      }),
  });
  try {
    return (await client.call('daemon.health')).pid;
  } finally {
    client.close();
  }
}

test('the app shows no board on a daemon from another build, only the offer to restart it as its own', async () => {
  const dataDir = tempDataDir();
  const oldDaemon = await startOldDaemon(dataDir);
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    const mismatch = window.getByTestId('build-mismatch');
    await expect(mismatch).toContainText('The daemon is from build 0000000 · 2026-01-01');
    // This build can't read another's state, so the board, and its chrome, wait for the restart.
    await expect(window.locator('.react-flow__pane')).toHaveCount(0);
    await expect(window.getByTestId('daemon-status')).toHaveCount(0);

    await mismatch.getByRole('button', { name: 'Restart daemon' }).click();

    await expect.poll(() => isProcessAlive(oldDaemon)).toBe(false);
    // The window reloads once this build's daemon is up: wait for the new page to show it.
    const status = window.getByTestId('daemon-status');
    await expect(status).toHaveAttribute('data-state', 'connected');
    await expect(status).not.toHaveAttribute('data-pid', String(oldDaemon));
    await expect(mismatch).toBeHidden();
    await expect(window.locator('.react-flow__pane')).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('restarting a daemon from another build warns first about sessions started after the banner appeared', async () => {
  const dataDir = tempDataDir();
  const oldDaemon = await startOldDaemon(dataDir);
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    const mismatch = window.getByTestId('build-mismatch');
    await expect(mismatch).toBeVisible();
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    await client.call('session.createShell', { cols: 80, rows: 24 });
    client.close();

    await mismatch.getByRole('button', { name: 'Restart daemon' }).click();
    await expect(mismatch).toContainText('Restarting it ends 1 running session.');

    await mismatch.getByRole('button', { name: 'Cancel' }).click();
    await expect(mismatch.getByRole('button', { name: 'Restart daemon' })).toBeVisible();
    expect(isProcessAlive(oldDaemon)).toBe(true);

    await mismatch.getByRole('button', { name: 'Restart daemon' }).click();
    await mismatch.getByRole('button', { name: 'Restart anyway' }).click();

    await expect.poll(() => isProcessAlive(oldDaemon)).toBe(false);
    await expect(mismatch).toBeHidden();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
