import { expect, type Locator, type Page } from '@playwright/test';
import type { BoardItem, Connector } from '@agent-board/daemon/protocol';
import { centreOf, drag, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';

// The diagram shapes: the picker under Shape (CL1), the / palette (CL3), and a picked shape on the board.

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ items: BoardItem[]; connectors: Connector[] }> {
  return withDaemon(dataDir, async (client) => ({ items: await client.call('item.list'), connectors: await client.call('connector.list') }));
}

/** Drags from one of `item`'s side handles, which show on hover, to `to`. */
async function dragFromHandle(window: Page, item: Locator, side: string, to: { x: number; y: number }): Promise<void> {
  await item.hover();
  const handle = item.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " react-flow__node ")]').locator(`.connector-handle[data-side="${side}"]`);
  await expect(handle).toHaveCSS('opacity', '1');
  await drag(window, centreOf(await settledBox(handle)), to);
}

test('picks a shape from the picker by search and draws it, joins an arrow to each of its four sides, and keeps them across a restart', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const shapes = window.getByTestId('shape');
    const picker = window.getByRole('dialog', { name: 'Shapes' });

    // S opens the picker under Shape with its search focused; Esc closes it and puts the tool down.
    await window.mouse.click(pane.x + pane.width - 20, pane.y + pane.height / 2);
    await window.keyboard.press('s');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('searchbox', { name: 'Search shapes' })).toBeFocused();
    await expect(picker.getByRole('region', { name: 'Architecture' }).getByRole('button')).toHaveCount(15);
    await window.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(window.getByTestId('board-tool')).toHaveCount(0);

    // Another word for it finds it: "db" is Database, and Enter arms it.
    await window.getByRole('button', { name: 'Shape', exact: true }).click();
    await window.keyboard.type('db');
    await expect(picker.getByRole('region', { name: 'Matches' }).getByRole('button').first()).toHaveAccessibleName('Database');
    await window.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(window.getByTestId('board-tool')).toHaveAttribute('data-tool', 'shape');

    // Dragged out on the board, at the size dragged.
    const start = { x: pane.x + 420, y: pane.y + 260 };
    await drag(window, start, { x: start.x + 160, y: start.y + 150 });
    await expect(shapes).toHaveCount(1);
    await expect(shapes).toHaveAttribute('data-shape', 'database');
    const box = await settledBox(shapes);
    expect(Math.abs(box.width - 160)).toBeLessThan(2);
    await expect.poll(async () => (await stored(dataDir)).items.map((item) => item.data.shape)).toEqual(['database']);

    // The picker remembers it: Recent, and pressed as the shape the tool draws.
    await window.keyboard.press('Escape');
    await window.keyboard.press('s');
    await expect(picker.getByRole('region', { name: 'Recent' }).getByRole('button', { name: 'Database' })).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    // A note on each side, and an arrow from each of the shape's four sides to it.
    const middle = centreOf(box);
    const around = {
      top: { x: middle.x, y: box.y - 150 },
      right: { x: box.x + box.width + 200, y: middle.y },
      bottom: { x: middle.x, y: box.y + box.height + 150 },
      left: { x: box.x - 200, y: middle.y },
    };
    for (const at of Object.values(around)) {
      await window.mouse.move(at.x, at.y);
      await window.keyboard.press('n');
      await window.keyboard.press('Escape');
    }
    await expect(window.getByTestId('sticky')).toHaveCount(4);
    for (const [side, at] of Object.entries(around)) await dragFromHandle(window, shapes, side, at);
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(4);
    const shapeId = (await stored(dataDir)).items.find((item) => item.kind === 'shape')!.id;
    await expect
      .poll(async () => (await stored(dataDir)).connectors.map(({ from }) => (from.id === shapeId ? from.side : 'not the shape')).sort())
      .toEqual(['bottom', 'left', 'right', 'top']);

    // A full restart: the shape and its arrows come back from the database.
    const firstDaemon = await connectedDaemonPid(window);
    await app.close();
    expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    await expect(window.getByTestId('shape')).toHaveAttribute('data-shape', 'database');
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(4);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('/ opens the palette at the pointer, where another word finds a shape and Enter puts it; a / typed in text stays text', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const shapes = window.getByTestId('shape');
    const palette = window.getByRole('dialog', { name: 'Insert a shape' });
    const options = palette.getByRole('option');

    // Esc closes it, putting nothing down.
    const at = { x: pane.x + 500, y: pane.y + 300 };
    await window.mouse.move(at.x, at.y);
    await window.keyboard.press('/');
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('combobox', { name: 'Shape to insert' })).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    // "person" is a User or an Actor; ↓ picks the Actor, and Enter puts it centred where the pointer was.
    await window.keyboard.press('/');
    await window.keyboard.type('person');
    await expect(options.nth(0)).toContainText('User');
    await expect(options.nth(0)).toContainText('“person” · Architecture');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(shapes).toHaveAttribute('data-shape', 'actor');
    const placed = centreOf(await settledBox(shapes));
    expect(Math.abs(placed.x - at.x)).toBeLessThan(3);
    expect(Math.abs(placed.y - at.y)).toBeLessThan(3);

    // Empty, it lists the shapes used: the Actor.
    await window.mouse.move(pane.x + 200, pane.y + 200);
    await window.keyboard.press('/');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('Actor');
    await window.keyboard.press('Escape');

    // Typed in a shape's text, / is only a character.
    await shapes.dblclick();
    await window.keyboard.type('a/b');
    await window.keyboard.press('Escape');
    await expect(shapes).toContainText('a/b');
    await expect(palette).toHaveCount(0);

    // The bar changes the kind of shape, keeping its text.
    await shapes.click();
    await window.getByRole('button', { name: 'Change shape: Actor' }).click();
    await window.getByRole('dialog', { name: 'Shapes' }).getByRole('button', { name: 'Cloud' }).click();
    await expect(shapes).toHaveAttribute('data-shape', 'cloud');
    await expect.poll(async () => (await stored(dataDir)).items[0]?.data).toMatchObject({ shape: 'cloud', text: 'a/b' });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
