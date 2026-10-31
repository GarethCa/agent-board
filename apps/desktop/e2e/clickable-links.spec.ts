import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

test('the clickable links switch is on, offers to restart running Claude agents when it changes, and never restarts on its own', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    const pidOf = async () => (await window.evaluate(() => globalThis.window.agentBoard.sessions.list())).find((session) => session.harness === 'claude')?.pid;
    const startedWithLinks = async () => (await agents(window))[0]!.clickableLinks;
    const before = await pidOf();
    // Started with the setting on.
    expect(await startedWithLinks()).toBe(true);

    const settings = await openSettings(window, 'agents.links');
    const links = settingsSection(settings, 'Links').getByRole('switch', { name: 'Clickable links from Claude' });
    const offer = settings.getByTestId('clickable-links-restart');
    await expect(links).toBeChecked();
    await expect(offer).toHaveCount(0);

    // Turning it off keeps the agent as it is and offers a restart.
    await links.click();
    await expect(links).not.toBeChecked();
    await expect(offer).toContainText('1 running Claude agent started with it');
    expect((await agents(window))[0]!.endedAt).toBeNull();

    // Later drops the offer without touching the agent.
    await offer.getByRole('button', { name: 'Later' }).click();
    await expect(offer).toHaveCount(0);
    expect((await agents(window))[0]!.endedAt).toBeNull();

    // Turning it back on matches how the agent started: nothing to offer.
    await links.click();
    await expect(links).toBeChecked();
    await expect(offer).toHaveCount(0);

    // Off again, and Restart ends the session and starts it again, now without it.
    await links.click();
    await expect(offer).toContainText('started with it');
    await offer.getByRole('button', { name: 'Restart it' }).click();
    await expect(offer).toHaveCount(0);
    await expect.poll(async () => {
      const now = await pidOf();
      return now !== undefined && now !== before;
    }).toBe(true);
    await expect.poll(startedWithLinks).toBe(false);
    expect((await agents(window))[0]!.endedAt).toBeNull();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
