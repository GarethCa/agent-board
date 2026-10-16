import { expect, type Locator, type Page } from '@playwright/test';
import { connectDaemon, type DaemonClient } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { Shell } from '@agent-board/daemon/protocol';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { SHELL_ENV } from './agent-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';

type Point = { x: number; y: number };

/** Where each shell tile sits in the zone: three in a row along the top, the fourth on its own below right. */
const PLACES = [
  { x: 40, y: 60 },
  { x: 340, y: 60 },
  { x: 640, y: 60 },
  { x: 1040, y: 280 },
];

/** Whether `node` (a React Flow node or edge, or something in one) is selected. */
const isSelected = (node: Locator) =>
  node.evaluate((element) => element.closest('.react-flow__node, .react-flow__edge')!.classList.contains('selected'));

/** What the bare point `at` is: the zone's body, the board, or something else. */
const underPoint = (page: Page, at: Point) =>
  page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element?.classList.contains('zone') ? 'zone' : element?.classList.contains('react-flow__pane') ? 'board' : element?.className;
  }, at);

/** The toolbar's pointer-mode button named `name`. */
const modeButton = (window: Page, name: string) => window.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name, exact: true });

interface CrewBoard {
  window: Page;
  zone: Locator;
  tiles: Locator[];
  zoneId: string;
  /** The zone's place as the daemon has it. */
  zoneAt(): Promise<Point>;
  /** Each shell's zone and place as the daemon has it. */
  shellPlaces(): Promise<{ zoneId: string | null; x: number; y: number }[]>;
  /** Whether each of the zone, the four tiles, the note and the connector is selected, in that order. */
  selected(): Promise<boolean[]>;
  clearSelection(): Promise<void>;
  /** Drags a marquee round the row of three and the note under it, from the zone's bare body; resolves where it began. */
  marqueeRoundRow(hold?: string): Promise<Point>;
  /** Checks `read` gives `expected` now and still does a few frames later, past any write a drag let go of late. */
  staysAt<T>(read: () => Promise<T>, expected: T): Promise<void>;
}

/**
 * A board with the group "Crew" holding four shell tiles (`PLACES`), a note under the middle of the row and a connector
 * from the first tile to the second, fitted to the view, for `use`; all taken down after.
 */
async function withCrewZone(use: (board: CrewBoard) => Promise<void>): Promise<void> {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, SHELL_ENV);
  let client: DaemonClient | undefined;
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);
    const daemon = await connectDaemon(daemonPaths(dataDir).socket);
    client = daemon;
    const made = await daemon.call('zone.addUnbound', { name: 'Crew', x: 80, y: 120, width: 1400, height: 480 });
    const shells: Shell[] = [];
    for (const position of PLACES) shells.push(await daemon.call('shell.create', { zoneId: made.id, position }));
    const sticky = await daemon.call('item.create', {
      kind: 'sticky',
      zoneId: made.id,
      x: 340,
      y: 230,
      width: 120,
      height: 120,
      data: { text: 'in the row', color: '#fff3a3' },
    });
    const line = await daemon.call('connector.create', {
      from: { type: 'shell', id: shells[0]!.id, side: 'right' },
      to: { type: 'shell', id: shells[1]!.id, side: 'left' },
    });
    // Zones are listed when the board loads.
    await window.reload();
    window = await app.firstWindow();
    const zone = window.getByTestId('zone');
    const tiles = shells.map((shell) => window.locator(`.react-flow__node[data-id="shell:${shell.id}"]`));
    const note = window.locator(`.react-flow__node[data-id="item:${sticky.id}"]`);
    const connector = window.locator(`.react-flow__edge[data-id="connector:${line.id}"]`);
    await expect(window.getByTestId('shell-tile')).toHaveCount(4);
    await expect(note).toBeVisible();
    await expect(connector).toHaveCount(1);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await settledBox(zone);

    const zoneAt = async () => {
      const known = ((await daemon.call('zone.list')) as { id: string; x: number; y: number }[]).find((each) => each.id === made.id)!;
      return { x: Math.round(known.x), y: Math.round(known.y) };
    };
    const shellPlaces = async () => {
      const known = (await daemon.call('shell.list')) as { id: string; zoneId: string | null; position?: Point }[];
      return shells.map((shell) => {
        const one = known.find((each) => each.id === shell.id)!;
        return { zoneId: one.zoneId, x: Math.round(one.position!.x), y: Math.round(one.position!.y) };
      });
    };
    const selected = () => Promise.all([zone, ...tiles, note, connector].map(isSelected));
    const clearSelection = async () => {
      const pane = (await window.locator('.react-flow__pane').boundingBox())!;
      const bare = { x: pane.x + 12, y: pane.y + pane.height / 2 };
      expect(await underPoint(window, bare)).toBe('board');
      await window.mouse.click(bare.x, bare.y);
      await expect.poll(selected).toEqual([false, false, false, false, false, false, false]);
    };
    const marqueeRoundRow = async (hold?: string): Promise<Point> => {
      const first = await settledBox(tiles[0]!);
      const third = await settledBox(tiles[2]!);
      const noteBox = await settledBox(note);
      const from = { x: first.x - 15, y: noteBox.y + noteBox.height + 20 };
      await drag(window, from, { x: third.x + third.width + 15, y: first.y - 15 }, { hold });
      return from;
    };
    const staysAt = async <T,>(read: () => Promise<T>, expected: T) => {
      expect<unknown>(await read()).toEqual(expected);
      for (let frame = 0; frame < 6; frame++) {
        await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));
        expect<unknown>(await read()).toEqual(expected);
      }
    };
    await use({ window, zone, tiles, zoneId: made.id, zoneAt, shellPlaces, selected, clearSelection, marqueeRoundRow, staysAt });
  } finally {
    client?.close();
    await app.close();
    await stopDaemon(dataDir);
    await removeDataDir(dataDir);
  }
}

