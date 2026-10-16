import { expect, type Locator, type Page } from '@playwright/test';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { centreOf, drag, settledBox, withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, newShell, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';

/** The one item's angle, as the daemon has stored it. */
async function storedRotation(dataDir: string): Promise<number> {
  const items: BoardItem[] = await withDaemon(dataDir, (client) => client.call('item.list'));
  return items[0]!.rotation;
}

/** The angle a board element is drawn at, from its own `rotate` and `transform` both: 0 when straight. */
function drawnAngle(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    const rotate = style.rotate === 'none' ? 0 : Number.parseFloat(style.rotate);
    const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
    return Math.round(rotate + (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
  });
}

/** Drags the rotate handle round the note's centre to the point at `degrees` clockwise from straight up. */
async function turnTo(window: Page, note: Locator, degrees: number, hold?: string): Promise<void> {
  const centre = centreOf(await settledBox(window.locator('.react-flow__node').filter({ has: note })));
  const handle = centreOf(await settledBox(window.getByTestId('rotate-handle')));
  const reach = Math.hypot(handle.x - centre.x, handle.y - centre.y);
  const radians = (degrees * Math.PI) / 180;
  await drag(window, handle, { x: centre.x + reach * Math.sin(radians), y: centre.y - reach * Math.cos(radians) }, { steps: 16, hold });
}

test('tiles sit straight; a sticky turned by its handle still drags and joins connectors, keeps its angle across a restart, Shift snaps to 15°, and undo and Reset rotation put it back', async () => {
  const dataDir = tempDataDir();
  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);

    // A tile is drawn straight, and stays straight while dragged.
    await newShell(window);
    await expect(window.getByTestId('session-window')).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    const tile = window.getByTestId('shell-tile');
    await expect(tile).toHaveCount(1);
    expect(await drawnAngle(tile)).toBe(0);
    const tileBox = await settledBox(tile);
    await window.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height - 12);
    await window.mouse.down();
    await window.mouse.move(tileBox.x + tileBox.width / 2 + 40, tileBox.y + tileBox.height + 28, { steps: 8 });
    expect(await drawnAngle(tile)).toBe(0);
    await window.mouse.up();

    // A note, made straight, shows a rotate handle under it once selected.
    await withDaemon(dataDir, (client) =>
      client.call('item.create', { kind: 'sticky', zoneId: null, x: 700, y: 140, width: 200, height: 200, data: { text: 'turn me', color: '#fff3a3' } }),
    );
    const note = window.getByTestId('sticky');
    await expect(note).toHaveCount(1);
    expect(await storedRotation(dataDir)).toBe(0);
    await note.click({ position: { x: 100, y: 40 } });
    await expect(window.getByTestId('rotate-handle')).toBeVisible();

    // The handle hangs straight down (180°); dragged round to 3 o'clock (90°), the note turns a quarter-turn back.
    await turnTo(window, note, 90);
    await expect.poll(() => storedRotation(dataDir)).toBeCloseTo(-90, 0);
    const rotor = window.locator('.item-rotor').filter({ has: note });
    expect(await drawnAngle(rotor)).toBe(Math.round(await storedRotation(dataDir)));

    // Turned, it still drags by its body (the command key held, so nothing snaps)...
    const storedItem = async () => ((await withDaemon(dataDir, (client) => client.call('item.list'))) as BoardItem[])[0]!;
    const { x: wasX, y: wasY } = await storedItem();
    const middle = centreOf(await settledBox(rotor));
    await drag(window, middle, { x: middle.x + 60, y: middle.y + 40 }, { hold: 'ControlOrMeta' });
    await expect.poll(async () => Math.round((await storedItem()).x - wasX)).toBe(60);
    expect(Math.round((await storedItem()).y - wasY)).toBe(40);
    // ...and a connector drawn from the handle on its top side, now turned to face left, joins it to the tile.
    await note.hover();
    const side = rotor.locator('.connector-handle[data-side="top"]');
    await expect(side).toHaveCSS('opacity', '1');
    const sideAt = centreOf(await settledBox(side));
    expect(sideAt.x).toBeLessThan(centreOf(await settledBox(rotor)).x - 80);
    await drag(window, sideAt, centreOf(await settledBox(tile)));
    await expect.poll(async () => (await withDaemon(dataDir, (client) => client.call('connector.list'))).length).toBe(1);
    await expect(window.locator('.react-flow__edge-path.connector-line')).toHaveCount(1);
    await note.click({ position: { x: 100, y: 100 } });
    await expect(window.getByTestId('rotate-handle')).toBeVisible();

    // Turned again with Shift held, to a point off any 15° step: it lands on one.
    await turnTo(window, note, -50, 'Shift');
    await expect.poll(async () => Math.abs((await storedRotation(dataDir)) % 15)).toBe(0);
    const snapped = await storedRotation(dataDir);
    expect(snapped).not.toBeCloseTo(-90, 0);

    // Undo puts the turn back; redo does it again.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedRotation(dataDir)).toBeCloseTo(-90, 0);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => storedRotation(dataDir)).toBe(snapped);

    // A full restart: the app and its daemon both go, and the note comes back at its angle.
    const firstDaemon = await connectedDaemonPid(window);
    await app.close();
    expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    await connectedDaemonPid(window);
    const restored = window.locator('.item-rotor').filter({ has: window.getByTestId('sticky') });
    await expect(restored).toHaveAttribute('data-rotation', String(snapped));
    expect(await drawnAngle(restored)).toBe(snapped);

    // Reset rotation, from the note's context menu, turns it straight; undone, then ⇧R does the same.
    const restoredNote = window.getByTestId('sticky');
    await restoredNote.click({ position: { x: 100, y: 100 } });
    await restoredNote.click({ button: 'right', position: { x: 100, y: 100 } });
    await window.getByRole('menuitem', { name: 'Reset rotation' }).click();
    await expect.poll(() => storedRotation(dataDir)).toBe(0);
    await expect(restored).toHaveAttribute('data-rotation', '0');
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedRotation(dataDir)).toBe(snapped);
    await window.keyboard.press('Shift+R');
    await expect.poll(() => storedRotation(dataDir)).toBe(0);
  } finally {
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});

