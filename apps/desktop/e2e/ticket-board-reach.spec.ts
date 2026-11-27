import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { launch, sessionWindow, TURN_MS, windowKey } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { drawsAsTicket } from '../src/renderer/src/board/tiles.ts';

/** Starts an agent in `zoneId` through the daemon: a ticket's chat, or one of its helpers. */
const start = (window: Page, params: { zoneId: string; prompt: string; name?: string; ticketChat?: boolean; ticket?: string; position?: { x: number; y: number } }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

const spotlight = (page: Page) => page.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
const field = (page: Page) => spotlight(page).getByRole('combobox', { name: 'Jump to a session, zone or setting' });

test("⌘K finds a helper from the main board on its ticket's tile and a note on the ticket's own board; Needs you there picks the helper on that board; the minimap marks the ticket's tile", async () => {
  test.setTimeout(120_000);
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const zone = await window.evaluate(async (path) => {
      const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Run: pnpm test | Run the test suite', name: 'Build the watch settings', ticket: chat.sessionId, position: { x: 400, y: 40 } });
    await window.evaluate(
      (ticket) => globalThis.window.agentBoard.items.create({ kind: 'sticky', ticket, zoneId: null, x: 0, y: 220, width: 200, height: 160, rotation: 0, data: { text: 'Make the dot 8 px on dark', color: '#fff3a3' } }),
      chat.sessionId,
    );
    const board = window.getByTestId('ticket-board');
    const member = (sessionId: string) => board.locator(`.react-flow__node[data-id="member:${sessionId}"]`);

    // The minimap marks the ticket's tile, which has a board of its own, and no other.
    await expect(window.locator('.board-minimap').getByTestId('minimap-ticket-mark')).toHaveCount(1);
    // While its chat starts, the helper has a tile of its own; once the chat draws as its ticket's tile, that tile holds
    // it. Picked before then, the helper's own tile would be selected and then go. So wait for the chat to have started,
    // with nothing waiting on a click to reach it: the board's own test of whether it draws as its ticket's tile.
    await expect
      .poll(
        async () => {
          const agents = await window.evaluate(() => globalThis.window.agentBoard.agents.list());
          const drawn = agents.find((each) => each.sessionId === chat.sessionId);
          return drawn !== undefined && drawsAsTicket(drawn);
        },
        { timeout: TURN_MS },
      )
      .toBe(true);
    await expect(window.locator(`.react-flow__node[data-id="agent:${chat.sessionId}"]`)).toHaveCount(1);
    await expect(window.locator(`.react-flow__node[data-id="agent:${helper.sessionId}"]`)).toHaveCount(0);

    // ⌘K from the main board: the helper's row says the ticket it is on, and picking it shows it here, as before.
    await window.keyboard.press(windowKey('k'));
    await field(window).fill('Build the watch');
    const helperRow = spotlight(window).getByTestId('spotlight-row').filter({ hasText: 'Build the watch settings' });
    await expect(helperRow).toContainText(chat.name);
    await helperRow.click();
    // The tile that draws it is picked: the ticket's tile, which holds the helper.
    await expect(window.locator(`.react-flow__node.selected[data-id="agent:${chat.sessionId}"]`)).toHaveCount(1);
    await expect(board).toBeHidden();

    // ⌘K finds the note on the ticket's board, under the ticket's name, and zooms in to show it there: it is on no other.
    await window.keyboard.press(windowKey('k'));
    await field(window).fill('dot 8 px');
    const noteRow = spotlight(window).getByTestId('spotlight-row').filter({ hasText: 'Make the dot 8 px on dark' });
    await expect(noteRow).toHaveAttribute('data-kind', 'item');
    await expect(noteRow).toContainText(chat.name);
    // Enter picks the active row: wait until the results have settled on the note's.
    await expect(noteRow).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Enter');
    await expect(board).toBeVisible();
    await expect(board.locator('.react-flow__node.selected')).toContainText('Make the dot 8 px on dark');

    // Needs you, from the ticket's board: the helper that asks permission is picked on that board, its window over it.
    // From the main board, Needs you on a helper opens its window there, as for any agent: that path is the inbox's own.
    // A helper's permission prompt always reaches the user. It was seen when ⌘K picked it, so the pill's count leaves it
    // out, but the list still holds it; the pill opens the list, which closes when the focus leaves it.
    await expect.poll(() => window.evaluate(async (id) => (await globalThis.window.agentBoard.agents.list()).find((a) => a.sessionId === id)?.permissions.length ?? 0, helper.sessionId), { timeout: TURN_MS }).toBeGreaterThan(0);
    await window.getByTestId('inbox-count').dispatchEvent('click');
    const asking = window.getByTestId('needs-you-inbox').locator(`[data-testid="inbox-item"][data-session-id="${helper.sessionId}"]`);
    await expect(asking).toHaveAttribute('data-kind', 'permission');
    await asking.getByRole('button', { name: `Open ${helper.name}`, exact: true }).click();
    await expect(board).toBeAttached();
    await expect(member(helper.sessionId)).toHaveClass(/selected/);
    await expect(sessionWindow(window)).toHaveAttribute('data-session-id', helper.sessionId);
    await expect(sessionWindow(window).getByTestId('session-terminal')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
