import { expect } from '@playwright/test';
import { launch, sessionWindow } from '../agent-helpers.ts';
import { newShell, removeDataDir, tempDataDir, test } from '../launch.ts';
import { RENDER_ARGS, RENDER_ENV, VIEWPORT, ignorePointer, pinFonts, settle } from '../render.ts';
import { SHOT, needsBaselines } from './shared.ts';

test.use({ viewport: null });

// The Dock setting (Settings › Board › Opening tiles › Dock) on a board with two minimised shells, one of them pinned: Only what I pin
// keeps the pinned one in the dock, with its pin; Off has no dock and the board's bottom row is free. Show everything,
// the default, is the existing session-dock shots, which this change leaves as they were.
const MODES = [
  { dock: 'pinned' as const, shot: 'dock-pinned' },
  { dock: 'off' as const, shot: 'dock-off' },
];
const THEMES = [
  { theme: 'light', suffix: '' },
  { theme: 'dark', suffix: '-dark' },
] as const;

for (const { dock, shot } of MODES) {
  for (const { theme, suffix } of THEMES) {
    test(`the board with the dock on ${dock}, ${theme}`, async () => {
      needsBaselines(`${shot}${suffix}`);
      const dataDir = tempDataDir();
      const appearance: Record<string, string> = theme === 'dark' ? { AGENT_BOARD_APPEARANCE: 'dark' } : {};
      const { app, window } = await launch(dataDir, { ...RENDER_ENV, ...appearance, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { dock });
      try {
        await window.setViewportSize(VIEWPORT);
        await pinFonts(window);
        // One shell pinned (when the dock is on pins) and minimised, one minimised unpinned.
        for (const pinned of [true, false]) {
          await newShell(window);
          await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
          if (pinned && dock === 'pinned') await window.getByRole('button', { name: 'Pin to the dock' }).click();
          await window.getByRole('button', { name: 'Minimise session window' }).click();
          await expect(sessionWindow(window)).toBeHidden();
        }
        await expect(window.getByTestId('dock-item')).toHaveCount(dock === 'pinned' ? 1 : 0);
        // The toast that says where an unpinned window went is not what these shots are of.
        for (const dismiss = window.getByRole('button', { name: 'Dismiss' }); await dismiss.count() > 0; ) await dismiss.first().click();
        await expect(window.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
        const restorePointer = await ignorePointer(window);
        await settle(window);
        await expect.soft(window.locator('.board')).toHaveScreenshot(`${shot}${suffix}.png`, SHOT);
        await restorePointer();
      } finally {
        await app.close();
        await removeDataDir(dataDir);
      }
    });
  }
}

// The session window's header in Only what I pin, with its pin button unpinned and then pressed, and the Captain's panel
// open with the dock Off: it reaches the board's bottom edge where the dock used to be.
test('the header pin button, unpinned and pinned, and the Captain panel with the dock off', async () => {
  needsBaselines('dock-header-pin', 'dock-header-pinned', 'dock-off-captain');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...RENDER_ENV, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' }, RENDER_ARGS, { dock: 'pinned' });
  try {
    await window.setViewportSize(VIEWPORT);
    await pinFonts(window);
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const head = sessionWindow(window).locator('.session-window-head');
    let restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(head).toHaveScreenshot('dock-header-pin.png', SHOT);
    await restorePointer();
    await window.getByRole('button', { name: 'Pin to the dock' }).click();
    await expect(window.getByRole('button', { name: 'Unpin from the dock' })).toBeVisible();
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(head).toHaveScreenshot('dock-header-pinned.png', SHOT);
    await restorePointer();

    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await window.getByRole('button', { name: 'Dismiss' }).click({ timeout: 1000 }).catch(() => {});
    await window.evaluate(() => globalThis.window.agentBoard.dock.set('off'));
    await expect(window.getByTestId('session-dock')).toHaveCount(0);
    await window.getByRole('button', { name: 'Captain' }).click();
    await expect(window.getByTestId('master-panel')).toBeVisible();
    restorePointer = await ignorePointer(window);
    await settle(window);
    await expect.soft(window.locator('.board')).toHaveScreenshot('dock-off-captain.png', SHOT);
    await restorePointer();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
