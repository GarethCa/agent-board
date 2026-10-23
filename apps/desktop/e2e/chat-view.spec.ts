import { expect } from '@playwright/test';
import { appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agents, launch, screen, sessionWindow, setClickOpens, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { clickClosing } from './windows.ts';

/** The one transcript a fake harness wrote under `home`: Claude's under `.claude/projects`, Codex's rollout under `.codex/sessions`. */
function transcriptIn(home: string, harness: 'Claude' | 'Codex'): string {
  const root = join(home, harness === 'Claude' ? '.claude/projects' : '.codex/sessions');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('.jsonl') && !path.includes('subagents'));
  expect(files).toHaveLength(1);
  return join(root, files[0]!);
}

for (const harness of ['Claude', 'Codex'] as const) {
  test(`a ${harness} agent's session window switches live between its terminal and a chat read from its transcript, which grows with the conversation`, async () => {
    const { dir, repo, env } = scratch('waiting');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, env);
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Pick a database', { harness });
      // It asks a question and waits at its prompt (Codex has no waiting state, so watch for the question).
      await expect(tile(window)).toHaveCount(1);
      await tile(window).dblclick();
      const view = sessionWindow(window).getByRole('group', { name: 'View' });
      const chat = sessionWindow(window).getByTestId('chat-view');
      await expect(view.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true');
      await expect(screen(window)).toContainText('Which database should I use');
      await expect(chat).toBeHidden();

      // Chat: the conversation so far, read from the transcript, with the terminal hidden behind it.
      await view.getByRole('button', { name: 'Chat' }).click();
      await expect(view.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
      await expect(chat).toBeVisible();
      await expect(screen(window)).toBeHidden();
      await expect(chat.getByTestId('chat-user')).toHaveText(['Pick a database']);
      await expect(chat.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);

      // It grows as the agent works: the reply, its tool call as one line, and what it said after.
      const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
      await composer.fill('Postgres');
      await composer.press('Enter');
      await expect(chat.getByTestId('chat-user')).toHaveText(['Pick a database', 'Postgres']);
      await expect(chat.getByTestId('chat-assistant').last()).toHaveText('Going with Postgres.');
      // Its tool calls fold into one row once the turn has moved on; a click opens it.
      const run = chat.getByTestId('chat-tool-run');
      await expect(run).toHaveCount(1);
      await expect(run.getByRole('button').first()).toHaveAttribute('aria-expanded', 'false');
      await expect(run).toContainText('1 tool call');
      await run.getByRole('button').first().click();
      const call = chat.getByTestId('chat-tool');
      await expect(call).toHaveCount(1);
      await expect(call).toContainText('echo "Postgres" > db.txt && echo saved');
      // How it went, from what it printed: for Codex, from its exec script's report.
      await expect(call.getByTestId('chat-tool-outcome')).toHaveText('saved');
      await expect(call).toHaveAttribute('aria-expanded', 'false');
      await expect(chat.getByLabel('Input')).toHaveCount(0);

      // A click opens the call to show what went in.
      await call.click();
      await expect(call).toHaveAttribute('aria-expanded', 'true');
      await expect(chat.getByLabel('Input')).toContainText('db.txt');
      await call.click();
      await expect(chat.getByLabel('Input')).toHaveCount(0);

      // Back to the terminal, still attached, with everything that happened while the chat showed.
      await view.getByRole('button', { name: 'Terminal' }).click();
      await expect(chat).toBeHidden();
      await expect(screen(window)).toContainText('Going with Postgres.');
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      // The terminal takes the keyboard again.
      await expect(sessionWindow(window).locator('.xterm-helper-textarea')).toBeFocused();

      // A transcript the adapter can't read leaves only the terminal, saying so, rather than a broken chat.
      const [agent] = await agents(window);
      expect(agent!.harness).toBe(harness.toLowerCase());
      appendFileSync(transcriptIn(join(dir, 'home'), harness), 'this is not a transcript entry\n');
      await view.getByRole('button', { name: 'Chat' }).click();
      await expect(chat).toContainText('Terminal only');
      await expect(chat).toContainText('the transcript has a line that is not JSON');
      await chat.getByRole('button', { name: 'Show terminal' }).click();
      await expect(view.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true');
      await expect(screen(window)).toBeVisible();
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

/** How long a fake turn that hands work to a subagent may take on a busy machine (several hooks, each a process). */
const TURN_TIMEOUT = 30_000;

for (const harness of ['Claude', 'Codex'] as const) {
  test(`a ${harness} agent's chat shows what its subagent said`, async () => {
    const { repo, env } = scratch('subagent');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, env);
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Map the code', { harness });
      await tile(window).dblclick();
      await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
      const chat = sessionWindow(window).getByTestId('chat-view');
      await expect(chat.getByTestId('chat-assistant').last()).toHaveText('The explorer found where sessions are created.', { timeout: TURN_TIMEOUT });
      await sessionWindow(window).getByRole('button', { name: 'Expand all' }).click();
      const answer = 'Sessions are created in src/daemon/sessions.ts.';
      if (harness === 'Codex') {
        // Codex records the messages between its agents in its own rollout: the task handed on, and the answer.
        const messages = chat.getByTestId('chat-subagent-message');
        await expect(messages).toHaveCount(2);
        await expect(messages.first()).toContainText('handed a task to /root/Explore');
        await expect(messages.last()).toContainText(answer);
        return;
      }
      // Claude keeps a subagent's conversation in its own transcript, which its call opens.
      const call = chat.getByTestId('chat-tool').filter({ hasText: 'Explore' });
      await expect(call.getByTestId('chat-tool-outcome')).toHaveText('done');
      await call.click();
      const thread = chat.getByTestId('chat-subagent');
      await expect(thread.getByTestId('chat-user')).toHaveText('Find where sessions are created');
      await expect(thread.getByTestId('chat-assistant')).toHaveText(answer);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}


test("the chat's message box sends a message of several lines, and the agent's Markdown reply renders", async () => {
  const { repo, env } = scratch('markdown');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Find the TODOs');
    await tile(window).dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = sessionWindow(window).getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant').last()).toContainText('Found one TODO, in src/cli.ts.', { timeout: TURN_MS });
    // Its Markdown: bold and inline code, not asterisks and backticks.
    await expect(chat.getByTestId('chat-assistant').last().locator('strong')).toHaveText('one');
    await expect(chat.getByTestId('chat-assistant').last().locator('code')).toHaveText('src/cli.ts');

    // Shift+Enter makes a new line; Enter sends both lines as one message.
    const box = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
    await box.click();
    await box.pressSequentially('Fix the TODO');
    await box.press('Shift+Enter');
    await box.pressSequentially('Add a test');
    await expect(box).toHaveValue('Fix the TODO\nAdd a test');
    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expect(chat.getByTestId('chat-user')).toHaveCount(2);
    // toHaveText folds whitespace; the line break itself must have arrived.
    expect(await chat.getByTestId('chat-user').last().textContent()).toBe('Fix the TODO\nAdd a test');

    // The reply: a heading, a list of the two lines (one item each, so the agent got them apart), and a highlighted code block.
    const reply = chat.getByTestId('chat-assistant').last();
    await expect(reply.getByRole('heading', { name: 'The plan' })).toBeVisible({ timeout: TURN_MS });
    await expect(reply.getByRole('listitem')).toHaveText(['Fix the TODO', 'Add a test']);
    await expect(reply.locator('pre code')).toHaveText('const answer: number = 42;');
    await expect(reply.locator('pre .hljs-keyword').first()).toHaveText('const');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a run of tool calls is one collapsed row that opens on a click; Expand all and Collapse all open and close every one', async () => {
  const { repo, env } = scratch('markdown');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Find the TODOs');
    await tile(window).dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = sessionWindow(window).getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant').last()).toContainText('Found one TODO', { timeout: TURN_MS });

    // Four calls between two messages: one row, collapsed now that the turn moved on.
    const run = chat.getByTestId('chat-tool-run');
    const line = run.getByRole('button').first();
    await expect(run).toHaveCount(1);
    await expect(run).toContainText('4 tool calls · Read ×2, Bash, Grep');
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    await expect(chat.getByTestId('chat-tool')).toHaveCount(0);

    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    await expect(chat.getByTestId('chat-tool')).toHaveCount(4);
    await line.click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(0);

    const strip = sessionWindow(window);
    await strip.getByRole('button', { name: 'Expand all' }).click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(4);
    // Expand all again opens even a run closed by a click since it was last pressed.
    await line.click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(0);
    await strip.getByRole('button', { name: 'Expand all' }).click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(4);
    await strip.getByRole('button', { name: 'Collapse all' }).click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(0);

    // The choice outlasts a trip to the terminal and back.
    await strip.getByRole('button', { name: 'Expand all' }).click();
    const view = strip.getByRole('group', { name: 'View' });
    await view.getByRole('button', { name: 'Terminal' }).click();
    await view.getByRole('button', { name: 'Chat' }).click();
    await expect(chat.getByTestId('chat-tool')).toHaveCount(4);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("an expanded tile shows the chat from the switch in its pane strip, and the choice is the session window's too", async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveCount(1);
    await setClickOpens(window, 'Expand in place');
    await tile(window).dblclick();
    const expanded = window.getByTestId('expanded-tile');
    const view = expanded.locator('.session-window-strip').getByRole('group', { name: 'View' });
    const chat = expanded.getByTestId('chat-view');
    await expect(view.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true');
    await expect(chat).toBeHidden();

    await view.getByRole('button', { name: 'Chat' }).click();
    await expect(chat.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);
    const composer = expanded.getByRole('textbox', { name: 'Message to the agent' });
    await composer.fill('Postgres');
    await composer.press('Enter');
    await expect(chat.getByTestId('chat-user')).toHaveText(['Pick a database', 'Postgres']);

    // Maximised, the same session is already in its chat, with the switch in the same place.
    await expanded.getByRole('button', { name: /^Maximise/ }).click();
    const maximised = sessionWindow(window).locator('.session-window-strip').getByRole('group', { name: 'View' });
    await expect(maximised.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
    await expect(sessionWindow(window).getByTestId('chat-view')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("an expanded tile's chat renders the agent's Markdown and opens its links without collapsing; the choice outlasts a pop-out and a relaunch", async () => {
  const { dir, repo, env } = scratch('markdown');
  const dataDir = tempDataDir();
  const first = await launch(dataDir, env);
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const { app, window } = first;
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Find the TODOs');
    await setClickOpens(window, 'Expand in place');
    await tile(window).dblclick();
    const expanded = window.getByTestId('expanded-tile');
    const view = expanded.locator('.session-window-strip').getByRole('group', { name: 'View' });
    const chat = expanded.getByTestId('chat-view');
    await view.getByRole('button', { name: 'Chat' }).click();
    const reply = chat.getByTestId('chat-assistant').last();
    await expect(reply).toContainText('Found one TODO', { timeout: TURN_MS });
    await expect(reply.locator('strong')).toHaveText('one');
    await expect(reply.locator('code')).toHaveText('src/cli.ts');

    // A link in a reply goes to the OS browser (here, recorded) and leaves the tile open.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __opened?: string[] }).__opened = opened;
      shell.openExternal = async (url: string) => void opened.push(url);
    });
    const box = expanded.getByRole('textbox', { name: 'Message to the agent' });
    await box.fill('https://example.com/docs');
    await box.press('Enter');
    const link = chat.getByTestId('chat-assistant').last().getByRole('link', { name: 'https://example.com/docs' });
    await expect(link).toBeVisible({ timeout: TURN_MS });
    await link.click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toEqual(['https://example.com/docs']);
    await expect(expanded).toHaveCount(1);
    await expect(chat).toBeVisible();

    // Popped out, it is still in Chat; Terminal there carries back to the tile.
    const [popped] = await Promise.all([app.waitForEvent('window'), expanded.getByRole('button', { name: 'Pop out' }).click()]);
    const popView = popped.getByRole('group', { name: 'View' });
    await expect(popView.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
    await popView.getByRole('button', { name: 'Terminal' }).click();
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    // Back on the board it is a session window, which the board's window read fresh: Terminal, as picked outside.
    const windowView = sessionWindow(window).getByRole('group', { name: 'View' });
    await expect(windowView.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true');
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    // Closed, the window gives the tile back expanded, as it was before it opened: in Terminal too.
    await expect(expanded).toHaveCount(1);
    await expect(view.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true');

    // Chat again, and a relaunch on the same data: still Chat.
    await view.getByRole('button', { name: 'Chat' }).click();
    await expect(view.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
    await app.close();
    second = await launch(dataDir, env);
    // The relaunched app, on the same data, still holds the session's choice.
    const [agent] = await agents(second.window);
    await expect.poll(() => second!.window.evaluate(() => localStorage.getItem('agent-board.chat-sessions'))).toBe(JSON.stringify([agent!.sessionId]));
  } finally {
    await first.app.close().catch(() => {});
    await second?.app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
