import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, closeAgent, launch, sessionWindow, SHELL_ENV, spawnAgent, tile, TURN_MS, zoneNamed } from './agent-helpers.ts';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// A zone's stage board: added from the zone's menu, it holds the work the zone's agents started, by stage. The agents
// the user started stay where they were put.

const agentTile = (window: Page, name: string) => tile(window).filter({ has: window.getByTitle(name, { exact: true }) });
const board = (window: Page) => window.getByTestId('stage-board');
const savedBlock = (window: Page) =>
  window.evaluate(async () => (await globalThis.window.agentBoard.items.list()).find((item) => item.kind === 'stages'));

/** Whether `inner`'s box lies inside `outer`'s, on the screen. */
async function inside(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = [(await inner.boundingBox())!, (await outer.boundingBox())!];
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

/** Drags `what` by its body until its centre is at `to`, on the screen. */
async function dragCentreTo(window: Page, what: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await settledBox(what);
  const grip = { x: box.x + 40, y: box.y + box.height - 12 };
  const centre = centreOf(box);
  await drag(window, grip, { x: grip.x + to.x - centre.x, y: grip.y + to.y - centre.y }, { steps: 16 });
}

async function closeWindow(window: Page): Promise<void> {
  if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
}

test("a zone's stage board: added from its menu, it draws its workers on Doing, leaves the user's own agents out, and a closed worker as a Done card", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    await closeWindow(window);
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    await spawnAgent(window, 'monorepo', 'Tidy the docs');
    await closeWindow(window);
    await expect(tile(window)).toHaveCount(4);
    const workers = [agentTile(window, 'worker one'), agentTile(window, 'worker two')];
    for (const worker of workers) await expect(worker).toHaveAttribute('data-state', /idle|waiting|done/, { timeout: TURN_MS });

    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
    await window.getByRole('menuitem', { name: 'Add stage board' }).click();
    await expect(board(window)).toHaveCount(1);
    // One to a zone: its menu says it has one.
    await zoneNamed(window, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
    await expect(window.getByRole('menuitem', { name: 'Add stage board' })).toBeDisabled();
    await window.keyboard.press('Escape');
    await window.getByRole('button', { name: 'Fit View' }).click();
    await expect(board(window).getByTestId('stage-heading')).toHaveText([/^To do\s*0/, /^Doing\s*2/, /^Waiting for review\s*0/, /^Done\s*0/]);
    // Each worker's ticket is a band on Doing, its tile drawn on the block; the lead and the user's own agent stay out.
    await expect(board(window).getByTestId('stage-band')).toHaveCount(2);
    for (const worker of workers) await expect.poll(() => inside(worker, board(window))).toBe(true);
    for (const outside of [window.locator('[data-testid="agent-tile"][data-orchestrator]'), agentTile(window, 'Tidy the docs')]) {
      await expect(outside).toBeVisible();
      expect(await inside(outside, board(window))).toBe(false);
    }
    // The block's size is saved, for the zone's layout to keep out of its way.
    const box = (await board(window).boundingBox())!;
    await expect
      .poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item) => item.kind === 'stages')?.width ?? 0)
      .toBeGreaterThan(1000);
    await window.screenshot({ path: test.info().outputPath('stage-board.png') });

    // Dragged by its header, the block moves with its tiles on it.
    const head = board(window).getByTestId('stage-board-head');
    const [blockBefore, tileBefore] = [await settledBox(board(window)), await settledBox(workers[1]!)];
    const grip = centreOf((await head.boundingBox())!);
    await drag(window, grip, { x: grip.x + 80, y: grip.y + 40 });
    const [blockAfter, tileAfter] = [await settledBox(board(window)), await settledBox(workers[1]!)];
    expect(blockAfter.x - blockBefore.x).toBeGreaterThan(20);
    expect(tileAfter.x - tileBefore.x).toBeCloseTo(blockAfter.x - blockBefore.x, 0);
    expect(tileAfter.y - tileBefore.y).toBeCloseTo(blockAfter.y - blockBefore.y, 0);
    // Dragged past its zone's edge, it stays in its zone, as the daemon keeps it.
    const zoneId = (await savedBlock(window))!.zoneId;
    const moved = centreOf((await head.boundingBox())!);
    await drag(window, moved, { x: 5, y: moved.y });
    await expect.poll(async () => (await savedBlock(window))?.x).toBeLessThan(100);
    expect((await savedBlock(window))!.zoneId).toBe(zoneId);
    await expect(board(window)).toBeVisible();
    await expect.poll(() => inside(board(window), zoneNamed(window, 'monorepo'))).toBe(true);
    await expect.poll(() => inside(workers[1]!, board(window))).toBe(true);

    // The user's own agent, dropped on the block, joins it: a band on Doing. A worker dragged off it leaves, to where
    // it was dropped.
    const mine = agentTile(window, 'Tidy the docs');
    const placed = await settledBox(board(window));
    const mineId = (await agents(window)).find((agent) => agent.name === 'Tidy the docs')!.sessionId;
    const savedPlace = async (sessionId: string) => (await agents(window)).find((agent) => agent.sessionId === sessionId)?.position ?? null;
    const mineBefore = await savedPlace(mineId);
    await dragCentreTo(window, mine, { x: placed.x + placed.width * 0.6, y: placed.y + placed.height / 2 });
    await expect.poll(async () => ((await savedBlock(window))?.data as { joined?: string[] } | undefined)?.joined).toEqual([mineId]);
    // It keeps the place it had, for when it leaves the block: the drop point is never saved.
    expect(await savedPlace(mineId)).toEqual(mineBefore);
    await expect(board(window).getByTestId('stage-band')).toHaveCount(3);
    // Its band is the foot of Doing, under the fold: the board draws only what is in view.
    await window.getByRole('button', { name: 'Fit View' }).click();
    await expect.poll(() => inside(mine, board(window))).toBe(true);
    // Off the block, into the room between the lead and the block.
    const [lead, grown] = [await settledBox(window.locator('[data-testid="agent-tile"][data-orchestrator]')), await settledBox(board(window))];
    const dropAt = { x: grown.x + grown.width / 2, y: (lead.y + lead.height + grown.y) / 2 };
    await dragCentreTo(window, workers[1]!, dropAt);
    await expect(board(window).getByTestId('stage-band')).toHaveCount(2);
    expect(await inside(workers[1]!, board(window))).toBe(false);
    // It lands where it was dropped, snapped to the grid.
    const landed = centreOf(await settledBox(workers[1]!));
    expect(Math.abs(landed.x - dropAt.x)).toBeLessThan(48);
    expect(Math.abs(landed.y - dropAt.y)).toBeLessThan(48);
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item) => item.kind === 'stages')?.data).toMatchObject({
      joined: [mineId],
      left: [(await agents(window)).find((agent) => agent.name === 'worker two')!.sessionId],
    });

    // Closed, a worker's ticket goes to Done by itself, folded behind its line, its tile hidden; shown, it is a quiet card.
    const one = (await agents(window)).find((agent) => agent.name === 'worker one')!;
    await closeAgent(window, one.sessionId);
    const card = board(window).getByTestId('stage-card');
    const doneLine = board(window).getByTestId('stage-done');
    await expect(doneLine).toHaveText(/^1 done\s*Show$/);
    await expect(card).toHaveCount(0);
    await expect(workers[0]!).toBeHidden();
    await expect(board(window).getByTestId('stage-band')).toHaveCount(1);
    await expect(board(window).getByTestId('stage-heading').last()).toHaveText(/^Done\s*1/);
    expect((await board(window).boundingBox())!.width).toBeLessThanOrEqual(box.width + 1);
    await window.screenshot({ path: test.info().outputPath('stage-board-done.png') });
    await doneLine.click();
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-stage', 'done');
    await expect(doneLine).toHaveText(/^1 done\s*Hide$/);
    await expect.poll(async () => ((await savedBlock(window))?.data as { showDone?: boolean } | undefined)?.showDone).toBe(true);
    await expect(workers[0]!).toBeHidden();
    await window.screenshot({ path: test.info().outputPath('stage-board-done-shown.png') });

    // A job on the zone's queue put off for later is drawn at the foot of To do, counted apart on its heading; shown
    // again, it goes.
    const queueZone = (await savedBlock(window))!.zoneId;
    const putOff = await window.evaluate(async (zoneId) => {
      const items = globalThis.window.agentBoard.items;
      const data = { title: 'For me', madeBy: { kind: 'user' }, audience: 'user', noAgents: false, count: 0 };
      const queue = await items.create({ kind: 'queue', zoneId, x: 20, y: 20, width: 340, height: 244, data });
      await items.changeQueue(queue.id, { action: 'add', text: 'Write the release notes\n\nFor the next one.' });
      const { jobs } = await items.readQueue(queue.id);
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await items.changeQueue(queue.id, { action: 'later', job: jobs[0]!.id, until });
      return { queue: queue.id, job: jobs[0]!.id };
    }, queueZone);
    const later = board(window).getByTestId('stage-later');
    await expect(later).toHaveText(/^Later\s*Write the release notes$/);
    await expect(board(window).getByTestId('stage-heading').first()).toHaveText(/^To do\s*0\s*\+ 1 later$/);
    await window.screenshot({ path: test.info().outputPath('stage-board-later.png') });
    await window.evaluate(({ queue, job }) => globalThis.window.agentBoard.items.changeQueue(queue, { action: 'later', job, until: null }), putOff);
    await expect(later).toHaveCount(0);
    await expect(board(window).getByTestId('stage-heading').first()).toHaveText(/^To do\s*0$/);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
