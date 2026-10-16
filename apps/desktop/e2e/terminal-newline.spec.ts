import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, screen, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile, TURN_MS, windowKey } from './agent-helpers.ts';
import { test, browseForZone, newShell, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** What the user said to the board's one agent, in order, from its transcript. */
async function userMessages(page: Page): Promise<string[]> {
  const [agent] = await agents(page);
  const chunk = await page.evaluate((sessionId) => window.agentBoard.agents.transcript(sessionId, 0), agent!.sessionId);
  return chunk.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []));
}

const expandedTile = (page: Page) => page.getByTestId('expanded-tile');

/** Types two lines with Shift+Enter between them, then Enter, into the focused terminal. */
async function typeTwoLines(window: Page): Promise<void> {
  await window.keyboard.type('line one');
  await window.keyboard.press('Shift+Enter');
  await window.keyboard.type('line two');
  await window.keyboard.press('Enter');
}

/** Each view of an agent's terminal: opens it from its tile, and says which page and terminal to type into. */
const VIEWS: Record<string, (app: ElectronApplication, window: Page) => Promise<{ page: Page; terminal: Locator }>> = {
  'session window': async (app, window) => {
    await setClickOpens(window, 'Session window');
    await tile(window).dblclick();
    return { page: window, terminal: window.getByTestId('session-terminal') };
  },
  'expanded tile': async (app, window) => {
    await setClickOpens(window, 'Expand in place');
    await tile(window).dblclick();
    return { page: window, terminal: expandedTile(window).getByTestId('session-terminal') };
  },
  maximised: async (app, window) => {
    await setClickOpens(window, 'Expand in place');
    await tile(window).dblclick();
    await expandedTile(window).getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    return { page: window, terminal: sessionWindow(window).getByTestId('session-terminal') };
  },
  'pop-out': async (app, window) => {
    await setClickOpens(window, 'Session window');
    await tile(window).dblclick();
    const [popped] = await Promise.all([app.waitForEvent('window'), window.getByRole('button', { name: 'Pop out session window' }).click()]);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    return { page: popped, terminal: popped.getByTestId('session-terminal') };
  },
  'tab in a pane': async (app, window) => {
    await setClickOpens(window, 'Session window');
    await tile(window).dblclick();
    // A shell tab beside the run, then back to the agent's own tab.
    await window.keyboard.press(windowKey('t'));
    await expect(sessionWindow(window).getByTestId('session-tab')).toHaveCount(2);
    await window.keyboard.press(windowKey('1'));
    const shown = sessionWindow(window).locator('[data-testid="session-tab-view"][data-focused]');
    return { page: window, terminal: shown.getByTestId('session-terminal').first() };
  },
};

for (const [view, open] of Object.entries(VIEWS)) {
  test(`Shift+Enter in an agent's terminal (${view}) is a line break in its message, and Enter sends it`, async () => {
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, env);
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      const { page, terminal } = await open(app, window);
      await expect(terminal.locator('.xterm-rows')).toContainText('Which database should I use');
      await terminal.click();

      await typeTwoLines(page);

      // One message of two lines: the fake answers it whole (a CR between them would have sent "line one" alone).
      await expect(terminal.locator('.xterm-rows')).toContainText('Going with line one', { timeout: TURN_MS });
      await expect.poll(() => userMessages(window)).toEqual(['Pick a database', 'line one\nline two']);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('Shift+Enter in a plain shell is Enter, as in any terminal', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByTestId('session-terminal').click();
    await window.keyboard.type('echo shifted-$((40 + 2))');
    await window.keyboard.press('Shift+Enter');
    await expect(screen(window)).toContainText('shifted-42');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("Shift+Enter in the fallback shell of an ended agent is ESC CR while its harness runs there, and CR once it exits", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).dblclick();
    const expanded = expandedTile(window);
    const rows = expanded.getByTestId('session-terminal').locator('.xterm-rows');
    await expect(rows).toContainText('Which database should I use');
    await expanded.getByTestId('session-terminal').click();
    // Quit claude at its prompt: the pane drops into a shell.
    await window.keyboard.press('Control+D');
    await expect(expanded.getByTestId('session-window-status')).toHaveText('ended · shell');
    const restart = expanded.getByTestId('restart-agent');
    await expect(restart).toBeVisible();

    // The user starts claude in that shell by hand: the tile says so, and Shift+Enter is a line break in its message.
    await expanded.getByTestId('session-terminal').click();
    await window.keyboard.type('claude');
    await window.keyboard.press('Enter');
    await expect(expanded.getByTestId('session-window-status')).toHaveText('claude running in this shell', { timeout: TURN_MS });
    await expect(restart).toBeHidden();
    await typeTwoLines(window);
    // One message of two lines at the fake's prompt (a CR between them would have sent "line one" alone, and shown
    // "line two" as a prompt of its own).
    await expect(rows).toContainText('> line oneline two', { timeout: TURN_MS });

    // It exits back to the shell prompt: a plain shell again, where Shift+Enter is Enter.
    await window.keyboard.press('Control+D');
    await expect(expanded.getByTestId('session-window-status')).toHaveText('ended · shell', { timeout: TURN_MS });
    await expect(restart).toBeVisible();
    await window.keyboard.type('echo shifted-$((40 + 2))');
    await window.keyboard.press('Shift+Enter');
    await expect(rows).toContainText('shifted-42');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
