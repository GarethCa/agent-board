import { _electron as electron, expect } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedApp } from './packaged-app.ts';
import { test, BACKGROUND_ENV, connectedDaemonPid, removeDataDir, tempDataDir } from './launch.ts';

test('the packaged app launches, starts its own daemon, and runs a shell session in a PTY', async () => {
  const appPath = packagedApp(fileURLToPath(new URL('..', import.meta.url)));
  const dataDir = tempDataDir();
  const app = await electron.launch({
    executablePath: join(appPath, 'Contents', 'MacOS', 'agent-board'),
    env: {
      ...process.env,
      ...BACKGROUND_ENV,
      AGENT_BOARD_DATA_DIR: dataDir,
      AGENT_BOARD_HOOK_SHIM: join(dataDir, 'bin', 'agent-board-hook'),
    },
  });
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle(/^agent-board · [0-9a-f]{7,}(-dirty)? · \d{4}-\d{2}-\d{2}$/);
    const pid = await connectedDaemonPid(window);
    await expect(window.getByTestId('build-mismatch')).toHaveCount(0);

    // The daemon is the packaged executable run as Node, and node-pty loads in it.
    expect(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()).toBe(
      join(appPath, 'Contents', 'MacOS', 'agent-board'),
    );
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    try {
      const session = await client.call('session.createShell', { cols: 80, rows: 24 });
      expect(session.endedAt).toBeNull();
      await client.call('session.kill', { sessionId: session.id });
    } finally {
      client.close();
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
