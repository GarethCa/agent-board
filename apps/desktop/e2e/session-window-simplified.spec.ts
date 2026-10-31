import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, screen, sessionWindow, spawnAgent, tile } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';
import { scratch } from './scratch.ts';

// An agent's window under the Simplified design: one header holding its zone, name and status, the Chat | Timeline |
// Terminal switch, the details toggle, ⋯ and Done.

/** ⌥⌘T, or Ctrl+Shift+Alt+T off macOS. */
const terminalKey = process.platform === 'darwin' ? 'Meta+Alt+t' : 'Control+Shift+Alt+t';

const header = (window: Page) => sessionWindow(window).locator('.session-window-head');
const view = (window: Page) => header(window).getByRole('group', { name: 'View' });
const picked = (window: Page, name: 'Chat' | 'Timeline' | 'Terminal') => expect(view(window).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');

test("an agent's window opens on its chat, and the header's switch and ⌥⌘T reach its live terminal and back", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await tile(window).dblclick();
    const chat = sessionWindow(window).getByTestId('chat-view');

    // One header: the zone, the name and its status, the switch, ⋯ and Done; none of the window's old buttons.
    await expect(header(window).getByTestId('session-window-zone')).toHaveText('monorepo');
    await expect(header(window).getByTestId('status-mark')).toBeVisible();
    await expect(header(window).getByRole('button', { name: 'More' })).toBeVisible();
    await expect(header(window).getByRole('button', { name: /^Done, close / })).toBeVisible();
    for (const gone of ['Minimise session window', 'Pop out session window', 'Delete session', 'Close session window']) {
      await expect(header(window).getByRole('button', { name: gone })).toHaveCount(0);
    }
    // The switch is the header's alone: the pane's strip has none.
    await expect(sessionWindow(window).getByRole('group', { name: 'View' })).toHaveCount(1);

    // It opens on the chat, read from its transcript.
    await picked(window, 'Chat');
    await expect(chat.getByTestId('chat-assistant')).toHaveText(['Which database should I use, Postgres or SQLite?']);
    await expect(chat).toHaveAttribute('data-style', 'cards');

    // Terminal: the harness's own screen, live, in the chat's place, with the keyboard.
    await view(window).getByRole('button', { name: 'Terminal' }).click();
    await picked(window, 'Terminal');
    await expect(chat).toBeHidden();
    await expect(screen(window)).toContainText('Which database should I use');
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(sessionWindow(window).locator('.xterm-helper-textarea')).toBeFocused();

    // ⌥⌘T from the terminal goes back to the chat, and again to the terminal.
    await window.keyboard.press(terminalKey);
    await picked(window, 'Chat');
    await expect(chat).toBeVisible();
    await window.keyboard.press(terminalKey);
    await picked(window, 'Terminal');
    await expect(screen(window)).toBeVisible();

    // Timeline: the same conversation drawn as its rail; ⌥⌘T goes to the terminal and back to it.
    await view(window).getByRole('button', { name: 'Timeline' }).click();
    await picked(window, 'Timeline');
    await expect(chat).toHaveAttribute('data-style', 'timeline');
    await window.keyboard.press(terminalKey);
    await picked(window, 'Terminal');
    await window.keyboard.press(terminalKey);
    await picked(window, 'Timeline');

    // ⋯ is the agent's menu, with End agent… above Delete; Done closes the window and the agent keeps running.
    await header(window).getByRole('button', { name: 'More' }).click();
    const menu = window.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^End agent…/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Delete agent/ })).toBeVisible();
    await window.keyboard.press('Escape');
    await header(window).getByRole('button', { name: /^Done, close / }).click();
    await expect(sessionWindow(window)).toBeHidden();

    // Opened again, it shows the view it was left on.
    await tile(window).dblclick();
    await picked(window, 'Timeline');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with Agent windows open on Terminal, a window with no view picked opens on the terminal', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');

    const settings = await openSettings(window, 'agents.chat');
    // Its fieldset and its switch share the name: the switch's Terminal is the section's only one.
    const terminal = settingsSection(settings, 'Chat').getByRole('button', { name: 'Terminal', exact: true });
    await terminal.click();
    await expect(terminal).toHaveAttribute('aria-pressed', 'true');
    await settings.close();

    await tile(window).dblclick();
    await picked(window, 'Terminal');
    await expect(screen(window)).toContainText('Which database should I use');
    await expect(sessionWindow(window).getByTestId('chat-view')).toBeHidden();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the header's one action stops a step with ⌘. and wakes a paused agent, and ⋯'s End agent… ends it, keeping its tile, with Restart in ⋯", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  // Slow turns, so there is time to stop one; and no idle_prompt, which would move an idle agent on to waiting.
  const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_STEP_DELAY_MS: '800', FAKE_HARNESS_IDLE_NOTIFY_MS: '600000' }, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Run the tests');
    await tile(window).dblclick();
    await view(window).getByRole('button', { name: 'Terminal' }).click();
    const more = header(window).getByRole('button', { name: 'More' });
    const menu = window.getByRole('menu');

    // Working: Stop, and ⌘. pressed in the window (Playwright's press, which macOS's own cancel never sees) stops the step;
    // the agent waits at its prompt.
    // The fake echoes the prompt once its turn is under way; a stop before that would reach it at its prompt and be lost.
    await expect(screen(window)).toContainText('> Run the tests');
    // Under way, not still starting, whose stop would be lost too.
    await expect.poll(async () => (await agents(window))[0]!.state).toMatch(/^(running|thinking)$/);
    await expect(header(window).getByRole('button', { name: 'Stop' })).toBeVisible();
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Period' : 'Control+Shift+Period');
    await expect(screen(window)).toContainText('Interrupted');
    await expect(tile(window)).toHaveAttribute('data-state', 'idle');
    await expect(header(window).getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(screen(window)).not.toContainText('All tests pass.');

    // Paused from ⋯, the header's action is Wake, which wakes it.
    await more.click();
    await menu.getByRole('menuitem', { name: /^Pause/ }).click();
    await expect(tile(window)).toHaveAttribute('data-state', 'hibernated');
    const wake = header(window).getByRole('button', { name: 'Wake' });
    await wake.click();
    await expect(wake).toHaveCount(0);
    // Back at its prompt, live again.
    await expect(tile(window)).toHaveAttribute('data-state', 'idle');

    // End agent… asks first, then ends it: its tile stays, ended, and ⋯ offers Restart in End agent…'s place.
    await more.click();
    await menu.getByRole('menuitem', { name: /^End agent…/ }).click();
    const confirm = window.getByRole('alertdialog', { name: /^End / });
    await confirm.getByRole('button', { name: 'End agent' }).click();
    await expect(confirm).toBeHidden();
    await expect(tile(window)).toHaveAttribute('data-state', 'done');
    await expect(tile(window)).toHaveCount(1);
    await more.click();
    await expect(menu.getByRole('menuitem', { name: /^Restart agent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^End agent…/ })).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