test('Shift and a drag from a zone body selects 3 of its 4 tiles, the note and the line among them, keeping what was selected, and leaves the zone; Shift-click on the body still toggles the zone; a plain drag moves the zone', async () => {
  await withCrewZone(async ({ window, tiles, zoneAt, selected, clearSelection, marqueeRoundRow, staysAt }) => {
    const placed = await zoneAt();

    // A Shift-marquee from the zone's body: round the three in a row, the note and their line, not the fourth.
    await clearSelection();
    const from = await marqueeRoundRow('Shift');
    expect(await underPoint(window, from)).toBe('zone');
    await expect.poll(selected).toEqual([false, true, true, true, false, true, true]);
    await staysAt(zoneAt, placed);

    // Shift keeps what was selected: the fourth, then a Shift-marquee from the zone's body round the rest.
    await clearSelection();
    await tiles[3]!.click();
    await expect.poll(() => isSelected(tiles[3]!)).toBe(true);
    await marqueeRoundRow('Shift');
    await expect.poll(selected).toEqual([false, true, true, true, true, true, true]);
    await staysAt(zoneAt, placed);

    // A Shift-click on the zone's body adds the zone, and another takes it out again, the rest still selected.
    await window.keyboard.down('Shift');
    await window.mouse.click(from.x, from.y);
    await expect.poll(selected).toEqual([true, true, true, true, true, true, true]);
    await window.mouse.click(from.x, from.y);
    await window.keyboard.up('Shift');
    await expect.poll(selected).toEqual([false, true, true, true, true, true, true]);
    await staysAt(zoneAt, placed);

    // The same from one tile selected by a click: Shift-click on the body adds the zone, and again takes it out.
    await clearSelection();
    await tiles[3]!.click();
    await window.keyboard.down('Shift');
    await window.mouse.click(from.x, from.y);
    await expect.poll(selected).toEqual([true, false, false, false, true, false, false]);
    await window.mouse.click(from.x, from.y);
    await window.keyboard.up('Shift');
    await expect.poll(selected).toEqual([false, false, false, false, true, false, false]);

    // A plain drag on the zone's body moves the zone; undo puts it back.
    await clearSelection();
    await drag(window, from, { x: from.x + 60, y: from.y + 40 });
    await expect.poll(async () => (await zoneAt()).x).toBeGreaterThan(placed.x + 20);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(zoneAt).toEqual(placed);
  });
});

