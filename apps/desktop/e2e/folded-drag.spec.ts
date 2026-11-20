import { expect, type Page } from '@playwright/test';
import { LIST_CARD_FOLDED_SIZE, STEPS_ICON_SIZE, TODO_PILL_SIZE, type BoardItem, type MemoryData, type QueueData, type Step, type StepsData, type TodoData } from '@agent-board/daemon/protocol';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

// A memory, a queue, a steps card and a to-do list folded to their icons drag by their faces as they do open, land
// where they are let go (saved, so a restart keeps them there), and a click on a face still opens what it opens.

/** Puts a folded memory, queue, steps card and to-do list of the user's on the board, side by side. */
async function putFolded(page: Page): Promise<BoardItem[]> {
  return page.evaluate(
    async ({ listSize, stepsSize, pillSize }) => {
      const items = window.agentBoard.items;
      const memoryData: MemoryData = { title: 'Facts', madeBy: { kind: 'user' }, noAgents: false, count: 0, folded: true };
      const memory = await items.create({ kind: 'memory', zoneId: null, x: 0, y: 0, ...listSize, data: { ...memoryData } });
      await items.changeMemory(memory.id, { action: 'add', text: 'A fact' });
      const queueData: QueueData = { title: 'Jobs', madeBy: { kind: 'user' }, audience: 'user', noAgents: false, count: 0, folded: true };
      const queue = await items.create({ kind: 'queue', zoneId: null, x: 300, y: 0, ...listSize, data: { ...queueData } });
      await items.changeQueue(queue.id, { action: 'add', text: 'A job' });
      const step: Step = { id: 's1', kind: 'todo', text: 'A step', section: null, required: false, choices: [], who: { kind: 'user' }, link: null, done: null, answer: null };
      const stepsData: StepsData = { title: 'Release', madeBy: { kind: 'user' }, answeredBy: { kind: 'user' }, steps: [step], sent: null, waits: [], closedAt: null, collapsed: true };
      const steps = await items.create({ kind: 'steps', zoneId: null, x: 600, y: 0, ...stepsSize, data: { ...stepsData } });
      const todoData: TodoData = { owner: { kind: 'user' }, lines: [{ id: 't1', text: 'A line', by: { kind: 'user' }, at: new Date().toISOString(), done: null }], folded: true };
      const todo = await items.create({ kind: 'todo', zoneId: null, x: 900, y: 0, ...pillSize, data: { ...todoData } });
      return [memory, queue, steps, todo];
    },
    { listSize: LIST_CARD_FOLDED_SIZE, stepsSize: STEPS_ICON_SIZE, pillSize: TODO_PILL_SIZE },
  );
}

const node = (page: Page, item: BoardItem) => page.locator(`.react-flow__node[data-id="item:${item.id}"]`);

/** The item's saved place, as the daemon has it. */
const savedAt = (page: Page, id: string) =>
  page.evaluate((id) => window.agentBoard.items.list().then((all) => all.find((item) => item.id === id)).then((item) => item && { x: item.x, y: item.y }), id);

test('a folded memory, queue, steps card and to-do list drag by their faces, land where let go after a restart, and their faces still open on a click', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const folded = await putFolded(window);
    await window.getByRole('button', { name: /^Fit view/ }).click();

    const moved = new Map<string, { x: number; y: number }>();
    for (const item of folded) {
      const before = (await savedAt(window, item.id))!;
      // Pressed at the middle of what is drawn: the face, for a memory and a queue.
      const from = centreOf(await settledBox(node(window, item)));
      await drag(window, from, { x: from.x, y: from.y + 160 });
      await expect.poll(async () => (await savedAt(window, item.id))!.y, { message: `the folded ${item.kind} dragged by its face` }).toBeGreaterThan(before.y + 20);
      moved.set(item.id, (await savedAt(window, item.id))!);
      // The click that ends a drag opens nothing: checked before the next press, which would close a peek left open.
      await expect(window.locator('.listcard-peek-popover'), `no peek opened by dragging the ${item.kind}`).toHaveCount(0);
    }

    // A click on a memory's face still opens its peek, and doesn't move it.
    await window.getByRole('button', { name: 'Facts: open its peek' }).click();
    await expect(window.getByTestId('memory-peek')).toBeVisible();
    await window.keyboard.press('Escape');

    await app.close();
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    for (const item of folded) await expect.poll(() => savedAt(window, item.id), { message: `the ${item.kind} kept where it was dropped` }).toEqual(moved.get(item.id));
    for (const item of folded) await expect(node(window, item)).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
