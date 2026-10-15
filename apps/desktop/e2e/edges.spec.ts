import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { Connector, FlowEdge } from '@agent-board/daemon/protocol';
import { agents, launch, spawnAgent, tile, zones } from './agent-helpers.ts';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

// Arrows and hand-offs between agents: one drawn from agent to agent asks which it is, ⌥ makes it a
// hand-off at once, and either can be bent and its ends moved to other sides.

const flowEdges = (page: Page): Promise<FlowEdge[]> => page.evaluate(() => window.agentBoard.flowEdges.list());
const connectors = (page: Page): Promise<Connector[]> => page.evaluate(() => window.agentBoard.connectors.list());
const nodeOf = (page: Page, sessionId: string) => page.locator(`.react-flow__node[data-id="agent:${sessionId}"]`);
const chooser = (page: Page) => page.getByTestId('handoff-chooser');

/** Drags from a side handle of an agent's tile (shown on hover) to the middle of `to`. */
async function dragFromHandle(page: Page, sessionId: string, side: string, to: Locator, hold?: string): Promise<void> {
  await nodeOf(page, sessionId).hover();
  const handle = nodeOf(page, sessionId).locator(`> .connector-handle[data-side="${side}"]`);
  await expect(handle).toHaveCSS('opacity', '1');
  await drag(page, centreOf(await settledBox(handle)), centreOf(await settledBox(to)), { hold });
}

/** Moves the agents' tiles to `x` across the zone, in order, on one row. */
async function placeAt(page: Page, sessionIds: string[], xs: number[]): Promise<void> {
  const [zone] = await zones(page);
  await page.evaluate(
    async ({ zoneId, sessionIds, xs }) => {
      for (const [index, id] of sessionIds.entries()) await window.agentBoard.agents.move(id, { zoneId, x: xs[index]!, y: 40 });
    },
    { zoneId: zone!.id, sessionIds, xs },
  );
  for (const id of sessionIds) await settledBox(nodeOf(page, id));
}

/** Two agents at their prompts, the first's tile on the left and well clear of the second's. */
async function twoAgents(page: Page): Promise<{ left: string; right: string }> {
  await spawnAgent(page, 'monorepo', 'Write the code');
  await spawnAgent(page, 'monorepo', 'Review the code');
  for (const name of ['Write the code', 'Review the code']) await expect(tile(page).filter({ hasText: name })).toHaveAttribute('data-state', 'waiting');
  const all = await agents(page);
  const [left, right] = ['Write the code', 'Review the code'].map((name) => all.find((agent) => agent.name === name)!.sessionId);
  await placeAt(page, [left!, right!], [20, 620]);
  return { left: left!, right: right! };
}

