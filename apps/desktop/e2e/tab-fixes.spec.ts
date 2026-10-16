import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, spawnAgent, tile, TURN_MS, windowKey } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const tabs = (page: Page) => sessionWindow(page).getByTestId('session-tab');
const tabNamed = (page: Page, name: string) => tabs(page).filter({ has: page.getByRole('tab', { name, exact: true }) });
/** The tab showing: its panes, and the terminal of its focused pane. */
const shown = (page: Page) => sessionWindow(page).locator('[data-testid="session-tab-view"]:not([hidden])');
const shownScreen = (page: Page) => shown(page).locator('.shell-pane[data-focused="true"] .xterm-rows');
/** The focused pane's terminal input, in the tab showing. */
const paneInput = (page: Page) => shown(page).locator('.shell-pane[data-focused="true"] .xterm-helper-textarea');
const liveSessions = (page: Page) => page.evaluate(() => window.agentBoard.sessions.list());

/** An agent waiting at its prompt, its session window open on its own tab. */
async function openAgent(page: Page, app: Parameters<typeof pickFolderNext>[0], repo: string): Promise<void> {
  await pickFolderNext(app, repo);
  await browseForZone(page);
  await spawnAgent(page, 'monorepo', 'Pick a database');
  await expect(tile(page)).toHaveCount(1);
  await tile(page).dblclick();
  await expect(shownScreen(page)).toContainText('Which database should I use', { timeout: TURN_MS });
}

test("Chat picked while a shell tab shows brings the agent's own tab forward in its chat, and its shell tabs stay terminals", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await openAgent(window, app, repo);
    await window.keyboard.press(windowKey('t'));
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');

    const chat = sessionWindow(window).getByTestId('chat-view');
    const composer = sessionWindow(window).getByLabel('Message to the agent');
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await expect(tabNamed(window, 'claude')).toHaveAttribute('data-active', 'true');
    await expect(chat).toBeVisible();
    await expect(chat.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);
    await expect(composer).toBeVisible();

    // A shell tab stays a terminal, with no message box or chat actions for the agent under it.
    await tabNamed(window, 'sh').getByRole('tab').click();
    await expect(chat).toBeHidden();
    await expect(shown(window).locator('.xterm')).toBeVisible();
    await expect(composer).toHaveCount(0);
    await expect(sessionWindow(window).getByRole('button', { name: 'Expand all' })).toHaveCount(0);

    // Back on the agent's tab, its chat again.
    await tabNamed(window, 'claude').getByRole('tab').click();
    await expect(chat).toBeVisible();
    await expect(composer).toBeVisible();
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell tab closes by ⌘W, a middle-click or its ×, asking first while its shell runs; the agent tab never closes', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await openAgent(window, app, repo);
    const ask = window.getByRole('alertdialog', { name: 'Close tab?' });

    // The agent's own tab has no close, and ⌘W there closes nothing.
    await expect(tabNamed(window, 'claude').getByRole('button', { name: /^Close/ })).toHaveCount(0);

    // ⌘W on a live shell asks; Cancel keeps it.
    await window.keyboard.press(windowKey('t'));
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');
    const first = await shown(window).getByTestId('shell-pane').getAttribute('data-session-id');
    await window.keyboard.press(windowKey('w'));
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await expect(tabs(window)).toHaveCount(2);
    await expect(paneInput(window)).toBeFocused();

    // Asked again and confirmed, the tab goes, its shell ends, and the agent's tab shows.
    await window.keyboard.press(windowKey('w'));
    await ask.getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs(window)).toHaveCount(1);
    await expect.poll(async () => (await liveSessions(window)).some((session) => session.id === first)).toBe(false);
    await expect(tabNamed(window, 'claude')).toHaveAttribute('data-active', 'true');
    // The keyboard goes to the tab now showing, so the window's shortcuts still work.
    await expect(paneInput(window)).toBeFocused();

    // ⌘W with the agent's own tab showing closes nothing.
    await window.keyboard.press(windowKey('w'));
    await expect(ask).toHaveCount(0);
    await expect(tabs(window)).toHaveCount(1);

    // A middle-click asks too.
    await window.keyboard.press(windowKey('t'));
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');
    await tabNamed(window, 'sh').getByRole('tab').click({ button: 'middle' });
    await ask.getByRole('button', { name: 'Close tab' }).click();
    await expect(tabs(window)).toHaveCount(1);

    // A tab whose shell has ended closes at once, by its ×.
    await window.keyboard.press(windowKey('t'));
    await expect(tabNamed(window, 'sh')).toHaveAttribute('data-active', 'true');
    await shown(window).getByTestId('session-terminal').click();
    await window.keyboard.type('exit');
    await window.keyboard.press('Enter');
    await expect(sessionWindow(window).getByTestId('session-window-status')).toContainText('exited');
    await tabNamed(window, 'sh').getByRole('button', { name: 'Close sh' }).click();
    await expect(ask).toHaveCount(0);
    await expect(tabs(window)).toHaveCount(1);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
