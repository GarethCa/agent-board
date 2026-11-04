import { expect, type ElectronApplication } from '@playwright/test';
import { agents, launch, SHELL_ENV } from './agent-helpers.ts';
import { connectedDaemonPid, killHard, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

test('the Captain button opens a Captain a restart stopped, with a Resume that brings it back', async () => {
  const { env } = scratch('waiting');
  const dataDir = tempDataDir();
  const appEnv = { ...env, ...SHELL_ENV };
  const apps: ElectronApplication[] = [];
  try {
    const first = await launch(dataDir, appEnv);
    apps.push(first.app);
    await first.window.getByTestId('master-button').click();
    await first.window.getByTestId('master-start').click();
    await expect(first.window.getByTestId('master-badge')).toHaveCount(1);
    await killHard(first.app, await connectedDaemonPid(first.window));

    const second = await launch(dataDir, appEnv);
    apps.push(second.app);
    const again = second.window;
    await expect.poll(async () => (await agents(again)).find((agent) => agent.master)?.state).toBe('stopped-by-restart');
    await again.getByTestId('master-button').click();
    await expect(again.getByTestId('master-panel')).toBeVisible();
    await expect(again.getByTestId('master-revive')).toContainText('stopped by a restart');
    await again.getByTestId('master-resume').click();
    await expect(again.getByTestId('master-revive')).toHaveCount(0);
    await expect.poll(async () => (await agents(again)).find((agent) => agent.master)?.endedAt).toBeNull();
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
