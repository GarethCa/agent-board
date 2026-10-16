import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, screen, sessionItems, sessionWindow, SHELL_ENV, showDetails, spawnAgent, tile, tileAction, windowKey } from './agent-helpers.ts';
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

test('⌘\\ belongs to the text while typing, in a terminal leaving the board menu shut, but ⌘K opens the switcher there', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const menu = window.getByRole('dialog', { name: 'Board menu' });
    const switcher = window.getByRole('dialog', { name: 'Jump to a session or zone' });
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByTestId('session-terminal').click();
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(menu).toHaveCount(0);
    await window.keyboard.press(windowKey('k'));
    await expect(switcher).toBeVisible();
    await expect(menu).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(switcher).toHaveCount(0);

    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.keyboard.press('ControlOrMeta+Backslash');
    await expect(menu).toBeVisible();
    // It opens on its search field.
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

test('fifteen docked sessions in a narrow window scroll sideways inside the dock, fade at its edges, keep the newest pill in view, and move nothing else, and never reach the zones pill or the zoom bar', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await window.setViewportSize({ width: 900, height: 700 });
    for (let count = 0; count < 15; count++) {
      await newShell(window);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Minimise session window' }).click();
      await expect(dockItem(window)).toHaveCount(count + 1);
    }
    const dock = window.getByTestId('session-dock');
    const track = window.getByTestId('session-dock-track');
    const box = async (locator: Locator) => (await locator.boundingBox())!;
    // Inside the window and never over the zones pill (bottom left), the zoom bar (bottom right) or the minimap, in a narrow
    // window, as it widens, and when the zones pill mounts late and then grows wide; one pill tall however many there are.
    const overlaps = async () => {
      const dockNow = await box(dock);
      const { width } = window.viewportSize()!;
      const problems: string[] = [];
      if (dockNow.x < 0 || dockNow.x + dockNow.width > width) problems.push(`the dock leaves the window: ${JSON.stringify(dockNow)}`);
      if (dockNow.width < 239 && (await dock.getAttribute('data-compact')) === null) problems.push(`the dock is only ${dockNow.width}px wide`);
      for (const [name, selector] of [['the zones pill', '.island-bottom-left'], ['the zoom bar', '.island-bottom-right'], ['the minimap', '.board-minimap']] as const) {
        const other = window.locator(selector);
        if ((await other.count()) === 0 || !(await other.first().isVisible())) continue;
        const near = (await other.first().boundingBox())!;
        const apart = near.x + near.width <= dockNow.x + 0.5 || dockNow.x + dockNow.width <= near.x + 0.5 || near.y + near.height <= dockNow.y + 0.5 || dockNow.y + dockNow.height <= near.y + 0.5;
        if (!apart) problems.push(`the dock overlaps ${name}: dock ${JSON.stringify(dockNow)}, ${name} ${JSON.stringify(near)}`);
      }
      return problems.join('; ') || 'apart';
    };
    await expect.poll(overlaps).toBe('apart');
    const dockBox = await box(dock);
    const heights = await dockItem(window).evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);

    // It overflows and scrolls, and the newest pill, docked last, is in view.
    const scrolls = () => track.evaluate((element) => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));
    expect((await scrolls()).max).toBeGreaterThan(0);
    const inView = async (item: Locator) => {
      const [i, t] = [await box(item), await box(track)];
      return i.x >= t.x - 1 && i.x + i.width <= t.x + t.width + 1;
    };
    await expect.poll(() => inView(dockItem(window).last())).toBe(true);
    await expect(dock).toHaveAttribute('data-more', 'start');
    expect(await inView(dockItem(window).first())).toBe(false);

    // Wheel (vertical, as a mouse's), trackpad (horizontal) and shift-wheel all scroll it, and the dock itself stays put.
    await window.mouse.move(dockBox.x + dockBox.width / 2, dockBox.y + dockBox.height / 2);
    await window.mouse.wheel(0, -300);
    await expect.poll(async () => (await scrolls()).left).toBeLessThan((await scrolls()).max);
    const afterWheel = (await scrolls()).left;
    await window.mouse.wheel(-200, 0);
    await expect.poll(async () => (await scrolls()).left).toBeLessThan(afterWheel);
    const afterTrackpad = (await scrolls()).left;
    await window.keyboard.down('Shift');
    await window.mouse.wheel(0, -200);
    await window.keyboard.up('Shift');
    await expect.poll(async () => (await scrolls()).left).toBeLessThan(afterTrackpad);
    await expect(dock).toHaveAttribute('data-more', /^(end|both)$/);
    expect(await box(dock)).toEqual(dockBox);

    // A long name is cut short, its tooltip whole.
    const first = dockItem(window).first().getByRole('button', { name: /^Shell/ });
    await first.hover();
    await expect(window.getByRole('tooltip')).toContainText('Shell');

    // The list is not left open when the dock widens back to its pills, nor opens again when it narrows (no zones yet: the zoom
    // bar alone leaves room for the pills at 900px and not at 520px).
    const compactButton = window.getByTestId('session-dock-compact');
    await window.setViewportSize({ width: 520, height: 700 });
    await expect(compactButton).toBeVisible();
    await compactButton.click();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(15);
    await window.setViewportSize({ width: 900, height: 700 });
    await expect(compactButton).toBeHidden();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(0);
    await window.setViewportSize({ width: 520, height: 700 });
    await expect(compactButton).toBeVisible();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(0);
    await window.setViewportSize({ width: 900, height: 700 });
    await expect(compactButton).toBeHidden();

    // The zones pill mounts with the first zone, and grows wide with each one after it.
    await window.evaluate(async () => {
      const { zones } = globalThis.window.agentBoard;
      for (let index = 0; index < 10; index++) {
        await zones.addUnbound({ name: `A zone with a rather long name ${index + 1}`, x: (index % 4) * 320, y: Math.floor(index / 4) * 220, width: 300, height: 200 });
      }
    });
    await expect(window.locator('.island-bottom-left')).toBeVisible();
    // However narrow it gets, it never reaches them: with less than a pill's room it is one button with the count, which opens
    // the list, and with less than that again, a row up.
    for (const width of [1400, 900, 640, 520, 380, 1400]) {
      await window.setViewportSize({ width, height: 700 });
      await expect.poll(overlaps, { message: `${width}px wide` }).toBe('apart');
      const compactButton = window.getByTestId('session-dock-compact');
      await expect
        .poll(async () => {
          const compact = (await dock.getAttribute('data-compact')) !== null;
          const shown = [await compactButton.isVisible(), await track.isVisible()];
          if (shown[0] !== compact || shown[1] === compact) return `compact ${compact}, but the button shows ${shown[0]} and the pills ${shown[1]}`;
          return compact ? await compactButton.innerText() : 'pills';
        }, { message: `${width}px wide` })
        .toMatch(/^(pills|15 sessions)$/);
    }
    // Collapsed, the button opens every docked session, and restoring one closes the list.
    await window.setViewportSize({ width: 520, height: 700 });
    await expect(window.getByTestId('session-dock-compact')).toBeVisible();
    await window.getByTestId('session-dock-compact').click();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(15);
    await window.getByTestId('dock-list-item').first().getByRole('button', { name: /^Shell/ }).click();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(0);
    await expect(sessionWindow(window)).toBeVisible();

    // Clicking inside the list, off its buttons, leaves the window that is shown showing, and the list open.
    await compactButton.click();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(14);
    const card = (await window.locator('.session-dock-popover').boundingBox())!;
    await window.mouse.click(card.x + 2, card.y + 2);
    await expect(sessionWindow(window)).toBeVisible();
    await expect(window.getByTestId('dock-list-item')).toHaveCount(14);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
