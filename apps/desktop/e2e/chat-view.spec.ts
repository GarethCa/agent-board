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
      // Each call is a card, closed once the turn has moved on (cards are every chat's style until another is picked).
      await expect(chat).toHaveAttribute('data-style', 'cards');
      const call = chat.getByTestId('chat-tool');
      const line = call.getByTestId('chat-tool-line');
      await expect(call).toHaveCount(1);
      await expect(call).toContainText('echo "Postgres" > db.txt && echo saved');
      // How it went, from what it printed (for Codex, from its exec script's report), and how long it took.
      await expect(call.getByTestId('chat-tool-outcome')).toHaveText(/^saved · \d+(\.\d)?s$/);
      await expect(line).toHaveAttribute('aria-expanded', 'false');
      await expect(chat.getByLabel('Input')).toHaveCount(0);

      // A click opens the card to show what went in.
      await line.click();
      await expect(line).toHaveAttribute('aria-expanded', 'true');
      await expect(chat.getByLabel('Input')).toContainText('db.txt');
      await line.click();
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
      // Expand all opened its card.
      const call = chat.getByTestId('chat-tool').filter({ hasText: 'Explore' });
      await expect(call.getByTestId('chat-tool-outcome')).toHaveText('done');
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

test('on the timeline rail, a run of tool calls is one collapsed line that opens on a click; Expand all and Collapse all open and close every one', async () => {
  const { repo, env } = scratch('markdown');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Find the TODOs');
    await tile(window).dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await sessionWindow(window).getByRole('group', { name: 'Chat style' }).getByRole('button', { name: 'Timeline' }).click();
    const chat = sessionWindow(window).getByTestId('chat-view');
    await expect(chat).toHaveAttribute('data-style', 'timeline');
    await expect(chat.getByTestId('chat-assistant').last()).toContainText('Found one TODO', { timeout: TURN_MS });

    // Four calls between two messages: one line by their dots, collapsed now that the turn moved on.
    const run = chat.getByTestId('chat-tool-run');
    const line = run.getByRole('button').first();
    await expect(run).toHaveCount(1);
    await expect(run).toContainText('Read, Bash, Grep · 4 calls');
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

/** What Claude puts on every transcript line, so a line written by hand reads as its own. */
const ENVELOPE = { isSidechain: false, userType: 'external', version: '2.1.0' };

/**
 * Times, in the renderer, how long a sent message takes to show as a bubble, and how long a line written to the
 * transcript takes to render. Both are printed, for the record; the bubble must show within a frame or so.
 */
test("a sent message shows in the chat at once, the transcript's writes render without waiting on a poll, and a paste in a message folds", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = sessionWindow(window).getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);

    // When Enter goes down in the message box, and when a bubble with the message first shows.
    await window.evaluate(() => {
      const times: { sent?: number; shown?: number; written?: number } = {};
      (globalThis as { __times?: typeof times }).__times = times;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && times.sent === undefined) times.sent = performance.now();
      }, { capture: true });
      new MutationObserver(() => {
        const users = [...document.querySelectorAll('[data-testid="chat-user"], [data-testid="chat-sent"]')];
        if (times.shown === undefined && users.some((user) => user.textContent?.includes('Postgres'))) times.shown = performance.now();
        const replies = [...document.querySelectorAll('[data-testid="chat-assistant"]')];
        if (times.written === undefined && replies.some((reply) => reply.textContent?.includes('Written straight to the transcript.'))) times.written = Date.now();
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const times = () => window.evaluate(() => (globalThis as { __times?: { sent?: number; shown?: number; written?: number } }).__times!);

    const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
    await composer.fill('Postgres');
    await composer.press('Enter');
    // Then the transcript's copy takes its place: the one bubble, once.
    await expect(chat.getByTestId('chat-user')).toHaveText(['Pick a database', 'Postgres']);
    await expect(chat.getByTestId('chat-sent')).toHaveCount(0);
    const { sent, shown } = await times();
    const sendToBubble = shown! - sent!;
    await expect(chat.getByTestId('chat-assistant').last()).toHaveText('Going with Postgres.');

    // A line the harness writes to its transcript, timed from the write to its render.
    const line = {
      ...ENVELOPE,
      type: 'assistant',
      message: { id: 'msg_timed', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'Written straight to the transcript.' }], stop_reason: 'end_turn' },
    };
    const writtenAt = Date.now();
    appendFileSync(transcriptIn(join(dir, 'home'), 'Claude'), `${JSON.stringify(line)}\n`);
    await expect(chat.getByTestId('chat-assistant').last()).toHaveText('Written straight to the transcript.');
    const writeToRender = (await times()).written! - writtenAt;
    console.log(`chat timings: Send to bubble ${sendToBubble.toFixed(0)} ms, transcript write to render ${writeToRender} ms`);
    test.info().annotations.push({ type: 'timings', description: `send→bubble ${sendToBubble.toFixed(0)} ms; write→render ${writeToRender} ms` });

    // A block pasted into a message folds to its line count, with no tag text, and opens to exactly what was pasted.
    const pasted = 'first line\n  second, indented\nthird';
    const message = { ...ENVELOPE, type: 'user', message: { role: 'user', content: `Look:\n<pasted_content id="p1">\n${pasted}\n</pasted_content id="p1">` } };
    appendFileSync(transcriptIn(join(dir, 'home'), 'Claude'), `${JSON.stringify(message)}\n`);
    const block = chat.getByTestId('chat-user').last().getByTestId('chat-pasted');
    await expect(block).toContainText('Pasted text (3 lines)');
    await expect(chat).not.toContainText('pasted_content');
    await block.getByText('Pasted text (3 lines)').click();
    expect(await block.locator('pre').textContent()).toBe(pasted);

    expect(sendToBubble).toBeLessThan(100);
    expect(writeToRender).toBeLessThan(500);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a message sent while the agent is in a turn shows at once as queued, and as itself where the agent takes it, at its next step', async () => {
  const { repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  // Every prompt plays the scenario, so a message from the chat can start its slow turn; one typed while it runs is
  // taken at its next step, written as a queued command, as Claude writes it.
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_REPEAT: '1', FAKE_HARNESS_QUEUE_MID_TURN: '1' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Get ready');
    await tile(window).dblclick();
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    const chat = sessionWindow(window).getByTestId('chat-view');
    await expect(chat.getByTestId('chat-assistant').last()).toContainText('STATUS: done', { timeout: TURN_MS });

    // Its next turn sleeps for five seconds in a shell.
    const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
    await composer.fill('Work slowly');
    await composer.press('Enter');
    await expect(chat.getByTestId('chat-user').last()).toHaveText('Work slowly');
    await expect(tile(window)).toHaveAttribute('data-state', /^(running|thinking)$/);

    await composer.fill('Then tidy up');
    await composer.press('Enter');
    const bubble = chat.getByTestId('chat-sent');
    await expect(bubble).toContainText('Then tidy up');
    await expect(bubble.getByTestId('chat-sent-status')).toHaveText('queued: taken at its next step');

    // The agent takes it after its shell call, in the same turn: the transcript's copy there, and no queued bubble.
    await expect(chat.getByTestId('chat-user')).toHaveText(['Get ready', 'Work slowly', 'Then tidy up'], { timeout: TURN_MS });
    await expect(bubble).toHaveCount(0);
    await expect(chat.getByTestId('chat-assistant').last()).toHaveText('Slow work done.');
    // Taken in that turn, it starts none of its own.
    await expect(tile(window)).not.toHaveAttribute('data-state', /^(running|thinking)$/);
    await expect(chat.getByTestId('chat-user')).toHaveCount(3);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
