import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';

/** Starts an agent in `zoneId` through the daemon, with `fields`: a ticket's chat, or one of its helpers. */
const start = (window: Page, params: { zoneId: string; prompt: string; ticketChat?: boolean; ticket?: string; role?: string }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

/** Picks what ticket tiles open as in Settings › Board › Agent tiles. */
async function openAs(window: Page, choice: 'Terminal' | 'Card'): Promise<void> {
  const settings = await openSettings(window, 'board.tiles');
  const button = settings.getByRole('group', { name: 'Ticket tiles open as' }).getByRole('button', { name: choice });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await settings.close();
}

test("a ticket's tile opens as its terminal, follows the Settings default until switched by hand, shows a helper in place with a breadcrumb back, and ⌥-click opens the helper's window", async () => {
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
    const helper = await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    const nodeId = `agent:${chat.sessionId}`;
    const opened = window.locator(`[data-testid="expanded-tile"][data-session-id="${chat.sessionId}"]`);
    const card = window.locator(`[data-ticket-tile][data-session-id="${chat.sessionId}"]`);

    // By default it opens as its chat's live terminal, its helper as a card in the strip under it.
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal', { timeout: 30_000 });
    await expect(opened.getByTestId('session-terminal')).toBeVisible();
    await expect(opened.getByTestId('ticket-helper-card')).toHaveCount(1);

    // A click on its helper's card shows the helper's terminal in place of the chat's; the breadcrumb leads back.
    await opened.getByTestId('ticket-helper-card').click();
    await expect(opened.getByTestId('ticket-crumb')).toContainText('Build the watch settings');
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal');
    await expect(opened.getByTestId('session-terminal')).toBeVisible();
    await opened.getByTestId('ticket-crumb-back').click();
    await expect(opened.getByTestId('ticket-crumb')).toBeHidden();

    // The Settings default moves every tile not switched by hand: Card puts it back to its card, Terminal opens it again.
    await openAs(window, 'Card');
    await expect(opened).toBeHidden();
    await expect(card).toBeVisible();
    await openAs(window, 'Terminal');
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal');

    // Switched by hand to its card, it stays one, saved, whatever the default says.
    await opened.getByTestId('ticket-view-switch').getByRole('button', { name: 'Show as a card' }).click();
    await expect(opened).toBeHidden();
    await expect(card).toBeVisible();
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('ticketTiles.views'))).toEqual({ [nodeId]: 'card' });
    await openAs(window, 'Card');
    await openAs(window, 'Terminal');
    await expect(card).toBeVisible();
    await expect(opened).toBeHidden();

    // At rest it is one agent tile: its helper has no tile and no head on its face, and opens from its ⋯ menu's board.
    await expect(card.getByTestId('ticket-helper')).toHaveCount(0);
    await expect(window.locator(`[data-session-id="${helper.sessionId}"]`)).toHaveCount(0);
    await card.getByRole('button', { name: 'More' }).click();
    await window.getByRole('menuitem', { name: 'Show as a terminal' }).click();
    await expect(opened).toHaveAttribute('data-ticket-open', 'terminal');

    // ⌥-click opens the helper's own session window instead.
    await opened.getByTestId('ticket-helper-card').click({ modifiers: ['Alt'] });
    await expect(sessionWindow(window)).toHaveAttribute('data-session-id', helper.sessionId);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
