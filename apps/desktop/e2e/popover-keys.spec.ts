import { expect } from '@playwright/test';
import { launch, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { connectedDaemonPid, launchApp, newShell, openAddZone, removeDataDir, stopDaemon, tempDataDir, test } from './launch.ts';

test("the board's single keys are a popover's own: N, T and S typed with a button focused in it do nothing, and work again once it closes", async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 300, pane.y + 250);
    const notes = window.getByTestId('sticky');
    const popover = await openAddZone(window, 'Group');
    const groupTab = popover.getByRole('tab', { name: 'Group' });
    await groupTab.focus();
    // Keys go to what has focus: wait until the popover does, not just until the call returned.
    await expect(groupTab).toBeFocused();

    for (const key of ['n', 't', 's']) await window.keyboard.press(key);
    await expect(notes).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'false');
    await expect(window.getByRole('button', { name: 'Shape' })).toHaveAttribute('aria-pressed', 'false');

    // Under load the popover's Escape handler can be attached a moment after it shows, so a press that comes first is
    // lost; press again until it closes.
    await expect(async () => {
      if (await popover.isVisible()) await window.keyboard.press('Escape');
      await expect(popover).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await window.mouse.move(pane.x + 300, pane.y + 250);
    await window.keyboard.press('n');
    await expect(notes).toHaveCount(1);
  } finally {
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});

test("the close key on a shell's only tab leaves the window open and says so once, however long it is held", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByTestId('session-terminal').click();

    // ⌘W, or Ctrl+Shift+W off macOS, held: the first press and its repeats.
    const modifiers = process.platform === 'darwin' ? ['Meta'] : ['Control', 'Shift'];
    for (const key of modifiers) await window.keyboard.down(key);
    await window.keyboard.down('w');
    await window.keyboard.down('w');
    await window.keyboard.down('w');
    await window.keyboard.up('w');
    for (const key of modifiers.toReversed()) await window.keyboard.up(key);

    await expect(window.getByText("A shell's only tab can't be closed.")).toHaveCount(1);
    await expect(sessionWindow(window)).toBeVisible();
  } finally {
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});
