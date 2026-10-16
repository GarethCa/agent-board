import { expect } from '@playwright/test';
import { launch, screen, sessionWindow, setClickOpens, SHELL_ENV } from './agent-helpers.ts';
import { test, newShell, removeDataDir, tempDataDir } from './launch.ts';

test.skip(process.platform !== 'darwin', "macOS line-editing keys are the Mac terminal's");

test('⌘⌫, ⌘←/→ and ⌥←/→ edit the line in a terminal as in any Mac terminal', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByTestId('session-terminal').click();

    // ⌘⌫ empties the line: only the second command runs (the first would be "command not found").
    await window.keyboard.type('hello world');
    await window.keyboard.press('Meta+Backspace');
    await window.keyboard.type('echo emptied-$((40 + 2))');
    await window.keyboard.press('Enter');
    await expect(screen(window)).toContainText('emptied-42');
    await expect(screen(window)).not.toContainText('not found');

    // ⌘← goes to the line start, so the text typed next lands before what was there.
    await window.keyboard.type('end');
    await window.keyboard.press('Meta+ArrowLeft');
    await window.keyboard.type('echo start-');
    await window.keyboard.press('Enter');
    await expect(screen(window)).toContainText('start-end');

    // ⌘→ goes to the line end, ⌥← back a word, ⌥→ forward a word.
    await window.keyboard.type('echo a b');
    await window.keyboard.press('Meta+ArrowLeft');
    await window.keyboard.press('Meta+ArrowRight');
    await window.keyboard.type(' c');
    await window.keyboard.press('Alt+ArrowLeft');
    await window.keyboard.type('X');
    await window.keyboard.press('Alt+ArrowRight');
    await window.keyboard.type('Y');
    await window.keyboard.press('Enter');
    await expect(screen(window)).toContainText('a b XcY');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("⌘⌫ in a terminal clears its line and doesn't delete the selected tile, which Backspace on the board does", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await newShell(window);
    const shell = window.getByTestId('shell-tile');
    // The new shell opens in a window over the board; closing it leaves the tile, which the click selects.
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await shell.click();
    const node = window.locator('.react-flow__node.selected');
    await expect(node).toHaveCount(1);

    // Expanded in place, the tile stays the board's selected node; its terminal takes the keyboard.
    await shell.dblclick();
    const terminal = window.getByTestId('expanded-tile').getByTestId('session-terminal');
    await expect(terminal.locator('.xterm-rows')).toBeVisible();
    await terminal.click();
    await window.keyboard.type('echo gone');
    await window.keyboard.press('Meta+Backspace');
    await window.keyboard.type('echo kept-$((40 + 2))');
    await window.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('kept-42');
    await expect(terminal.locator('.xterm-rows')).not.toContainText('echo gone');
    await expect(window.getByRole('alertdialog')).toHaveCount(0);
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(1);

    // Control: Backspace with the board focused does ask to delete the selected tile, so the checks above could fail.
    await window.getByTestId('expanded-tile').locator('.session-window-head').click();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);
    await shell.click();
    await window.keyboard.press('Backspace');
    await expect(window.getByRole('alertdialog')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
