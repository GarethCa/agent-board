import { expect } from '@playwright/test';
import { connectDaemon, type DaemonClient } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { drag } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';

/** How far a duplicate lands from what it copies: the desk's dot gap. */
const DUPLICATE_OFFSET = 24;

/** The stickies as the daemon has them, by where they are, left to right then top to bottom. */
async function storedNotes(client: DaemonClient): Promise<{ id: string; x: number; y: number }[]> {
  const items: BoardItem[] = await client.call('item.list');
  return items
    .filter((item) => item.kind === 'sticky')
    .map(({ id, x, y }) => ({ id, x: Math.round(x), y: Math.round(y) }))
    .toSorted((a, b) => a.y - b.y || a.x - b.x);
}

test('marquee-selects three stickies, duplicates and moves them, undoes twice and redoes once; a shortcut typed in a sticky is typed', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  let client: DaemonClient | undefined;
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    client = daemon;
    // Three notes in a row, made by the daemon as another window would: they show here as they are made.
    for (const x of [100, 340, 580]) {
      await daemon.call('item.create', { kind: 'sticky', zoneId: null, x, y: 200, width: 200, height: 200, data: { text: `note ${x}`, color: '#fff3a3' } });
    }
    const notes = window.getByTestId('sticky');
    await expect(notes).toHaveCount(3);
    const originals = await storedNotes(daemon);

    // A marquee from bare board round all three selects them, in one labelled box.
    const boxes = await Promise.all([0, 1, 2].map(async (n) => (await notes.nth(n).boundingBox())!));
    const from = { x: Math.min(...boxes.map((box) => box.x)) - 40, y: Math.min(...boxes.map((box) => box.y)) - 40 };
    const to = { x: Math.max(...boxes.map((box) => box.x + box.width)) + 40, y: Math.max(...boxes.map((box) => box.y + box.height)) + 40 };
    expect(await window.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'), from)).toBe(true);
    await drag(window, from, to);
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(3);
    await expect(window.getByTestId('selection-label')).toHaveText('3 selected · 3 notes');

    // Duplicated: three more, a step down and right, selected in their place.
    await window.keyboard.press('ControlOrMeta+d');
    await expect(notes).toHaveCount(6);
    await expect.poll(async () => (await storedNotes(daemon)).length).toBe(6);
    const copies = (await storedNotes(daemon)).filter((note) => !originals.some((original) => original.id === note.id));
    expect(copies.map(({ x, y }) => ({ x, y }))).toEqual(originals.map(({ x, y }) => ({ x: x + DUPLICATE_OFFSET, y: y + DUPLICATE_OFFSET })));
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(3);

    // Moved together by dragging one of them, holding the command key so nothing snaps.
    const copy = window.locator(`.react-flow__node[data-id="item:${copies[0]!.id}"]`);
    const grip = (await copy.boundingBox())!;
    const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height - 30 };
    await drag(window, start, { x: start.x + 60, y: start.y + 300 }, { hold: 'ControlOrMeta' });
    const moved = copies.map(({ id, x, y }) => ({ id, x: x + 60, y: y + 300 }));
    await expect.poll(() => storedNotes(daemon)).toEqual([...originals, ...moved]);

    // Undo the move, then the duplicate; redo the duplicate.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedNotes(daemon)).toEqual([...originals, ...copies]);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedNotes(daemon)).toEqual(originals);
    await expect(notes).toHaveCount(3);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => storedNotes(daemon)).toEqual([...originals, ...copies]);
    await expect(notes).toHaveCount(6);

    // Typing a tool's key in a note types it: no note is made and no tool is armed.
    // By its top-left corner, which its copy doesn't cover.
    await window.locator(`.react-flow__node[data-id="item:${originals[0]!.id}"]`).dblclick({ position: { x: 12, y: 12 } });
    const editor = window.getByRole('textbox', { name: 'Note text' });
    await expect(editor).toBeFocused();
    await window.keyboard.type(' nts');
    await expect(editor).toHaveValue(/ nts$/);
    await expect(notes).toHaveCount(6);
    await expect(window.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'false');
    await expect(window.getByRole('button', { name: 'Shape' })).toHaveAttribute('aria-pressed', 'false');
  } finally {
    client?.close();
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});

