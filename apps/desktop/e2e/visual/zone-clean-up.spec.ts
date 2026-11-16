import { expect } from '@playwright/test';
import { launch, listFinishedTurns, screen } from '../agent-helpers.ts';
import { busySpineZone, cleanUpFromMenu } from '../clean-up-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, pinRandomText, settle } from '../render.ts';
import { scratch } from '../scratch.ts';
import { SHOT, needsBaselines, nodesStill, viewSettled } from './shared.ts';

test.use({ viewport: null });

// A busy Spine zone after a Clean up, Classic light: its bands, a note gathered to the tail of its band, the finished
// ticket on the Done line under them, and the user's sticky and the tile dragged by hand where they were left.
test('a Spine zone after a Clean up: bands, a band tail and the Done line', async () => {
  needsBaselines('zone-cleaned-up');
  const { repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS);
  try {
    await listFinishedTurns(window);
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await busySpineZone(window);
    await cleanUpFromMenu(window);
    // The toast goes, so the shot is of the zone alone.
    await window.getByLabel('Notifications').getByRole('button', { name: 'Dismiss' }).click();
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await nodesStill(window);
    await pinRandomText(window);
    const restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('zone-cleaned-up.png', { ...SHOT, mask: [screen(window)] });
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
