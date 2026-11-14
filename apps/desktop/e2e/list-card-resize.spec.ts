import { expect, type Page } from '@playwright/test';
import { LIST_CARD_MIN_SIZE, STEPS_CARD_SIZE, type BoardItem, type MemoryData, type QueueData, type Step, type StepsData, type TodoData } from '@agent-board/daemon/protocol';
import { boardZoom, centreOf, drag, settledBox, viewTransform } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

// A memory, a queue, a steps card and a to-do list are resized from their handles, keep that size folded and after a restart, and
// scroll what doesn't fit inside them, stop at their least size; a steps card widened keeps its height, and opens every step in full.

const LONG = 'Check the release notes name every migration, the flags each one needs, and who signs them off before Friday';

/** Puts a memory, a queue, a steps card and a to-do list of the user's on the board, each with more rows than it shows. */
async function putCards(page: Page): Promise<{ memory: BoardItem; queue: BoardItem; steps: BoardItem; todo: BoardItem }> {
  return page.evaluate(async (long) => {
    const items = window.agentBoard.items;
    const memoryData: MemoryData = { title: 'Facts', madeBy: { kind: 'user' }, noAgents: false, count: 0 };
    const memory = await items.create({ kind: 'memory', zoneId: null, x: 0, y: 0, width: 340, height: 220, data: { ...memoryData } });
    for (let n = 1; n <= 12; n += 1) await items.changeMemory(memory.id, { action: 'add', text: n === 12 ? long : `Fact ${n}` });
    const queueData: QueueData = { title: 'Jobs', madeBy: { kind: 'user' }, audience: 'user', noAgents: false, count: 0 };
    const queue = await items.create({ kind: 'queue', zoneId: null, x: 460, y: 0, width: 340, height: 244, data: { ...queueData } });
    for (let n = 1; n <= 12; n += 1) await items.changeQueue(queue.id, { action: 'add', text: n === 1 ? long : `Job ${n}` });
    const steps: Step[] = Array.from({ length: 24 }, (_, n) => ({
      id: `s${n}`,
      kind: 'todo',
      text: n === 0 ? long : `Step ${n + 1}`,
      section: null,
      required: false,
      choices: [],
      who: { kind: 'user' },
      link: null,
      done: n < 2 ? { by: { kind: 'user' }, at: new Date().toISOString() } : null,
      answer: null,
    }));
    const stepsData: StepsData = { title: 'Release', madeBy: { kind: 'user' }, answeredBy: { kind: 'user' }, steps, sent: null, waits: [], closedAt: null };
    const card = await items.create({ kind: 'steps', zoneId: null, x: 920, y: 0, width: 280, height: 104, data: { ...stepsData } });
    const at = new Date().toISOString();
    const todoData: TodoData = { owner: { kind: 'user' }, lines: Array.from({ length: 12 }, (_, n) => ({ id: `t${n}`, text: `To do ${n + 1}`, by: { kind: 'user' }, at, done: null })) };
    const todo = await items.create({ kind: 'todo', zoneId: null, x: 1320, y: 0, width: 300, height: 196, data: { ...todoData } });
    return { memory, queue, steps: card, todo };
  }, LONG);
}

const node = (page: Page, item: BoardItem) => page.locator(`.react-flow__node[data-id="item:${item.id}"]`);

/** The item's saved size, as the daemon has it. */
const savedSize = (page: Page, id: string) =>
  page.evaluate((id) => window.agentBoard.items.list().then((all) => all.find((item) => item.id === id)).then((item) => item && { width: item.width, height: item.height }), id);

/**
 * Selects the card and drags its bottom-right corner by `by` on screen; resolves with its frame before, as drawn once
 * selected (a steps card left at its start grows round the rows it shows then).
 */
async function resizeBy(page: Page, item: BoardItem, by: { x: number; y: number }): Promise<{ width: number; height: number }> {
  await node(page, item).locator('[data-testid$="-card"]').first().click({ position: { x: 40, y: 12 } });
  await settledBox(node(page, item));
  const before = await node(page, item).evaluate((element: HTMLElement) => ({ width: element.offsetWidth, height: element.offsetHeight }));
  const handle = node(page, item).locator('.react-flow__resize-control.handle.bottom.right');
  await expect(handle, `the ${item.kind}'s corner handle, once it is selected`).toBeVisible();
  const corner = centreOf(await settledBox(handle));
  await drag(page, corner, { x: corner.x + by.x, y: corner.y + by.y });
  return before;
}

/** That the saved size grew by `by` on screen, at the board's zoom, give or take a pixel's rounding. */
async function expectGrown(page: Page, item: BoardItem, before: { width: number; height: number }, by: { x: number; y: number }): Promise<void> {
  const zoom = await boardZoom(page);
  const off = async () => {
    const now = (await savedSize(page, item.id))!;
    return Math.max(Math.abs(now.width - (before.width + by.x / zoom)), Math.abs(now.height - (before.height + by.y / zoom)));
  };
  await expect.poll(off, { message: `${item.kind} resized by its corner` }).toBeLessThan(3);
}

