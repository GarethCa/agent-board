import { expect } from '@playwright/test';
import { agents, launch, SHELL_ENV, spawnAgent, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { rmSync } from 'node:fs';
import { scratch } from './scratch.ts';

// The Simplified pane's "Since you last looked": what finished since the Needs-you list was last in view, from the app.

test('an agent that finishes while the list is away is in Done when it is reopened, until Mark as seen', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV }, [], { design: 'simplified' });
  try {
    const pane = window.getByTestId('master-panel');
    const needsYou = window.getByTestId('inbox-count');
    const digest = pane.getByTestId('since-looked');

    // A first look: nothing to have missed, so no card.
    await needsYou.click();
    await expect(pane.getByTestId('needs-you-inbox')).toBeVisible();
    await expect(digest).toHaveCount(0);
    await needsYou.click();
    await expect(pane).toHaveCount(0);

    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Gate in the background');
    // It says its work is finished (the tile's own badge is Classic's).
    await expect.poll(async () => (await agents(window))[0]?.workFinishedAt ?? null, { timeout: TURN_MS }).not.toBeNull();

    await needsYou.click();
    await expect(digest).toBeVisible();
    await expect(digest.getByTestId('since-looked-done')).toHaveCount(1);
    await expect(digest.getByTestId('since-looked-done')).toContainText('Gate in the background');
    // Nothing from the Captain: no Up next, and nothing made up.
    await expect(digest.getByTestId('since-looked-next')).toHaveCount(0);

    // Mark as seen clears it for good; a reopen finds nothing new.
    await digest.getByTestId('since-looked-seen').click();
    await expect(digest).toHaveCount(0);
    await needsYou.click();
    await needsYou.click();
    await expect(pane.getByTestId('needs-you-inbox')).toBeVisible();
    await expect(digest).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('under Classic the Captain panel has no such digest', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await window.getByTestId('master-button').click();
    await expect(window.getByTestId('master-panel')).toBeVisible();
    await expect(window.getByTestId('since-looked')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
