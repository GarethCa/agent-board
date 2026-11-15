import { expect, type Page } from '@playwright/test';
import { launch } from './agent-helpers.ts';
import { removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/** Starts an agent in `zoneId` through the daemon: a ticket's chat, or one of its helpers. */
const start = (window: Page, params: { zoneId: string; prompt: string; ticketChat?: boolean; ticket?: string; role?: string }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

/**
 * Opens the ticket's own board from its tile's ⋯ menu, once the tile shows its `helpers`: as cards in the open tile's
 * strip (a live chat opens as its terminal), or as icons on the card. A tile still drawing a helper that has just joined
 * can drop a menu opened over it, so the press is tried again until the menu is up.
 */
async function openAsBoard(window: Page, chatId: string, helpers = 1): Promise<void> {
  const tile = window.locator(`[data-session-id="${chatId}"]`).filter({ has: window.getByRole('button', { name: 'More' }) }).first();
  await expect(tile.locator('[data-testid="ticket-helper-card"], [data-testid="ticket-helper"]')).toHaveCount(helpers);
  const item = window.getByRole('menuitem', { name: 'Open as board' });
  await expect(async () => {
    if (await item.isVisible()) return;
    await window.keyboard.press('Escape');
    await tile.getByRole('button', { name: 'More' }).click();
    await expect(item).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await item.click();
}

test("a ticket's tile zooms into its own board, with its helpers and a note on it and a box to message it; the breadcrumb and Esc zoom out, and a relaunch lands where the user was", async () => {
  // Two launches of the app, the second on the first's data.
  test.setTimeout(120_000);
  const { env, repo } = scratch('output');
  const dataDir = tempDataDir();
  const first = await launch(dataDir, env);
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const { app, window } = first;
    const zone = await window.evaluate(async (path) => {
      const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    await window.evaluate(
      (ticket) => globalThis.window.agentBoard.items.create({ kind: 'sticky', ticket, zoneId: null, x: 0, y: 220, width: 200, height: 160, rotation: 0, data: { text: 'Make the dot 8 px on dark', color: '#fff3a3' } }),
      chat.sessionId,
    );
    // A note on the main board, which the keys pressed on the ticket's board must leave alone.
    await window.evaluate(() =>
      globalThis.window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 1800, y: 0, width: 200, height: 160, rotation: 0, data: { text: 'On the main board', color: '#fff3a3' } }),
    );
    const mainItems = () => window.evaluate(async () => (await globalThis.window.agentBoard.items.list()).map((item) => item.id));
    const onMain = await mainItems();
    expect(onMain).toHaveLength(1);
    const board = window.getByTestId('ticket-board');
    const crumb = window.getByTestId('ticket-board-crumb');

    // In: its chat and helper as tiles, the note on its board, and the breadcrumb in the creation toolbar's place.
    await openAsBoard(window, chat.sessionId);
    await expect(board).toBeVisible();
    await expect(crumb).toContainText('Board');
    await expect(board.getByTestId('ticket-board-chat')).toHaveCount(1);
    await expect(board.getByTestId('ticket-board-helper')).toHaveCount(1);
    await expect(board.getByTestId('ticket-board-helper')).toContainText('Build the watch settings');
    await expect(board.getByText('Make the dot 8 px on dark')).toBeVisible();
    await expect(window.getByRole('toolbar', { name: 'Create' })).toBeHidden();
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('board.level'))).toEqual({ ticket: chat.sessionId });

    // The main board's keys are off while it is hidden: select all and delete, or a paste, leave it as it was.
    await window.keyboard.press('Meta+a');
    await window.keyboard.press('Backspace');
    await app.evaluate(({ clipboard }) => clipboard.writeText('A pasted line'));
    await window.keyboard.press('Meta+v');
    // Long enough for a delete or a paste to have reached the daemon, had either run.
    await window.waitForTimeout(500);
    expect(await mainItems()).toEqual(onMain);
    await expect(board).toBeVisible();

    // The chat's tile has a box to message the ticket: keys typed there edit the message, Esc leaves the board open, and Enter sends it.
    const message = board.getByTestId('ticket-board-chat').getByRole('textbox', { name: 'Message to the agent' });
    await expect(message).toHaveAttribute('placeholder', 'Message the ticket…');
    await message.click();
    await window.keyboard.type('A first go');
    await window.keyboard.press('Meta+a');
    await window.keyboard.press('Backspace');
    await window.keyboard.press('Escape');
    await expect(message).toHaveValue('');
    await expect(board).toBeVisible();
    expect(await mainItems()).toEqual(onMain);
    await message.fill('How is the build going?');
    await window.keyboard.press('Enter');
    await expect(message).toHaveValue('');

    // A helper dragged here gets a place on the ticket's board, and keeps its tile where it was on the main board.
    const before = await window.evaluate(async (id) => (await globalThis.window.agentBoard.agents.list()).find((agent) => agent.sessionId === id)!.position, helper.sessionId);
    const tile = board.getByTestId('ticket-board-helper');
    const box = (await tile.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 8 });
    await window.mouse.up();
    await expect
      .poll(() => window.evaluate(async (id) => (await globalThis.window.agentBoard.agents.list()).find((agent) => agent.sessionId === id)!.ticketPlace, helper.sessionId))
      .toBeDefined();
    expect(await window.evaluate(async (id) => (await globalThis.window.agentBoard.agents.list()).find((agent) => agent.sessionId === id)!.position, helper.sessionId)).toEqual(before);

    // Out by the breadcrumb, in again, and out by Esc.
    await window.getByTestId('ticket-board-back').click();
    await expect(board).toBeHidden();
    await expect(window.getByRole('toolbar', { name: 'Create' })).toBeVisible();
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('board.level'))).toBeNull();
    await openAsBoard(window, chat.sessionId);
    await expect(board).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(board).toBeHidden();

    // In once more, then a relaunch on the same data lands on the ticket's board.
    await openAsBoard(window, chat.sessionId);
    await expect.poll(() => window.evaluate(() => globalThis.window.agentBoard.view.get('board.level'))).toEqual({ ticket: chat.sessionId });
    await app.close();
    second = await launch(dataDir, env);
    await expect(second.window.getByTestId('ticket-board')).toBeVisible({ timeout: 30_000 });
    await expect(second.window.getByTestId('ticket-board').getByText('Make the dot 8 px on dark')).toBeVisible();
    // The helper is drawn where it was dragged to: its saved place on the ticket's board.
    const place = await second.window.evaluate(async (id) => (await globalThis.window.agentBoard.agents.list()).find((agent) => agent.sessionId === id)!.ticketPlace, helper.sessionId);
    expect(place).toBeDefined();
    const drawn = second.window.getByTestId('ticket-board').locator(`.react-flow__node[data-id="member:${helper.sessionId}"]`);
    await expect(drawn).toHaveAttribute('style', new RegExp(`translate\\(${place!.x}px, ${place!.y}px\\)`));
  } finally {
    await first.app.close().catch(() => {});
    await second?.app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test("a right-click on a ticket's board arranges its chat and helpers beside its note, and moves nothing on the main board", async () => {
  test.setTimeout(90_000);
  const { env, repo } = scratch('output');
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
    await window.evaluate(
      (ticket) => globalThis.window.agentBoard.items.create({ kind: 'sticky', ticket, zoneId: null, x: 600, y: 40, width: 200, height: 160, rotation: 0, data: { text: 'Make the dot 8 px on dark', color: '#fff3a3' } }),
      chat.sessionId,
    );
    const agents = () => window.evaluate(async () => (await globalThis.window.agentBoard.agents.list()).map(({ sessionId, position, ticketPlace }) => ({ sessionId, position, ticketPlace })));
    const before = await agents();
    expect(before.every((agent) => agent.ticketPlace === undefined)).toBe(true);

    await openAsBoard(window, chat.sessionId);
    const board = window.getByTestId('ticket-board');
    await expect(board.getByTestId('ticket-board-helper')).toHaveCount(1);
    // On the background, clear of the tiles and the note.
    const pane = (await board.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.click(pane.x + pane.width - 40, pane.y + pane.height - 40, { button: 'right' });
    await window.getByRole('menuitem', { name: /^Arrange/ }).click();

    // Both get places on the ticket's board, left of the note and level with its top; their main-board places stay.
    await expect.poll(async () => (await agents()).every((agent) => agent.ticketPlace !== undefined)).toBe(true);
    const after = await agents();
    expect(after.map(({ sessionId, position }) => ({ sessionId, position }))).toEqual(before.map(({ sessionId, position }) => ({ sessionId, position })));
    const placeOf = (id: string) => after.find((agent) => agent.sessionId === id)!.ticketPlace!;
    expect(placeOf(chat.sessionId).y).toBe(40);
    expect(placeOf(helper.sessionId).y).toBe(40);
    expect(placeOf(chat.sessionId).x).toBeLessThan(placeOf(helper.sessionId).x);
    expect(placeOf(helper.sessionId).x + 240).toBeLessThan(600);
    const drawn = board.locator(`.react-flow__node[data-id="member:${helper.sessionId}"]`);
    const { x, y } = placeOf(helper.sessionId);
    await expect(drawn).toHaveAttribute('style', new RegExp(`translate\\(${x}px, ${y}px\\)`));
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
