import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { agents, launch, sessionWindow, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, browseForZone, pickFolderNext, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';
import { nodeRect, settledBox } from './board-helpers.ts';

test("a double-click opens the agent's pop-up over the dimmed board; Esc, – and a click on the board each go back to its tile; pinned expanded, it comes back pinned", async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  // The app's own default, the pop-up, rather than the session window the other specs keep.
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' });
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(window.locator('.board[data-click-opens]')).toHaveAttribute('data-click-opens', 'popup');
    const popup = window.getByTestId('agent-popup');
    const agentTile = tile(window).filter({ hasText: 'Pick a database' });

    // Its header and its session, over the whole board, dimmed, with the pop-up centred on it and the keys its own; no
    // session window opens, and nothing on the board moves.
    await agentTile.dblclick();
    await expect(popup).toBeVisible();
    await expect(popup.locator('.session-window-head')).toContainText('Pick a database');
    for (const name of ['Expand', 'Pop out', 'More', 'Back to its tile']) await expect(popup.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(window.getByTestId('session-window')).toHaveCount(0);
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);
    const scrim = window.getByTestId('agent-popup-scrim');
    await expect(scrim).toHaveCSS('position', 'absolute');
    const board = (await window.locator('.board').boundingBox())!;
    const dimmed = (await scrim.boundingBox())!;
    for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(dimmed[side] - board[side])).toBeLessThan(2);
    const box = (await popup.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (board.x + board.width / 2))).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - (board.y + board.height / 2))).toBeLessThan(2);
    expect(await popup.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    // Esc from its header goes back to the tile, selected.
    await popup.locator('.session-window-head-fill').click();
    await window.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(window.locator('.react-flow__node.selected')).toContainText('Pick a database');

    // So does –.
    await agentTile.dblclick();
    await popup.getByRole('button', { name: 'Back to its tile', exact: true }).click();
    await expect(popup).toHaveCount(0);

    // And a click on the dimmed board, which reaches nothing under it.
    await agentTile.dblclick();
    await window.getByTestId('agent-popup-scrim').click({ position: { x: 5, y: 5 } });
    await expect(popup).toHaveCount(0);
    await expect(tile(window)).toHaveCount(1);

    // Pinned expanded, a double-click on its header opens the pop-up too: the tile hands its session over, so it is
    // drawn once, and Esc gives the tile back, still pinned, where it was and at its size.
    const expanded = window.getByTestId('expanded-tile');
    await tileAction(agentTile, 'Pin expanded', 'Arrange');
    await expect(expanded).toHaveAttribute('data-pinned', 'true');
    await expect.poll(async () => (await agents(window))[0]!.pinnedExpanded).toBe(true);
    const expandedNode = window.locator('.react-flow__node').filter({ has: expanded });
    await settledBox(expandedNode);
    const at = await nodeRect(expandedNode);
    await expanded.locator('.session-window-head-fill').dblclick();
    await expect(popup).toBeVisible();
    await expect(expanded).toHaveCount(0);
    await popup.locator('.session-window-head-fill').click();
    await window.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(expanded).toHaveAttribute('data-pinned', 'true');
    expect((await agents(window))[0]!.pinnedExpanded).toBe(true);
    await expect.poll(() => nodeRect(expandedNode)).toEqual(at);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/** Starts an agent in `zoneId` through the daemon: a ticket's chat, or one of its helpers. */
const start = (window: Page, params: { zoneId: string; prompt: string; ticketChat?: boolean; ticket?: string; role?: string }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

test("a ticket's pop-up has one row of tabs, its Board, its chat and its helper; a click, ⌃Tab, ⌘1–9 and ⌘[ move along it, a drag reorders it and the order stays", async () => {
  const { repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' });
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    const zone = await window.evaluate(async (path) => {
      const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    // Its tile at rest as a card, so a double-click pops it up rather than finding it opened in place.
    const settings = await openSettings(window, 'board.tiles');
    await settings.getByRole('group', { name: 'Ticket tiles open as' }).getByRole('button', { name: 'Card' }).click();
    await settings.close();
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
    const card = window.locator(`[data-ticket-tile][data-session-id="${chat.sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // It opens on its chat. The row: its Board, then the chat's tab with its pill, then its helper's; + ends it.
    await card.dblclick();
    const popup = window.getByTestId('agent-popup');
    await expect(popup).toHaveAttribute('data-ticket', 'true');
    const tabs = popup.getByTestId('agent-popup-tabs').getByTestId('session-tab');
    const tab = (key: string) => popup.getByTestId('agent-popup-tabs').locator(`[data-testid="session-tab"][data-tab="${key}"]`);
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAttribute('data-tab', 'board');
    await expect(tabs.nth(1)).toHaveAttribute('data-tab', chat.sessionId);
    await expect(tabs.nth(1)).toContainText('chat');
    await expect(tabs.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(tabs.nth(2)).toHaveAttribute('data-tab', helper.sessionId);
    await expect(popup.getByTestId('agent-popup-tab-dot')).toHaveCount(2);
    await expect(popup.getByTestId('agent-popup-plus')).toBeVisible();
    // The tab that is on has its ⋯; one row of tabs, the session under it drawing no strip of its own, with no + or Split.
    await expect(tab(chat.sessionId).getByTestId('agent-popup-tab-more')).toBeVisible();
    await expect(tab(helper.sessionId).getByTestId('agent-popup-tab-more')).toHaveCount(0);
    await expect(popup.locator('.session-tabs-list')).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'New tab' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Split pane' })).toHaveCount(0);
    // Its Terminal | Chat switch is in the header.
    await expect(popup.locator('.agent-popup-head').getByRole('group', { name: 'View' })).toBeVisible();
    // Its helper stays off the board.
    await expect(tile(window)).toHaveCount(1);

    // A click on the helper's tab shows the helper, the chat's underlined as the one it came from; ⌘[ goes back to it.
    // The row holds still: the ⋯ moves to the helper's tab in room each tab keeps for it.
    // Within a pixel: a tab's character changes its pose, by a fraction of a pixel, as it turns on; a shift is a slot's width.
    const plusAt = async () => (await popup.getByTestId('agent-popup-plus').boundingBox())?.x ?? Number.NaN;
    const heldStill = (before: number, after: number) => expect(Math.abs(after - before)).toBeLessThan(1);
    const plusBefore = await plusAt();
    await tab(helper.sessionId).getByRole('tab').click();
    heldStill(plusBefore, await plusAt());
    await expect(tab(helper.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(tab(chat.sessionId)).toHaveAttribute('data-from', 'true');
    await window.keyboard.press('Meta+BracketLeft');
    await expect(tab(chat.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(tab(helper.sessionId)).toHaveAttribute('data-from', 'true');

    // ⌃Tab one on, round to the start; ⌃⇧Tab one back; ⌘1 the first.
    await window.keyboard.press('Control+Tab');
    await expect(tab(helper.sessionId)).toHaveAttribute('data-active', 'true');
    await window.keyboard.press('Control+Tab');
    await expect(tab('board')).toHaveAttribute('data-active', 'true');
    await window.keyboard.press('Control+Shift+Tab');
    await expect(tab(helper.sessionId)).toHaveAttribute('data-active', 'true');
    // ⌘1 from the helper's terminal too, whose panes have ⌘1–9 of their own.
    await window.keyboard.press('Meta+1');
    await expect(tab('board')).toHaveAttribute('data-active', 'true');

    // The Board shows the ticket's board in the pop-up, with no breadcrumb of its own; × closes it, back to the tab
    // before, and + opens it again.
    await expect(popup.getByTestId('ticket-board')).toHaveAttribute('data-in-pop-up', 'true');
    await tab('board').getByRole('button', { name: 'Close Board' }).click();
    await expect(tab('board')).toHaveCount(0);
    await expect(tab(helper.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(popup.locator('[data-from]')).toHaveCount(0);
    await popup.getByTestId('agent-popup-plus').click();
    await window.getByRole('menuitem', { name: /Board/ }).click();
    await expect(tab('board')).toHaveAttribute('data-active', 'true');
    // From the Board to the chat, its × giving way to the room kept for it, the row holds still too.
    const plusOnBoard = await plusAt();
    await tab(chat.sessionId).getByRole('tab').click();
    await expect(tab(chat.sessionId)).toHaveAttribute('data-active', 'true');
    heldStill(plusOnBoard, await plusAt());

    // A drag puts the helper's tab before the chat's; closed and opened again, the row keeps that order, on its chat.
    await tab(helper.sessionId).dragTo(tab(chat.sessionId), { targetPosition: { x: 4, y: 8 } });
    await expect(tabs.nth(1)).toHaveAttribute('data-tab', helper.sessionId);
    await expect(tabs.nth(2)).toHaveAttribute('data-tab', chat.sessionId);
    await popup.getByRole('button', { name: 'Back to its tile', exact: true }).click();
    await card.dblclick();
    await expect(tab(chat.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(tabs.nth(1)).toHaveAttribute('data-tab', helper.sessionId);

    // Too narrow for the row, the tabs fold into "+n" from the right; the tab that is on stays, and none is clipped.
    const strip = popup.getByTestId('agent-popup-tabs');
    // Room for the chat's tab, +, and "+n", but not the Board's tab beside them.
    const chatWidth = (await tab(chat.sessionId).boundingBox())?.width ?? 0;
    await strip.evaluate((element, width) => (element.style.width = `${width}px`), Math.round(chatWidth + 110));
    await expect(popup.getByTestId('agent-popup-more')).toHaveText(/^\+2/);
    await expect(tab(chat.sessionId)).toBeVisible();
    expect(await strip.locator('.session-tabs-list').evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
    await strip.evaluate((element) => (element.style.width = ''));
    await expect(popup.getByTestId('agent-popup-more')).toHaveCount(0);

    // ⌥-click opens the helper in its own window.
    await tab(helper.sessionId).getByRole('tab').click({ modifiers: ['Alt'] });
    await expect(sessionWindow(window)).toHaveAttribute('data-session-id', helper.sessionId);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("Answer on a ticket's tile opens its pop-up on the helper that asks", async () => {
  // Under this scenario the chat does its work and ends; the helper asks to run a command, and waits.
  const { repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' });
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    const zone = await window.evaluate(async (path) => {
      const result = await globalThis.window.agentBoard.zones.addFolder(path, { x: 0, y: 0, width: 1600, height: 900, color: '#4c6ef5' });
      if (result.status !== 'added') throw new Error(result.message);
      return result.zone;
    }, repo);
    const settings = await openSettings(window, 'board.tiles');
    await settings.getByRole('group', { name: 'Ticket tiles open as' }).getByRole('button', { name: 'Card' }).click();
    await settings.close();
    const chat = await start(window, { zoneId: zone.id, prompt: 'Watch settings for a zone', ticketChat: true });
    const helper = await start(window, { zoneId: zone.id, prompt: 'Ask permission', ticket: chat.sessionId });
    const card = window.locator(`[data-ticket-tile][data-session-id="${chat.sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    const answer = card.getByTestId('tile-act');
    await expect(answer).toHaveText('Answer', { timeout: 30_000 });
    await answer.click();
    const popup = window.getByTestId('agent-popup');
    const tabs = popup.getByTestId('agent-popup-tabs').getByTestId('session-tab');
    await expect(tabs.nth(2)).toHaveAttribute('data-tab', helper.sessionId);
    await expect(tabs.nth(2)).toHaveAttribute('data-active', 'true');
    await expect(tabs.nth(2)).toHaveAttribute('data-ask', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
