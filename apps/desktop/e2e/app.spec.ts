import { expect } from '@playwright/test';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir, newShell } from './launch.ts';

test('the built app opens a window titled agent-board, with the commit it was built from', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle(/^agent-board · [0-9a-f]{7,}(-dirty)? · \d{4}-\d{2}-\d{2}$/);
    await expect(window.getByRole('heading', { name: 'agent-board' })).toBeVisible();
    await connectedDaemonPid(window);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('the app runs under the harness guard, so a spawned claude would hit a tripwire', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const path = await app.evaluate(() => process.env.PATH ?? '');
    expect(path.split(':')[0]).toBe(process.env.AGENT_BOARD_HARNESS_GUARD_DIR);
    await connectedDaemonPid(await app.firstWindow());
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('the character gallery shows all nine poses, in a bean body for Claude and a block body for Codex', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await window.evaluate(() => {
      location.hash = '#gallery';
      location.reload();
    });
    const gallery = window.getByTestId('character-gallery');
    await expect(gallery).toBeVisible();
    const poses = ['running', 'thinking', 'waiting', 'needs-permission', 'idle', 'rate-limited', 'failed', 'done', 'handing-off'];
    for (const pose of poses) {
      const characters = gallery.locator(`[data-testid="character"][data-pose="${pose}"]`);
      await expect(characters.and(window.locator('[data-body="bean"]'))).toBeVisible();
      await expect(characters.and(window.locator('[data-body="block"]'))).toBeVisible();
    }
    await expect(gallery.getByTestId('character')).toHaveCount(poses.length * 2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('headless, no window is ever on screen, yet the board and a popped-out window render and take input', async () => {
  test.skip(process.env.AGENT_BOARD_HEADED === '1', 'AGENT_BOARD_HEADED=1 shows the windows, to watch a run');
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, { SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' });
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const anyShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((each) => each.isVisible()));
    expect(await anyShown()).toBe(false);
    await newShell(window);
    await expect(window.getByTestId('session-window')).toHaveAttribute('data-state', 'attached');
    const [popped] = await Promise.all([
      app.waitForEvent('window'),
      window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(popped.getByTestId('session-window')).toHaveAttribute('data-state', 'attached');
    // Painted though never shown: a hidden page that doesn't paint would leave the screenshot blank or hang it.
    expect(await popped.evaluate(() => document.visibilityState)).toBe('visible');
    // At one device pixel per CSS pixel, whatever the display: offscreen paint is in software.
    expect(await popped.evaluate(() => devicePixelRatio)).toBe(1);
    // Painting into a bitmap, not just hidden: every window's page renders offscreen.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((each) => each.webContents.isOffscreen()))).toEqual([
      true,
      true,
    ]);
    // A page that never painted gives a screenshot of one flat colour; this one has the terminal and its chrome.
    const shot = (await popped.screenshot()).toString('base64');
    const colours = await app.evaluate(({ nativeImage }, png) => {
      const bitmap = nativeImage.createFromBuffer(Buffer.from(png, 'base64')).toBitmap();
      const seen = new Set<number>();
      for (let i = 0; i < bitmap.length && seen.size < 10; i += 4) seen.add(bitmap.readUInt32LE(i));
      return seen.size;
    }, shot);
    expect(colours).toBeGreaterThan(1);
    expect(await anyShown()).toBe(false);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('with the e2e background mode on, no window is ever focused', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, { SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' });
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const focused = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() === null);
    expect(await focused()).toBe(true);
    await newShell(window);
    await expect(window.getByTestId('session-window')).toHaveAttribute('data-state', 'attached');
    const [popped] = await Promise.all([
      app.waitForEvent('window'),
      window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(popped.getByTestId('session-window')).toHaveAttribute('data-state', 'attached');
    expect(await focused()).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
