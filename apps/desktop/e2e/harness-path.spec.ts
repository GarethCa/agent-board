import { expect, type Page } from '@playwright/test';
import { fakeBinDir } from '@agent-board/fake-harness';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, setClickOpens, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const expandedTile = (page: Page) => page.getByTestId('expanded-tile');
const expandedScreen = (page: Page) => expandedTile(page).getByTestId('session-terminal').locator('.xterm-rows');

/**
 * An app on a Mac where `claude` is reachable only through the user's `.zshrc`: its PATH is launchd's bare one plus
 * git and gh, its shell is a real zsh reading a temp home, and the places an installer would put
 * `claude` are that home's. `setUp` makes `claude` reachable the way the case under test does.
 */
async function startsAndRestarts(setUp: (home: string, fake: string) => void) {
  const { dir, repo, env } = scratch('waiting');
  const home = env.HOME!;
  const tools = join(dir, 'tools');
  mkdirSync(tools);
  // The tools the daemon runs, linked from wherever the developer has them: not their dirs, which may hold a claude.
  for (const tool of ['git', 'gh']) {
    const found = execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim();
    if (found !== '') symlinkSync(found, join(tools, tool));
  }
  // The fake claude, under a name no PATH of the app's has.
  const fake = join(dir, 'installed', 'claude');
  mkdirSync(join(dir, 'installed'));
  symlinkSync(join(fakeBinDir, 'claude'), fake);
  // `node`, which the fake runs on, is reachable only through .zshrc too, as under nvm or fnm.
  const nodeBin = join(dir, 'node-bin');
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  writeFileSync(join(home, '.zshrc'), `export PATH="${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin"\n`);
  setUp(home, fake);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {
    ...env,
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ZDOTDIR: home,
    SHELL: '/bin/zsh',
    // A login shell, as the app has by default.
    AGENT_BOARD_LOGIN_SHELL: '',
    // Only the home's own places, never a harness the developer has installed.
    AGENT_BOARD_HARNESS_DIRS: join(home, '.claude', 'local'),
  });
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');

    // Quit claude at its prompt: its pane drops into a shell, and Restart carries the agent on.
    await tile(window).dblclick();
    await expect(expandedScreen(window)).toContainText('Which database should I use');
    await expandedTile(window).getByTestId('session-terminal').click();
    await window.keyboard.press('Control+D');
    await expect(expandedTile(window).getByTestId('agent-exit-banner')).toContainText('claude exited (code 0)');
    await expandedTile(window).locator('.session-window-head').click();
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toHaveCount(0);
    // Restart from the tile's hover corner, pressed twice: it restarts once, and the second press is no error.
    await tile(window).getByRole('button', { name: 'Restart', exact: true }).dblclick();
    await expect.poll(async () => (await agents(window))[0]!.endedAt).toBeNull();
    await expect(window.getByText(/Could not restart/)).toHaveCount(0);
    await tile(window).dblclick();
    await expect(expandedScreen(window)).toContainText('Which database should I use');
    await expect(expandedScreen(window)).not.toContainText('command not found');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an agent starts and restarts when claude is on a PATH that only .zshrc sets', async () => {
  await startsAndRestarts((home, fake) => {
    const bin = join(home, 'rc-bin');
    mkdirSync(bin);
    symlinkSync(fake, join(bin, 'claude'));
    appendFileSync(join(home, '.zshrc'), `export PATH="${bin}:$PATH"\n`);
  });
});

test('an agent starts and restarts when claude is only an alias in .zshrc, installed where the installer puts it', async () => {
  await startsAndRestarts((home, fake) => {
    const local = join(home, '.claude', 'local');
    mkdirSync(local, { recursive: true });
    symlinkSync(fake, join(local, 'claude'));
    appendFileSync(join(home, '.zshrc'), `alias claude=${join(local, 'claude')}\n`);
  });
});