test('the Box select tool draws a marquee from a zone body with no key held; the three tiles move together, in the zone, and undo puts them back', async () => {
  await withCrewZone(async ({ window, tiles, zoneId, zoneAt, shellPlaces, selected, clearSelection, marqueeRoundRow, staysAt }) => {
    const placed = await zoneAt();
    const tilesPlaced = await shellPlaces();

    const boxSelect = modeButton(window, 'Box select');
    await boxSelect.click();
    await expect(boxSelect).toHaveAttribute('aria-pressed', 'true');
    await clearSelection();
    const from = await marqueeRoundRow();
    expect(await underPoint(window, from)).toBe('board');
    await expect.poll(selected).toEqual([false, true, true, true, false, true, true]);
    await staysAt(zoneAt, placed);
    await staysAt(shellPlaces, tilesPlaced);

    // Dragged by one, the three go together, still in the zone, the fourth where it was; undo puts them back.
    const grab = centreOf(await settledBox(tiles[1]!));
    await drag(window, grab, { x: grab.x + 40, y: grab.y + 90 });
    await expect.poll(async () => (await shellPlaces())[1]!.y).toBeGreaterThan(tilesPlaced[1]!.y + 20);
    const moved = await shellPlaces();
    const by = { x: moved[1]!.x - tilesPlaced[1]!.x, y: moved[1]!.y - tilesPlaced[1]!.y };
    for (const index of [0, 1, 2]) {
      expect(moved[index]).toEqual({ zoneId, x: tilesPlaced[index]!.x + by.x, y: tilesPlaced[index]!.y + by.y });
    }
    expect(moved[3]).toEqual(tilesPlaced[3]);
    await staysAt(zoneAt, placed);
    await clearSelection();
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(shellPlaces).toEqual(tilesPlaced);
  });
});

test("a zone moves by its tab in select and in box select; V and B pick the modes, and box select's zone body is the board's", async () => {
  await withCrewZone(async ({ window, zone, zoneAt, clearSelection }) => {
    const placed = await zoneAt();
    const tabName = zone.getByTestId('zone-tab').locator('.zone-tab-name');
    const body = async () => {
      const box = await settledBox(zone);
      return { x: box.x + 30, y: box.y + box.height - 30 };
    };
    const byTab = async () => {
      const grip = centreOf(await settledBox(tabName));
      // ⌘ held, so nothing snaps.
      await drag(window, grip, { x: grip.x + 60, y: grip.y + 40 }, { hold: 'ControlOrMeta' });
      await expect.poll(async () => (await zoneAt()).x).toBeGreaterThan(placed.x + 20);
      await clearSelection();
      await window.keyboard.press('ControlOrMeta+z');
      await expect.poll(zoneAt).toEqual(placed);
    };

    // Select: the body is the zone's, and the tab moves it.
    await expect(modeButton(window, 'Select')).toHaveAttribute('aria-pressed', 'true');
    expect(await underPoint(window, await body())).toBe('zone');
    await byTab();

    // B: box select, where the body is the board's, and the tab still moves it.
    await window.keyboard.press('b');
    await expect(modeButton(window, 'Box select')).toHaveAttribute('aria-pressed', 'true');
    expect(await underPoint(window, await body())).toBe('board');
    // Its connector handles neither show nor take a press there: a zone is joined from select.
    const handles = window.locator('.react-flow__node-zone .react-flow__handle');
    expect(await handles.count()).toBeGreaterThan(0);
    const looks = await handles.evaluateAll((all) => all.map((one) => `${getComputedStyle(one).visibility} ${getComputedStyle(one).pointerEvents}`));
    expect(new Set(looks)).toEqual(new Set(['hidden none']));
    await byTab();

    // V: select again.
    await window.keyboard.press('v');
    await expect(modeButton(window, 'Box select')).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton(window, 'Select')).toHaveAttribute('aria-pressed', 'true');
    expect(await underPoint(window, await body())).toBe('zone');
  });
});
