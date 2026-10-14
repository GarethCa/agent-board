import { expect } from '@playwright/test';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { drag, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';

/** The board's items as the daemon has stored them. */
function stored(dataDir: string): Promise<BoardItem[]> {
  return withDaemon(dataDir, (client) => client.call('item.list'));
}

test('makes a heading and a shape with text, restyles both, and keeps them across a restart', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const texts = window.getByTestId('text-item');
    const shapes = window.getByTestId('shape');

    // T, then a click: text opens there, as wide as what is typed.
    await window.mouse.move(pane.x + 300, pane.y + 200);
    await window.keyboard.press('t');
    await expect(window.getByTestId('board-tool')).toHaveAttribute('data-tool', 'text');
    await window.mouse.click(pane.x + 120, pane.y + 140);
    await expect(texts).toHaveCount(1);
    const editor = texts.getByRole('textbox', { name: 'Text' });
    await expect(editor).toBeFocused();
    await window.keyboard.type('Sprint 12');
    const shortBox = await settledBox(texts);
    await window.keyboard.type(' movable sessions');
    await expect.poll(async () => (await settledBox(texts)).width).toBeGreaterThan(shortBox.width + 40);
    await window.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(texts).toContainText('Sprint 12 movable sessions');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.text).toBe('Sprint 12 movable sessions');
    // Fitted to the view, so the bar above it is on screen however the board was zoomed.
    await window.getByRole('button', { name: 'Fit View' }).click();
    const bodyHeight = (await settledBox(texts)).height;

    // Restyled from the bar: a heading is taller, and bold, italic, centred and coloured are kept.
    await window.getByRole('button', { name: 'Heading 1' }).click();
    await window.getByRole('button', { name: 'Italic' }).click();
    await window.getByRole('button', { name: 'Align center' }).click();
    await window.getByRole('button', { name: 'Text blue' }).click();
    await expect(texts).toHaveAttribute('data-size', 'h1');
    await expect.poll(async () => (await settledBox(texts)).height).toBeGreaterThan(bodyHeight);
    await expect
      .poll(async () => (await stored(dataDir))[0]?.data)
      .toMatchObject({ size: 'h1', bold: true, italic: true, align: 'center', color: '#3b5bdb' });

    // Resized from a side (the left, which is on screen), it keeps that width and wraps.
    await texts.click();
    const handle = await settledBox(window.locator('.react-flow__resize-control.left'));
    const grip = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const widthBefore = (await settledBox(texts)).width;
    await drag(window, grip, { x: grip.x + 250, y: grip.y });
    await expect.poll(async () => (await stored(dataDir))[0]?.data.wrap).toBe(true);
    await expect.poll(async () => (await stored(dataDir))[0]?.width).toBeLessThan(widthBefore);
    await expect.poll(async () => (await stored(dataDir))[0]?.height).toBeGreaterThan(71);

    // S, then a drag: a shape of that size.
    await window.keyboard.press('Escape');
    // Bare board, clear of the islands in the corners.
    await window.mouse.click(pane.x + pane.width - 20, pane.y + pane.height / 2);
    await window.keyboard.press('s');
    await expect(window.getByTestId('board-tool')).toHaveAttribute('data-tool', 'shape');
    // Below the heading, which may have been zoomed to fit.
    const start = { x: pane.x + 160, y: pane.y + 500 };
    await drag(window, start, { x: start.x + 220, y: start.y + 130 });
    await expect(shapes).toHaveCount(1);
    await expect(window.getByTestId('board-tool')).toHaveCount(0);
    const dragged = await settledBox(shapes);
    expect(Math.abs(dragged.x - start.x)).toBeLessThan(2);
    expect(Math.abs(dragged.width - 220)).toBeLessThan(2);
    expect(Math.abs(dragged.height - 130)).toBeLessThan(2);

    // A tiny drag still makes a shape that can be worked with.
    await window.keyboard.press('Escape');
    await window.keyboard.press('s');
    await drag(window, { x: pane.x + 700, y: pane.y + 560 }, { x: pane.x + 710, y: pane.y + 566 });
    await expect(shapes).toHaveCount(2);
    await expect
      .poll(async () => (await stored(dataDir)).filter((item) => item.kind === 'shape').map((item) => item.width >= 40))
      .toEqual([true, true]);
    await window.keyboard.press('Backspace');
    await expect(shapes).toHaveCount(1);

    // Double-click to type its centred text.
    await shapes.dblclick();
    await expect(shapes.getByRole('textbox', { name: 'Shape text' })).toBeFocused();
    await window.keyboard.type('CI green?');
    await window.keyboard.press('Escape');
    await expect(shapes).toContainText('CI green?');

    // Restyled from the bar.
    await shapes.click();
    await window.getByRole('button', { name: 'Fill green' }).click();
    await window.getByRole('button', { name: 'Stroke violet' }).click();
    await window.getByRole('button', { name: 'Thick stroke' }).click();
    await window.getByRole('button', { name: 'Ellipse', exact: true }).click();
    await expect(shapes).toHaveAttribute('data-shape', 'ellipse');
    await expect
      .poll(async () => (await stored(dataDir)).find((item) => item.kind === 'shape')?.data)
      .toMatchObject({
        shape: 'ellipse',
        fill: '#d3f9d8',
        stroke: '#6741d9',
        strokeWidth: 4,
        text: 'CI green?',
      });
    await window.getByRole('button', { name: 'No fill' }).click();
    await expect(shapes).toHaveAttribute('data-fill', 'none');
    await expect.poll(async () => (await stored(dataDir)).find((item) => item.kind === 'shape')?.data.fill).toBeNull();

    // A full restart: the app and its daemon both go, so both come back from the database.
    const firstDaemon = await connectedDaemonPid(window);
    await app.close();
    expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    expect(await connectedDaemonPid(window)).not.toBe(firstDaemon);

    const restoredText = window.getByTestId('text-item');
    await expect(restoredText).toHaveCount(1);
    await expect(restoredText).toHaveAttribute('data-size', 'h1');
    await expect(restoredText).toHaveAttribute('data-italic', 'true');
    await expect(restoredText).toContainText('Sprint 12 movable sessions');
    const restoredShape = window.getByTestId('shape');
    await expect(restoredShape).toHaveCount(1);
    await expect(restoredShape).toHaveAttribute('data-shape', 'ellipse');
    await expect(restoredShape).toHaveAttribute('data-fill', 'none');
    await expect(restoredShape).toContainText('CI green?');

    // Deleted with Backspace, and gone from the daemon.
    await restoredShape.click();
    await window.keyboard.press('Backspace');
    await expect(restoredShape).toHaveCount(0);
    await expect.poll(async () => (await stored(dataDir)).map((item) => item.kind)).toEqual(['text']);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a text left empty is not kept, and Escape puts down an armed tool', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;

    await window.getByRole('button', { name: 'Text', exact: true }).click();
    await expect(window.getByTestId('board-tool')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('board-tool')).toHaveCount(0);

    await window.getByRole('button', { name: 'Text', exact: true }).click();
    await window.mouse.click(pane.x + 200, pane.y + 200);
    await expect(window.getByTestId('text-item')).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('text-item')).toHaveCount(0);
    expect(await stored(dataDir)).toEqual([]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
