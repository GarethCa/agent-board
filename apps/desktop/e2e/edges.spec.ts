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

    // Hand off (clicked, here) makes the arrow a hand-off from the same side, arriving on an automatic one (it was let go
    // on the tile, not a handle), its Edge rules open.
    await dragFromHandle(window, left, 'right', target);
    await chooser(window).getByRole('menuitem', { name: /Hand off/ }).click();
    await expect(window.getByTestId('flow-edge')).toHaveCount(1);
    await expect(window.getByRole('complementary', { name: 'Edge rules' })).toBeVisible();
    await expect.poll(() => connectors(window)).toEqual([]);
    expect(await flowEdges(window)).toEqual([expect.objectContaining({ from: left, to: right, fromSide: 'right', toSide: 'auto' })]);

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

    // Selected (it is, once drawn), a curve shows a handle on each end and one bow handle on its middle, and nothing to
    // pull bends out of: pulled up, the bow bows the whole curve through where it was let go.
    const bow = window.getByTestId('line-bow');
    await expect(bow).toHaveCount(1);
    await expect(window.getByTestId('line-insert')).toHaveCount(0);
    const middle = centreOf(await settledBox(bow));
    await drag(window, middle, { x: middle.x, y: middle.y - 120 });
    await expect.poll(async () => (await flowEdges(window))[0]!.points).toHaveLength(1);
    await expect.poll(async () => centreOf(await settledBox(bow)).y).toBeLessThan(middle.y - 100);

    // Its far end, dragged over the top of the other tile, moves to that side.
    const end = window.locator('[data-testid="line-end"][data-end="to"]');
    const other = await settledBox(nodeOf(window, right));
    await drag(window, centreOf(await settledBox(end)), { x: other.x + other.width / 2, y: other.y + 4 });
    await expect.poll(async () => (await flowEdges(window))[0]!.toSide).toBe('top');
    const shaped = (await flowEdges(window))[0]!;
    const drawn = await edgePath.getAttribute('d');

    // Undo takes the side back, then the bow; redo does both again.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await flowEdges(window))[0]!.toSide).toBe('auto');
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