test('the handle under a selection of several turns each item in it about its own centre, as one undo step', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await withDaemon(dataDir, async (client) => {
      for (const x of [200, 500]) {
        await client.call('item.create', { kind: 'sticky', zoneId: null, x, y: 160, width: 200, height: 200, data: { text: `note ${x}`, color: '#fff3a3' } });
      }
    });
    const notes = window.getByTestId('sticky');
    await expect(notes).toHaveCount(2);
    const before: BoardItem[] = await withDaemon(dataDir, (client) => client.call('item.list'));

    await notes.first().click({ position: { x: 100, y: 40 } });
    await notes.last().click({ position: { x: 100, y: 40 }, modifiers: ['Shift'] });
    const box = window.getByTestId('selection-box');
    await expect(window.getByTestId('selection-label')).toHaveText('2 selected · 2 notes');
    // One handle, the box's: the notes' own are hidden while several are selected.
    await expect(window.getByTestId('rotate-handle')).toHaveCount(0);
    const handle = window.getByTestId('selection-rotate-handle');
    await expect(handle).toBeVisible();

    // From straight down round to 9 o'clock, Shift held: a quarter-turn clockwise, each note about its own centre.
    const centre = centreOf(await settledBox(box));
    const from = centreOf(await settledBox(handle));
    const reach = Math.hypot(from.x - centre.x, from.y - centre.y);
    await drag(window, from, { x: centre.x - reach, y: centre.y + 4 }, { steps: 16, hold: 'Shift' });
    const turned = async () => ((await withDaemon(dataDir, (client) => client.call('item.list'))) as BoardItem[]).map(({ rotation, x, y }) => ({ rotation, x, y }));
    await expect.poll(turned).toEqual(before.map(({ x, y }) => ({ rotation: 90, x, y })));
    // Still selected: letting go of the handle is no click on the board.
    await expect(window.getByTestId('selection-label')).toHaveText('2 selected · 2 notes');

    // One undo puts both back.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(turned).toEqual(before.map(({ x, y }) => ({ rotation: 0, x, y })));
  } finally {
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
});
