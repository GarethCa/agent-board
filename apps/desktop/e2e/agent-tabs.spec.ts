import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, sessionWindow, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const tabs = (page: Page) => sessionWindow(page).getByTestId('session-tab');
const tabNamed = (page: Page, name: string) => tabs(page).filter({ has: page.getByRole('tab', { name, exact: true }) });
/** The tab the focused pane shows: its panes, and the terminal of its focused one. */
const shown = (page: Page) => sessionWindow(page).locator('[data-testid="session-tab-view"][data-focused]');
/** The window's panes, each with a strip of its own once there are several. */
const windowPanes = (page: Page) => sessionWindow(page).getByTestId('window-pane');
/** The focused pane's strip: the window's own while it has one pane. */
const focusedStrip = (page: Page) => sessionWindow(page).locator('[data-testid="session-tabs"][data-focused], .session-window-strip [data-testid="session-tabs"]');
const shownScreen = (page: Page) => shown(page).locator('.shell-pane[data-focused="true"] .xterm-rows');

/** A session window's own shortcut: ⌘ on macOS, Ctrl+Shift elsewhere, where Ctrl's keys are the terminal's. */
const windowKey = (key: string) => `${process.platform === 'darwin' ? 'Meta' : 'Control+Shift'}+${key}`;

/** The sessions the daemon runs now. */
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());