test('an arrow dropped from one agent on another asks Arrow or Hand off: Enter and Esc keep the arrow, H or a click hands off, undo makes it the arrow again, ⌥ skips the chooser, and a note to an agent is just an arrow', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const { left, right } = await twoAgents(window);
    const target = nodeOf(window, right);

    // Arrow is the default: Enter keeps it, as does Esc. Neither makes a hand-off.
    for (const key of ['Enter', 'Escape']) {
      await dragFromHandle(window, left, 'right', target);
      await expect(chooser(window)).toBeVisible();
      await expect(chooser(window).getByRole('menuitem', { name: /Arrow/ })).toBeFocused();
      await window.keyboard.press(key);
      await expect(chooser(window)).toHaveCount(0);
      await expect.poll(() => connectors(window)).toEqual([
        expect.objectContaining({ from: expect.objectContaining({ type: 'agent', side: 'right' }), to: expect.objectContaining({ type: 'agent', side: 'left' }) }),
      ]);
      expect(await flowEdges(window)).toEqual([]);
      // Taken back: the next drag starts from an empty board.
      await window.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => connectors(window)).toEqual([]);
    }

    // Hand off (clicked, here) makes the arrow a hand-off from the same sides, its Edge rules open.
    await dragFromHandle(window, left, 'right', target);
    await chooser(window).getByRole('menuitem', { name: /Hand off/ }).click();
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(window.getByRole('complementary', { name: 'Edge rules' })).toBeVisible();
    await expect.poll(() => connectors(window)).toEqual([]);
    expect(await flowEdges(window)).toEqual([expect.objectContaining({ from: left, to: right, fromSide: 'right', toSide: 'left' })]);

    // One undo makes it the arrow again; redo, the hand-off.
    await window.keyboard.press('Escape');
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => flowEdges(window)).toEqual([]);
    await expect.poll(async () => (await connectors(window)).length).toBe(1);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await flowEdges(window)).length).toBe(1);
    await expect.poll(() => connectors(window)).toEqual([]);
    await window.keyboard.press('ControlOrMeta+z');
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => [(await flowEdges(window)).length, (await connectors(window)).length]).toEqual([0, 0]);

    // With ⌥ held throughout, it is a hand-off as soon as it is let go: no chooser.
    await dragFromHandle(window, left, 'right', target, 'Alt');
    await expect.poll(async () => (await flowEdges(window)).length).toBe(1);
    await expect(chooser(window)).toHaveCount(0);
    expect(await connectors(window)).toEqual([]);

    // A note dropped on an agent is an arrow, with no chooser, ⌥ or not.
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await window.mouse.move(pane.x + 80, pane.y + pane.height - 120);
    await window.keyboard.press('n');
    await window.keyboard.press('Escape');
    const note = window.getByTestId('sticky');
    await note.hover();
    const noteHandle = note.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " react-flow__node ")]').locator('.connector-handle[data-side="top"]');
    await expect(noteHandle).toHaveCSS('opacity', '1');
    await drag(window, centreOf(await settledBox(noteHandle)), centreOf(await settledBox(target)), { hold: 'Alt' });
    await expect.poll(async () => (await connectors(window)).length).toBe(1);
    await expect(chooser(window)).toHaveCount(0);
    expect(await flowEdges(window)).toHaveLength(1);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-off bent through a point and with an end moved to another side keeps its shape across a restart, and undo puts it back', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const { left, right } = await twoAgents(window);
    await dragFromHandle(window, left, 'right', nodeOf(window, right), 'Alt');
    await expect.poll(async () => (await flowEdges(window)).length).toBe(1);
    const edgePath = window.locator('.react-flow__edge-path.flow-edge');

    // Selected (it is, once drawn), it shows a handle on each end and one halfway along: pulled out, it is a bend.
    const insert = window.getByTestId('line-insert');
    await expect(insert).toHaveCount(1);
    const middle = centreOf(await settledBox(insert));
    await drag(window, middle, { x: middle.x, y: middle.y - 120 });
    await expect(window.getByTestId('line-bend')).toHaveCount(1);
    await expect.poll(async () => (await flowEdges(window))[0]!.points).toHaveLength(1);

    // Its far end, dragged over the top of the other tile, moves to that side.
    const end = window.locator('[data-testid="line-end"][data-end="to"]');
    const other = await settledBox(nodeOf(window, right));
    await drag(window, centreOf(await settledBox(end)), { x: other.x + other.width / 2, y: other.y + 4 });
    await expect.poll(async () => (await flowEdges(window))[0]!.toSide).toBe('top');
    const shaped = (await flowEdges(window))[0]!;
    const drawn = await edgePath.getAttribute('d');

    // Undo takes the side back, then the bend; redo does both again.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await flowEdges(window))[0]!.toSide).toBe('left');
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await flowEdges(window))[0]!.points).toEqual([]);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await flowEdges(window))[0]).toMatchObject({ toSide: 'top', points: shaped.points });

    // Its style changes over its label, and back.
    await window.getByRole('toolbar', { name: 'Edge style' }).getByRole('button', { name: 'Elbow' }).click();
    await expect.poll(async () => (await flowEdges(window))[0]!.style).toBe('elbow');
    await window.getByRole('toolbar', { name: 'Edge style' }).getByRole('button', { name: 'Curved' }).click();
    await expect.poll(async () => (await flowEdges(window))[0]!.style).toBe('curved');

    // After a restart it is drawn just as it was.
    await app.close();
    ({ app, window } = await launch(dataDir, env));
    await expect(window.locator('.react-flow__edge-path.flow-edge')).toHaveCount(1);
    expect((await flowEdges(window))[0]).toMatchObject({ fromSide: 'right', toSide: 'top', style: 'curved', points: shaped.points });
    await expect.poll(() => window.locator('.react-flow__edge-path.flow-edge').getAttribute('d')).toBe(drawn);

    // Its zone moved, both its agents move with it, and so does its bend: the whole line moves, its shape as it was.
    const line = window.locator('.react-flow__edge-path.flow-edge');
    const box = () => line.evaluate((path: SVGPathElement) => {
      const { x, y, width, height } = path.getBBox();
      return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    });
    const before = await box();
    const [zone] = await zones(window);
    await window.evaluate(
      ({ id, x, y, width, height }) => globalThis.window.agentBoard.zones.update(id, { x: x + 120, y: y + 80, width, height }),
      zone!,
    );
    await expect.poll(box).toEqual({ ...before, x: before.x + 120, y: before.y + 80 });
    expect((await flowEdges(window))[0]!.points).toEqual(shaped.points);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand-off between tiles too close for its label shows a marker, the label on hover or focus, its rules on a click, and a manual one's Send; apart, the label comes back", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const { left, right } = await twoAgents(window);
    await window.evaluate(([from, to]) => globalThis.window.agentBoard.flowEdges.create({ from: from!, to: to!, trigger: 'manual' }), [left, right]);
    const edge = window.getByTestId('flow-edge');
    await expect(edge.locator('.flow-edge-pill')).toHaveCount(1);
    await expect(edge).not.toHaveAttribute('data-collapsed');

    // Side by side, the line between them is too short: a marker, its trigger in a dot, with Send beside it.
    await placeAt(window, [left, right], [20, 300]);
    await expect(edge).toHaveAttribute('data-collapsed', 'true');
    const marker = window.getByTestId('flow-edge-marker');
    await expect(marker).toHaveAttribute('aria-label', 'final message: Delivers when sent');
    await expect(edge.locator('.flow-edge-pill')).toHaveCount(0);

    // Hovered, or focused, the label shows over it.
    const dot = marker.locator('.flow-edge-trigger-dot');
    await dot.hover();
    await expect(edge.locator('.flow-edge-pill')).toHaveCount(1);
    await expect(edge).toContainText('final message');
    await window.mouse.move(5, 400);
    await expect(edge.locator('.flow-edge-pill')).toHaveCount(0);
    await marker.focus();
    await expect(edge.locator('.flow-edge-pill')).toHaveCount(1);
    await marker.blur();

    // Its Send, beside it, sends; Enter on it, or a click, opens its rules.
    await window.getByTestId('flow-edge-marker-send').click();
    await expect.poll(async () => (await flowEdges(window))[0]!.lastDelivery).not.toBeNull();
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await marker.focus();
    await window.keyboard.press('Enter');
    await expect(rules).toBeVisible();
    await rules.getByRole('button', { name: 'Close edge rules' }).click();
    await expect(rules).toHaveCount(0);
    await dot.click();
    await expect(rules).toBeVisible();

    // Apart again, the label is back on the line.
    await placeAt(window, [left, right], [20, 620]);
    await expect(edge).not.toHaveAttribute('data-collapsed');
    await expect(edge.locator('.flow-edge-pill')).toHaveCount(1);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an arrow between notes bent through a point, its end moved to another side, keeps its shape across a restart', async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, {});
  try {
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    for (const x of [200, 600]) {
      await window.mouse.move(pane.x + x, pane.y + 300);
      await window.keyboard.press('n');
      await window.keyboard.press('Escape');
    }
    const notes = window.getByTestId('sticky');
    await expect(notes).toHaveCount(2);
    const left = notes.nth(0);
    await left.hover();
    const handle = left.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " react-flow__node ")]').locator('.connector-handle[data-side="right"]');
    await expect(handle).toHaveCSS('opacity', '1');
    await drag(window, centreOf(await settledBox(handle)), centreOf(await settledBox(notes.nth(1))));
    await expect.poll(async () => (await connectors(window)).length).toBe(1);

    // Selected by a click on its line, it shows its handles: pulled out, the middle one bends it; its far end, dragged
    // over the other note's bottom, moves there.
    const line = window.locator('.react-flow__edge-path.connector-line');
    const box = await settledBox(line);
    await window.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
    const insert = window.getByTestId('line-insert');
    await expect(insert).toHaveCount(1);
    const middle = centreOf(await settledBox(insert));
    await drag(window, middle, { x: middle.x, y: middle.y + 140 });
    await expect.poll(async () => (await connectors(window))[0]!.points).toHaveLength(1);
    const other = await settledBox(notes.nth(1));
    await drag(window, centreOf(await settledBox(window.locator('[data-testid="line-end"][data-end="to"]'))), { x: other.x + other.width / 2, y: other.y + other.height - 4 });
    await expect.poll(async () => (await connectors(window))[0]!.to.side).toBe('bottom');
    const shaped = (await connectors(window))[0]!;
    const drawn = await line.getAttribute('d');

    await app.close();
    ({ app, window } = await launch(dataDir, {}));
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(1);
    expect((await connectors(window))[0]).toMatchObject({ from: { side: 'right' }, to: { side: 'bottom' }, points: shaped.points });
    await expect.poll(() => window.locator('.react-flow__edge-path.connector-line').getAttribute('d')).toBe(drawn);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
