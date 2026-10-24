import { expect } from '@playwright/test';
import { agents, launch, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const MASTER_KEY = process.platform === 'darwin' ? 'Meta+Shift+m' : 'Control+Shift+m';

test('⌘⇧M opens the Captain’s panel: Start the Captain puts its tile on the board, and the panel shows the zones it watches and its chat', async () => {
  const { repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);

    // No master yet: the panel says what it does, and nothing starts it but the click.
    await window.keyboard.press(MASTER_KEY);
    const panel = window.getByTestId('master-panel');
    await expect(panel).toBeVisible();
    const start = panel.getByTestId('master-start');
    await expect(start).toBeFocused();
    expect((await agents(window)).some((agent) => agent.master)).toBe(false);
    await start.click();

    // Its tile, loose on the board with the CAPTAIN badge, at board scope in a folder of its own.
    const master = tile(window).filter({ has: window.getByTestId('master-badge') });
    await expect(master).toHaveCount(1);
    await expect(master).toHaveAttribute('data-zone', '');
    const [started] = (await agents(window)).filter((agent) => agent.master);
    expect(started).toMatchObject({ orchestrate: 'board', zoneId: null, branch: '', ownsWorktree: false });

    // Watching lists the zone, which has no orchestrator yet; the chat shows the master's brief.
    await expect(panel.getByTestId('master-watch-row')).toHaveText([/monorepo.*no orchestrator/]);
    await expect(panel.getByTestId('chat-user').first()).toContainText('You are the Captain');
    // ⌘⇧M again puts the caret in its message box.
    await window.keyboard.press(MASTER_KEY);
    await expect(panel.getByRole('textbox', { name: 'Message to the agent' })).toBeFocused();

    // Closing the panel stops nothing; the Captain button opens the same Captain again.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    await expect(master).toHaveCount(1);
    await window.getByTestId('master-button').click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('master-start')).toHaveCount(0);
    expect((await agents(window)).filter((agent) => agent.master)).toHaveLength(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
