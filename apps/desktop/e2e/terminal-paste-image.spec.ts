import { expect, type Page } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { launch, screen, sessionWindow, setClickOpens, spawnAgent, tile, TURN_MS, windowKey } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

const GRADIENT = readFileSync(new URL('./images/gradient.png', import.meta.url));

/** Pastes the test image, and `text` beside it, at the first element matching `selector`, as ⌘V does with that on the clipboard. */
async function paste(window: Page, selector: string, text?: string) {
  await window.evaluate(
    ({ bytes, selector, text }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }));
      if (text !== undefined) data.setData('text/plain', text);
      document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { bytes: [...GRADIENT], selector, text },
  );
}

test("an image pasted into an agent's terminal or chat view goes to the agent as a file path, with no image item on the board; a paste with text is left alone", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).dblclick();
    await window.getByTestId('session-terminal').click();
    // Pasted into the terminal's own text field, as ⌘V does with an image on the clipboard.
    const screenText = screen(window);
    // The terminal's text field has the focus.
    await paste(window, '.xterm-helper-textarea');
    await expect(screenText).toContainText('pasted-images', { timeout: TURN_MS });

    // The chat view, with the focus on the page rather than in the message box, as after a click in its transcript.
    await window.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Chat' }).click();
    await window.locator('.session-chat-view').click({ position: { x: 5, y: 5 } });
    expect(await window.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    await paste(window, 'body');
    await expect(window.locator('.composer-field textarea')).toHaveValue(/pasted-images/, { timeout: TURN_MS });
    // Long enough for an item the paste wrongly made to show.
    await window.waitForTimeout(1000);
    await expect(window.getByTestId('board-image')).toHaveCount(0);

    // A copy with text beside its picture pastes the text.
    await window.locator('.composer-field textarea').fill('');
    await window.locator('.session-chat-view').click({ position: { x: 5, y: 5 } });
    await paste(window, 'body', 'cells');
    await expect(window.locator('.composer-field textarea')).toHaveValue('cells');
    await window.waitForTimeout(1000);
    await expect(window.getByTestId('board-image')).toHaveCount(0);

    // A shell tab showing (the agent's terminal hidden behind it): the image goes to the shell, not the hidden agent.
    await window.keyboard.press(windowKey('t'));
    await expect(sessionWindow(window).getByTestId('session-tab')).toHaveCount(2);
    await window.locator('.session-window-head').click({ position: { x: 150, y: 10 } });
    await paste(window, 'body');
    const shellScreen = sessionWindow(window).locator('[data-testid="session-tab-view"][data-focused] .xterm-rows');
    await expect(shellScreen).toContainText('pasted-images', { timeout: TURN_MS });
    await window.waitForTimeout(1000);
    await expect(window.getByTestId('board-image')).toHaveCount(0);

    // Split beside the agent's chat: the image goes to the pane the user is in, the shell's or the agent's.
    await sessionWindow(window).locator('[data-testid="session-tab-view"][data-focused] [data-testid="session-terminal"]').click();
    await window.keyboard.press(windowKey('1'));
    // ⌘D splits the tab showing, so it waits for the agent's tab to be it.
    await expect(sessionWindow(window).getByTestId('session-tab').first()).toHaveAttribute('data-active', 'true');
    // The keys go to what has the focus, which must be in the window: the message box, as the shell's terminal is hidden.
    await window.locator('.composer-field textarea').click();
    await window.keyboard.press(windowKey('d'));
    await expect(sessionWindow(window).getByTestId('window-pane')).toHaveCount(2);
    await window.locator('.session-window-head').click({ position: { x: 150, y: 10 } });
    await paste(window, 'body');
    await expect(sessionWindow(window).locator('[data-testid="session-tab-view"][data-focused] .xterm-rows')).toContainText('pasted-images', { timeout: TURN_MS });
    await window.locator('.composer-field textarea').fill('');
    await sessionWindow(window).locator('[data-testid="session-tab-view"][data-tab="own"] .session-chat-view').click({ position: { x: 5, y: 5 } });
    await window.locator('.session-window-head').click({ position: { x: 150, y: 10 } });
    await paste(window, 'body');
    await expect(window.locator('.composer-field textarea')).toHaveValue(/pasted-images/, { timeout: TURN_MS });
    await expect(window.getByTestId('board-image')).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with tiles expanded in place, a paste goes to the agent whose tile the user last worked in, and to the board once they click it', async () => {
  test.setTimeout(120_000);
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await setClickOpens(window, 'Expand in place');
    for (const name of ['first', 'second']) {
      await spawnAgent(window, 'monorepo', 'Pick a database', { name });
      await expect(tile(window).last()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
      await tile(window).last().dblclick();
    }
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toHaveCount(2);
    const printed = (n: number) => expanded.nth(n).getByTestId('session-terminal').locator('.xterm-rows');

    // The user last worked in the second tile: the focus is then on the page, as after a click in a transcript.
    await expanded.nth(1).getByTestId('session-terminal').click();
    await window.evaluate(() => (document.activeElement as HTMLElement).blur());
    await paste(window, 'body');
    await expect(printed(1)).toContainText('pasted-images', { timeout: TURN_MS });
    await expect(printed(0)).not.toContainText('pasted-images');
    await expect(window.getByTestId('board-image')).toHaveCount(0);

    // Back on the board, a paste is the board's.
    await window.mouse.click(40, 600);
    await paste(window, 'body');
    await expect(window.getByTestId('board-image')).toHaveCount(1);
    await expect(printed(0)).not.toContainText('pasted-images');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
