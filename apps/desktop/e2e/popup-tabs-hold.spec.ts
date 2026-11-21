import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { launch, tile } from './agent-helpers.ts';
import { test, removeDataDir, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings } from './settings-helpers.ts';

// A click on a tab in the pop-up's row, or the pointer over one, leaves every tab where it was and as wide.
const start = (window: Page, params: { zoneId: string; prompt: string; ticketChat?: boolean; ticket?: string; role?: string }) =>
  window.evaluate(async (asked) => {
    const result = await globalThis.window.agentBoard.agents.spawn({ ...asked, cols: 100, rows: 30 });
    if (result.status !== 'started') throw new Error(result.message);
    return result.agent;
  }, params);

const boxes = (tabs: Locator) => tabs.evaluateAll((all) => all.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width }; }));

/** Clicks each tab in turn, checking every tab's place and width under the pointer and away from it. */
async function holdsStill(window: Page, tabs: Locator) {
  const count = await tabs.count();
  await tabs.nth(0).getByRole('tab').click();
  await window.mouse.move(0, 0);
  await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true');
  const first = await boxes(tabs);
  for (let index = 0; index < count; index++) {
    await tabs.nth(index).getByRole('tab').click();
    await expect(tabs.nth(index)).toHaveAttribute('data-active', 'true');
    expect(await boxes(tabs), `hovering tab ${index}`).toEqual(first);
    await window.mouse.move(0, 0);
    expect(await boxes(tabs), `after clicking tab ${index}`).toEqual(first);
  }
}

for (const design of ['classic', 'simplified'] as const)
  test(`under the ${design} design, a click on any tab of the pop-up's row, or the pointer over it, moves no tab`, async () => {
    const { repo, env } = scratch('output');
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_CLICK_OPENS: '' }, [], { design });
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
      await start(window, { zoneId: zone.id, prompt: 'Build the watch settings', ticket: chat.sessionId, role: 'implementer' });
      const card = window.locator(`[data-ticket-tile][data-session-id="${chat.sessionId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.dblclick();
      const popup = window.getByTestId('agent-popup');
      const tabs = popup.getByTestId('agent-popup-tabs').getByTestId('session-tab');
      // A view's tab (its Board, with a × while on, as a shell's tab has) and two agents' (with a ⋯ while on).
      await expect(tabs).toHaveCount(3);

      await holdsStill(window, tabs);

      // One agent alone with a shell: its own tab, named for its view, and the shell's.
      await popup.getByRole('button', { name: 'Back to its tile', exact: true }).click();
      await expect(popup).toHaveCount(0);
      await start(window, { zoneId: zone.id, prompt: 'Pick a database' });
      const lone = tile(window).filter({ hasText: 'Pick a database' });
      await expect(lone).toBeVisible({ timeout: 30_000 });
      await lone.dblclick();
      await popup.getByTestId('agent-popup-plus').click();
      await window.getByRole('menuitem', { name: /^New shell in this worktree/ }).click();
      await expect(tabs).toHaveCount(2);
      await holdsStill(window, tabs);
    } finally {
      await app.close();
      removeDataDir(dataDir);
    }
  });
