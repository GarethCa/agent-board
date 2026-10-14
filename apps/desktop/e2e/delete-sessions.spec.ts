import { expect, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import { existsSync, rmSync } from 'node:fs';
import { run } from './board-helpers.ts';
import { agents, launch, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const shellTiles = (page: Page) => page.getByTestId('shell-tile');
const stickies = (page: Page) => page.getByTestId('sticky');

test('an ended agent is deleted from the right-click menu, keeping its worktree when asked', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');

    // Quit claude at its prompt: the agent has ended.
    await tile(window).dblclick();
    const expanded = window.getByTestId('expanded-tile');
    await expanded.getByTestId('session-terminal').click();
    await window.keyboard.press('Control+D');
    await expect(expanded.getByTestId('agent-exit-banner')).toContainText('claude exited');
    await expanded.locator('.session-window-head').click();
    await window.keyboard.press('Escape');
    await expect(expanded).toHaveCount(0);
    await expect.poll(async () => (await agents(window))[0]?.endedAt).not.toBeNull();

    await tile(window).click();
    await tile(window).click({ button: 'right' });
    await window.getByRole('menuitem', { name: /^Delete/ }).click();
    // Even ended, an agent with a worktree of its own asks whether to remove it with its branch or keep them.
    const confirm = window.getByRole('alertdialog', { name: 'Delete agent?' });
    await expect(confirm).toContainText('worktree and branch are removed');
    const [ended] = await agents(window);
    await confirm.getByRole('button', { name: 'Keep worktree and branch' }).click();
    await expect(tile(window)).toHaveCount(0);
    expect(await agents(window)).toEqual([]);
    expect(existsSync(ended!.worktree)).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exited shell is deleted with Backspace; a sticky and a live shell are deleted together behind one question', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const newShell = window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' });

    // A shell whose process has exited goes straight away.
    await newShell.click();
    await expect(sessionWindow(window)).toBeVisible();
    await run(window, 'exit');
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(shellTiles(window)).toContainText('1 pane');
    await shellTiles(window).click();
    await window.keyboard.press('Backspace');
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(window.getByRole('alertdialog')).toHaveCount(0);

    // A sticky and a live shell: one combined question, which says what happens to each.
    await newShell.click();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(shellTiles(window)).toHaveCount(1);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    await daemon.call('item.create', { kind: 'sticky', zoneId: null, x: 700, y: 420, width: 160, height: 160, data: { text: 'note', color: '#fff3a3' } });
    daemon.close();
    await expect(stickies(window)).toHaveCount(1);
    await stickies(window).click({ position: { x: 12, y: 12 } });
    await shellTiles(window).click({ modifiers: ['Shift'] });
    await window.keyboard.press('Backspace');
    const confirm = window.getByRole('alertdialog', { name: 'Delete selection?' });
    await expect(confirm).toContainText('1 board item');
    await expect(confirm).toContainText('still has running shells');
    await expect(confirm).toContainText("can't be undone");
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(stickies(window)).toHaveCount(1);

    // A ⌫ typed while the question is open is the question's: it asks nothing more, and deletes nothing.
    await window.keyboard.press('Backspace');
    await expect(confirm).toBeVisible();
    await window.keyboard.press('Backspace');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('alertdialog')).toHaveCount(0);
    await expect(shellTiles(window)).toHaveCount(1);

    await window.keyboard.press('Backspace');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(stickies(window)).toHaveCount(0);

    // Undo brings the sticky back; the shell, a session, is not undoable.
    await window.keyboard.press('ControlOrMeta+z');
    await expect(stickies(window)).toHaveCount(1);
    await expect(shellTiles(window)).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⌫ inside a session window never deletes its session, even with focus in its terminal; the window Delete button and the tile menu ask as ⌫ does', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toBeVisible();
    await run(window, 'exit');
    await expect(shellTiles(window)).toHaveCount(1);

    // With focus in the window's terminal, ⌫ is the terminal's.
    await sessionWindow(window).getByTestId('session-terminal').click();
    await window.keyboard.press('Backspace');
    await expect(sessionWindow(window)).toBeVisible();
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(window.getByRole('alertdialog')).toHaveCount(0);

    // The tile stays selected behind its window: a ⌫ pressed after clicking the window's header is not for the tile.
    await sessionWindow(window).locator('.session-window-head').click();
    await window.keyboard.press('Backspace');
    await expect(sessionWindow(window)).toBeVisible();
    await expect(shellTiles(window)).toHaveCount(1);

    // The window's own Delete, a danger action beside Close: an exited shell goes with no question.
    await sessionWindow(window).getByRole('button', { name: 'Delete session' }).click();
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(sessionWindow(window)).toBeHidden();

    // The tile's hover row has Pop out and no Delete; Delete is in ⋯, and asks first while a pane runs.
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await shellTiles(window).hover();
    await expect(shellTiles(window).getByRole('button', { name: 'Pop out' })).toBeVisible();
    await expect(shellTiles(window).getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await shellTiles(window).getByRole('button', { name: 'More' }).click();
    await expect(window.getByRole('menuitem', { name: 'Pop out' })).toHaveCount(0);
    await window.getByRole('menuitem', { name: 'Delete shell' }).click();
    const confirm = window.getByRole('alertdialog', { name: 'Delete shell?' });
    await expect(confirm).toContainText('still has running shells');
    await expect(confirm).toContainText("can't be undone");
    await confirm.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(shellTiles(window)).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain click selects an agent tile and ⌫ asks to delete it; the hover row has Pop out, and Delete is in ⋯', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');

    await tile(window).hover();
    await expect(tile(window).getByRole('button', { name: 'Expand' })).toBeVisible();
    await expect(tile(window).getByRole('button', { name: 'Pop out' })).toBeVisible();
    await expect(tile(window).getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await tile(window).getByRole('button', { name: 'More' }).click();
    await expect(window.getByRole('menuitem', { name: 'Delete agent' })).toBeVisible();
    await expect(window.getByRole('menuitem', { name: 'Pop out' })).toHaveCount(0);
    await window.keyboard.press('Escape');

    // One plain click, then ⌫: the confirmation shows.
    await tile(window).click();
    await window.keyboard.press('Backspace');
    const confirm = window.getByRole('alertdialog', { name: 'Delete agent?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(tile(window)).toHaveCount(1);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
