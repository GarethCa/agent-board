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
    // One agent alone, with no second tab open, has no row of tabs.
    await expect(popup.getByTestId('agent-popup-tabs')).toHaveCount(0);
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

    // And a click on the dimmed board, which reaches nothing under it. On a board this size the pop-up fills it less the
    // margin, whose corners resize it: the click goes halfway down the left side, outside the edge's strip.
    await agentTile.dblclick();
    await scrim.click({ position: { x: 3, y: Math.round(dimmed.height / 2) } });
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

test("a ticket's pop-up has one row of tabs, its Board, its chat and its helper; its sidebar lists its views, a click opening one or going to its tab; a click, ⌃Tab, ⌘1–9 and ⌘[ move along it, a drag reorders it and the order stays", async () => {
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
    // The tab that is on has its ⋯; one row of tabs, the session under it drawing no strip of its own: its one + is the
    // row's, and there is no Split.
    await expect(tab(chat.sessionId).getByTestId('agent-popup-tab-more')).toBeVisible();
    await expect(tab(helper.sessionId).getByTestId('agent-popup-tab-more')).toHaveCount(0);
    await expect(popup.locator('.session-tabs-list')).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'New tab' })).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'Split pane' })).toHaveCount(0);
    // The + opens what the strip's + did (shells, a page), the views, or one beside.
    await popup.getByTestId('agent-popup-plus').click();
    for (const name of [/^New shell in this worktree/, /^New shell at a folder…/, /^Web…/, /^Open beside…/]) await expect(window.getByRole('menuitem', { name })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('menuitem', { name: /New shell/ })).toHaveCount(0);
    await expect(popup).toBeVisible();

    // Open beside… splits it: the helper on the right, the chat staying left; the window grows to 16px in from the
    // board's edges, both tabs on with their sides' pills, one row, and the header's split button pressed.
    const popupBoard = (await window.locator('.board').boundingBox())!;
    const before = (await popup.boundingBox())!;
    await popup.getByTestId('agent-popup-plus').click();
    await window.getByRole('menuitem', { name: /^Open beside…/ }).click();
    await window.getByRole('menu').last().getByRole('menuitem').first().click();
    await expect(popup.getByTestId('agent-popup-pane-right')).toBeVisible();
    await expect(popup).toHaveAttribute('data-split', 'true');
    await expect(async () => {
      const grown = (await popup.boundingBox())!;
      expect(Math.abs(grown.x - popupBoard.x - 16)).toBeLessThan(2);
      expect(Math.abs(grown.y - popupBoard.y - 16)).toBeLessThan(2);
      expect(Math.abs(grown.width - (popupBoard.width - 32))).toBeLessThan(2);
    }).toPass();
    await expect(tab(chat.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(tab(chat.sessionId).locator('.session-tab-pill')).toHaveText('left');
    await expect(tab(helper.sessionId)).toHaveAttribute('data-beside', 'true');
    await expect(tab(helper.sessionId).locator('.session-tab-pill')).toHaveText('right');
    await expect(popup.locator('.session-tabs-list')).toHaveCount(1);
    await expect(popup.getByTestId('agent-popup-divider')).toHaveCount(1);
    const splitButton = popup.getByTestId('agent-popup-split');
    await expect(splitButton).toHaveAttribute('aria-pressed', 'true');
    // A click on the right's tab focuses its pane; its ⋯ has Close this side, back to the chat alone at its own size.
    await tab(helper.sessionId).getByRole('tab').click();
    await expect(tab(helper.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(popup.getByTestId('agent-popup-pane-right')).toHaveAttribute('data-focused', 'true');
    await tab(helper.sessionId).getByTestId('agent-popup-tab-more').click();
    await window.getByRole('menuitem', { name: /^Close this side/ }).click();
    await expect(popup.getByTestId('agent-popup-pane-right')).toHaveCount(0);
    await expect(async () => {
      const back = (await popup.boundingBox())!;
      expect(Math.abs(back.width - before.width)).toBeLessThan(2);
      expect(Math.abs(back.height - before.height)).toBeLessThan(2);
    }).toPass();
    await expect(tab(chat.sessionId)).toHaveAttribute('data-active', 'true');
    // Split again from a right-click on the helper's tab, then the row's keys move the focus and never end the split.
    await expect(splitButton).toHaveAttribute('aria-pressed', 'false');
    await tab(helper.sessionId).getByRole('tab').click({ button: 'right' });
    await window.getByRole('menuitem', { name: /^Open beside(?!…)/ }).click();
    await expect(popup.getByTestId('agent-popup-pane-right')).toBeVisible();
    await tab(chat.sessionId).getByRole('tab').focus();
    await window.keyboard.press('Meta+3');
    await expect(tab(helper.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(popup.getByTestId('agent-popup-pane-right')).toHaveAttribute('data-focused', 'true');
    await window.keyboard.press('Meta+2');
    await expect(tab(chat.sessionId)).toHaveAttribute('data-active', 'true');
    await expect(popup.getByTestId('agent-popup-pane-left')).toHaveAttribute('data-focused', 'true');
    // The Board's tab, picked with the right focused, is the one on, the left showing it.
    await tab(helper.sessionId).getByRole('tab').click();
    await tab('board').getByRole('tab').click();
    await expect(tab('board')).toHaveAttribute('data-active', 'true');
    await expect(popup.getByTestId('agent-popup-pane-left')).toHaveAttribute('data-focused', 'true');
    await expect(popup.getByTestId('agent-popup-pane-right')).toBeVisible();
    // The pressed button ends it.
    await splitButton.click();
    await expect(popup.getByTestId('agent-popup-pane-right')).toHaveCount(0);
    // Split, – closes the whole pop-up, and it opens again on one agent.
    await splitButton.click();
    await window.getByRole('menu').last().getByRole('menuitem').first().click();
    await expect(popup.getByTestId('agent-popup-pane-right')).toBeVisible();
    await popup.getByRole('button', { name: 'Back to its tile', exact: true }).click();
    await expect(popup).toHaveCount(0);
    await card.dblclick();
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId('agent-popup-pane-right')).toHaveCount(0);
    await expect(popup).not.toHaveAttribute('data-split', 'true');
    // So does Esc.
    await splitButton.click();
    await window.getByRole('menu').last().getByRole('menuitem').first().click();
    await expect(popup.getByTestId('agent-popup-pane-right')).toBeVisible();
    await popup.locator('.agent-popup-head .session-window-head-fill').click();
    await window.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await card.dblclick();
    await expect(popup.getByTestId('agent-popup-pane-right')).toHaveCount(0);
    // Its one Chat | Terminal switch, for every agent in it, is in the header.
    await expect(popup.locator('.agent-popup-head').getByRole('group', { name: 'View of every agent in this pop-up' })).toBeVisible();
    // Its helper stays off the board.
    await expect(tile(window)).toHaveCount(1);

    // Its views lead its sidebar: the Board, a tab not on, has the dot; a click goes to its tab, never a second one.
    const boardRow = popup.getByTestId('agent-shelves-views').locator('[data-view="board"]');
    await expect(boardRow).toHaveAttribute('data-state', 'open');
    await expect(boardRow.getByTestId('agent-shelves-view-dot')).toBeVisible();
    await boardRow.click();
    await expect(tab('board')).toHaveAttribute('data-active', 'true');
    await expect(boardRow).toHaveAttribute('data-state', 'on');
    await boardRow.click();
    await expect(tabs).toHaveCount(3);
    // The sidebar stays beside the Board, the chat's terminal kept under it, out of view.
    await expect(popup.getByTestId('session-window-cover')).toBeVisible();
    await expect(popup.locator('.session-window-main')).toBeHidden();
    await tab(chat.sessionId).getByRole('tab').click();
    await expect(popup.getByTestId('session-window-cover')).toHaveCount(0);

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
    await expect(boardRow).toHaveAttribute('data-state', 'closed');
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

test('on a wide board the pop-up stops at 1600px, centred; the header button fills the board and the choice is kept; a narrow board has no button', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' });
  // Zoomed out, the board's CSS pixels outnumber the screen's: a 1280px window at 0.35 is a board some 3600px wide.
  const zoom = (factor: number) => app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.setZoomFactor(f)), factor);
  const ACT = { timeout: 10_000 };
  // Where it got to, printed as it goes, so a timeout shows the last stage reached.
  const reached = (stage: string) => console.log(`wide board: ${stage} at ${Math.round(performance.now())}ms`);
  test.setTimeout(120_000);
  reached('launched');
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await pickFolderNext(app, repo);
    await browseForZone(window);
    reached('zone added');
    await spawnAgent(window, 'monorepo', 'Pick a database');
    reached('agent spawned');
    const popup = window.getByTestId('agent-popup');
    const fill = popup.getByTestId('agent-popup-fill');
    const agentTile = tile(window).filter({ hasText: 'Pick a database' });
    const width = async () => Math.round((await popup.boundingBox(ACT))?.width ?? 0);
    await test.step('a 1280px window: no cap, no button', async () => {
      await agentTile.dblclick(ACT);
      await expect(popup).toBeVisible();
      await expect(fill).toHaveCount(0);
      reached('opened at 1x');
    });

    await test.step('a wide board: 1600 wide, centred, as tall as the board less its margin', async () => {
      await zoom(0.35);
      await expect(fill).toBeVisible();
      await expect(fill).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(width).toBe(1600);
      const board = (await window.locator('.board').boundingBox(ACT))!;
      const capped = (await popup.boundingBox(ACT))!;
      expect(board.width).toBeGreaterThan(1632);
      expect(Math.abs(capped.x + capped.width / 2 - (board.x + board.width / 2))).toBeLessThan(2);
      expect(Math.abs(capped.height - (board.height - 32))).toBeLessThan(2);
      reached('capped');
    });

    await test.step('pressed, it fills the board, the button in the accent', async () => {
      await fill.click(ACT);
      await expect(fill).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(width).toBeGreaterThan(1700);
      reached('filled');
    });

    await test.step('a narrow board again: the button goes; the next pop-up, on a wide board, opens filled', async () => {
      await zoom(1);
      await expect(fill).toHaveCount(0);
      await window.keyboard.press('Escape');
      await expect(popup).toHaveCount(0);
      await agentTile.dblclick(ACT);
      await expect(popup).toBeVisible();
      await zoom(0.35);
      await expect(fill).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(width).toBeGreaterThan(1700);
      await fill.click(ACT);
      await expect.poll(width).toBe(1600);
      reached('kept and un-filled');
    });
  } finally {
    await zoom(1).catch(() => {});
    reached('closing');
    await app.close();
    reached('closed');
    await removeDataDir(dataDir);
  }
});

test("on a laptop-size board the pop-up opens as wide as the board less its margin, and its side edges drag out to the board's edges", async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' });
  try {
    await window.emulateMedia({ reducedMotion: 'reduce' });
    // A 1512 x 982 MacBook's screen, less its menu bar and the window's title bar: wider than 16:10, so the 16:10 fit
    // would leave board either side.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1512, 900));
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    const popup = window.getByTestId('agent-popup');
    await tile(window).filter({ hasText: 'Pick a database' }).dblclick();
    await expect(popup).toBeVisible();
    const board = (await window.locator('.board').boundingBox())!;
    expect(board.width / board.height).toBeGreaterThan(16 / 10);
    // Opens as wide as the board less the margin each side, as tall as the room lets it be.
    await expect.poll(async () => Math.round((await popup.boundingBox())?.width ?? 0)).toBe(Math.round(board.width - 32));
    // Narrowed from its side edge, then dragged back out past the board's edge: it stops at the margin.
    const edge = window.getByTestId('agent-popup-edge-e');
    const drag = async (dx: number) => {
      const at = (await edge.boundingBox())!;
      await window.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await window.mouse.down();
      await window.mouse.move(at.x + at.width / 2 + dx / 2, at.y + at.height / 2, { steps: 4 });
      await window.mouse.move(at.x + at.width / 2 + dx, at.y + at.height / 2, { steps: 4 });
      await window.mouse.up();
    };
    await drag(-200);
    await expect.poll(async () => Math.round((await popup.boundingBox())?.width ?? 0)).toBeLessThan(Math.round(board.width - 300));
    await drag(600);
    await expect.poll(async () => Math.round((await popup.boundingBox())?.width ?? 0)).toBe(Math.round(board.width - 32));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
