import { expect, type Page } from '@playwright/test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { STICKY_SIZE, type BoardItem } from '@agent-board/daemon/protocol';
import { agents, launch, openSubmenu, spawnAgent, tile, zoneNamed, zones } from './agent-helpers.ts';
import { drag, tokenOf, untilStill, withDaemon } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// Arrange tidies every item in the zone where its kind's placement says: a pick in the zone's menu is kept as the
// zone's, and an item the user drags stays where they put it.

type Rect = { x: number; y: number; width: number; height: number };

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The zone's lead tile and its items, by name, relative to the zone. */
async function placesIn(window: Page, zoneId: string, ids: Record<string, string>): Promise<Record<string, Rect>> {
  const [lead] = await agents(window);
  const items: BoardItem[] = await window.evaluate(() => globalThis.window.agentBoard.items.list());
  const named = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
  return Object.fromEntries([
    ['lead', { ...lead!.position!, ...AGENT_TILE_SIZE }],
    ...items.filter((item) => item.zoneId === zoneId && named.has(item.id)).map((item) => [named.get(item.id)!, { x: item.x, y: item.y, width: item.width, height: item.height }]),
  ]);
}

test("arrange places a zone's to-do down the side as its menu says, the agent's note and file beside it, the rest under the top row, the sticky and a dragged queue where they are, the same again", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Print your board identity');
    await expect(tile(window)).toHaveCount(1);
    const [lead] = await agents(window);
    const [zone] = await zones(window);
    const token = await withDaemon(dataDir, (client) => tokenOf(client, lead!.sessionId));

    // A messy zone: the lead's note and a file it showed, a to-do, two queues and a clock piled on each other,
    // and a sticky the user put by the lead.
    const user = { kind: 'user' };
    const author = { sessionId: lead!.sessionId, name: lead!.name, harness: 'claude', role: null };
    const ids: Record<string, string> = await window.evaluate(
      async ({ zoneId, user, sticky, author }) => {
        const { items } = globalThis.window.agentBoard;
        const make = (kind: BoardItem['kind'], x: number, y: number, width: number, height: number, data: Record<string, unknown>) =>
          items.create({ kind, zoneId, x, y, width, height, data } as never) as Promise<BoardItem>;
        const todo = await make('todo', 60, 260, 300, 196, { owner: user, lines: [] });
        const queue = await make('queue', 120, 300, 340, 244, { title: 'Backlog', madeBy: user, audience: 'user', noAgents: false, count: 0 });
        const later = await make('queue', 180, 340, 340, 220, { title: 'Later', madeBy: user, audience: 'user', noAgents: false, count: 0 });
        const note = await make('sticky', 700, 60, sticky.width, sticky.height, { text: 'mine', color: '#fff3a3' });
        const agentNote = await make('agent-note', 240, 380, 180, 136, { text: 'Found the flaky test', agent: author, writtenAt: new Date().toISOString(), editedByUser: false });
        return { todo: todo.id, queue: queue.id, later: later.id, sticky: note.id, note: agentNote.id };
      },
      { zoneId: zone!.id, user, sticky: STICKY_SIZE, author },
    );
    const plan = join(lead!.worktree, 'plan.md');
    writeFileSync(plan, '# Plan\n');
    // A connection that shows a document with the agent's token is the agent's from then on, so the user's clock comes on its own.
    await withDaemon(dataDir, (client) => client.call('settings.set', { placeDocTiles: true }));
    await withDaemon(dataDir, (client) => client.call('board.showDoc', { token, path: plan, onBoard: true }));
    const clock = await withDaemon(dataDir, (client) =>
      client.call('clock.add', { place: { zoneId: zone!.id, x: 300, y: 420 }, data: { cron: '0 * * * *', does: 'message', agent: null, prompt: 'Check the build' } }),
    );
    ids.clock = clock.id;
    await expect.poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item: BoardItem) => item.kind === 'document')?.zoneId).toBe(zone!.id);
    ids.file = (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item: BoardItem) => item.kind === 'document')!.id;
    const before = await placesIn(window, zone!.id, ids);

    // The zone's menu: Arrange items › To-dos › Down the side, kept as the zone's. The zone grows round the new items
    // first: its menus hang from it, and one that moves between a click's aim and its press sends the click to the page,
    // which closes them. So the menu opens once the zone is still, and the rows two menus down are picked with keys.
    const monorepo = zoneNamed(window, 'monorepo');
    await untilStill(async () => JSON.stringify(await monorepo.boundingBox()));
    await monorepo.getByRole('button', { name: 'Zone options' }).click();
    await openSubmenu(window, 'Arrange items');
    await window.getByRole('menuitem', { name: /^To-dos/ }).press('ArrowRight');
    const todos = window.getByRole('menu', { name: /^To-dos/ });
    await expect(todos).toBeInViewport();
    await expect(todos.getByRole('menuitemradio', { name: /^Under the top row/ })).toHaveAttribute('aria-checked', 'true');
    await todos.getByRole('menuitemradio', { name: /^Down the side/ }).press('Enter');
    await expect.poll(async () => (await zones(window))[0]!.placements).toEqual({ todos: 'sidebar' });

    const arrange = async () => {
      await withDaemon(dataDir, (client) => client.call('orchestrator.arrange', { token }));
      await untilStill(async () => JSON.stringify(await placesIn(window, zone!.id, ids)));
      return placesIn(window, zone!.id, ids);
    };
    const once = await arrange();
    // The sticky stays; the lead's note and file in its lane after its tile; the queues and the clock on
    // rows under the lead; the to-do in a column right of all of them.
    expect(once.sticky).toEqual(before.sticky);
    for (const name of ['note', 'file']) {
      expect(once[name]!.y).toBe(once.lead!.y);
      expect(once[name]!.x).toBeGreaterThanOrEqual(once.lead!.x + once.lead!.width);
    }
    expect(once.queue!.y).toBe(once.later!.y);
    for (const name of ['queue', 'later', 'clock']) expect(once[name]!.y).toBeGreaterThan(once.lead!.y + AGENT_TILE_SIZE.height);
    for (const name of ['lead', 'note', 'file', 'queue', 'later', 'clock']) expect(once.todo!.x).toBeGreaterThanOrEqual(once[name]!.x + once[name]!.width);
    // Nothing on top of anything, and the zone holds all of it.
    const rects = Object.values(once);
    rects.forEach((a, index) => rects.slice(index + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
    const fitted = (await zones(window))[0]!;
    for (const rect of rects) expect(rect.x + rect.width).toBeLessThanOrEqual(fitted.width);
    const map = await withDaemon(dataDir, (client) => client.call('orchestrator.map', { zoneId: zone!.id }));
    expect(map.overlaps).toEqual([]);
    expect(map.placed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'todos', placement: 'sidebar' }),
        expect.objectContaining({ kind: 'queues', placement: 'top' }),
        expect.objectContaining({ kind: 'clocks', placement: 'top' }),
        expect.objectContaining({ kind: 'notes', placement: 'cluster' }),
        expect.objectContaining({ kind: 'files', placement: 'cluster' }),
      ]),
    );
    // Arranged again, nothing moves.
    expect(await arrange()).toEqual(once);

    // The user drags the queue down a little: it is marked placed by hand, and the next arrange leaves it. Its centre
    // stays in the zone (the zone fits what it holds, and a drop's centre picks its zone), so it is still the zone's.
    await window.getByRole('button', { name: /^Fit view/ }).click();
    const queueNode = window.locator(`.react-flow__node[data-id="item:${ids.queue}"]`);
    // Fit view eases the board to its new zoom: the drag starts once the queue is still, on the queue itself.
    await untilStill(async () => JSON.stringify(await queueNode.boundingBox()));
    const box = (await queueNode.boundingBox())!;
    const scale = box.width / once.queue!.width;
    const from = { x: box.x + 12, y: box.y + 10 };
    expect(await window.evaluate(({ x, y, id }) => document.elementFromPoint(x, y)?.closest('.react-flow__node')?.getAttribute('data-id') === id, { ...from, id: `item:${ids.queue}` })).toBe(true);
    await drag(window, from, { x: from.x, y: from.y + (once.queue!.height / 3) * scale });
    await expect
      .poll(async () => (await window.evaluate(() => globalThis.window.agentBoard.items.list())).find((item: BoardItem) => item.id === ids.queue)!.data.placedByHand)
      .toBe(true);
    const dragged = await placesIn(window, zone!.id, ids);
    expect(dragged.queue!.y).toBeGreaterThan(once.queue!.y);

    // Arrange may lay out anything again, but the shape holds: the queue stays where it was dropped, the lead and the
    // sticky don't move, the note and file keep the lead's lane, the to-do stays down the side, and nothing overlaps.
    // Without the queue the row under the top row is narrower, so the lane and the side column may come in.
    const again = await arrange();
    expect(again.queue).toEqual(dragged.queue);
    for (const name of ['lead', 'sticky']) expect(again[name]).toEqual(once[name]);
    for (const name of ['note', 'file']) {
      expect(again[name]!.y).toBe(again.lead!.y);
      expect(again[name]!.x).toBeGreaterThanOrEqual(again.lead!.x + again.lead!.width);
    }
    expect(again.todo!.y).toBe(once.todo!.y);
    for (const name of ['lead', 'note', 'file', 'later', 'clock']) expect(again.todo!.x).toBeGreaterThanOrEqual(again[name]!.x + again[name]!.width);
    const after = Object.values(again);
    after.forEach((a, index) => after.slice(index + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
    // Arranged once more, nothing moves.
    expect(await arrange()).toEqual(again);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
