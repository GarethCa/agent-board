import { expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './board-helpers.ts';
import { agents, launch, sessionWindow, SHELL_ENV, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const folder = (page: Page) => sessionWindow(page).getByTestId('details-folder');
const panes = (page: Page) => page.getByTestId('shell-pane');
const controls = (page: Page) => sessionWindow(page).getByRole('navigation', { name: 'Session controls' });

test("a shell window's details follow the focused pane's folder through cd and pane switches", async () => {
  const { dir, repo, env } = scratch('output');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(folder(window)).toHaveText(repo);

    // A cd shows up without any other sign of it.
    await run(window, `cd ${elsewhere}`);
    await expect(folder(window)).toHaveText(elsewhere);

    // A second pane starts in the zone's folder; it cds on its own, and focus decides which pane's folder shows.
    await controls(window).getByRole('button', { name: 'Split horizontally' }).click();
    await expect(panes(window)).toHaveCount(2);
    await expect(folder(window)).toHaveText(repo);
    await run(window, `cd ${dir}`);
    await expect(folder(window)).toHaveText(dir);
    await panes(window).nth(0).click();
    await expect(folder(window)).toHaveText(elsewhere);
    await panes(window).nth(1).click();
    await expect(folder(window)).toHaveText(dir);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent window shows its live folder beside its fixed worktree, hinting when the shell it dropped into leaves it", async () => {
  const { dir, repo, env } = scratch('waiting');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    const [agent] = await agents(window);
    await tile(window).dblclick();
    await expect(sessionWindow(window)).toBeVisible();

    const worktree = sessionWindow(window).getByRole('region', { name: 'Worktree and branch' }).getByText(agent!.worktree, { exact: true });
    await expect(folder(window)).toHaveText(agent!.cwd);
    await expect(worktree).toBeVisible();
    await expect(window.getByTestId('details-outside-worktree')).toHaveCount(0);

    // Quit claude: the pane drops into a shell, which cds out of the worktree. The worktree row doesn't move.
    await sessionWindow(window).getByTestId('session-terminal').click();
    await window.keyboard.press('Control+D');
    await expect(sessionWindow(window).getByTestId('session-window-status')).toHaveText('ended · shell');
    await sessionWindow(window).getByTestId('session-terminal').click();
    await window.keyboard.type(`cd ${elsewhere}`);
    await window.keyboard.press('Enter');
    await expect(folder(window)).toHaveText(elsewhere);
    await expect(window.getByTestId('details-outside-worktree')).toBeVisible();
    await expect(worktree).toBeVisible();
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
