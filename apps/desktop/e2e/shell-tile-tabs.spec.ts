import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, SHELL_ENV, windowKey } from './agent-helpers.ts';
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
const paneLeft = `${process.platform === 'darwin' ? 'Meta+Alt' : 'Control+Shift+Alt'}+ArrowLeft`;
const shownScreen = (page: Page) => shown(page).locator('.shell-pane[data-focused="true"] .xterm-rows');

/** The sessions the daemon runs now. */
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());

/** Types a command into the focused pane of the tab showing. */
async function run(page: Page, command: string): Promise<void> {
  await shown(page).locator('.shell-pane[data-focused="true"]').getByTestId('session-terminal').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test("a shell tile's window has tabs and panes as an agent's does (⌘T, + menu, ⌘D, ⌘1–9, ⌘⌥←, ×), none of them a tile, kept across a restart, counted when it is deleted, and the next becomes first when the first closes", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const appEnv = { ...env, ...SHELL_ENV };
  const { app, window } = await launch(dataDir, appEnv);
  let relaunched: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();

    // One tab, the tile's own panes, named after it, and a named + to open another.
    await expect(tabs(window)).toHaveCount(1);
    await expect(tabNamed(window, 'Shell 1')).toHaveAttribute('data-active', 'true');
    await expect(tabNamed(window, 'Shell 1').getByRole('button', { name: 'Close Shell 1' })).toHaveCount(0);
    await expect(sessionWindow(window).getByRole('button', { name: 'New tab' })).toHaveText('Shell');
    await run(window, 'echo first-$((20 + 1))');
    await expect(shownScreen(window)).toContainText('first-21');

    // ⌘T: a shell tab in the tile's folder, showing and taking the keyboard.
    await window.keyboard.press(windowKey('t'));
    await expect(tabs(window)).toHaveCount(2);
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');
    // The tile's own tab has a × now it has another, to close its panes and have the next take its place.
    await expect(tabNamed(window, 'Shell 1').getByRole('button', { name: 'Close Shell 1' })).toHaveCount(1);
    await run(window, 'pwd -P');
    await expect(shownScreen(window)).toContainText(repo);

    // ⌘D splits the pane, a new shell tab in a pane of its own beside it, focused.
    await window.keyboard.press(windowKey('d'));
    await expect(windowPanes(window)).toHaveCount(2);
    await expect(windowPanes(window).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);
    await expect(windowPanes(window).nth(1)).toHaveAttribute('data-focused', 'true');

    // ⌘⌥← to the first pane; ⌘1 to the tile's own panes, as they were; ⌘9 to its last.
    await window.keyboard.press(paneLeft);
    await expect(windowPanes(window).nth(0)).toHaveAttribute('data-focused', 'true');
    await window.keyboard.press(windowKey('1'));
    await expect(tabNamed(window, 'Shell 1')).toHaveAttribute('data-active', 'true');
    await expect(shownScreen(window)).toContainText('first-21');
    await window.keyboard.press(windowKey('9'));
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');

    // The + menu opens one in the tile's folder too; × closes it, once asked as its shell still runs, ending its shell, and shows the tab before it.
    await focusedStrip(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: 'New shell in this folder' }).click();
    await expect(tabNamed(window, 'sh 3')).toHaveAttribute('data-active', 'true');
    const closedPane = await shown(window).getByTestId('shell-pane').getAttribute('data-session-id');
    await tabNamed(window, 'sh 3').getByRole('button', { name: 'Close sh 3' }).click();
    await window.getByRole('alertdialog', { name: 'Close tab?' }).getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs(window)).toHaveCount(3);
    await expect.poll(async () => (await liveSessions(window)).some((session) => session.id === closedPane)).toBe(false);
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');

    // No tab is a tile of its own.
    await expect(window.getByTestId('shell-tile')).toHaveCount(1);

    // The app restarts with the daemon still up: the window open when it quit opens again, with its tabs and panes.
    await app.close();
    relaunched = await launchApp(dataDir, appEnv);
    const again = await relaunched.firstWindow();
    await connectedDaemonPid(again);
    await expect(tabs(again)).toHaveCount(3);
    await expect(windowPanes(again)).toHaveCount(2);
    await expect(windowPanes(again).nth(0).getByTestId('session-tab')).toHaveText(['Shell 1', 'sh']);
    await expect(again.getByTestId('shell-tile')).toHaveCount(1);

    // With the tile's own shell ended, deleting it still asks first: its tabs' shells run.
    await tabNamed(again, 'Shell 1').getByRole('tab').click();
    const ownPane = await shown(again).getByTestId('shell-pane').getAttribute('data-session-id');
    await run(again, 'exit');
    await expect.poll(async () => (await liveSessions(again)).some((session) => session.id === ownPane)).toBe(false);
    await sessionWindow(again).getByRole('button', { name: 'Delete session' }).click();
    const confirm = again.getByRole('alertdialog', { name: 'Delete shell?' });
    await expect(confirm).toContainText('still has running shells');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();

    // Closing that last pane of its first tab keeps the tile: its next tab becomes its first, in its place.
    await sessionWindow(again).getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Close pane' }).click();
    await expect(tabs(again)).toHaveCount(2);
    await expect(windowPanes(again).nth(0).getByTestId('session-tab')).toHaveText(['Shell 1']);
    await expect(tabNamed(again, 'Shell 1')).toHaveAttribute('data-active', 'true');
    await expect(again.getByTestId('shell-tile')).toHaveCount(1);

    // The tile's own tab's ×, while it has another: once asked, its panes end and its next tab takes their place, where
    // that tab was; the pane it leaves closes.
    const right = await windowPanes(again).nth(1).getAttribute('data-pane');
    const promoted = await sessionWindow(again).locator(`[data-testid="session-tab-view"][data-pane="${right}"]:not([hidden]) [data-testid="shell-pane"]`).getAttribute('data-session-id');
    await tabNamed(again, 'Shell 1').getByRole('button', { name: 'Close Shell 1' }).click();
    await again.getByRole('alertdialog', { name: 'Close tab?' }).getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs(again)).toHaveText(['Shell 1']);
    await expect(windowPanes(again)).toHaveCount(0);
    await expect(sessionWindow(again).getByTestId('shell-pane')).toHaveAttribute('data-session-id', promoted!);
    await expect(again.getByTestId('shell-tile')).toHaveCount(1);
  } finally {
    await (relaunched ?? app).close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
