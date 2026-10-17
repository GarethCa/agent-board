import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, setClickOpens, SHELL_ENV, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const expandedTile = (page: Page) => page.getByTestId('expanded-tile');
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());
const expandedScreen = (page: Page) => expandedTile(page).getByTestId('session-terminal').locator('.xterm-rows');

test('an agent that exits drops its pane into a shell in its worktree, and Restart brings the agent back there, asking first while the shell runs something', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    const [agent] = await agents(window);

    // Quit claude at its prompt, as the user would.
    await tile(window).dblclick();
    await expect(expandedScreen(window)).toContainText('Which database should I use');
    await expandedTile(window).getByTestId('session-terminal').click();
    await window.keyboard.press('Control+D');

    // Its pane drops into a shell, marked as such, under the agent's last output.
    const banner = expandedTile(window).getByTestId('agent-exit-banner');
    await expect(banner).toContainText('claude exited (code 0)');
    await expect(expandedTile(window).getByTestId('session-window-status')).toHaveText('ended · shell');
    await expect(expandedScreen(window)).toContainText('Which database should I use');
    // Typing works straight away, in the agent's worktree.
    await expandedTile(window).getByTestId('session-terminal').click();
    await window.keyboard.type('pwd');
    await window.keyboard.press('Enter');
    await expect(expandedScreen(window)).toContainText(agent!.cwd);

    // Something running in the shell: Restart from the tile's menu asks before it ends the shell.
    await window.keyboard.type('sleep 30');
    await window.keyboard.press('Enter');
    await expandedTile(window).locator('.session-window-head').click();
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toHaveCount(0);
    // Its tile says it ended, and how, in its state pill: no Restart row pushes its footer out of it.
    await expect(tile(window).locator('.hybrid-tile-footer .ui-pill')).toHaveText('ended · exit 0');
    await expect(tile(window).getByTestId('restart-agent')).toHaveCount(0);
    const [footer, card] = [await tile(window).locator('.hybrid-tile-footer').boundingBox(), await tile(window).boundingBox()];
    expect(footer!.y + footer!.height, 'footer bottom').toBeLessThanOrEqual(card!.y + card!.height + 0.5);
    await tileAction(tile(window), 'Restart agent');
    const confirm = window.getByRole('alertdialog', { name: 'Restart agent?' });
    await expect(confirm).toContainText('running something');
    await confirm.getByRole('button', { name: 'Restart anyway' }).click();

    // The shell goes, and the agent carries on its conversation in a live session of its own, in the same pane.
    await expect(confirm).toBeHidden();
    await expect.poll(async () => {
      const [restarted] = await agents(window);
      return { endedAt: restarted!.endedAt, shellSessionId: restarted!.shellSessionId };
    }).toEqual({ endedAt: null, shellSessionId: null });
    expect((await liveSessions(window)).map((session) => session.id)).toContain(agent!.sessionId);
    await tile(window).dblclick();
    await expect(expandedTile(window).getByTestId('agent-exit-banner')).toBeHidden();
    await expect(expandedTile(window).getByTestId('session-window-status')).not.toHaveText('ended · shell');
    await expect(expandedScreen(window)).toContainText('Which database should I use');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