test('select all asks before deleting a shell, notes alone are deleted at once, undo brings notes back with their connector; copy pastes at the pointer; the context menu aligns and colours; ] and [ restack', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  let client: DaemonClient | undefined;
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    client = daemon;
    const note = (x: number, y: number, text: string) =>
      daemon.call('item.create', { kind: 'sticky', zoneId: null, x, y, width: 160, height: 160, data: { text, color: '#fff3a3' } });
    const a = await note(100, 160, 'A');
    const b = await note(400, 220, 'B');
    await daemon.call('connector.create', { from: { type: 'item', id: a.id, side: 'right' }, to: { type: 'item', id: b.id, side: 'left' } });
    const shell = await daemon.call('shell.create', { zoneId: null, position: { x: 100, y: 420 } });
    const notes = window.getByTestId('sticky');
    await expect(notes).toHaveCount(2);
    const shellTile = window.locator(`.react-flow__node[data-id="shell:${shell.id}"]`);
    await expect(shellTile).toBeVisible();
    const stored = async () => ({
      items: (await daemon.call('item.list')) as BoardItem[],
      connectors: (await daemon.call('connector.list')).length,
      shells: (await daemon.call('shell.list')).length,
    });

    // Everything selected; deleting asks first, as the shell is a session, and Cancel leaves it all.
    await window.keyboard.press('ControlOrMeta+a');
    await expect(window.getByTestId('selection-label')).toHaveText('3 selected · 2 notes, 1 shell');
    await window.keyboard.press('Backspace');
    const confirm = window.getByRole('alertdialog', { name: 'Delete selection?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(notes).toHaveCount(2);
    await expect(shellTile).toBeVisible();

    // Only the notes selected; deleting takes them and their connector, with no question, and the shell stays.
    await window.locator(`.react-flow__node[data-id="item:${a.id}"]`).click({ position: { x: 12, y: 12 } });
    await window.locator(`.react-flow__node[data-id="item:${b.id}"]`).click({ position: { x: 12, y: 12 }, modifiers: ['Shift'] });
    await window.keyboard.press('Backspace');
    await expect(notes).toHaveCount(0);
    await expect.poll(async () => ({ ...(await stored()), items: (await stored()).items.length })).toEqual({ items: 0, connectors: 0, shells: 1 });
    await expect(shellTile).toBeVisible();

    // Undone: the same notes, and the connector between them.
    await window.keyboard.press('ControlOrMeta+z');
    await expect(notes).toHaveCount(2);
    await expect.poll(async () => (await stored()).items.map((item) => item.id).toSorted()).toEqual([a.id, b.id].toSorted());
    await expect.poll(async () => (await stored()).connectors).toBe(1);

    // Copied and pasted where the pointer is.
    const noteA = window.locator(`.react-flow__node[data-id="item:${a.id}"]`);
    const noteB = window.locator(`.react-flow__node[data-id="item:${b.id}"]`);
    await noteA.click();
    await window.keyboard.press('ControlOrMeta+c');
    const boxB = (await noteB.boundingBox())!;
    const pointer = { x: boxB.x + boxB.width + 200, y: boxB.y + boxB.height + 150 };
    await window.mouse.move(pointer.x, pointer.y);
    await window.keyboard.press('ControlOrMeta+v');
    await expect(notes).toHaveCount(3);
    const pasted = window.locator('.react-flow__node.selected');
    await expect(pasted).toHaveCount(1);
    const pastedBox = (await pasted.boundingBox())!;
    expect(Math.abs(pastedBox.x + pastedBox.width / 2 - pointer.x)).toBeLessThan(3);
    expect(Math.abs(pastedBox.y + pastedBox.height / 2 - pointer.y)).toBeLessThan(3);
    await expect(pasted).toContainText('A');

    // A and B: Shift-click adds to the selection; the context menu lines their tops up, and colours both.
    await noteA.click();
    await noteB.click({ modifiers: ['Shift'] });
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(2);
    await noteB.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Align' }).hover();
    await window.getByRole('menuitem', { name: 'Top edges' }).click();
    const byId = async (id: string) => (await stored()).items.find((item) => item.id === id)!;
    await expect.poll(async () => [(await byId(a.id)).y, (await byId(b.id)).y]).toEqual([160, 160]);
    await noteB.click({ button: 'right' });
    await window.getByRole('group', { name: 'Note colour' }).getByRole('menuitem', { name: 'Blue' }).click();
    await expect.poll(async () => [(await byId(a.id)).data.color, (await byId(b.id)).data.color]).toEqual(['#a5d8ff', '#a5d8ff']);

    // ] brings A to the front, [ sends it to the back.
    await noteA.click();
    const zs = async () => (await stored()).items.map((item) => item.z);
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(1);
    await window.keyboard.press(']');
    await expect.poll(async () => (await byId(a.id)).z === Math.max(...(await zs()))).toBe(true);
    await window.keyboard.press('[');
    await expect.poll(async () => (await byId(a.id)).z === Math.min(...(await zs()))).toBe(true);
  } finally {
    client?.close();
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});

test('a dragged note snaps to the edge of one near it, showing the guide; a tile moved by dragging moves back on undo', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  let client: DaemonClient | undefined;
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    client = daemon;
    const still = await daemon.call('item.create', { kind: 'sticky', zoneId: null, x: 100, y: 120, width: 160, height: 160, data: { text: 'still', color: '#fff3a3' } });
    const dragged = await daemon.call('item.create', { kind: 'sticky', zoneId: null, x: 420, y: 400, width: 160, height: 160, data: { text: 'dragged', color: '#fff3a3' } });
    const shell = await daemon.call('shell.create', { zoneId: null, position: { x: 700, y: 120 } });
    const item = (id: string) => window.locator(`.react-flow__node[data-id="item:${id}"]`);
    await expect(item(dragged.id)).toBeVisible();

    // Let go 3px right of the still note's left edge: it lands on it, with the guide drawn while it is held there.
    const box = (await item(dragged.id).boundingBox())!;
    const target = (await item(still.id).boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height - 20 };
    const to = { x: start.x - (box.x - target.x) + 3, y: start.y };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 12 });
    await expect(window.getByTestId('snap-guides')).toBeVisible();
    await window.mouse.up();
    await expect(window.getByTestId('snap-guides')).toHaveCount(0);
    await expect.poll(async () => ((await daemon.call('item.list')) as BoardItem[]).find((known) => known.id === dragged.id)?.x).toBe(100);

    // A shell tile dragged down, then put back by undo.
    const tile = window.locator(`.react-flow__node[data-id="shell:${shell.id}"]`);
    const tileBox = (await tile.boundingBox())!;
    const grip = { x: tileBox.x + tileBox.width / 2, y: tileBox.y + 12 };
    await drag(window, grip, { x: grip.x, y: grip.y + 250 }, { hold: 'ControlOrMeta' });
    const placeOf = async () => (await daemon.call('shell.list')).find((known) => known.id === shell.id)?.position;
    await expect.poll(async () => (await placeOf())?.y).toBe(370);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await placeOf())?.y).toBe(120);
    expect((await placeOf())?.x).toBe(700);
  } finally {
    client?.close();
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});

