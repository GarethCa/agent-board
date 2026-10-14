import { expect } from '@playwright/test';
import { isProcessAlive } from '@agent-board/daemon/pid';
import { existsSync } from 'node:fs';
import { connectedDaemonPid, daemonsServing, launchApp, reapedDataDirs, tempDataDir, test } from './launch.ts';

// The two tests run in order in one worker: the first leaves an app and its daemon (with a long idle timeout, so it
// would run on) for the teardown after every test to reap, and the second checks that it did.
let leftBy: { dataDir: string; pid: number } | undefined;

test('a test that leaves its app and daemon running', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, { AGENT_BOARD_DAEMON_IDLE_TIMEOUT_MS: '3600000' });
  const pid = await connectedDaemonPid(await app.firstWindow());
  expect(daemonsServing([dataDir])).toContain(pid);
  leftBy = { dataDir, pid };
});

test('after that test finished, its daemon was gone and its data dir removed', () => {
  expect(leftBy).toBeDefined();
  const { dataDir, pid } = leftBy!;
  expect(reapedDataDirs).toContain(dataDir);
  expect(isProcessAlive(pid)).toBe(false);
  expect(daemonsServing(reapedDataDirs)).toEqual([]);
  expect(existsSync(dataDir)).toBe(false);
});
