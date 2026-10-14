import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { run } from './board-helpers.ts';
import { launch, sessionWindow, SHELL_ENV, tileAction } from './agent-helpers.ts';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';
import { clickClosing } from './windows.ts';

const panes = (page: Page) => page.getByTestId('shell-pane');
const controls = (page: Page) => sessionWindow(page).getByRole('navigation', { name: 'Session controls' });

test('a shell tile in a zone splits into panes, resizes and closes them, and comes back with its layout after the app restarts', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const appEnv = { ...env, ...SHELL_ENV };
  const { app, window } = await launch(dataDir, appEnv);
  let relaunched: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();

    // The shell starts in the zone's folder, in a window with one pane.
    await expect(panes(window)).toHaveCount(1);
    await expect(window.getByTestId('shell-tile')).toHaveCount(1);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await run(window, 'pwd -P');
    await expect(panes(window).first()).toContainText(repo);

    // Split side by side, then the new pane top and bottom: three panes, the newest focused.
    await controls(window).getByRole('button', { name: 'Split horizontally' }).click();
    await expect(panes(window)).toHaveCount(2);
    await expect(panes(window).nth(1)).toHaveAttribute('data-focused', 'true');
    await expect(panes(window).nth(1).getByTestId('session-terminal')).toBeVisible();
    await run(window, 'echo second-$((20 + 1))');
    await expect(panes(window).nth(1)).toContainText('second-21');
    await controls(window).getByRole('button', { name: 'Split vertically' }).click();
    await expect(panes(window)).toHaveCount(3);
    await expect(panes(window).nth(2).getByTestId('session-terminal')).toBeVisible();
    await run(window, 'echo third-$((30 + 3))');
    await expect(panes(window).nth(2)).toContainText('third-33');
    await expect(panes(window).nth(0)).not.toContainText('third-33');
    await expect(window.getByTestId('shell-tile-panes')).toHaveText('3 panes');

    // Focus follows a click.
    await panes(window).nth(0).click();
    await expect(panes(window).nth(0)).toHaveAttribute('data-focused', 'true');
    await expect(panes(window).nth(2)).toHaveAttribute('data-focused', 'false');

    // Dragging the first divider resizes, and the new size is kept. It is grabbed a quarter of the way down, clear of
    // where the right half's own divider meets it.
    const divider = window.getByTestId('shell-divider').first();
    const before = Number(await divider.getAttribute('data-ratio'));
    const box = (await divider.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 4, { steps: 5 });
    await window.mouse.up();
    await expect.poll(async () => Number(await divider.getAttribute('data-ratio'))).toBeGreaterThan(before + 0.05);
    const resized = Number(await divider.getAttribute('data-ratio'));

    // Closing the focused pane ends its shell and gives its space to its neighbour.
    await panes(window).nth(2).click();
    await controls(window).getByRole('button', { name: 'Close pane' }).click();
    await expect(panes(window)).toHaveCount(2);
    await expect(window.getByTestId('shell-tile-panes')).toHaveText('2 panes');

    // Restart the app: the daemon (and so the shells) stays up, and the layout and panes come back, in the window that
    // was open when it quit.
    await app.close();
    relaunched = await launchApp(dataDir, appEnv);
    const again = await relaunched.firstWindow();
    await connectedDaemonPid(again);
    await expect(panes(again)).toHaveCount(2);
    await expect(sessionWindow(again)).toHaveAttribute('data-state', 'attached');
    await expect(panes(again).nth(1)).toContainText('second-21');
    expect(Number(await again.getByTestId('shell-divider').first().getAttribute('data-ratio'))).toBeCloseTo(resized, 2);
    await panes(again).nth(1).click();
    await run(again, 'echo after-$((40 + 2))');
    await expect(panes(again).nth(1)).toContainText('after-42');

    // Closing the last panes removes the tile.
    await again.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Close pane' }).click();
    await again.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Close pane' }).click();
    await expect(again.getByTestId('shell-tile')).toHaveCount(0);
    await expect(sessionWindow(again)).toBeHidden();
  } finally {
    await relaunched?.close().catch(() => {});
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a split shell pops out with its panes and back in, and deleting a tile with live panes asks first', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await controls(window).getByRole('button', { name: 'Split horizontally' }).click();
    await expect(panes(window)).toHaveCount(2);

    // Popped out, its own OS window lays out both panes, and the focused one takes input.
    const [popped] = await Promise.all([
      app.waitForEvent('window'),
      window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(panes(popped)).toHaveCount(2);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    await expect(sessionWindow(window)).toBeHidden();
    expect(await popped.title()).toMatch(/^Shell 1/);
    await panes(popped).nth(0).click();
    await run(popped, 'echo popped-$((5 * 5))');
    await expect(panes(popped).nth(0)).toContainText('popped-25');
    await expect(panes(popped).nth(1)).not.toContainText('popped-25');

    // Back in, the board's window shows both panes again, with what was typed outside.
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    await expect(panes(window)).toHaveCount(2);
    await expect(panes(window).nth(0)).toContainText('popped-25');

    // Deleting the tile while its panes are live asks first; Cancel keeps it, Delete anyway ends both panes. Its
    // window is closed first, as it sits over the tile; the panes keep running.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    const tile = window.getByTestId('shell-tile');
    await tileAction(tile, 'Delete shell');
    const confirm = window.getByRole('alertdialog', { name: 'Delete shell?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(tile).toHaveCount(1);
    await tileAction(tile, 'Delete shell');
    await confirm.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(tile).toHaveCount(0);
    await expect(sessionWindow(window)).toBeHidden();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
