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
    await expect(texts).toHaveAttribute('data-font-size', '32');
    await expect.poll(async () => (await settledBox(texts)).height).toBeGreaterThan(bodyHeight);
    await expect
      .poll(async () => (await stored(dataDir))[0]?.data)
      .toMatchObject({ size: 'h1', fontSize: 32, bold: true, italic: true, align: 'center', color: '#3b5bdb' });

    // Resized from a side (the left, which is on screen), it keeps that width and wraps.
    await texts.click();
    const handle = await settledBox(window.locator('.react-flow__resize-control.line.left'));
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
    // Below the shape picker, which S opens under the bar.
    await drag(window, { x: pane.x + 700, y: pane.y + 640 }, { x: pane.x + 710, y: pane.y + 646 });
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
    // The kind of shape, from the bar's shape picker.
    await window.getByRole('button', { name: 'Change shape: Process' }).click();
    await window.getByRole('dialog', { name: 'Shapes' }).getByRole('button', { name: 'Ellipse', exact: true }).click();
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
    await expect(restoredText).toHaveAttribute('data-font-size', '32');
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

test('a shape grows to fit the text typed in it, and takes an alignment, a font size and mono', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const shapes = window.getByTestId('shape');
    const shape = async () => (await stored(dataDir)).find((item) => item.kind === 'shape')!;

    await window.mouse.move(pane.x + 300, pane.y + 200);
    await window.keyboard.press('s');
    const start = { x: pane.x + 160, y: pane.y + 160 };
    await drag(window, start, { x: start.x + 160, y: start.y + 70 });
    await expect(shapes).toHaveCount(1);
    await shapes.dblclick();
    await expect(shapes.getByRole('textbox', { name: 'Shape text' })).toBeFocused();
    await window.keyboard.type('Validates the merge gate, then squash-merges the PR and removes the worktree and its branch.');
    await expect.poll(async () => (await shape()).height).toBeGreaterThan(100);
    const grown = (await shape()).height;
    const width = (await shape()).width;
    await window.keyboard.press('Escape');

    // Nothing is cut off: the text is all inside the shape, which kept its width.
    const label = shapes.locator('.shape-text');
    await expect(label).toContainText('removes the worktree and its branch.');
    expect(await label.evaluate((el) => el.scrollHeight <= el.parentElement!.clientHeight - 24 + 1)).toBe(true);
    expect((await shape()).width).toBe(width);

    // Enter on the selected shape types in it again, from its end.
    await shapes.click();
    await window.keyboard.press('Enter');
    const editor = shapes.getByRole('textbox', { name: 'Shape text' });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/removes the worktree and its branch\.$/);
    await window.keyboard.press('Escape');
    await expect(editor).toBeHidden();

    // Restyled from the bar: a bigger font needs a taller shape, and the others are kept.
    const fits = () => label.evaluate((el) => el.scrollHeight <= el.parentElement!.clientHeight - 24 + 1);
    await shapes.click();
    // Three clicks in a row, each a step of its own.
    await window.getByRole('button', { name: 'Align left' }).click();
    await window.getByRole('button', { name: 'Mono' }).click();
    await window.getByRole('button', { name: 'Larger text' }).click();
    await expect(shapes).toHaveAttribute('data-align', 'left');
    await expect(shapes).toHaveAttribute('data-mono', 'true');
    await expect.poll(async () => (await shape()).height).toBeGreaterThan(grown);
    await expect.poll(async () => (await shape()).data).toMatchObject({ align: 'left', mono: true, fontSize: 20 });
    await expect.poll(fits).toBe(true);

    // One undo takes the bigger font back with the height it needed, and leaves the click before it.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await shape()).data.fontSize).toBeNull();
    await expect.poll(async () => (await shape()).data).toMatchObject({ align: 'left', mono: true });
    await expect.poll(fits).toBe(true);

    // Dragged by its top-right corner in and down, shorter and narrower than the text fits, the shape keeps the height the
    // text needs and its bottom edge where it was: not grown downward from the new top once the drag is done.
    await window.getByRole('button', { name: 'Fit View' }).click();
    await shapes.click();
    const before = await shape();
    const edge = await settledBox(window.locator('.react-flow__resize-control.handle.top.right'));
    const grip = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
    await drag(window, grip, { x: grip.x - 40, y: grip.y + 60 });
    await expect.poll(async () => (await shape()).width).toBeLessThan(before.width);
    // Settled: the text fits, and the saved bottom edge is where it was.
    await expect(async () => {
      expect(await fits()).toBe(true);
      const after = await shape();
      expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(2);
    }).toPass();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("a shape grown on its own (its text clipped when it arrives) is not an undo step", async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const shapes = window.getByTestId('shape');

    // The user's own step: a shape with a word typed in it.
    await window.mouse.move(pane.x + 300, pane.y + 200);
    await window.keyboard.press('s');
    await drag(window, { x: pane.x + 160, y: pane.y + 160 }, { x: pane.x + 320, y: pane.y + 230 });
    await shapes.dblclick();
    await window.keyboard.type('Hello');
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.text).toBe('Hello');

    // A shape that arrives with more text than fits (as from another window, or an older board) grows to fit.
    const clipped = await withDaemon(dataDir, (client) =>
      client.call('item.create', {
        kind: 'shape',
        zoneId: null,
        x: 500,
        y: 160,
        width: 160,
        height: 60,
        data: {
          shape: 'rectangle',
          fill: '#fff3bf',
          stroke: '#d9480f',
          strokeWidth: 2.5,
          dashed: false,
          text: 'Validates the merge gate, then squash-merges the PR and removes the worktree and its branch.',
          textSize: 'h2',
          bold: true,
          textColor: '#2b2a27',
        },
      }),
    );
    await expect.poll(async () => (await stored(dataDir)).find((item) => item.id === clipped.id)?.height).toBeGreaterThan(100);

    // One undo takes the user's typing back: the board's growth is no step in the way.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await stored(dataDir)).find((item) => item.id !== clipped.id)?.data.text).toBe('');
    expect((await stored(dataDir)).find((item) => item.id === clipped.id)!.height).toBeGreaterThan(100);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a text box resizes from a corner and takes a font size, each undoable and kept across a restart', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const texts = window.getByTestId('text-item');

    await window.mouse.move(pane.x + 300, pane.y + 200);
    await window.keyboard.press('t');
    await window.mouse.click(pane.x + 200, pane.y + 200);
    await expect(texts.getByRole('textbox', { name: 'Text' })).toBeFocused();
    await window.keyboard.type('Resize me');
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.text).toBe('Resize me');
    await window.getByRole('button', { name: 'Fit View' }).click();
    await texts.click();

    // Dragged from the bottom-right corner: wider and taller than its text.
    const before = (await stored(dataDir))[0]!;
    const corner = await settledBox(window.locator('.react-flow__resize-control.handle.bottom.right'));
    const grip = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
    await drag(window, grip, { x: grip.x + 120, y: grip.y + 80 });
    await expect.poll(async () => (await stored(dataDir))[0]?.width).toBeGreaterThan(before.width + 20);
    await expect.poll(async () => (await stored(dataDir))[0]?.height).toBeGreaterThan(before.height + 20);
    await expect.poll(async () => (await stored(dataDir))[0]?.data.wrap).toBe(true);
    const resized = (await stored(dataDir))[0]!;

    // 48px from the size control.
    await window.getByLabel('Font size').selectOption('48');
    await expect(texts).toHaveAttribute('data-font-size', '48');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.fontSize).toBe(48);

    // Undo takes the size back, then the resize; redo puts both back. The size select still has focus, as a real pick leaves it.
    await window.getByLabel('Font size').focus();
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.fontSize).toBe(16);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await stored(dataDir))[0]?.width).toBe(before.width);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.fontSize).toBe(48);
    await expect.poll(async () => (await stored(dataDir))[0]?.width).toBe(resized.width);

    // A restart keeps both.
    await app.close();
    await stopDaemon(dataDir);
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    await expect(window.getByTestId('text-item')).toHaveAttribute('data-font-size', '48');
    expect((await stored(dataDir))[0]).toMatchObject({ width: resized.width });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Shift on a corner scales the font with the box, and a box with no dragged height fits its text again', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const texts = window.getByTestId('text-item');
    await window.mouse.move(pane.x + 300, pane.y + 200);
    await window.keyboard.press('t');
    await window.mouse.click(pane.x + 200, pane.y + 200);
    await window.keyboard.type('Scale me');
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.text).toBe('Scale me');
    await window.getByRole('button', { name: 'Fit View' }).click();
    await texts.click();

    // Shift held before the grab: the font grows with the width.
    const before = (await stored(dataDir))[0]!;
    const corner = await settledBox(window.locator('.react-flow__resize-control.handle.bottom.right'));
    const grip = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
    await window.keyboard.down('Shift');
    await drag(window, grip, { x: grip.x + 100, y: grip.y + 40 });
    await window.keyboard.up('Shift');
    await expect.poll(async () => (await stored(dataDir))[0]?.width).toBeGreaterThan(before.width + 20);
    const scaled = (await stored(dataDir))[0]!;
    expect(scaled.data.fontSize).toBeGreaterThan(before.data.fontSize as number);

    // A taller box that was dragged so stays tall; one that was not shrinks back with its text.
    await window.getByLabel('Font size').selectOption('96');
    await expect.poll(async () => (await stored(dataDir))[0]?.data.fontSize).toBe(96);
    const tall = (await stored(dataDir))[0]!.height;
    await window.getByLabel('Font size').selectOption('12');
    await expect.poll(async () => (await stored(dataDir))[0]?.height).toBeLessThan(tall / 2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a class is typed in section by section, Tab moving between its name, attributes and methods, and grows to fit them', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const shapes = window.getByTestId('shape');
    const look = { fill: '#ffffff', stroke: '#2b2a27', strokeWidth: 2.5, dashed: false, text: '', textSize: 'body', bold: true, textColor: '#2b2a27' };
    // A class saved without its sections or mono, as one drawn before they were kept: it has both, empty, in mono.
    const made = await withDaemon(dataDir, (client) =>
      client.call('item.create', { kind: 'shape', zoneId: null, x: 200, y: 160, width: 220, height: 120, data: { shape: 'class', ...look } }),
    );
    const classShape = shapes.and(window.locator('[data-shape="class"]'));
    const sections = classShape.locator('.shape-section');
    const saved = async () => (await stored(dataDir)).find((item) => item.id === made.id)?.data;
    await expect(sections).toHaveCount(3);
    const before = await settledBox(classShape);

    // Its name, under a stereotype; Tab to the attributes, which are mono; Tab to the methods.
    await sections.first().dblclick();
    await expect(window.getByRole('textbox', { name: 'Shape text' })).toBeFocused();
    await window.keyboard.type('<<entity>>\nSession');
    await window.keyboard.press('Tab');
    const attributes = window.getByRole('textbox', { name: 'Class attributes' });
    await expect(attributes).toBeFocused();
    expect(await attributes.evaluate((editor) => getComputedStyle(editor).fontFamily)).toMatch(/mono/i);
    // Saved as typing pauses, and again at the end: still one step to undo.
    await window.keyboard.type('+ id: string\n+ state: AgentState');
    await expect.poll(async () => (await saved())?.attributes).toBe('+ id: string\n+ state: AgentState');
    await window.keyboard.type('\n+ branch: string\n+ zone: string');
    await window.keyboard.press('Tab');
    await expect(window.getByRole('textbox', { name: 'Class methods' })).toBeFocused();
    await window.keyboard.type('+ send(text)\n+ restart()');
    // Shift+Tab goes back, and Tab from the last comes round to the name.
    await window.keyboard.press('Shift+Tab');
    await expect(attributes).toBeFocused();
    await window.keyboard.press('Tab');
    await window.keyboard.press('Tab');
    await expect(window.getByRole('textbox', { name: 'Shape text' })).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('textbox')).toHaveCount(0);

    await expect.poll(saved).toMatchObject({
      text: '<<entity>>\nSession',
      attributes: '+ id: string\n+ state: AgentState\n+ branch: string\n+ zone: string',
      methods: '+ send(text)\n+ restart()',
    });
    await expect(classShape.locator('.shape-stereotype')).toHaveText('«entity»');
    // Grown to hold all three, its width kept, the rules between them where their text puts them.
    await expect.poll(async () => (await stored(dataDir)).find((item) => item.id === made.id)?.height).toBeGreaterThan(before.height + 40);
    const grown = await settledBox(classShape);
    expect(Math.abs(grown.width - before.width)).toBeLessThan(2);
    const [name, members, methods] = await Promise.all([0, 1, 2].map((at) => settledBox(sections.nth(at))));
    expect(members!.y).toBeGreaterThanOrEqual(name!.y + name!.height - 1);
    expect(methods!.y).toBeGreaterThanOrEqual(members!.y + members!.height - 1);
    expect(methods!.y + methods!.height).toBeLessThanOrEqual(grown.y + grown.height + 1);

    // A double-click on a section types in that one.
    await sections.nth(2).dblclick();
    await expect(window.getByRole('textbox', { name: 'Class methods' })).toBeFocused();
    await window.keyboard.press('Escape');

    // Each section's typing undoes as one step of its own, the last first.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(saved).toMatchObject({ text: '<<entity>>\nSession', attributes: '+ id: string\n+ state: AgentState\n+ branch: string\n+ zone: string', methods: '' });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(saved).toMatchObject({ text: '<<entity>>\nSession', attributes: '', methods: '' });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(saved).toMatchObject({ text: '' });

    // Mono is the sections' look, and the bar's Mono turns it off; the name is never mono.
    await classShape.click();
    await window.getByRole('button', { name: 'Fit View' }).click();
    const fontOf = (at: number) => sections.nth(at).evaluate((section) => getComputedStyle(section).fontFamily);
    expect(await fontOf(0)).not.toMatch(/mono/i);
    await window.getByRole('button', { name: 'Mono', exact: true }).click();
    await expect.poll(saved).toMatchObject({ mono: false });
    expect(await fontOf(1)).not.toMatch(/mono/i);

    // A box interface has the same sections, under «interface» until its name gives another stereotype.
    await withDaemon(dataDir, (client) =>
      client.call('item.create', { kind: 'shape', zoneId: null, x: 600, y: 160, width: 200, height: 160, data: { shape: 'interface-box', ...look, text: 'Runner' } }),
    );
    const box = shapes.and(window.locator('[data-shape="interface-box"]'));
    await expect(box.locator('.shape-section')).toHaveCount(3);
    await expect(box.locator('.shape-stereotype')).toHaveText('«interface»');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
