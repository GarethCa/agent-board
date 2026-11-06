// Renderer routing of synthetic keys only. Playwright's keyboard.press does not reach the app menu's accelerators (a real
// menu item on ⌘D, Q or K stayed unfired in every run), so nothing here shows whether a menu item steals a key from a
// terminal. That is the macOS key-order question, which needs real keystrokes; app-menu.test.ts guards the template.
import { expect } from '@playwright/test';
import { launch, screen, sessionWindow, SHELL_ENV } from './agent-helpers.ts';
import { test, newShell, removeDataDir, tempDataDir } from './launch.ts';

test("N, K, M and Q typed into a focused terminal reach it and add nothing to the board, though each adds an item with the board focused", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    const nodes = window.locator('.react-flow__node');
    const before = await nodes.count();

    // The four keys are pressed one at a time at the prompt, and only show up in the command's output if the terminal got them.
    await window.getByTestId('session-terminal').click();
    await window.keyboard.type('echo x$((40 + 2))');
    for (const key of ['k', 'm', 'q', 'n']) await window.keyboard.press(key);
    await window.keyboard.press('Enter');
    await expect(screen(window)).toContainText('x42kmqn');
    expect(await nodes.count()).toBe(before);
    await expect(window.getByTestId('queue-card')).toHaveCount(0);

    // Control: with the board focused, each of the four adds an item, so the checks above could fail.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.click(pane.x + 400, pane.y + 300);
    for (const [index, key] of ['n', 'k', 'm', 'q'].entries()) {
      await window.mouse.move(pane.x + 200 + index * 260, pane.y + 150);
      await window.keyboard.press(key);
      await expect(nodes).toHaveCount(before + index + 1);
      await window.keyboard.press('Escape');
      await window.mouse.click(pane.x + 400, pane.y + 500);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test.describe('⌘D', () => {
  test.skip(process.platform !== 'darwin', "off macOS the split is Ctrl+Shift+D, and Ctrl+D is the shell's end-of-input");

  test('splits the pane in a focused terminal and leaves the selected note alone, where on the board it duplicates the note', async () => {
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, SHELL_ENV);
    try {
      // A note to duplicate, selected: it is what the board's ⌘D would copy.
      const pane = (await window.locator('.react-flow__pane').boundingBox())!;
      await window.mouse.move(pane.x + 300, pane.y + 200);
      await window.keyboard.press('n');
      const notes = window.getByTestId('sticky');
      await expect(notes).toHaveCount(1);
      await window.keyboard.press('Escape');
      await notes.click({ position: { x: 4, y: 4 } });
      await expect(window.locator('.react-flow__node.selected')).toHaveCount(1);

      await newShell(window);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByTestId('session-terminal').click();
      const panes = sessionWindow(window).getByTestId('window-pane');
      const before = await panes.count();
      await window.keyboard.press('Meta+d');
      // The split is the ordering point: by the time the pane is there, a duplicate would have been made too. Removing the
      // pane handler's stopPropagation does not fail this: the key then reaches the window, where isTyping and
      // inOverlay hold it, so this guards the outcome whichever layer holds it.
      await expect.poll(() => panes.count()).toBeGreaterThan(before);
      await expect(notes).toHaveCount(1);

      // Control: with the board focused, ⌘D does duplicate the note.
      await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
      await notes.first().click({ position: { x: 4, y: 4 } });
      await window.keyboard.press('Meta+d');
      await expect(notes).toHaveCount(2);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
});
