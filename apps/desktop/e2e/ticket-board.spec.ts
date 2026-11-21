import { expect, type Page } from '@playwright/test';
import { launch, sessionWindow, TURN_MS, windowKey } from './agent-helpers.ts';
import { removeDataDir, runDesign, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

/** Starts an agent in `zoneId` through the daemon: a ticket's chat, or one of its helpers. */
const start = (window: Page, params: { zoneId: string; prompt: string; name?: string; harness?: 'claude' | 'codex'; ticketChat?: boolean; ticket?: string; role?: string }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

/** Adds `repo` as a zone on the main board. */
const addZone = (window: Page, repo: string) =>
  window.evaluate(async (path) => {
    const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
    if (result.status !== 'added') throw new Error(result.message);
    return result.zone;
  }, repo);

/** Puts a note on the board of the ticket whose chat is `ticket`, at `at`. */
const addTicketNote = (window: Page, ticket: string, at: { x: number; y: number }) =>
  window.evaluate(
    ({ ticket, x, y }) => globalThis.window.agentBoard.items.create({ kind: 'sticky', ticket, zoneId: null, x, y, width: 200, height: 160, rotation: 0, data: { text: 'Make the dot 8 px on dark', color: '#fff3a3' } }),
    { ticket, ...at },
  );

/** Each agent's place on the main board and, once it has one, on its ticket's board. */
const agents = (window: Page) =>
  window.evaluate(async () => (await globalThis.window.agentBoard.agents.list()).map(({ sessionId, position, ticketPlace }) => ({ sessionId, position, ticketPlace })));

/** The sessions whose windows are saved as open, for the next launch to open again. */
const openWindows = (window: Page) =>
  window.evaluate(async () => {
    const saved = await globalThis.window.agentBoard.view.get('windows');
    return Array.isArray(saved) ? saved.map((entry: { id?: unknown }) => entry.id) : [];
  });

/**
 * Opens the ticket's own board from its tile's ⋯ menu, once the ticket has its `helpers`. A tile still drawing a helper that has just joined
 * can drop a menu opened over it, so the press is tried again until the menu is up.
 */
async function openAsBoard(window: Page, chatId: string, helpers = 1): Promise<void> {
  const tile = window.locator(`[data-session-id="${chatId}"]`).filter({ has: window.getByRole('button', { name: 'More' }) }).first();
  await expect
    .poll(() => window.evaluate(async (id) => (await globalThis.window.agentBoard.agents.list()).filter((agent) => agent.ticket === id).length, chatId), { timeout: 30_000 })
    .toBe(helpers);
  const item = window.getByRole('menuitem', { name: "Open the ticket's board" });
  await expect(async () => {
    if (await item.isVisible()) return;
    await window.keyboard.press('Escape');
    // A short try, so that a press the tile drops, or one that can't land while it redraws, is tried again.
    await tile.getByRole('button', { name: 'More' }).click({ timeout: 2_000 });
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
    const zone = await addZone(window, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    await addTicketNote(window, chat.sessionId, { x: 0, y: 220 });
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

test("a ticket's ⋯ opens its Watches sheet, and Close ticket… asks, then ends its chat and its helper", async () => {
  test.setTimeout(90_000);
  const { env, repo } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const zone = await addZone(window, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    const ended = () =>
      window.evaluate(
        async (ids) => (await globalThis.window.agentBoard.agents.list()).filter((agent) => ids.includes(agent.sessionId) && agent.endedAt !== null).length,
        [chat.sessionId, helper.sessionId],
      );
    // Ticket tiles open as their terminal by default, expanded in place, whose ⋯ has no Watches… (its header has them).
    // It opens once the board and its settings are read, which can be after the first key below: wait for it, and put
    // it back to its card with Esc, as the user does.
    const open = window.locator(`section.ticket-open[data-session-id="${chat.sessionId}"]`);
    await expect(open).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      await window.keyboard.press('Escape');
      await expect(open).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    const tile = window.locator(`[data-session-id="${chat.sessionId}"]`).filter({ has: window.getByRole('button', { name: 'More' }) }).first();
    const menuItem = async (name: string) => {
      const item = window.getByRole('menuitem', { name });
      await expect(async () => {
        if (await item.isVisible()) return;
        await window.keyboard.press('Escape');
        await tile.getByRole('button', { name: 'More' }).click({ timeout: 2_000 });
        await expect(item).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await item.click();
    };

    // Watches… opens the sheet the eye used to.
    await menuItem('Watches…');
    const sheet = window.getByRole('dialog', { name: /^What .+ watches$/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('It never approves or merges.');
    await window.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    // Close ticket… asks first: cancelled, nothing ends.
    await menuItem('Close ticket…');
    const ask = window.getByRole('alertdialog', { name: 'Close ticket?' });
    await expect(ask).toContainText('and its 1 helper end');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    expect(await ended()).toBe(0);

    // Confirmed, the chat and its helper both end.
    await menuItem('Close ticket…');
    await ask.getByRole('button', { name: 'Close ticket' }).click();
    await expect.poll(ended, { timeout: TURN_MS }).toBe(2);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test("a right-click on a ticket's board arranges its chat and helpers beside its note, and moves nothing on the main board", async () => {
  test.setTimeout(90_000);
  const { env, repo } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const zone = await addZone(window, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    await addTicketNote(window, chat.sessionId, { x: 600, y: 40 });
    const before = await agents(window);
    expect(before.every((agent) => agent.ticketPlace === undefined)).toBe(true);

    await openAsBoard(window, chat.sessionId);
    const board = window.getByTestId('ticket-board');
    await expect(board.getByTestId('ticket-board-helper')).toHaveCount(1);
    // On the background, clear of the tiles and the note.
    const pane = (await board.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.click(pane.x + pane.width - 40, pane.y + pane.height - 40, { button: 'right' });
    await window.getByRole('menuitem', { name: /^Arrange/ }).click();

    // Both get places on the ticket's board, left of the note and level with its top; their main-board places stay.
    await expect.poll(async () => (await agents(window)).every((agent) => agent.ticketPlace !== undefined)).toBe(true);
    const after = await agents(window);
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

test("the whole path on a ticket's board: in from its tile, ⌘K finds a helper there, Needs you answers its question, a right-click arranges it, the breadcrumb zooms out, a relaunch keeps the main board and the arranged places, and a window closed just before a quit stays closed", async () => {
  // Three launches of the app, each on the one before's data. The helper asks with Claude's question tool, which needs
  // the user whatever the needs-you setting; the ticket's chat runs on Codex, which has no such tool, so it asks nothing
  // and its tile is still while its menu is used.
  test.setTimeout(180_000);
  const { env, repo } = scratch('ask-questions');
  const dataDir = tempDataDir();
  const first = await launch(dataDir, env);
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  let third: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const { app, window } = first;
    const zone = await addZone(window, repo);
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', harness: 'codex', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Set up the build', name: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    await addTicketNote(window, chat.sessionId, { x: 600, y: 40 });
    const level = (page = window) => page.evaluate(() => globalThis.window.agentBoard.view.get('board.level'));
    const board = window.getByTestId('ticket-board');
    const member = (sessionId: string) => board.locator(`.react-flow__node[data-id="member:${sessionId}"]`);
    const spotlight = window.getByRole('dialog', { name: 'Jump to a session, zone or setting' });

    // In from the ticket's tile: its chat, its helper and its note on its own board.
    await openAsBoard(window, chat.sessionId);
    await expect(board).toBeVisible();
    await expect(board.getByTestId('ticket-board-helper')).toContainText('Build the watch settings');
    await expect(board.getByText('Make the dot 8 px on dark')).toBeVisible();
    await expect.poll(() => level()).toEqual({ ticket: chat.sessionId });

    // ⌘K on the ticket's board finds the helper and picks it there, where it asks: the board stays in.
    await window.keyboard.press(windowKey('k'));
    await spotlight.getByRole('combobox', { name: 'Jump to a session, zone or setting' }).fill('Build the watch');
    await spotlight.getByTestId('spotlight-row').filter({ hasText: 'Build the watch settings' }).click();
    await expect(board).toBeVisible();
    await expect.poll(() => level()).toEqual({ ticket: chat.sessionId });
    await expect(member(helper.sessionId)).toHaveClass(/selected/);
    await expect(board.getByTestId('ticket-board-helper')).toHaveAttribute('data-ask', 'true', { timeout: TURN_MS });

    // Needs you holds its question; picking an option answers it, and the board stays in.
    const inbox = window.getByTestId('needs-you-inbox');
    if (!(await inbox.isVisible())) await window.getByTestId('inbox-count').dispatchEvent('click');
    await expect(inbox).toBeVisible();
    const asking = inbox.locator(`[data-testid="inbox-item"][data-session-id="${helper.sessionId}"]`);
    const dialog = asking.getByTestId('dialog-quick-ask');
    await expect(dialog).toContainText('Which cache should the build use?');
    await dialog.locator('.quick-ask-option', { hasText: 'Redis' }).click();
    await expect(asking).toHaveCount(0, { timeout: TURN_MS });
    await expect(board.getByTestId('ticket-board-helper')).not.toHaveAttribute('data-ask');
    await expect(board).toBeVisible();
    await expect.poll(() => level()).toEqual({ ticket: chat.sessionId });
    // Its window, opened from its tile on the ticket's board, says what it went with. Under the Classic design it opens on
    // its terminal, under the Simplified on its chat.
    // Dispatched, not clicked: the Needs you list may still be over it. The main board's terminal tile is mounted under
    // this one, so the terminal is looked for in the window.
    await board.getByTestId('ticket-board-helper').dispatchEvent('dblclick');
    await expect(sessionWindow(window)).toHaveAttribute('data-session-id', helper.sessionId);
    await expect(runDesign() === 'simplified' ? sessionWindow(window) : sessionWindow(window).locator('.xterm-rows')).toContainText('Going with Redis.', { timeout: TURN_MS });
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toBeHidden();
    await expect.poll(() => openWindows(window)).not.toContain(helper.sessionId);

    // A right-click on its background arranges the chat and helper beside the note; their main-board places stay.
    const before = await agents(window);
    expect(before.every((agent) => agent.ticketPlace === undefined)).toBe(true);
    const pane = (await board.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.click(pane.x + pane.width - 40, pane.y + pane.height - 40, { button: 'right' });
    await window.getByRole('menuitem', { name: /^Arrange/ }).click();
    await expect.poll(async () => (await agents(window)).every((agent) => agent.ticketPlace !== undefined)).toBe(true);
    const arranged = await agents(window);
    expect(arranged.map(({ sessionId, position }) => ({ sessionId, position }))).toEqual(before.map(({ sessionId, position }) => ({ sessionId, position })));
    const placeOf = (id: string) => arranged.find((agent) => agent.sessionId === id)!.ticketPlace!;
    expect(placeOf(chat.sessionId).x).toBeLessThan(placeOf(helper.sessionId).x);

    // Out by the breadcrumb, back on the main board.
    await window.getByTestId('ticket-board-back').click();
    await expect(board).toBeHidden();
    await expect(window.getByRole('toolbar', { name: 'Create' })).toBeVisible();
    await expect.poll(() => level()).toBeNull();

    // A relaunch on the same data lands on the main board; going in again draws the helper where it was arranged.
    await app.close();
    second = await launch(dataDir, env);
    const again = second.window;
    await expect(again.getByRole('toolbar', { name: 'Create' })).toBeVisible({ timeout: 30_000 });
    await expect(again.getByTestId('ticket-board')).toBeHidden();
    expect(await level(again)).toBeNull();
    expect((await agents(again)).find((agent) => agent.sessionId === helper.sessionId)!.ticketPlace).toEqual(placeOf(helper.sessionId));
    await openAsBoard(again, chat.sessionId);
    const drawn = again.getByTestId('ticket-board').locator(`.react-flow__node[data-id="member:${helper.sessionId}"]`);
    const { x, y } = placeOf(helper.sessionId);
    await expect(drawn).toHaveAttribute('style', new RegExp(`translate\\(${x}px, ${y}px\\)`));
    await expect(again.getByTestId('ticket-board').getByText('Make the dot 8 px on dark')).toBeVisible();
    await expect.poll(() => level(again)).toEqual({ ticket: chat.sessionId });

    // A session window closed just before the app quits stays closed at the next launch: the quit waits for its save.
    await again.getByTestId('ticket-board').getByTestId('ticket-board-helper').dispatchEvent('dblclick');
    await expect(sessionWindow(again)).toHaveAttribute('data-session-id', helper.sessionId);
    await again.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(again)).toBeHidden();
    await second.app.close();
    third = await launch(dataDir, env);
    const last = third.window;
    await expect(last.getByTestId('ticket-board')).toBeVisible({ timeout: 30_000 });
    expect(await openWindows(last)).not.toContain(helper.sessionId);
    await expect(sessionWindow(last)).toBeHidden();
  } finally {
    await first.app.close().catch(() => {});
    await second?.app.close().catch(() => {});
    await third?.app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
