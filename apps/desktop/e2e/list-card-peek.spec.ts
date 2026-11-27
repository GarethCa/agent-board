import { expect, type Page } from '@playwright/test';
import { TODO_PILL_SIZE, type QueueData } from '@agent-board/daemon/protocol';
import { boardZoom, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

// A queue's peek, opened by its Open ↗, is a popover like the app's others: the same size on screen at any zoom, and Esc
// or a click on empty board (in its zone or out of it) closes it. A double-click on the card opens it full screen instead;
// a folded to-do list's peek opens on one click on its pill, and full screen on a double-click.

/** Pinches the board about `at`: in (`-1`) or out (`1`), as Chromium reports a pinch, the wheel with Ctrl. */
async function pinch(page: Page, at: { x: number; y: number }, way: -1 | 1): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  for (let step = 0; step < 3; step += 1) await page.mouse.wheel(0, 40 * way);
  await page.keyboard.up('Control');
}

test('a queue peek keeps its size as the board zooms, and Esc or a click on empty board closes it; a double-click opens full screen', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const page = await app.firstWindow();
    await connectedDaemonPid(page);
    const zone = await withDaemon(dataDir, (daemon) => daemon.call('zone.addUnbound', { name: 'Work', x: 80, y: 120, width: 1000, height: 560 }));
    await page.evaluate(async (zoneId) => {
      const data: QueueData = { title: 'Jobs', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
      const queue = await window.agentBoard.items.create({ kind: 'queue', zoneId, x: 40, y: 60, width: 340, height: 244, data: { ...data } });
      for (const text of ['Fix the login', 'Write the docs']) await window.agentBoard.items.changeQueue(queue.id, { action: 'add', text });
    }, zone.id);
    const card = page.getByTestId('queue-card');
    await expect(card.locator('.listcard-row')).toHaveCount(2);
    const peek = page.locator('.listcard-peek-popover');
    const open = async () => {
      await card.getByRole('button', { name: 'Open ↗' }).click();
      await expect(peek).toBeVisible();
    };

    await open();
    const before = await settledBox(peek);
    const zoom = await boardZoom(page);
    const cardBox = await settledBox(card);
    const pivot = { x: cardBox.x + 20, y: cardBox.y + cardBox.height + 40 };
    await pinch(page, pivot, -1);
    await expect.poll(() => boardZoom(page)).toBeGreaterThan(zoom * 1.1);
    await settledBox(card);
    await expect(peek).toBeVisible();
    const after = await settledBox(peek);
    expect.soft(after.width, 'its width at any zoom').toBeCloseTo(before.width, 0);
    expect.soft(after.height, 'its height at any zoom').toBeCloseTo(before.height, 0);

    await page.keyboard.press('Escape');
    await expect.soft(peek, 'Esc closes it').toBeHidden();
    await pinch(page, pivot, 1);
    await expect.poll(() => boardZoom(page)).toBeLessThan(zoom * 1.05);
    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // Empty board in its zone, below the card.
    await open();
    const shown = await settledBox(card);
    await page.mouse.click(shown.x + 20, shown.y + shown.height + 60);
    await expect.soft(peek, 'a click on its zone closes it').toBeHidden();
    await page.keyboard.press('Escape');

    // Empty board out of any zone.
    await open();
    const zoneBox = await settledBox(page.locator('.react-flow__node-zone'));
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const below = zoneBox.y + zoneBox.height + 40;
    const empty =
      below < pane.y + pane.height - 20
        ? { x: zoneBox.x + zoneBox.width / 2, y: below }
        : { x: zoneBox.x + zoneBox.width + 40, y: zoneBox.y + zoneBox.height / 2 };
    const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane') ?? false, empty);
    expect(under, 'the click lands on empty board, out of the zone').toBe(true);
    await page.mouse.click(empty.x, empty.y);
    await expect.soft(peek, 'a click on empty board closes it').toBeHidden();

    // A double-click on the card opens it full screen, not its peek; esc goes back.
    await card.locator('.listcard-title').dblclick();
    const full = page.getByTestId('queue-full');
    await expect(full).toBeVisible();
    await expect(peek).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(full).toBeHidden();

    // A folded to-do list: one click on its pill opens its peek, esc closes it, and a double-click opens it full screen.
    await page.evaluate(
      async ({ zoneId, pill }) => {
        const user = { kind: 'user' as const };
        const line = { id: 't1', text: 'Book the room', by: user, at: '2026-11-05T09:00:00.000Z', done: null };
        await window.agentBoard.items.create({ kind: 'todo', zoneId, x: 480, y: 60, ...pill, data: { owner: user, folded: true, lines: [line] } } as never);
      },
      { zoneId: zone.id, pill: TODO_PILL_SIZE },
    );
    const face = page.getByTestId('todo-pill').getByRole('button', { name: /open its peek/ });
    await face.click();
    const todoPeek = page.getByTestId('todo-peek');
    await expect(todoPeek).toBeVisible();
    await expect(todoPeek.getByTestId('todo-pop-line')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(todoPeek).toBeHidden();
    await face.dblclick();
    const todoFull = page.getByTestId('todo-full');
    await expect(todoFull).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(todoFull).toBeHidden();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