test('a note made here and deleted comes back on undo, alone or with others; the context menu copies and restacks', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  let client: DaemonClient | undefined;
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    client = daemon;
    const first = await daemon.call('item.create', { kind: 'sticky', zoneId: null, x: 120, y: 160, width: 160, height: 160, data: { text: 'first', color: '#fff3a3' } });
    const notes = window.getByTestId('sticky');
    await expect(notes).toHaveCount(1);
    const ids = async () => ((await daemon.call('item.list')) as BoardItem[]).map((item) => item.id).toSorted();
    const original = window.locator(`.react-flow__node[data-id="item:${first.id}"]`);

    // A duplicate made here, then deleted on its own: undo brings that very note back.
    await original.click();
    await window.keyboard.press('ControlOrMeta+d');
    await expect(notes).toHaveCount(2);
    await expect.poll(async () => (await ids()).length).toBe(2);
    const both = await ids();
    await window.keyboard.press('Backspace');
    await expect.poll(ids).toEqual([first.id]);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(ids).toEqual(both);
    await expect(notes).toHaveCount(2);

    // Duplicated again, then everything deleted: undo brings back every note.
    await original.click({ position: { x: 12, y: 12 } });
    await window.keyboard.press('ControlOrMeta+d');
    await expect.poll(async () => (await ids()).length).toBe(3);
    const all = await ids();
    await window.keyboard.press('ControlOrMeta+a');
    await window.keyboard.press('Backspace');
    await expect.poll(ids).toEqual([]);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(ids).toEqual(all);
    await expect(notes).toHaveCount(3);

    // The context menu's Copy, pasted where the pointer is.
    await original.click({ position: { x: 12, y: 12 } });
    await original.click({ button: 'right', position: { x: 12, y: 12 } });
    await window.getByRole('menuitem', { name: 'Copy' }).click();
    const box = (await original.boundingBox())!;
    await window.mouse.move(box.x + box.width + 300, box.y + box.height + 200);
    await window.keyboard.press('ControlOrMeta+v');
    await expect(notes).toHaveCount(4);
    await expect.poll(async () => (await ids()).length).toBe(4);

    // Its Bring to front puts the original on top of all four.
    await original.click({ position: { x: 12, y: 12 } });
    await original.click({ button: 'right', position: { x: 12, y: 12 } });
    await window.getByRole('menuitem', { name: 'Bring to front' }).click();
    await expect
      .poll(async () => {
        const items = (await daemon.call('item.list')) as BoardItem[];
        return items.find((item) => item.id === first.id)!.z === Math.max(...items.map((item) => item.z));
      })
      .toBe(true);
  } finally {
    client?.close();
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});