test('a memory, a queue, a steps card and a to-do list resize from a corner, keep their size folded and after a restart, scroll inside without panning the board, show a long line whole on hover, and steps open in full', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const { memory, queue, steps, todo } = await putCards(window);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await expect(node(window, steps).getByTestId('steps-card')).toBeVisible();

    // Widened from its edge, a steps card left at its start is wider, not taller: it keeps its saved height, though
    // its frame grew round its rows while it was selected.
    await test.step('widen the steps card', async () => {
      await node(window, steps).getByTestId('steps-card').click({ position: { x: 40, y: 12 } });
      const edge = node(window, steps).locator('.react-flow__resize-control.line.right');
      await expect(edge).toBeVisible();
      const from = centreOf(await settledBox(edge));
      await drag(window, from, { x: from.x + 60, y: from.y });
      const zoom = await boardZoom(window);
      await expect.poll(async () => (await savedSize(window, steps.id))!.width, { message: 'the steps card widened' }).toBeGreaterThan(steps.width + 60 / zoom - 3);
      expect((await savedSize(window, steps.id))!.height).toBe(STEPS_CARD_SIZE.height);
    });

    // Each resizes from its corner, and keeps the size it was given.
    const grow = { x: 60, y: 120 };
    for (const item of [memory, queue, steps, todo]) await test.step(`resize the ${item.kind}`, async () => expectGrown(window, item, await resizeBy(window, item, grow), grow));
    const sizes = {
      memory: (await savedSize(window, memory.id))!,
      queue: (await savedSize(window, queue.id))!,
      steps: (await savedSize(window, steps.id))!,
      todo: (await savedSize(window, todo.id))!,
    };

    // Folded to its icon and opened again, a queue is the size it was given.
    await node(window, queue).getByTestId('queue-card').click({ position: { x: 40, y: 12 } });
    await window.getByRole('button', { name: 'Fold to its icon' }).click();
    await expect.poll(() => savedSize(window, queue.id)).not.toEqual(sizes.queue);
    await window.getByRole('button', { name: 'Open the card' }).click();
    await expect.poll(() => savedSize(window, queue.id)).toEqual(sizes.queue);

    // Its rows past its foot fade out, and the wheel scrolls them, not the board.
    const rows = node(window, memory).locator('.listcard-rows');
    await expect(rows).toHaveAttribute('data-fade', 'bottom');
    const view = await viewTransform(window);
    const box = (await rows.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 400);
    await expect.poll(() => rows.evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
    await expect(rows).toHaveAttribute('data-fade', /top|both/);
    expect(await viewTransform(window)).toBe(view);

    // A line cut short shows whole while it is pointed at, laid over its row: the rows under it stay put.
    const long = node(window, queue).locator('.listcard-row', { hasText: 'release notes' }).locator('.listcard-value');
    // Put down first, by a click on the board just left of the memory.
    const left = (await node(window, memory).boundingBox())!;
    const aside = { x: left.x - 24, y: left.y + left.height / 2 };
    await window.mouse.click(aside.x, aside.y);
    await expect(node(window, queue)).not.toHaveClass(/selected/);
    await expect.poll(() => long.evaluate((line) => line.scrollWidth > line.clientWidth)).toBe(true);
    const under = node(window, queue).locator('.listcard-row').nth(1);
    const before = await under.boundingBox();
    await long.hover();
    const whole = node(window, queue).getByTestId('whole-line');
    await expect(whole).toHaveText(LONG);
    expect(await under.boundingBox()).toEqual(before);
    await window.mouse.move(aside.x, aside.y);
    await expect(whole).toHaveCount(0);

    // Clicked, the card shows no line over its rows; selected, it wraps its lines in place, so pointing at one lays none over it.
    await node(window, queue).getByTestId('queue-card').click({ position: { x: 40, y: 12 } });
    await expect(node(window, queue)).toHaveClass(/selected/);
    await expect(whole).toHaveCount(0);
    await long.hover();
    await expect.poll(() => long.evaluate((line) => line.scrollWidth > line.clientWidth + 1)).toBe(false);
    await expect(whole).toHaveCount(0);
    await window.mouse.click(aside.x, aside.y);
    await expect(node(window, queue)).not.toHaveClass(/selected/);

    // Made taller, the steps card shows every step without being selected, folding none, and they scroll inside it.
    const stepsRows = node(window, steps).locator('.steps-rows');
    await expect(stepsRows).toBeVisible();
    await expect(stepsRows.getByText(/earlier|more$/)).toHaveCount(0);
    await expect(stepsRows).toHaveAttribute('data-fade', /bottom|both/);

    // A double-click opens every step in full, with its state; esc closes it.
    await node(window, steps).getByTestId('steps-card').dblclick({ position: { x: 40, y: 12 } });
    const full = window.getByTestId('steps-full');
    await expect(full).toBeVisible();
    await expect(full.getByTestId('steps-full-step')).toHaveCount(24);
    await expect(full.getByTestId('steps-full-step').first()).toContainText(LONG);
    await expect(full.getByTestId('steps-full-step').first()).toHaveAttribute('data-state', 'done');
    await window.keyboard.press('Escape');
    await expect(full).toBeHidden();

    // After a restart each is the size it was given.
    await app.close();
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    for (const [item, size] of [
      [memory, sizes.memory],
      [queue, sizes.queue],
      [steps, sizes.steps],
      [todo, sizes.todo],
    ] as const) {
      await expect.poll(() => savedSize(window, item.id)).toEqual(size);
      await expect.poll(() => node(window, item).evaluate((element: HTMLElement) => [element.offsetWidth, element.offsetHeight])).toEqual([Math.round(size.width), Math.round(size.height)]);
    }

    // Pulled smaller than it can be, it stops at its least size.
    await test.step('shrink the memory past its least size', async () => {
      const box = (await node(window, memory).boundingBox())!;
      await resizeBy(window, memory, { x: -(box.width - 8), y: -(box.height - 8) });
      await expect.poll(() => savedSize(window, memory.id)).toEqual(LIST_CARD_MIN_SIZE);
    });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