test("a one-way hand-off is a rail with a small arrow at the receiving end, its document a token at the sender's end with Send while it waits, all reached by the keyboard", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const { left, right } = await twoAgents(window);
    await window.evaluate(([from, to]) => globalThis.window.agentBoard.flowEdges.create({ from: from!, to: to!, trigger: 'manual' }), [left, right]);
    const edge = window.getByTestId('flow-edge');
    await expect(edge).toHaveAttribute('marker-end', 'url(#rail-arrow)');
    await expect(edge).not.toHaveAttribute('data-pair');

    // Its agent done with its turn, its final message waits for Send at its end, however close the tiles.
    await placeAt(window, [left, right], [20, 300]);
    const token = window.getByTestId('rail-token');
    await expect(token).toHaveAttribute('data-state', 'waiting');
    await expect(token).toHaveAttribute('data-side', 'right');
    // Too close for its name to lie along the rail: its mark and Send alone, its name while hovered.
    await expect(token).toHaveAttribute('data-compact', 'true');
    await expect(token.locator('.rail-token-name')).toBeHidden();
    await token.locator('.rail-token-open').hover();
    await expect(token.locator('.rail-token-name')).toBeVisible();
    const send = token.getByTestId('rail-token-send');
    await send.focus();
    await window.keyboard.press('Enter');
    await expect.poll(async () => (await flowEdges(window))[0]!.lastDelivery).toMatchObject({ delivered: true });
    // Delivered, it sits at the other end, saying when, with nothing to send.
    await expect(token).toHaveAttribute('data-state', 'delivered');
    await expect(token).toHaveAttribute('data-side', 'left');
    await expect(token.getByTestId('rail-token-note')).toHaveText(/^delivered \d\d:\d\d( [AP]M)?$/);
    await expect(send).toHaveCount(0);

    // Enter on it opens its rules.
    const rules = window.getByRole('complementary', { name: 'Edge rules' });
    await token.getByRole('button', { name: 'final message: delivered' }).focus();
    await window.keyboard.press('Enter');
    await expect(rules).toBeVisible();
    await expect(rules.getByRole('group', { name: 'Direction' })).toHaveCount(0);

    // Apart, it lies along the rail in full.
    await placeAt(window, [left, right], [20, 620]);
    await expect(token).not.toHaveAttribute('data-compact');
    await expect(token.locator('.rail-token-name')).toBeVisible();

    // Its agent's next turn ends: what it left waits for Send again, at its end.
    await window.evaluate((id) => globalThis.window.agentBoard.agents.answer(id, 'SQLite'), left);
    await expect(token).toHaveAttribute('data-state', 'waiting', { timeout: 15_000 });
    await expect(token).toHaveAttribute('data-side', 'right');
    await expect(send).toBeVisible();

    // Dragged by its tile, the token goes with it at once, motion on: it never trails behind.
    const sender = nodeOf(window, left);
    const before = await settledBox(sender);
    await drag(window, { x: before.x + 60, y: before.y + 14 }, { x: before.x + 60, y: before.y + 214 });
    const [after, chip] = await Promise.all([sender.boundingBox(), token.locator('.rail-token-chip').boundingBox()]);
    expect(after!.y).toBeGreaterThan(before.y + 150);
    expect(Math.abs(chip!.y + chip!.height / 2 - (after!.y + after!.height / 2))).toBeLessThan(6);
    expect(chip!.x).toBeGreaterThan(after!.x + after!.width);
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

    // Selected by a click on its line, it shows its handles: pulled down, the bow bows it; its far end, dragged over
    // the other note's bottom, moves there.
    const line = window.locator('.react-flow__edge-path.connector-line');
    const box = await settledBox(line);
    await window.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
    const bow = window.getByTestId('line-bow');
    await expect(bow).toHaveCount(1);
    const middle = centreOf(await settledBox(bow));
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

/** Makes a sticky note centred on each point of the pane, and returns their board nodes, in the same order. */
async function notesAt(page: Page, points: { x: number; y: number }[]): Promise<{ id: string; node: Locator }[]> {
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  for (const { x, y } of points) {
    await page.mouse.move(pane.x + x, pane.y + y);
    await page.keyboard.press('n');
    await page.keyboard.press('Escape');
  }
  await expect(page.getByTestId('sticky')).toHaveCount(points.length);
  const items = await page.evaluate(() => window.agentBoard.items.list());
  const notes = await Promise.all(
    items.map(async (item) => ({ id: item.id, box: await settledBox(page.locator(`.react-flow__node[data-id="item:${item.id}"]`)) })),
  );
  // Each point is inside the note made there.
  return points.map(({ x, y }) => {
    const { id } = notes.find(({ box }) => pane.x + x >= box.x && pane.x + x <= box.x + box.width && pane.y + y >= box.y && pane.y + y <= box.y + box.height)!;
    return { id, node: page.locator(`.react-flow__node[data-id="item:${id}"]`) };
  });
}

test('while an arrow is drawn only the object near the pointer shows its handles, grown, and one let go on a handle lands on that side', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const [a, b, c] = await notesAt(window, [{ x: 200, y: 200 }, { x: 600, y: 200 }, { x: 400, y: 520 }]);
    await a!.node.hover();
    const from = a!.node.locator('.connector-handle[data-side="right"]');
    await expect(from).toHaveCSS('opacity', '1');
    const start = centreOf(await settledBox(from));
    const target = await settledBox(b!.node);
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();

    // Just left of the other note, not over it: its four handles show, grown; the far note's show none.
    await window.mouse.move(target.x - 24, target.y + target.height / 2, { steps: 10 });
    await expect(b!.node.locator('.connector-handle[data-near]')).toHaveCount(4);
    await expect(c!.node.locator('.connector-handle').first()).toHaveCSS('opacity', '0');
    const bottom = b!.node.locator('.connector-handle[data-side="bottom"]');
    await expect.poll(async () => (await bottom.boundingBox())!.width).toBeGreaterThan(15);

    // Let go on its bottom handle, the arrow lands there.
    const handle = centreOf(await settledBox(bottom));
    await window.mouse.move(handle.x, handle.y, { steps: 6 });
    await window.mouse.up();
    await expect.poll(() => connectors(window)).toEqual([
      expect.objectContaining({ from: expect.objectContaining({ id: a!.id, side: 'right' }), to: expect.objectContaining({ id: b!.id, side: 'bottom' }) }),
    ]);
    await expect(window.locator('.connector-handle[data-near]')).toHaveCount(0);

    // Let go just off the far note, clear of its body and handles, as its handles show: it joins that note, as lit,
    // and makes no new one.
    await a!.node.hover();
    const again = centreOf(await settledBox(a!.node.locator('.connector-handle[data-side="bottom"]')));
    const far = await settledBox(c!.node);
    await window.mouse.move(again.x, again.y);
    await window.mouse.down();
    await window.mouse.move(far.x + 20, far.y + far.height + 24, { steps: 10 });
    await expect(c!.node.locator('.connector-handle[data-near]')).toHaveCount(4);
    await window.mouse.up();
    await expect.poll(async () => (await connectors(window)).map((connector) => connector.to.id)).toEqual([b!.id, c!.id]);
    await expect(window.getByTestId('sticky')).toHaveCount(3);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test("a selected arrow's end dragged onto another object joins it on the side nearest the pointer, goes back when let go on nothing, and undo puts it back", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, {});
  try {
    const [a, b, c] = await notesAt(window, [{ x: 200, y: 200 }, { x: 600, y: 200 }, { x: 400, y: 520 }]);
    await window.evaluate(
      ([from, to]) => globalThis.window.agentBoard.connectors.create({ from: { type: 'item', id: from!, side: 'right' }, to: { type: 'item', id: to!, side: 'left' } }),
      [a!.id, b!.id],
    );
    const line = window.locator('.react-flow__edge-path.connector-line');
    const box = await settledBox(line);
    await window.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
    const end = window.locator('[data-testid="line-end"][data-end="to"]');
    await expect(end).toHaveCount(1);

    // Over the top of the third note, its top handle is the one lit; let go, the end joins it there.
    const third = await settledBox(c!.node);
    const grabbed = centreOf(await settledBox(end));
    await window.mouse.move(grabbed.x, grabbed.y);
    await window.mouse.down();
    await window.mouse.move(third.x + third.width / 2, third.y + 8, { steps: 12 });
    await expect(c!.node.locator('.connector-handle[data-target]')).toHaveAttribute('data-side', 'top');
    await window.mouse.up();
    await expect.poll(async () => (await connectors(window))[0]).toMatchObject({ from: { id: a!.id, side: 'right' }, to: { type: 'item', id: c!.id, side: 'top' } });

    // Let go on empty board, it goes back to where it was.
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    await drag(window, centreOf(await settledBox(end)), { x: pane.x + pane.width - 60, y: pane.y + pane.height - 60 });
    await expect.poll(async () => (await connectors(window))[0]!.to).toMatchObject({ id: c!.id, side: 'top' });

    // One undo puts it back on the note it left.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await connectors(window))[0]!.to).toMatchObject({ id: b!.id, side: 'left' });
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test("a hand-off's end dragged onto a third agent hands off there instead, a note won't take it, and undo puts it back", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const { left, right } = await twoAgents(window);
    await spawnAgent(window, 'monorepo', 'Check the code');
    await expect(tile(window).filter({ hasText: 'Check the code' })).toHaveAttribute('data-state', 'waiting');
    const third = (await agents(window)).find((agent) => agent.name === 'Check the code')!.sessionId;
    const [zone] = await zones(window);
    await window.evaluate(({ zoneId, id }) => globalThis.window.agentBoard.agents.move(id, { zoneId, x: 320, y: 420 }), { zoneId: zone!.id, id: third });
    await window.evaluate(([from, to]) => globalThis.window.agentBoard.flowEdges.create({ from: from!, to: to!, trigger: 'manual' }), [left, right]);
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    const end = window.locator('[data-testid="line-end"][data-end="to"]');
    await expect(end).toHaveCount(1);

    // Dropped on the third agent's tile, it hands off to that agent, from the same agent, its rules as they were.
    const checker = await settledBox(nodeOf(window, third));
    await drag(window, centreOf(await settledBox(end)), { x: checker.x + checker.width / 2, y: checker.y + 10 });
    await expect.poll(async () => (await flowEdges(window))[0]).toMatchObject({ from: left, to: third, toSide: 'top', trigger: 'manual' });

    // A note isn't an agent: let go on one, the end goes back.
    const [note] = await notesAt(window, [{ x: 120, y: 560 }]);
    await window.getByTestId('rail-token').locator('.rail-token-open').click();
    await drag(window, centreOf(await settledBox(end)), centreOf(await settledBox(note!.node)));
    await expect.poll(async () => (await flowEdges(window))[0]!.to).toBe(third);

    // Undo hands off to the agent it left again.
    await window.keyboard.press('Escape');
    await window.keyboard.press('ControlOrMeta+z');
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await flowEdges(window))[0]).toMatchObject({ from: left, to: right });
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