test('a zone moved by its tab moves back on undo, but not while typing in a note; Shift-marquee adds to the selection', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  let client: DaemonClient | undefined;
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    client = daemon;
    const zone = await daemon.call('zone.addUnbound', { name: 'Ideas', x: 80, y: 120 });
    const a = await daemon.call('item.create', { kind: 'sticky', zoneId: null, x: 860, y: 120, width: 140, height: 140, data: { text: 'a', color: '#fff3a3' } });
    const b = await daemon.call('item.create', { kind: 'sticky', zoneId: null, x: 860, y: 420, width: 140, height: 140, data: { text: 'b', color: '#fff3a3' } });
    // Zones are listed when the board loads.
    await window.reload();
    window = await app.firstWindow();
    await expect(window.getByTestId('zone')).toHaveCount(1);
    await expect(window.getByTestId('sticky')).toHaveCount(2);
    const zoneAt = async () => {
      const known = ((await daemon.call('zone.list')) as { id: string; x: number; y: number }[]).find((each) => each.id === zone.id)!;
      return { x: Math.round(known.x), y: Math.round(known.y) };
    };

    // Moved by its tab, holding the command key so nothing snaps. Its box once the board has fitted the view to it: the
    // zone is on the page before it is measured and the view fitted.
    const tabName = window.getByTestId('zone-tab').locator('.zone-tab-name');
    let last = '';
    await expect
      .poll(async () => {
        const box = JSON.stringify(await tabName.boundingBox());
        const settled = box === last && box !== 'null';
        last = box;
        return settled;
      })
      .toBe(true);
    const tab = JSON.parse(last) as { x: number; y: number; width: number; height: number };
    const grip = { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 };
    await drag(window, grip, { x: grip.x + 40, y: grip.y + 60 }, { hold: 'ControlOrMeta' });
    await expect.poll(async () => (await zoneAt()).y > 150).toBe(true);
    const moved = await zoneAt();
    expect(moved.x).toBeGreaterThan(100);

    // In a note, ⌘A selects its text, ] is typed, and ⌘Z undoes the typing, never the board.
    const noteA = window.locator(`.react-flow__node[data-id="item:${a.id}"]`);
    await noteA.dblclick();
    const editor = window.getByRole('textbox', { name: 'Note text' });
    await expect(editor).toBeFocused();
    await window.keyboard.type(']');
    await expect(editor).toHaveValue('a]');
    await window.keyboard.press('ControlOrMeta+a');
    await expect(window.getByTestId('selection-box')).toHaveCount(0);
    await window.keyboard.press('ControlOrMeta+z');
    await expect(editor).toBeFocused();
    expect(await zoneAt()).toEqual(moved);

    // Off the note, ⌘Z takes the zone back (the note's typing was undone in it, so saves nothing new).
    await window.keyboard.press('Escape');
    await window.mouse.click(5, (await window.locator('.react-flow__pane').boundingBox())!.y + 300);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(zoneAt).toEqual({ x: 80, y: 120 });

    // A selected, then a Shift-marquee round B: both are selected.
    await noteA.click();
    await expect(noteA).toHaveClass(/\bselected\b/);
    const boxB = (await window.locator(`.react-flow__node[data-id="item:${b.id}"]`).boundingBox())!;
    const from = { x: boxB.x - 30, y: boxB.y - 30 };
    expect(await window.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'), from)).toBe(true);
    await drag(window, from, { x: boxB.x + boxB.width + 30, y: boxB.y + boxB.height + 30 }, { hold: 'Shift' });
    await expect(window.locator('.react-flow__node.selected')).toHaveCount(2);
    await expect(window.getByTestId('selection-label')).toHaveText('2 selected · 2 notes');
  } finally {
    client?.close();
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});
