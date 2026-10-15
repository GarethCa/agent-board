import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, screen, sessionItems, sessionWindow, SHELL_ENV, showDetails, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, newShell } from './launch.ts';
import { clickClosing } from './windows.ts';
import { scratch } from './scratch.ts';

const dockItem = (page: Page) => page.getByTestId('dock-item');

/** Types a command into the shown session window's terminal. */
async function run(page: Page, command: string): Promise<void> {
  await page.getByTestId('session-terminal').click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test('a session window minimises to the dock and restores, pops out into its own OS window and back, with its terminal intact', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await run(window, 'echo before-$((40 + 2))');
    await expect(screen(window)).toContainText('before-42');

    // Minimise: the window goes to the dock, the session keeps running, and restoring shows what it had.
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await expect(dockItem(window)).toHaveCount(1);
    await expect(dockItem(window)).toHaveAttribute('data-placement', 'docked');
    await dockItem(window).getByRole('button', { name: /^Shell/ }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(screen(window)).toContainText('before-42');
    await expect(dockItem(window)).toHaveCount(0);

    // Pop out: its own OS window shows the same terminal and takes input; the board keeps it in the dock as out.
    const [popped] = await Promise.all([
      app.waitForEvent('window'),
      window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    await expect(screen(popped)).toContainText('before-42');
    await expect(sessionWindow(window)).toBeHidden();
    await expect(dockItem(window)).toHaveAttribute('data-placement', 'popped');
    expect(await popped.title()).toMatch(/^Shell/);
    await run(popped, 'echo outside-$((6 * 7))');
    await expect(screen(popped)).toContainText('outside-42');

    // Pop back in: the OS window closes and the board shows the session again, with what was typed outside.
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(screen(window)).toContainText('outside-42');
    await expect(dockItem(window)).toHaveCount(0);

    // Closing a popped-out OS window closes the session window; the session keeps running.
    const [again] = await Promise.all([
      app.waitForEvent('window'),
      window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(sessionWindow(again)).toHaveAttribute('data-state', 'attached');
    await again.getByRole('button', { name: 'More' }).click();
    await clickClosing(again, again.getByRole('menuitem', { name: 'Close window' }));
    await expect(dockItem(window)).toHaveCount(0);
    await expect(sessionWindow(window)).toBeHidden();
    await expect(await sessionItems(window)).toHaveCount(1);

    // With the board closed, popping back in opens the board with the session shown on it.
    await (await sessionItems(window)).getByRole('button', { name: 'Open' }).click();
    const [last] = await Promise.all([
      app.waitForEvent('window'),
      window.getByRole('button', { name: 'Pop out session window' }).click(),
    ]);
    await expect(sessionWindow(last)).toHaveAttribute('data-state', 'attached');
    await window.close();
    const [board] = await Promise.all([
      app.waitForEvent('window'),
      clickClosing(last, last.getByRole('button', { name: 'Back to board' })),
    ]);
    await expect(sessionWindow(board)).toHaveAttribute('data-state', 'attached');
    await expect(screen(board)).toContainText('outside-42');
    await expect(await sessionItems(board)).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("several session windows wait in the dock, reachable over the shown one, and a shell's Interrupt stops its command", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const first = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    // Interrupt sends Ctrl-C: the sleep ends at once and the next command runs.
    await run(window, 'sleep 30');
    await sessionWindow(window).getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Interrupt' }).click();
    await run(window, 'echo back-$((1 + 1))');
    await expect(screen(window)).toContainText('back-2', { timeout: 5_000 });

    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await newShell(window);
    await expect(sessionWindow(window)).not.toHaveAttribute('data-shell-id', first);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const second = (await sessionWindow(window).getAttribute('data-shell-id'))!;
    await expect(dockItem(window)).toHaveCount(1);

    // The dock stays reachable over the shown window: restoring the first docks the second.
    await dockItem(window).getByRole('button', { name: /^Shell/ }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-shell-id', first);
    await expect(screen(window)).toContainText('back-2');
    await expect(dockItem(window)).toHaveCount(1);
    await expect(dockItem(window)).toHaveAttribute('data-shell-id', second);
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(dockItem(window)).toHaveCount(2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

for (const harness of ['Claude', 'Codex'] as const) {
  test(`a ${harness} agent's session window interrupts it, sends it messages from the composer, stops it, and closes with it`, async () => {
    const { dir, repo, env } = scratch('output');
    const dataDir = tempDataDir();
    // Slow turns, so there is time to interrupt one; and no idle_prompt, which would move an idle agent on to waiting.
    const { app, window } = await launch(dataDir, { ...env, FAKE_HARNESS_STEP_DELAY_MS: '800', FAKE_HARNESS_IDLE_NOTIFY_MS: '600000' });
    try {
      await pickFolderNext(app, repo);
      await browseForZone(window);
      await spawnAgent(window, 'monorepo', 'Run the tests', { harness });
      await expect(tile(window)).toHaveCount(1);
      await tile(window).dblclick();
      await showDetails(sessionWindow(window));
      const controls = sessionWindow(window).getByRole('navigation', { name: 'Session controls' });
      // Only controls that work: nothing says "Not built yet", and no Connections placeholder.
      for (const later of ['Pause', 'Hand off', 'Fork']) await expect(controls.getByRole('button', { name: later })).toHaveCount(0);
      await expect(sessionWindow(window)).not.toContainText('Not built yet');
      await expect(sessionWindow(window)).not.toContainText('Flows between agents come with M2');

      // Interrupt mid-turn: the turn stops short and the agent is idle at its prompt. The fake echoes the prompt once
      // its turn is under way; a Ctrl-C before that reaches it at its prompt and is lost, however enabled Interrupt looks.
      await expect(screen(window)).toContainText('> Run the tests');
      await expect(controls.getByRole('button', { name: 'Interrupt' })).toBeEnabled();
      await controls.getByRole('button', { name: 'Interrupt' }).click();
      await expect(screen(window)).toContainText('Interrupted');
      await expect(tile(window)).toHaveAttribute('data-state', 'idle');
      await expect(controls.getByRole('button', { name: 'Interrupt' })).toBeDisabled();
      await expect(screen(window)).not.toContainText('All tests pass.');

      // The composer sends the next message, and another while the agent works on that one, which it takes next.
      const view = sessionWindow(window).getByRole('group', { name: 'View' });
      await view.getByRole('button', { name: 'Chat' }).click();
      const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
      await composer.fill('carry on');
      await composer.press('Enter');
      await expect(composer).toHaveValue('');
      await expect(tile(window)).toHaveAttribute('data-state', 'thinking');
      await composer.fill('and then this');
      await composer.press('Enter');
      await expect(composer).toHaveValue('');
      // The fake's cooked PTY echoes the second message into the first reply's output, so match its end only.
      // Both turns run at the slow step delay (a word at a time), so give them room beyond the default 5 s.
      await view.getByRole('button', { name: 'Terminal' }).click();
      await expect(screen(window)).toContainText('carry on.', { timeout: 30_000 });
      await expect(screen(window)).toContainText('Done: and then this.', { timeout: 30_000 });

      // Stop ends its session as done; its worktree stays, and its pane drops into a shell there.
      await controls.getByRole('button', { name: 'Stop' }).click();
      await expect(tile(window)).toHaveAttribute('data-state', 'done');
      await expect(window.getByTestId('session-window-status')).toHaveText('ended · shell');
      await expect(sessionWindow(window).getByTestId('agent-exit-banner')).toContainText(`${harness.toLowerCase()} exited`);
      // The terminal view has no composer; the exit banner offers Restart, and the chat's composer says why it is off.
      await expect(composer).toHaveCount(0);
      await expect(sessionWindow(window).getByTestId('restart-agent')).toBeEnabled();
      await view.getByRole('button', { name: 'Chat' }).click();
      await expect(composer).toBeDisabled();
      await expect(composer).toHaveAttribute('placeholder', 'The agent has ended');
      await view.getByRole('button', { name: 'Terminal' }).click();
      await expect(controls.getByRole('button', { name: 'Stop' })).toBeDisabled();

      // Deleting the agent closes its window, popped out or not.
      const [popped] = await Promise.all([
        app.waitForEvent('window'),
        window.getByRole('button', { name: 'Pop out session window' }).click(),
      ]);
      await expect(sessionWindow(popped)).toBeVisible();
      await tileAction(tile(window), 'Delete agent');
      await Promise.all([popped.waitForEvent('close'), window.getByRole('alertdialog').getByRole('button', { name: 'Delete agent' }).click()]);
      await expect(tile(window)).toHaveCount(0);
      await expect(dockItem(window)).toHaveCount(0);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('⌘K and ⌘\\ belong to the text while typing: in a terminal they leave the board menu shut, on the board they open it', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByTestId('session-terminal').click();
    await window.keyboard.press('ControlOrMeta+k');
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(menu).toHaveCount(0);

    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.keyboard.press('ControlOrMeta+k');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('searchbox', { name: 'Find a zone or agent' })).toBeFocused();
    // Typed into the search field, ⌘\ is the field's too.
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(menu).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(menu).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("a permission prompt shows a Show prompt banner over the terminal, and answering it in the terminal puts it away", async () => {
  const { dir, repo, env } = scratch('permission');
  const dataDir = tempDataDir();
  // The inbox's hold lapses at once, so the fake asks in its terminal.
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_PERMISSION_HOLD_MS: '500' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Clean up');
    await tile(window).dblclick();
    const composer = sessionWindow(window).getByRole('textbox', { name: 'Message to the agent' });
    const banner = sessionWindow(window).getByTestId('agent-blocked-banner');
    await expect(tile(window)).toHaveAttribute('data-state', 'needs-permission');
    await expect(banner).toContainText('Waiting on a permission prompt');
    await expect(composer).toHaveCount(0);
    await expect(screen(window)).toContainText('(y/n)');

    // Show prompt gives the keyboard to the terminal, where the prompt is answered.
    await sessionWindow(window).getByRole('button', { name: 'Show prompt' }).click();
    await window.keyboard.type('y');
    await window.keyboard.press('Enter');
    await expect(screen(window)).toContainText('Removed dist.');
    await expect(tile(window)).toHaveAttribute('data-state', 'idle');
    await expect(banner).toHaveCount(0);
    await sessionWindow(window).getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await expect(composer).toBeEnabled();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splitting stops when a pane would be left too small to use, and says why', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const panes = sessionWindow(window).getByTestId('window-pane');
    // Split until it refuses: each press adds a pane, or says why it can't.
    const status = sessionWindow(window).getByTestId('session-window-status');
    for (let i = 0; i < 10 && !/no room to split/.test((await status.textContent()) ?? ''); i++) {
      const before = await panes.count();
      await window.keyboard.press('ControlOrMeta+d');
      await expect.poll(async () => (await panes.count()) > before || /no room to split/.test((await status.textContent()) ?? '')).toBe(true);
    }
    await expect(status).toContainText('no room to split');
    expect(await panes.count()).toBeGreaterThan(1);
    // Every pane kept room for a usable terminal.
    for (const box of await panes.evaluateAll((all) => all.map((pane) => pane.getBoundingClientRect().width))) expect(box).toBeGreaterThan(100);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