/** Types a command into the focused pane of the tab showing. */
async function run(page: Page, command: string): Promise<void> {
  await shown(page).locator('.shell-pane[data-focused="true"]').getByTestId('session-terminal').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test("an agent's window opens shell tabs beside its run (⌘T, + menu, a package script), splits a pane beside it (⌘D), switches (⌘1–9), and keeps them across a restart; its tile counts them", async () => {
  const { dir, repo, env } = scratch('waiting');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { greet: 'echo hello-from-$((20 + 22))' } }));
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'scripts']);
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  let relaunched: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveCount(1);
    await tile(window).dblclick();
    const [agent] = await agents(window);

    // One tab, the agent's own, and a named + to open a shell beside it.
    await expect(tabs(window)).toHaveCount(1);
    await expect(tabNamed(window, 'claude')).toHaveAttribute('data-active', 'true');
    await expect(shownScreen(window)).toContainText('Which database should I use', { timeout: TURN_MS });
    await expect(sessionWindow(window).getByRole('button', { name: 'New tab' })).toHaveText('Shell');

    // ⌘T: a shell tab in the agent's worktree, showing and taking the keyboard.
    await window.keyboard.press(windowKey('t'));
    await expect(tabs(window)).toHaveCount(2);
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');
    await run(window, 'pwd -P');
    await expect(shownScreen(window)).toContainText(agent!.worktree);

    // ⌘1 back to the agent, whose run is still there; ⌘D splits its pane, a new shell tab in a pane beside it.
    await window.keyboard.press(windowKey('1'));
    await expect(tabNamed(window, 'claude')).toHaveAttribute('data-active', 'true');
    await expect(windowPanes(window)).toHaveCount(0);
    // Its terminal is tagged, to tell that the split keeps it, attached, rather than mounting it afresh.
    await shown(window).locator('.shell-pane[data-agent] .xterm').evaluate((element) => ((element as HTMLElement).dataset.kept = 'yes'));
    await window.keyboard.press(windowKey('d'));
    await expect(windowPanes(window)).toHaveCount(2);
    await expect(windowPanes(window).nth(0).getByTestId('session-tab')).toHaveText(['claude', 'sh']);
    await expect(windowPanes(window).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);
    await expect(tabNamed(window, 'sh 2')).toHaveAttribute('data-active', 'true');
    const agentView = sessionWindow(window).locator('[data-testid="session-tab-view"][data-tab="own"]');
    await expect(agentView).toBeVisible();
    await expect(agentView).toContainText('Which database should I use');
    await expect(agentView.locator('.xterm[data-kept="yes"]')).toHaveCount(1);
    await run(window, 'echo beside-$((6 * 7))');
    await expect(shownScreen(window)).toContainText('beside-42');

    // + in that pane runs a package script of the worktree in a tab of its own there, named after it.
    await focusedStrip(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: 'greet' }).click();
    await expect(tabNamed(window, 'npm greet')).toHaveAttribute('data-active', 'true');
    await expect(windowPanes(window).nth(1).getByTestId('session-tab')).toHaveText(['sh 2', 'npm greet']);
    await expect(shownScreen(window)).toContainText('hello-from-42');

    // ⌘1 goes to the focused pane's first tab; ⌘⌥← to the agent's pane, ⌘2 to its shell tab, as it was.
    await window.keyboard.press(windowKey('1'));
    await expect(tabNamed(window, 'sh 2')).toHaveAttribute('data-active', 'true');
    await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta+Alt' : 'Control+Shift+Alt'}+ArrowLeft`);
    await expect(windowPanes(window).nth(0)).toHaveAttribute('data-focused', 'true');
    await window.keyboard.press(windowKey('2'));
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');
    await expect(shownScreen(window)).toContainText(agent!.worktree);
    // A command that fails turns the shell red on the tile.
    await run(window, 'false');

    // ⇧⌘D splits the focused pane below it (Ctrl+Shift+Alt+D off macOS), and ⌘W closes its tab, asking first as its
    // shell runs, the pane going with its last tab.
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+d' : 'Control+Shift+Alt+d');
    await expect(windowPanes(window)).toHaveCount(3);
    await expect(windowPanes(window).nth(1).getByTestId('session-tab')).toHaveText(['sh 3']);
    await expect(windowPanes(window).nth(1)).toHaveAttribute('data-focused', 'true');
    await window.keyboard.press(windowKey('w'));
    await window.getByRole('alertdialog', { name: 'Close tab?' }).getByRole('button', { name: 'Close tab' }).click();
    await expect(windowPanes(window)).toHaveCount(2);
    await expect(tabs(window)).toHaveText(['claude', 'sh', 'sh 2', 'npm greet']);

    // Closed, the window leaves the tile counting its shells; its list opens the window on one.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const chip = tile(window).getByTestId('tile-shells');
    await expect(chip).toContainText('3 shells');
    await chip.hover();
    const rows = window.getByTestId('tile-shells-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'last command failed · exit 1' })).toHaveCount(1);
    await expect(chip.locator('.tile-shells-dot[data-state="failed"]')).toHaveCount(1);
    await rows.filter({ hasText: 'npm greet' }).click();
    await expect(tabNamed(window, 'npm greet')).toHaveAttribute('data-active', 'true');
    await expect(windowPanes(window).nth(1)).toHaveAttribute('data-focused', 'true');

    // Closing a shell tab, once asked as its shell still runs, ends its shell and shows the tab before it.
    const greetPane = await shown(window).getByTestId('shell-pane').getAttribute('data-session-id');
    await tabNamed(window, 'npm greet').getByRole('button', { name: 'Close npm greet' }).click();
    await window.getByRole('alertdialog', { name: 'Close tab?' }).getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs(window)).toHaveCount(3);
    await expect.poll(async () => (await liveSessions(window)).some((session) => session.id === greetPane)).toBe(false);
    await expect(tabNamed(window, 'sh 2')).toHaveAttribute('data-active', 'true');

    // The app restarts with the daemon still up: the tabs, and the panes, are as they were.
    await app.close();
    relaunched = await launchApp(dataDir, env);
    const again = await relaunched.firstWindow();
    await connectedDaemonPid(again);
    await expect(tile(again).getByTestId('tile-shells')).toContainText('2 shells');
    // The window open when it quit opens again, laid out as it was.
    await expect(windowPanes(again)).toHaveCount(2);
    await expect(windowPanes(again).nth(0).getByTestId('session-tab')).toHaveText(['claude', 'sh']);
    await expect(windowPanes(again).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);
  } finally {
    await (relaunched ?? app).close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
