import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, spawnAgent, tile, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';
import { openSettings, settingsSection } from './settings-helpers.ts';

type Mode = 'All' | 'Hand-offs only' | 'None';

/** Picks which connections the board draws, in the Settings window's Board › Connections. */
async function showConnections(window: Page, mode: Mode): Promise<void> {
  const settings = await openSettings(window, 'board.connections');
  const choice = settingsSection(settings, 'Connections').getByRole('group', { name: 'Show connections' }).getByRole('button', { name: mode });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  // The pointer leaves the board's tiles, as clicking in another window does: a hovered tile shows its own connections.
  await window.mouse.move(5, 5);
}

const savedMode = (window: Page) => window.evaluate(() => globalThis.window.agentBoard.view.get('connections'));
/** The pill is beside the object inside the board's node for it, not in it. */
const badge = (object: Locator) => object.locator('xpath=ancestor::*[contains(@class, "react-flow__node")][1]').getByTestId('connections-count');

test('connections are hidden, hand-offs only or shown from the board menu or ⇧E, hidden ones still hand off, and a hovered tile shows its own', async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    for (const prompt of ['Write the code', 'Review the code', 'Bystander']) await spawnAgent(window, 'monorepo', prompt);
    const coder = tile(window).filter({ hasText: 'Write the code' });
    const reviewer = tile(window).filter({ hasText: 'Review the code' });
    const bystander = tile(window).filter({ hasText: 'Bystander' });
    for (const agent of [coder, reviewer, bystander]) await expect(agent).toHaveAttribute('data-state', 'waiting');
    const all = await agents(window);
    const id = (name: string) => all.find((agent) => agent.name === name)!.sessionId;
    const [zone] = await zones(window);
    // The coder and reviewer apart in a row, and the bystander under the reviewer, all in view.
    await window.evaluate(
      async ({ zoneId, ids }) => {
        const places = [{ x: 20, y: 40 }, { x: 400, y: 40 }, { x: 400, y: 300 }];
        for (const [index, sessionId] of ids.entries()) await globalThis.window.agentBoard.agents.move(sessionId, { zoneId, ...places[index]! });
      },
      { zoneId: zone!.id, ids: [id('Write the code'), id('Review the code'), id('Bystander')] },
    );
    // A hand-off edge, and an arrow, which is not one.
    await window.evaluate(
      async ({ from, to, far }) => {
        await globalThis.window.agentBoard.flowEdges.create({ from, to });
        await globalThis.window.agentBoard.connectors.create({ from: { type: 'agent', id: to, side: 'bottom' }, to: { type: 'agent', id: far, side: 'top' } });
      },
      { from: id('Write the code'), to: id('Review the code'), far: id('Bystander') },
    );
    // And a note under the coder, joined by an arrow: connections of any kind of object are hidden and counted.
    await window.evaluate(
      async ({ zoneId, from }) => {
        const note = await globalThis.window.agentBoard.items.create({ kind: 'sticky', zoneId, x: 20, y: 320, width: 230, height: 120, data: { text: 'Note', color: '#fff3a3' } });
        await globalThis.window.agentBoard.connectors.create({ from: { type: 'agent', id: from, side: 'bottom' }, to: { type: 'item', id: note.id, side: 'top' } });
      },
      { zoneId: zone!.id, from: id('Write the code') },
    );
    const note = window.getByTestId('sticky');
    const edges = window.locator('.react-flow__edge');
    await expect(edges).toHaveCount(3);
    await expect(badge(coder)).toHaveCount(0);

    // Hand-offs only: the arrow goes, and the tiles at its ends say they have one.
    await showConnections(window, 'Hand-offs only');
    await expect(edges).toHaveCount(1);
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(badge(reviewer)).toHaveText('↔ 1');
    await expect(badge(bystander)).toHaveText('↔ 1');
    await expect(badge(coder)).toHaveText('↔ 1');
    await expect(badge(note)).toHaveText('↔ 1');
    expect(await savedMode(window)).toBe('handoffs');

    // None: all go, and the badges count them all.
    await showConnections(window, 'None');
    await expect(edges).toHaveCount(0);
    await expect(badge(coder)).toHaveText('↔ 2');
    await expect(badge(reviewer)).toHaveText('↔ 2');
    await expect(badge(bystander)).toHaveText('↔ 1');
    expect(await savedMode(window)).toBe('none');

    // Hovering a tile shows its own, and only its own.
    await bystander.hover();
    await expect(edges).toHaveCount(1);
    await reviewer.hover();
    await expect(edges).toHaveCount(2);
    // A moment after the pointer leaves, they go; but not before it could reach one.
    await window.mouse.move(5, 5);
    await expect(edges).toHaveCount(0);

    // A selected edge stays drawn, and with it its Edge rules: nothing is open over a line that isn't there.
    await reviewer.hover();
    await window.getByTestId('flow-edge').click({ force: true });
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await expect(rules).toBeVisible();
    await window.mouse.move(5, 5);
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(rules).toBeVisible();
    // Deselected, it goes, and its panel with it.
    await window.mouse.click(5, 300);
    await expect(edges).toHaveCount(0);
    await expect(rules).toHaveCount(0);

    // A hand-off still delivers while its edge is hidden.
    await window.evaluate((sessionId) => globalThis.window.agentBoard.agents.answer(sessionId, 'Ship it'), id('Write the code'));
    await expect
      .poll(async () => (await agents(window)).find((agent) => agent.sessionId === id('Review the code'))?.lastMessage)
      .toBe(`Done: ⟨hand-off from Write the code · agent:${id('Write the code').slice(0, 8)}⟩ Hand-off from Write the code (its final message): Done: Ship it..`);
    await expect(edges).toHaveCount(0);

    // ⇧E cycles: None, All, Hand-offs only, None; a plain E does nothing.
    await window.keyboard.press('e');
    await expect(edges).toHaveCount(0);
    await window.keyboard.press('Shift+E');
    await expect(edges).toHaveCount(3);
    await expect(badge(reviewer)).toHaveCount(0);
    await window.keyboard.press('Shift+E');
    await expect(edges).toHaveCount(1);
    await window.keyboard.press('Shift+E');
    await expect(edges).toHaveCount(0);

    // The pointer over a tile as the mode changes: its own show at once, without leaving and coming back.
    await window.keyboard.press('Shift+E');
    await expect(edges).toHaveCount(3);
    await reviewer.hover();
    await window.keyboard.press('Shift+E');
    await window.keyboard.press('Shift+E');
    await expect(edges).toHaveCount(2);
    await window.mouse.move(5, 5);
    await expect(edges).toHaveCount(0);

    // The mode is kept across a restart.
    await app.close();
    const again = await launch(dataDir, env);
    app = again.app;
    window = again.window;
    await expect(window.getByTestId('agent-tile')).toHaveCount(3);
    await expect(window.getByTestId('connections-count')).toHaveCount(4);
    await expect(window.locator('.react-flow__edge')).toHaveCount(0);
    expect(await savedMode(window)).toBe('none');
    await showConnections(window, 'All');
    await expect(window.locator('.react-flow__edge')).toHaveCount(3);
    expect(await savedMode(window)).toBe('all');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
