import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, SHELL_ENV, spawnAgent, tile, zoneNamed, zones } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { clickClosing } from './windows.ts';

const shells = (page: Page) => page.evaluate(() => window.agentBoard.shells.list());
/** Clicks empty zone floor, so the board (not a terminal or a field) has the keyboard. */
async function focusBoard(page: Page): Promise<void> {
  const zone = page.getByTestId('zone').first();
  const box = (await zone.boundingBox())!;
  await page.mouse.click(box.x + 12, box.y + box.height - 12);
}

const field = (page: Page) => page.getByTestId('rename-field');

test('renames an agent by double-click and the pencil, a shell with F2 and its panes by double-click, and undoes it', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Rename me');
    await expect(tile(window)).toHaveCount(1);
    const [original] = await agents(window);

    // A double-click on the tile's name edits it in place; it doesn't open the session window.
    await tile(window).locator('.hybrid-tile-name').dblclick();
    await expect(field(window)).toBeFocused();
    await field(window).fill('Fix the login');
    await field(window).press('Enter');
    await expect(tile(window).locator('.hybrid-tile-name')).toHaveText('Fix the login');
    await expect(sessionWindow(window)).toBeHidden();
    const [renamed] = await agents(window);
    expect(renamed).toMatchObject({ name: 'Fix the login', sessionId: original!.sessionId, branch: original!.branch, worktree: original!.worktree });

    // Escape cancels, and a blank name reverts.
    await tile(window).hover();
    await tile(window).getByRole('button', { name: 'Rename', exact: true }).click();
    await field(window).fill('Never saved');
    await field(window).press('Escape');
    await expect(tile(window).locator('.hybrid-tile-name')).toHaveText('Fix the login');
    await tile(window).locator('.hybrid-tile-name').dblclick();
    await field(window).fill('   ');
    await field(window).press('Enter');
    await expect(tile(window).locator('.hybrid-tile-name')).toHaveText('Fix the login');

    // Undo and redo, from the board.
    await focusBoard(window);
    await window.keyboard.press('ControlOrMeta+z');
    await expect(tile(window).locator('.hybrid-tile-name')).toHaveText(original!.name);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect(tile(window).locator('.hybrid-tile-name')).toHaveText('Fix the login');

    // A shell: F2 with its tile selected.
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const shellTile = window.getByTestId('shell-tile');
    await shellTile.locator('.hybrid-tile-name').click();
    await window.keyboard.press('F2');
    await expect(field(window)).toBeFocused();
    await field(window).fill('Build box');
    await field(window).press('Enter');
    await expect.poll(async () => (await shells(window))[0]!.name).toBe('Build box');
    await expect(shellTile.locator('.hybrid-tile-name')).toHaveText('Build box');
    await shellTile.hover();
    await shellTile.getByRole('button', { name: 'Expand' }).click();
    await expect(window.getByTestId('expanded-tile')).toHaveAccessibleName('Build box, expanded');

    // Its panes: split in two, then label the first one.
    await window.getByTestId('expanded-tile').getByRole('button', { name: 'Split horizontally' }).click();
    await expect(window.getByTestId('shell-pane-head')).toHaveCount(2);
    await expect(window.getByTestId('shell-pane-head').nth(0)).toHaveText('Build box');
    await window.getByTestId('shell-pane-head').nth(0).locator('.shell-pane-name').dblclick();
    await field(window).fill('logs');
    await field(window).press('Enter');
    await expect(window.getByTestId('shell-pane-head').nth(0)).toHaveText('logs');
    await expect(window.getByTestId('shell-pane-head').nth(1)).toHaveText('Build box');

    // Undo takes the label off again (from the board, not the terminal, which would take Ctrl-Z itself).
    await focusBoard(window);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => JSON.stringify((await shells(window))[0]!.layout)).not.toContain('logs');
    expect((await shells(window))[0]!.name).toBe('Build box');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renames from the session window header, the menus and a popped-out window, with the dock and OS window title following', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Window rename');
    const name = tile(window).locator('.hybrid-tile-name');
    const head = sessionWindow(window).locator('.session-window-name');

    // The session window's header: a double-click on the name, then its pencil.
    await tile(window).dblclick({ position: { x: 40, y: 70 } });
    await expect(sessionWindow(window)).toBeVisible();
    await head.dblclick();
    await field(window).fill('From window');
    await field(window).press('Enter');
    await expect(head).toHaveText('From window');
    await expect(name).toHaveText('From window');
    await sessionWindow(window).locator('.session-window-head').hover();
    await sessionWindow(window).getByRole('button', { name: 'Rename', exact: true }).click();
    await field(window).fill('By pencil');
    await field(window).press('Enter');
    await expect(head).toHaveText('By pencil');

    // The dock follows the name.
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(window.getByTestId('dock-item')).toContainText('By pencil');
    await window.getByTestId('dock-item').locator('.session-dock-open').click();

    // Popped out, the pencil renames (its double-click is in a drag region, which the stylesheet test covers), and
    // the OS window's title follows.
    const [popped] = await Promise.all([app.waitForEvent('window'), window.getByRole('button', { name: 'Pop out session window' }).click()]);
    await expect.poll(() => popped.title()).toBe('By pencil');
    await popped.locator('.session-window-head').hover();
    await popped.getByRole('button', { name: 'Rename', exact: true }).click();
    await field(popped).fill('From pop-out');
    await field(popped).press('Enter');
    await expect(popped.locator('.session-window-name')).toHaveText('From pop-out');
    await expect.poll(() => popped.title()).toBe('From pop-out');
    await expect(name).toHaveText('From pop-out');
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();

    // The tile's context menu, then its More menu (Escape leaves the name alone).
    await name.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(field(window)).toBeFocused();
    await field(window).fill('From context menu');
    await field(window).press('Enter');
    await expect(name).toHaveText('From context menu');
    await tile(window).hover();
    await tile(window).getByRole('button', { name: 'More' }).click();
    await window.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(field(window)).toBeFocused();
    await field(window).press('Escape');
    await expect(name).toHaveText('From context menu');
    expect((await agents(window))[0]!.name).toBe('From context menu');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redoes a shell rename, labels a pane with its pencil, clears the label with a blank name, and undoes and redoes both', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const shellTile = window.getByTestId('shell-tile');
    const shellName = async () => (await shells(window))[0]!.name;
    const layout = async () => JSON.stringify((await shells(window))[0]!.layout);

    await shellTile.locator('.hybrid-tile-name').click();
    await window.keyboard.press('F2');
    await field(window).fill('Box');
    await field(window).press('Enter');
    await expect.poll(shellName).toBe('Box');
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(shellName).toBe('Shell 1');
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(shellName).toBe('Box');

    // Two panes: the second's pencil labels it, and a blank name takes the label off, back to the shell's name.
    await shellTile.hover();
    await shellTile.getByRole('button', { name: 'Expand' }).click();
    const expanded = window.getByTestId('expanded-tile');
    await expanded.getByRole('button', { name: 'Split horizontally' }).click();
    const heads = window.getByTestId('shell-pane-head');
    await expect(heads).toHaveCount(2);
    await heads.nth(1).hover();
    await heads.nth(1).getByRole('button', { name: 'Rename pane' }).click();
    await field(window).fill('logs');
    await field(window).press('Enter');
    await expect(heads.nth(1)).toHaveText('logs');
    await heads.nth(1).locator('.shell-pane-name').dblclick();
    await expect(field(window)).toHaveValue('logs');
    await field(window).fill('');
    await field(window).press('Enter');
    await expect(heads.nth(1)).toHaveText('Box');
    expect(await layout()).not.toContain('logs');

    // From the board: undo brings the label back, redo clears it again.
    await focusBoard(window);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(layout).toContain('logs');
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(layout).not.toContain('logs');
    expect(await shellName()).toBe('Box');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renames a group from its menu, and undoes and redoes it', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(window, 'G1');
    const name = async () => (await zones(window))[0]!.name;
    await zoneNamed(window, 'G1').getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'Rename' }).click();
    await field(window).fill('Renamed');
    await field(window).press('Enter');
    await expect.poll(name).toBe('Renamed');
    await focusBoard(window);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(name).toBe('G1');
    await expect(zoneNamed(window, 'G1')).toBeVisible();
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(name).toBe('Renamed');
    await expect(zoneNamed(window, 'Renamed')).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test('keys typed straight after F2 go to the name, not to the board: no sticky note appears', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await addEmptyZone(window, 'G1');
    await zoneNamed(window, 'G1').getByRole('button', { name: 'New shell in zone' }).click();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const shellTile = window.getByTestId('shell-tile');
    await shellTile.locator('.hybrid-tile-name').click();
    // No wait for the field: N is the board's sticky-note key, and it must not land there.
    await window.keyboard.press('F2');
    await window.keyboard.type('nnn');
    await expect(field(window)).toBeVisible();
    await window.waitForTimeout(300);
    await expect(window.getByTestId('sticky')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
