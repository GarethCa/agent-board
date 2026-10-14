import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, screen, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { test, browseForZone, newShell, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

/** What the user said to the board's one agent, in order, from its transcript. */
async function userMessages(page: Page): Promise<string[]> {
  const [agent] = await agents(page);
  const chunk = await page.evaluate((sessionId) => window.agentBoard.agents.transcript(sessionId, 0), agent!.sessionId);
  return chunk.entries.flatMap((entry) => (entry.kind === 'user' ? [entry.text] : []));
}

/** Types two lines with Shift+Enter between them, then Enter, into the focused terminal. */
async function typeTwoLines(window: Page): Promise<void> {
  await window.keyboard.type('line one');
  await window.keyboard.press('Shift+Enter');
  await window.keyboard.type('line two');
  await window.keyboard.press('Enter');
}

for (const opens of ['Session window', 'Expand in place'] as const) {
  test(`Shift+Enter in an agent's terminal (${opens === 'Session window' ? 'session window' : 'expanded tile'}) is a line break in its message, and Enter sends it`, async () => {
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, env);
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database');
      await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await setClickOpens(window, opens);
      await tile(window).dblclick();
      await expect(screen(window)).toContainText('Which database should I use');
      await window.getByTestId('session-terminal').click();

      await typeTwoLines(window);

      // One message of two lines: the fake answers it whole (a CR between them would have sent "line one" alone).
      await expect(screen(window)).toContainText('Going with line one', { timeout: TURN_MS });
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
