import { expect, type Page } from '@playwright/test';
import type { BoardItem, Connector } from '@agent-board/daemon/protocol';
import { centreOf, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

// Mermaid on the board: a pasted class diagram drawn as shapes and connectors, and a selection copied back as Mermaid.

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ items: BoardItem[]; connectors: Connector[] }> {
  return withDaemon(dataDir, async (client) => ({ items: await client.call('item.list'), connectors: await client.call('connector.list') }));
}

/** Pastes `text` onto the board, as the paste shortcut does with the clipboard's text. */
async function pasteText(window: Page, text: string): Promise<void> {
  await window.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

const DIAGRAM = ['```mermaid', 'classDiagram', '  class Order {', '    +UUID id', '    +total() Money', '  }', '  Order "1" *-- "1..*" Line : holds', '  Base <|-- Order', '  note for Order "kept"', '```'].join('\n');

test('pasting a Mermaid class diagram draws its classes and relations laid out, and Copy as Mermaid gives it back', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const shapes = window.getByTestId('shape');
    // What Copy as Mermaid writes, kept in the page: the system clipboard is the user's, and other specs' too.
    await window.evaluate(() => {
      const copied: string[] = [];
      (globalThis as { copied?: string[] }).copied = copied;
      Object.defineProperty(navigator.clipboard, 'writeText', { value: async (text: string) => void copied.push(text) });
    });

    await window.mouse.move(640, 400);
    await pasteText(window, DIAGRAM);
    await expect(shapes).toHaveCount(3);
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(2);
    // What it left out, it says.
    await expect(window.getByText('Drew the diagram without one line it can\'t draw: note for Order "kept"')).toBeVisible();
    await expect.poll(async () => (await stored(dataDir)).items.length).toBe(3);
    const { items, connectors } = await stored(dataDir);
    const byText = (text: string) => items.find((item) => item.data.text === text)!;
    const [order, line, base] = [byText('Order'), byText('Line'), byText('Base')];
    expect(order.data).toMatchObject({ shape: 'class', attributes: '+UUID id', methods: '+total() Money', fillSlot: 'tile', strokeSlot: 'accent' });
    // The parent above, the part below, as Mermaid lays them out.
    expect(base.y + base.height).toBeLessThan(order.y);
    expect(order.y + order.height).toBeLessThan(line.y);
    expect(connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: { type: 'item', id: order.id, side: 'bottom' }, to: { type: 'item', id: line.id, side: 'top' }, startEnd: 'filled-diamond', label: 'holds', startLabel: '1', endLabel: '1..*' }),
        expect.objectContaining({ from: { type: 'item', id: order.id, side: 'top' }, to: { type: 'item', id: base.id, side: 'bottom' }, endEnd: 'triangle', dashed: false }),
      ]),
    );
    // Pasted as one: selected, and gone in one undo.
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(3);

    // The selection's context menu copies it as Mermaid, which reads back as what was pasted.
    await window.mouse.click(...(Object.values(centreOf(await settledBox(shapes.first()))) as [number, number]), { button: 'right' });
    await window.getByRole('menuitem', { name: /^Copy as Mermaid/ }).click();
    await expect
      .poll(() => window.evaluate(() => (globalThis as { copied?: string[] }).copied?.at(-1)))
      .toBe(['classDiagram', '  class Order {', '    +UUID id', '    +total() Money', '  }', '  class Line', '  class Base', '  Order "1" *-- "1..*" Line : holds', '  Order --|> Base', ''].join('\n'));

    // Words that aren't a diagram draw nothing, nor a list under the word Graph.
    await pasteText(window, 'classDiagrams are nice');
    await pasteText(window, 'Graph\nmilk\neggs');
    await expect(shapes).toHaveCount(3);
    // The paste goes in one undo.
    await window.keyboard.press('ControlOrMeta+z');
    await expect(shapes).toHaveCount(0);
  } finally {
    await app.close();
    removeDataDir(dataDir);
  }
});
