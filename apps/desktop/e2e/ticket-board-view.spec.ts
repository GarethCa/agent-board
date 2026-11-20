import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';

/** Starts an agent in `zoneId` through the daemon: a ticket's chat, or one of its helpers. */
const start = (window: Page, params: { zoneId: string; prompt: string; ticketChat?: boolean; ticket?: string; role?: string }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

/** Picks what ticket tiles open as in Settings › Board › Agent tiles. */
async function openAs(window: Page, choice: 'Terminal' | 'Card' | 'Board'): Promise<void> {
  const settings = await openSettings(window, 'board.tiles');
  const button = settings.getByRole('group', { name: 'Ticket tiles open as' }).getByRole('button', { name: choice });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await settings.close();
}

test("with Board picked in Settings a ticket's tile rests as its card and a double-click takes the user into its board; its own switch overrides the setting, and Open the ticket's board goes in whatever the view", async () => {
  const { repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const zone = await window.evaluate(async (path) => {
      const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    const nodeId = `agent:${chat.sessionId}`;
    const opened = window.locator(`[data-testid="expanded-tile"][data-session-id="${chat.sessionId}"]`);
    const card = window.locator(`[data-ticket-tile][data-session-id="${chat.sessionId}"]`);
    const board = window.getByTestId('ticket-board');
    const menuRow = async (on: typeof card, name: string) => {
      await on.getByRole('button', { name: 'More' }).click();
      await window.getByRole('menuitem', { name }).click();
    };
    const views = () => window.evaluate(() => globalThis.window.agentBoard.view.get('ticketTiles.views'));

    // Terminal by default; Board in Settings puts it back to its tile at rest.
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal', { timeout: 30_000 });
    await openAs(window, 'Board');
    await expect(opened).toBeHidden();
    await expect(card).toBeVisible();

    // A double-click takes the user into its board; Esc comes back out to its card.
    await card.getByTestId('tile-description').dblclick();
    await expect(board).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(board).toBeHidden();
    await expect(card).toBeVisible();
    await expect(opened).toBeHidden();

    // Its own switch in its ⋯ menu overrides the setting, saved: Show as a terminal opens its terminal.
    await menuRow(card, 'Show as a terminal');
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal');
    await expect.poll(views).toEqual({ [nodeId]: 'terminal' });

    // Open the ticket's board goes in from the terminal view too, and leaves the tile's view as it was.
    await menuRow(opened, "Open the ticket's board");
    await expect(board).toBeVisible();
    await window.getByTestId('ticket-board-back').click();
    await expect(board).toBeHidden();
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal');

    // Show as a board switches it by hand and takes the user in; the setting turned to Card changes it no more.
    await menuRow(opened, 'Show as a board');
    await expect(board).toBeVisible();
    await expect.poll(views).toEqual({ [nodeId]: 'board' });
    await window.keyboard.press('Escape');
    await expect(board).toBeHidden();
    await expect(opened).toBeHidden();
    await openAs(window, 'Card');
    await expect.poll(views).toEqual({ [nodeId]: 'board' });

    // Its ⋯ menu at rest does the same: Show as a card puts it back, Show as a board takes the user in again.
    await menuRow(card, 'Show as a card');
    await expect.poll(views).toEqual({ [nodeId]: 'card' });
    await menuRow(card, 'Show as a board');
    await expect(board).toBeVisible();
    await expect.poll(views).toEqual({ [nodeId]: 'board' });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("in the board view, the tile's one button opens the chat that asks, not the ticket's board", async () => {
  // A question put through the question tool needs the user whatever the needs-you setting; one in plain words at the end
  // of a turn only does when that setting counts finished turns.
  const { repo, env } = scratch('ask-questions');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const zone = await window.evaluate(async (path) => {
      const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    await openAs(window, 'Board');
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const card = window.locator(`[data-ticket-tile][data-session-id="${chat.sessionId}"]`);
    const answer = card.getByTestId('tile-act');
    // Its own ask is an agent tile's: Open, as on any agent that asks. A helper's ask says Answer.
    await expect(answer).toHaveText(/Open/, { timeout: 30_000 });
    await answer.click();
    await expect(sessionWindow(window)).toHaveAttribute('data-session-id', chat.sessionId);
    await expect(window.getByTestId('ticket-board')).toBeHidden();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
