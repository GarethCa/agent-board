import { expect, type Locator, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { BoardItem, Connector } from '@agent-board/daemon/protocol';
import { centreOf, drag, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ items: BoardItem[]; connectors: Connector[] }> {
  return withDaemon(dataDir, async (client) => ({ items: await client.call('item.list'), connectors: await client.call('connector.list') }));
}

/** The point halfway along a connector's line, on the screen: a place a click lands on it. */
async function midpoint(line: Locator): Promise<{ x: number; y: number }> {
  return line.evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM()!;
    return { x: at.x * matrix.a + at.y * matrix.c + matrix.e, y: at.x * matrix.b + at.y * matrix.d + matrix.f };
  });
}

/** Presses on a side handle of the note: it shows on hover. */
async function dragFromHandle(window: Page, note: Locator, side: string, to: { x: number; y: number }): Promise<void> {
  await note.hover();
  const handle = note.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " react-flow__node ")]').locator(`.connector-handle[data-side="${side}"]`);
  await expect(handle).toHaveCSS('opacity', '1');
  await drag(window, centreOf(await settledBox(handle)), to);
}

test('draws connectors between notes, labels and restyles them, follows a moved end, and drops one with its deleted end', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const notes = window.getByTestId('sticky');
    const lines = window.locator('.react-flow__edge-path.connector-line');

    // Two notes side by side.
    await window.mouse.move(pane.x + 200, pane.y + 250);
    await window.keyboard.press('n');
    await window.keyboard.press('Escape');
    await window.mouse.move(pane.x + 560, pane.y + 250);
    await window.keyboard.press('n');
    await window.keyboard.press('Escape');
    await expect(notes).toHaveCount(2);
    const [left, right] = [notes.nth(0), notes.nth(1)];

    // Their handles show on hover; dragging from one onto the other note joins them.
    await dragFromHandle(window, left, 'right', centreOf(await settledBox(right)));
    await expect(lines).toHaveCount(1);
    const items = (await stored(dataDir)).items;
    await expect
      .poll(async () => (await stored(dataDir)).connectors.map(({ from, to }) => [from.id, to.id]))
      .toEqual([[items[0]!.id, items[1]!.id]]);
    const made = (await stored(dataDir)).connectors[0]!;
    expect(made).toMatchObject({ from: { type: 'item', side: 'right' }, to: { type: 'item', side: 'left' }, style: 'curved', endEnd: 'arrow', label: '' });

    // Dropped on empty board, the drag makes a new note there, already joined.
    await dragFromHandle(window, right, 'bottom', { x: pane.x + 560, y: pane.y + 560 });
    await expect(notes).toHaveCount(3);
    await expect(lines).toHaveCount(2);
    await window.keyboard.type('new idea');
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await stored(dataDir)).connectors).toHaveLength(2);
    const third = (await stored(dataDir)).items.find((item) => item.data.text === 'new idea')!;
    expect((await stored(dataDir)).connectors[1]).toMatchObject({ from: { id: items[1]!.id, side: 'bottom' }, to: { id: third.id, side: 'top' } });

    // Double-clicking a connector edits its label.
    const first = lines.nth(0);
    const at = await midpoint(first);
    await window.mouse.dblclick(at.x, at.y);
    const input = window.getByRole('textbox', { name: 'Connector label' });
    await expect(input).toBeFocused();
    await window.keyboard.type('depends on');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('connector-label')).toHaveText('depends on');
    await expect.poll(async () => (await stored(dataDir)).connectors[0]?.label).toBe('depends on');

    // Selected, it can be restyled.
    await window.getByTestId('connector-label').click();
    await window.getByRole('button', { name: 'Elbow' }).click();
    await window.getByRole('button', { name: 'End: dot' }).click();
    await window.getByRole('button', { name: 'Blue' }).click();
    await expect.poll(async () => (await stored(dataDir)).connectors[0]).toMatchObject({ style: 'elbow', endEnd: 'dot', color: '#3b5bdb' });

    // It follows an end that moves.
    const pathBefore = await first.getAttribute('d');
    const box = await settledBox(right);
    await drag(window, { x: box.x + box.width / 2, y: box.y + 20 }, { x: box.x + box.width / 2 + 60, y: box.y + 120 });
    await expect.poll(() => first.getAttribute('d')).not.toBe(pathBefore);

    // Deleting a note deletes the connectors on it; the other stays.
    await settledBox(left);
    await left.click();
    await window.keyboard.press('Backspace');
    await expect(notes).toHaveCount(2);
    await expect(lines).toHaveCount(1);
    await expect.poll(async () => (await stored(dataDir)).connectors.map((c) => c.to.id)).toEqual([third.id]);

    // A connector selected on its own goes with Backspace, and its notes stay.
    const remaining = await midpoint(lines.first());
    await window.mouse.click(remaining.x, remaining.y);
    await window.keyboard.press('Backspace');
    await expect(lines).toHaveCount(0);
    await expect(notes).toHaveCount(2);
    await expect.poll(async () => (await stored(dataDir)).connectors).toEqual([]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('shows a connector made by another client, and one removed with its object', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    const note = (x: number) =>
      client.call('item.create', { kind: 'sticky', zoneId: null, x, y: 100, width: 160, height: 120, data: { text: '', color: '#fff3a3' } });
    const [a, b] = [await note(0), await note(400)];
    await expect(window.getByTestId('sticky')).toHaveCount(2);

    await client.call('connector.create', { from: { type: 'item', id: a.id, side: 'right' }, to: { type: 'item', id: b.id, side: 'left' }, label: 'from afar' });
    await expect(window.getByTestId('connector-label')).toHaveText('from afar');

    // Gone with its end, though the daemon announces only the note's going.
    await client.call('item.delete', { id: b.id });
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(0);
    expect(await client.call('connector.list')).toEqual([]);
    client.close();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('draws a connector to a note React Flow measured just as it took the board nodes again from an older copy', async () => {
  // React Flow takes the board's nodes in an effect after each render. A note its resize observer measures before that
  // effect runs is taken again from the older copy, with no `measured` yet, which drops the handles it just measured;
  // React Flow never measures it again, so nothing could be drawn to it. The race is played out here: the
  // first time the observer measures a note, React Flow is handed copies of the nodes from before, at once.
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await window.addInitScript(() => {
      const Observer = globalThis.ResizeObserver;
      let armed = true;
      /** React Flow's store, from the context provider above its viewport. */
      const flowStore = () => {
        const viewport = document.querySelector('.react-flow__viewport');
        const key = viewport && Object.keys(viewport).find((name) => name.startsWith('__reactFiber$'));
        type Store = { getState(): { nodes: object[]; nodeLookup: unknown; setNodes(nodes: object[]): void } };
        let fiber = key ? (viewport as unknown as Record<string, { return: unknown; memoizedProps?: { value?: Store } } | undefined>)[key] : undefined;
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          if (value && typeof value.getState === 'function' && value.getState().nodeLookup) return value;
          fiber = fiber.return as typeof fiber;
        }
        return undefined;
      };
      globalThis.ResizeObserver = class extends Observer {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            const note = entries.some((entry) => entry.target.getAttribute('data-id')?.startsWith('item:'));
            const store = armed && note ? flowStore() : undefined;
            const before = store?.getState().nodes.map((node) => ({ ...node }));
            callback(entries, observer);
            if (store === undefined || before === undefined) return;
            armed = false;
            store.getState().setNodes(before);
          });
        }
      };
    });
    await window.reload();
    await connectedDaemonPid(window);

    const client = await connectDaemon(daemonPaths(dataDir).socket);
    const note = (x: number) =>
      client.call('item.create', { kind: 'sticky', zoneId: null, x, y: 100, width: 160, height: 120, data: { text: '', color: '#fff3a3' } });
    const a = await note(0);
    await expect(window.getByTestId('sticky')).toHaveCount(1);
    const b = await note(400);
    await expect(window.getByTestId('sticky')).toHaveCount(2);
    await client.call('connector.create', { from: { type: 'item', id: a.id, side: 'right' }, to: { type: 'item', id: b.id, side: 'left' } });
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(1);
    client.close();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
