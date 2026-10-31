import { expect, type Locator, type Page } from '@playwright/test';
import { SPACING_GAPS } from '@agent-board/daemon/board-layout';
import { rmSync } from 'node:fs';
import { drag, run, settledBox, viewSettled } from './board-helpers.ts';
import { agents, launch, sessionWindow, setClickOpens, SHELL_ENV, showDetails, spawnAgent, tile, tileAction, TURN_MS, zones } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, runDesign, tempDataDir, browseForZone, newShell, placeWithTool, addEmptyZone } from './launch.ts';
import { scratch } from './scratch.ts';
import { clickClosing } from './windows.ts';

const expandedTile = (page: Page) => page.getByTestId('expanded-tile');
/** The expanded tile's bottom-right resize handle (React Flow marks each handle with its sides). */
const bottomRight = (page: Page) => expandedTile(page).locator('.expanded-tile-resize.bottom.right');
const expandedScreen = (page: Page) => expandedTile(page).getByTestId('session-terminal').locator('.xterm-rows');
const terminals = (page: Page) => page.getByTestId('session-terminal');

/** The branch of the one agent on the board. */
const branchOf = (page: Page) => page.evaluate(async () => (await window.agentBoard.agents.list())[0]!.branch);

/** The sizes the board remembers expanded tiles were let go at, saved for the next run, as JSON. */
const savedSizes = (page: Page) => page.evaluate(async () => JSON.stringify(await window.agentBoard.view.get('expandedTiles.sizes')));

/** The expanded tiles the board has saved for the next run, as JSON. */
const savedExpanded = (page: Page) => page.evaluate(async () => JSON.stringify(await window.agentBoard.view.get('expandedTiles')));

/** The tiles the board has saved as dragged onto another, left there, as JSON. */
const savedOverlaps = (page: Page) => page.evaluate(async () => JSON.stringify(await window.agentBoard.view.get('expandedTiles.overlaps')));

/** Each shell's place as the daemon stores it, by id, in id order. */
const storedShellPlaces = (page: Page) =>
  page.evaluate(async () => (await window.agentBoard.shells.list()).map((shell) => [shell.id, shell.position] as const).toSorted());

/** Each zone's layout as the daemon stores it. */
const storedZoneLayouts = (page: Page) =>
  page.evaluate(async () => (await window.agentBoard.zones.list()).map(({ x, y, width, height }) => ({ x, y, width, height })));

type Rect = { x: number; y: number; width: number; height: number };

/** A node's rect on the board, unscaled by the zoom: where React Flow draws it. */
const nodeRect = (node: Locator): Promise<Rect> =>
  node.evaluate((element) => {
    const [x, y] = (element as HTMLElement).style.transform.match(/-?[\d.]+/g)!.map(Number);
    return { x: x!, y: y!, width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight };
  });

/** A zone's rect on the board as drawn. */
const zoneRect = async (zone: Locator): Promise<Rect> => {
  const [x, y, width, height] = await Promise.all(['data-x', 'data-y', 'data-width', 'data-height'].map(async (name) => Number(await zone.getAttribute(name))));
  return { x: x!, y: y!, width: width!, height: height! };
};

/** Whether `outer` holds `inner` with room to spare. */
const holds = (outer: Rect, inner: Rect) =>
  inner.x > outer.x && inner.y > outer.y && inner.x + inner.width < outer.x + outer.width && inner.y + inner.height < outer.y + outer.height;

/** Adds the group `name` and `count` shells in it, each made through its tab and its session window closed. */
async function zoneWithShells(page: Page, name: string, count: number): Promise<Locator> {
  await addEmptyZone(page, name);
  const zone = page.getByTestId('zone');
  for (let made = 1; made <= count; made++) {
    await zone.getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(page)).toHaveAttribute('data-state', 'attached');
    await page.getByRole('button', { name: 'Close session window' }).click();
    await expect(page.getByTestId('shell-tile')).toHaveCount(made);
  }
  return zone;
}

/** Moves each of the shells `ids` to its place in `places`, in the one zone, as the daemon stores it. */
const scatter = (page: Page, ids: readonly string[], places: readonly { x: number; y: number }[]) =>
  page.evaluate(
    async ({ ids, places }) => {
      const [zone] = await window.agentBoard.zones.list();
      for (const [index, id] of ids.entries()) await window.agentBoard.shells.move(id, { zoneId: zone!.id, ...places[index]! });
    },
    { ids, places },
  );

/** Makes a shell tile in the one zone (loose on the board if `loose`) at each of `places`, with the daemon's API, and returns their ids. */
const shellsAt = (page: Page, places: readonly { x: number; y: number }[], loose = false) =>
  page.evaluate(
    async ({ places, loose }) => {
      const [zone] = await window.agentBoard.zones.list();
      const made: string[] = [];
      for (const position of places) made.push((await window.agentBoard.shells.create({ zoneId: loose ? null : zone!.id, position })).id);
      return made;
    },
    { places, loose },
  );

/** The node of the shell tile with id `shellId`. */
const shellNode = (page: Page, shellId: string) => page.locator(`.react-flow__node[data-id="shell:${shellId}"]`);

/** An expanded tile's width when it first opens, on the board (`EXPANDED_SIZE`). */
const EXPANDED_WIDTH = 960;

/** The expanded tile's width on the board, unscaled by the zoom: its node's. */
const boardWidthOf = (page: Page) =>
  page.locator('.react-flow__node').filter({ has: expandedTile(page) }).evaluate((node) => (node as HTMLElement).offsetWidth);

/** The on-screen box of the first `word` in the expanded terminal's text: its first and last characters' cells. */
const wordBox = (screen: Locator, word: string) =>
  screen.evaluate((rows, target) => {
    const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(target);
      if (at < 0) continue;
      const cell = (index: number) => {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return range.getBoundingClientRect();
      };
      const first = cell(at);
      const last = cell(at + target.length - 1);
      return { left: first.left, right: last.right, y: first.top + first.height / 2, cell: first.width };
    }
    return null;
  }, word);

/** What the expanded terminal has selected, as xterm would copy it. */
const selectedText = (screen: Locator) =>
  screen.evaluate((rows) => {
    const element = rows.closest('.xterm')!;
    const data = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, cancelable: true, bubbles: true }));
    return data.getData('text/plain');
  });

/** The board's zoom, read off the terminal: its on-screen width over its layout width. */
const scaleOf = (page: Page) =>
  expandedTile(page).getByTestId('session-terminal').first().evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);

/** Zooms the board with its button until the terminal's scale satisfies `done`. */
async function zoomTo(page: Page, button: 'Zoom Out' | 'Zoom In', done: (scale: number) => boolean): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await settledBox(expandedTile(page));
    if (done(await scaleOf(page))) return;
    await page.getByRole('button', { name: button }).click();
  }
  throw new Error(`never zoomed far enough with ${button}`);
}

/** Drags across `word` in the terminal screen and checks that exactly it is selected. Returns the board's zoom. */
async function dragSelectWord(page: Page, screen: Locator, word: string): Promise<number> {
  await settledBox(expandedTile(page));
  const box = (await wordBox(screen, word))!;
  expect(box).not.toBeNull();
  // From the first letter's left half to the last letter's right half: xterm rounds to the nearest edge.
  await page.mouse.move(box.left + box.cell * 0.25, box.y);
  await page.mouse.down();
  await page.mouse.move((box.left + box.right) / 2, box.y, { steps: 5 });
  await page.mouse.move(box.right - box.cell * 0.25, box.y, { steps: 5 });
  await page.mouse.up();
  expect(await selectedText(screen)).toBe(word);
  return scaleOf(page);
}

async function addRepoZone(page: Page, app: Parameters<typeof pickFolderNext>[0], repo: string): Promise<void> {
  await pickFolderNext(app, repo);
  await browseForZone(page);
  await expect(page.getByTestId('zone')).toHaveCount(1);
}

test('a Claude agent tile expands in place with its details and live terminal, moves with the board, collapses, and escalates to its session window and its own OS window', async () => {
  // Its session window is the Simplified design's under `E2E_DESIGN=simplified`: no dock, Done in its header.
  const simplified = runDesign() === 'simplified';
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await setClickOpens(window, 'Expand in place');
    await addRepoZone(window, app, repo);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await window.getByRole('button', { name: 'Fit View' }).click();
    // A compact tile attaches no terminal.
    await expect(terminals(window)).toHaveCount(0);

    // A click expands it in place: its details on the left, its live terminal beside them.
    await tile(window).dblclick();
    await expect(expandedTile(window)).toBeVisible();
    await expect(tile(window)).toHaveCount(0);
    const branch = await branchOf(window);
    await expect(expandedTile(window).getByRole('heading', { name: 'Pick a database' })).toBeVisible();
    await expect(expandedTile(window).locator('.session-window-head')).toContainText(branch);
    // Opens collapsed to its icon rail; the rail's Show details opens it.
    await expect(expandedTile(window).getByRole('complementary', { name: 'Session details' })).toHaveCount(0);
    await showDetails(expandedTile(window));
    const details = expandedTile(window).getByRole('complementary', { name: 'Session details' });
    await expect(details).toContainText('Worktree and branch');
    await expect(details).toContainText('PR and checks');
    await expect(details.getByTestId('details-last-message')).toContainText('Which database should I use');
    await expect(expandedTile(window).getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Stop' })).toBeEnabled();
    await expect(expandedScreen(window)).toContainText('Which database should I use');
    // It waits for a click before taking the keyboard, so Esc still reaches the board.
    expect(await window.evaluate(() => document.activeElement?.closest('.xterm') === null)).toBe(true);

    // Its terminal takes input. Esc typed there is the agent's, not the board's.
    await expandedTile(window).getByTestId('session-terminal').click();
    await run(window, 'SQLite');
    await expect(expandedScreen(window)).toContainText('Going with SQLite.');
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toBeVisible();

    // Its Delete asks as the tile's ⋯ menu does: a running agent's worktree and branch go with it. Cancelled here.
    await expandedTile(window).getByRole('button', { name: 'Delete agent' }).click();
    const deleting = window.getByRole('alertdialog', { name: 'Delete agent?' });
    await expect(deleting).toContainText('worktree and branch are removed');
    await deleting.getByRole('button', { name: 'Cancel' }).click();
    await expect(deleting).toHaveCount(0);
    await expect(expandedTile(window)).toBeVisible();

    // It is part of the board: zooming scales it, terminal and all, and dragging its header moves it.
    const before = await settledBox(expandedTile(window));
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    const zoomed = await settledBox(expandedTile(window));
    expect(zoomed.width).toBeLessThan(before.width);
    await expect(expandedScreen(window)).toContainText('Going with SQLite.');
    const header = expandedTile(window).locator('.session-window-head');
    const grip = await settledBox(header);
    const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(from.x + 40, from.y + 20, { steps: 8 });
    await window.mouse.move(from.x + 80, from.y + 40, { steps: 8 });
    await window.mouse.up();
    const moved = await settledBox(expandedTile(window));
    expect(moved.x - zoomed.x).toBeCloseTo(80, -1);
    expect(moved.y - zoomed.y).toBeCloseTo(40, -1);
    await expect(expandedTile(window)).toBeVisible();

    // Its bottom-right corner resizes it, and it keeps that size while expanded, saved for the next run.
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    const sized = await settledBox(expandedTile(window));
    const corner = await settledBox(bottomRight(window));
    await window.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await window.mouse.down();
    await window.mouse.move(corner.x + 40, corner.y + 30, { steps: 6 });
    await window.mouse.move(corner.x + 80, corner.y + 60, { steps: 6 });
    await window.mouse.up();
    const resized = await settledBox(expandedTile(window));
    // Give or take the few pixels the pointer moves before the resize takes hold.
    expect([Math.abs(resized.width - sized.width - 80) < 15, Math.abs(resized.height - sized.height - 60) < 15]).toEqual([true, true]);
    const width = await boardWidthOf(window);
    expect(width).toBeGreaterThan(EXPANDED_WIDTH);
    await expect.poll(() => savedExpanded(window)).toContain(`"width":${width}`);

    // Collapse returns it to its tile; the terminal detaches and the session keeps running.
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await expect(tile(window)).toBeVisible();
    await expect(terminals(window)).toHaveCount(0);

    // Expanded again, it attaches afresh, with what was there, at the size it was let go at.
    await tile(window).dblclick();
    await expect(expandedScreen(window)).toContainText('Going with SQLite.');
    expect(await boardWidthOf(window)).toBe(width);
    // Esc with the board focused collapses it.
    await header.click();
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toHaveCount(0);
    // A click on bare board leaves it expanded: it collapses only when told to.
    await tile(window).dblclick();
    await expect(expandedTile(window)).toBeVisible();
    // Left of the zone: an expanded tile opens rightwards, and the islands sit in the corners.
    const zone = await settledBox(window.getByTestId('zone'));
    await window.mouse.click(zone.x - 60, zone.y + 60);
    await expect(expandedTile(window)).toHaveCount(1);

    // Maximise opens its session window, and the tile goes back to compact: one terminal at a time.
    const sizeBefore = await settledBox(expandedTile(window));
    await expandedTile(window).getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(expandedTile(window)).toHaveCount(0);
    await expect(terminals(window)).toHaveCount(1);
    if (simplified) {
      // The Simplified design has no dock: Done closes the window, giving the tile back as it was, expanded at the same size.
      await window.getByRole('button', { name: 'Done, close Pick a database' }).click();
    } else {
      // Minimise still docks it.
      await window.getByRole('button', { name: 'Minimise session window' }).click();
      await expect(window.getByTestId('dock-item')).toHaveAttribute('data-placement', 'docked');
      // Docked, it stays compact; closing the window gives the tile back as it was, expanded at the same size.
      await expect(expandedTile(window)).toHaveCount(0);
      await window.getByTestId('dock-item').getByRole('button', { name: 'Close Pick a database' }).click();
    }
    await expect(expandedTile(window)).toHaveCount(1);
    await expect(tile(window)).toHaveCount(0);
    const sizeAfter = await settledBox(expandedTile(window));
    expect([sizeAfter.width, sizeAfter.height]).toEqual([sizeBefore.width, sizeBefore.height]);

    // Pop out opens it in its own OS window, which pops back in.
    const [popped] = await Promise.all([app.waitForEvent('window'), expandedTile(window).getByRole('button', { name: 'Pop out' }).click()]);
    await expect(sessionWindow(popped)).toHaveAttribute('data-state', 'attached');
    // Classic opens it on its terminal; the Simplified design on its chat.
    if (simplified) await expect(popped.getByText('Going with SQLite.').first()).toBeVisible();
    else await expect(popped.getByTestId('session-terminal').locator('.xterm-rows')).toContainText('Going with SQLite.');
    await expect(expandedTile(window)).toHaveCount(0);
    // A click on its tile meanwhile goes to that window (brought forward) rather than opening a second terminal here.
    await tile(window).dblclick();
    await expect(expandedTile(window)).toHaveCount(0);
    if (simplified) {
      // Back to board is in its header's ⋯ under the Simplified design, and Done closes the window it comes back to.
      await popped.locator('.session-window-head').getByRole('button', { name: 'More', exact: true }).click();
      await clickClosing(popped, popped.getByRole('menuitem', { name: 'Back to board' }));
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Done, close Pick a database' }).click();
    } else {
      await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
    }
    await expect(expandedTile(window)).toHaveCount(1);
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);

    // A single click only selects the compact tile; the double-click expands it, the view following if it would open
    // past the window's edge.
    await window.getByRole('button', { name: 'Fit View' }).click();
    const compact = await settledBox(tile(window));
    const at = { x: compact.x + compact.width / 2, y: compact.y + compact.height / 2 };
    await window.mouse.click(at.x, at.y);
    await expect(expandedTile(window)).toHaveCount(0);
    await window.mouse.click(at.x, at.y, { clickCount: 2 });
    await expect(expandedTile(window)).toBeVisible();
    await expect(sessionWindow(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell tile expands in place with its two panes, each taking input, and keeps them through collapse, maximise and pop out', async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    const shellTile = window.getByTestId('shell-tile');
    await expect(terminals(window)).toHaveCount(0);

    await shellTile.dblclick();
    await expect(expandedTile(window)).toBeVisible();
    const panes = expandedTile(window).getByTestId('shell-pane');
    await expect(panes).toHaveCount(1);
    await panes.first().click();
    await run(window, 'echo first-$((20 + 1))');
    await expect(panes.first()).toContainText('first-21');

    // Split from the expanded tile's controls: the new pane has the keyboard once clicked.
    await expandedTile(window).getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Split horizontally' }).click();
    await expect(panes).toHaveCount(2);
    await panes.nth(1).click();
    await run(window, 'echo second-$((40 + 2))');
    await expect(panes.nth(1)).toContainText('second-42');
    await expect(panes.first()).not.toContainText('second-42');

    // + › Web… in the expanded tile opens a blank tab with its address bar focused, though the tile expanding gave the keyboard away.
    await expandedTile(window).getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: /^Web…/ }).click();
    await expect(expandedTile(window).getByTestId('web-address')).toBeFocused();
    await expandedTile(window).getByRole('button', { name: 'Close New tab' }).click();
    await expect(panes).toHaveCount(2);

    // Collapsed, it attaches nothing; expanded again, both panes come back with what they had.
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(terminals(window)).toHaveCount(0);
    await expect(window.getByTestId('shell-tile-panes')).toHaveText('2 panes');
    await shellTile.dblclick();
    await expect(panes).toHaveCount(2);
    await expect(panes.first()).toContainText('first-21');
    await expect(panes.nth(1)).toContainText('second-42');

    // Maximised, the session window has both panes.
    const shellSizeBefore = await settledBox(expandedTile(window));
    await expandedTile(window).getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window).getByTestId('shell-pane')).toHaveCount(2);
    await expect(expandedTile(window)).toHaveCount(0);
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(panes).toHaveCount(2);
    const shellSizeAfter = await settledBox(expandedTile(window));
    expect([shellSizeAfter.width, shellSizeAfter.height]).toEqual([shellSizeBefore.width, shellSizeBefore.height]);

    // Popped out from the expanded tile, its own window has both panes too.
    const [popped] = await Promise.all([app.waitForEvent('window'), expandedTile(window).getByRole('button', { name: 'Pop out' }).click()]);
    await expect(popped.getByTestId('shell-pane')).toHaveCount(2);
    await expect(popped.getByTestId('shell-pane').nth(1)).toContainText('second-42');
    await expect(expandedTile(window)).toHaveCount(0);
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    await expect(sessionWindow(window).getByTestId('shell-pane')).toHaveCount(2);
    await window.getByRole('button', { name: 'Close session window' }).click();

    // Left expanded when the app quits, it opens expanded again, its panes attached afresh.
    await expect(panes).toHaveCount(2);
    await expect.poll(() => savedExpanded(window)).toContain('shell:');
    await app.close();
    ({ app, window } = await launch(dataDir, SHELL_ENV));
    await expect(expandedTile(window).getByTestId('shell-pane')).toHaveCount(2);
    await expect(expandedTile(window).getByTestId('shell-pane').nth(1)).toContainText('second-42');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('several tiles expand at once, the last one clicked in front, and Esc collapses them one at a time, front first', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    for (let made = 1; made <= 2; made++) {
      // Each where it is put, side by side.
      await placeWithTool(window, 'New shell', { x: 240 + (made - 1) * 400, y: 240 });
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(window.getByTestId('shell-tile')).toHaveCount(made);
    }
    // Zoomed out, so neither expanded tile moves the view, and the second tile stays clear of the first one's.
    for (let step = 0; step < 3; step++) await window.getByRole('button', { name: 'Zoom Out' }).click();
    const tiles = window.getByTestId('shell-tile');
    const boxes = [await settledBox(tiles.nth(0)), await settledBox(tiles.nth(1))];
    // An expanded tile opens rightwards and down from its tile: the one further right or down first.
    const order = boxes[0]!.x + boxes[0]!.y >= boxes[1]!.x + boxes[1]!.y ? [0, 1] : [1, 0];
    const ids = [await tiles.nth(order[0]!).getAttribute('data-shell-id'), await tiles.nth(order[1]!).getAttribute('data-shell-id')];
    const shellTile = (shellId: string | null) => window.locator(`[data-testid="shell-tile"][data-shell-id="${shellId}"]`);
    await shellTile(ids[0]!).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    await shellTile(ids[1]!).dblclick();
    await expect(expandedTile(window)).toHaveCount(2);

    // The one expanded last draws over the other.
    const zOf = (shellId: string | null) =>
      window
        .locator('.react-flow__node')
        .filter({ has: window.locator(`[data-testid="expanded-tile"][data-shell-id="${shellId}"]`) })
        .evaluate((node) => Number(getComputedStyle(node).zIndex));
    expect(await zOf(ids[1]!)).toBeGreaterThan(await zOf(ids[0]!));

    // Esc collapses the one in front, then the other.
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toHaveCount(1);
    await expect(expandedTile(window)).toHaveAttribute('data-shell-id', ids[0]!);
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toHaveCount(0);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('dragging across a word in an expanded tile selects exactly that word, zoomed out and in', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await setClickOpens(window, 'Expand in place');
    await addRepoZone(window, app, repo);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
    await tile(window).dblclick();
    await expect(expandedScreen(window)).toContainText('Which database should I use');

    const scales: number[] = [];
    const selectsWord = async () => scales.push(await dragSelectWord(window, expandedScreen(window), 'database'));

    await zoomTo(window, 'Zoom Out', (scale) => scale < 0.8);
    await selectsWord();
    await zoomTo(window, 'Zoom In', (scale) => scale > 0.95 && scale < 1.05);
    await selectsWord();
    await zoomTo(window, 'Zoom In', (scale) => scale > 1.4);
    await selectsWord();
    expect(scales[0]).toBeLessThan(0.8);
    expect(scales[2]).toBeGreaterThan(1.4);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dragging across a word in an expanded shell tile\'s pane selects exactly that word, zoomed out and in', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await newShell(window);
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.getByTestId('shell-tile').dblclick();
    await expandedTile(window).getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Split horizontally' }).click();
    const panes = expandedTile(window).getByTestId('shell-pane');
    await expect(panes).toHaveCount(2);
    await panes.nth(1).click();
    await run(window, 'echo before-$((20 + 1))-after');
    await expect(panes.nth(1)).toContainText('before-21-after');
    const screen = panes.nth(1).locator('.xterm-rows');

    await zoomTo(window, 'Zoom Out', (scale) => scale < 0.8);
    expect(await dragSelectWord(window, screen, 'before-21-after')).toBeLessThan(0.8);
    await zoomTo(window, 'Zoom In', (scale) => scale > 1.4);
    expect(await dragSelectWord(window, screen, 'before-21-after')).toBeGreaterThan(1.4);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('an expanded tile pushes its neighbours clear, and they go back to exactly where they were when it collapses, the stored layout unchanged', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    // A tile with neighbours close on its left, on its right and below it.
    const spots = [
      { x: 520, y: 220 },
      { x: 200, y: 220 },
      { x: 840, y: 220 },
      { x: 520, y: 460 },
    ];
    for (const [made, at] of spots.entries()) {
      await placeWithTool(window, 'New shell', at);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(window.getByTestId('shell-tile')).toHaveCount(made + 1);
    }
    const stored = async () => JSON.stringify(await storedShellPlaces(window));
    /** Each tile's rect on the board, unscaled by the zoom, by node id: where React Flow draws its node. */
    const drawn = () =>
      window.locator('.react-flow__node-tile').evaluateAll((nodes) =>
        Object.fromEntries(
          nodes.map((node) => {
            const element = node as HTMLElement;
            const [x, y] = element.style.transform.match(/-?[\d.]+/g)!.map(Number);
            return [element.dataset.id!, { x: x!, y: y!, width: element.offsetWidth, height: element.offsetHeight }];
          }),
        ),
      );
    const before = await drawn();
    const layout = await stored();
    // Which is which, by where they were put.
    const ids = Object.keys(before).toSorted((a, b) => before[a]!.y - before[b]!.y || before[a]!.x - before[b]!.x);
    const [left, middle, right] = ids.slice(0, 3);
    const below = ids[3]!;
    expect(before[left!]!.x).toBeLessThan(before[middle!]!.x);

    await window.locator(`.react-flow__node[data-id="${middle}"]`).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    await expect.poll(async () => (await drawn())[middle!]!.width).toBeGreaterThan(before[middle!]!.width);
    await viewSettled(window);
    const during = await drawn();
    const open = during[middle!]!;
    const clear = (rect: { x: number; y: number; width: number; height: number }) =>
      rect.x >= open.x + open.width || rect.x + rect.width <= open.x || rect.y >= open.y + open.height || rect.y + rect.height <= open.y;
    for (const id of [left!, right!, below]) expect(clear(during[id]!), id).toBe(true);
    // The ones it would have covered moved; the one it doesn't reach stayed put.
    expect(during[right!]).not.toEqual(before[right!]);
    expect(during[below]).not.toEqual(before[below]);
    expect(during[left!]).toEqual(before[left!]);
    // Only drawn there: what is stored is as it was.
    expect(await stored()).toBe(layout);

    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await expect.poll(drawn).toEqual(before);
    expect(await stored()).toBe(layout);

    // Nudged with an arrow key while pushed aside, a tile moves from where it is drawn, and stays there once the other
    // collapses.
    await window.locator(`.react-flow__node[data-id="${middle}"]`).dblclick();
    await expect.poll(async () => (await drawn())[right!]!).toEqual(during[right!]);
    await viewSettled(window);
    const rightNode = window.locator(`.react-flow__node[data-id="${right}"]`);
    await rightNode.focus();
    await window.keyboard.press('ArrowRight');
    const rightId = right!.slice('shell:'.length);
    await expect
      .poll(async () => (await storedShellPlaces(window)).find(([id]) => id === rightId)![1])
      .toMatchObject({ x: during[right!]!.x + 1, y: during[right!]!.y });
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await expect.poll(async () => (await drawn())[right!]).toMatchObject({ x: during[right!]!.x + 1, y: during[right!]!.y });

    // Dragged while pushed aside (further from the expanded tile, so it stays clear), a tile stays where it is dropped
    // once the other collapses.
    await window.locator(`.react-flow__node[data-id="${middle}"]`).dblclick();
    await expect.poll(async () => (await drawn())[below]!).not.toEqual(before[below]);
    // All of it in view: pushed aside, it may be past the edge the view has followed the expanded tile from.
    await viewSettled(window);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await viewSettled(window);
    const belowNode = window.locator(`.react-flow__node[data-id="${below}"]`);
    // Done easing aside, so it is grabbed where it ends up.
    await expect.poll(() => belowNode.evaluate((node) => node.getAnimations().length)).toBe(0);
    const pushed = (await belowNode.boundingBox())!;
    await window.mouse.move(pushed.x + pushed.width / 2, pushed.y + pushed.height / 2);
    await window.mouse.down();
    await window.mouse.move(pushed.x + pushed.width / 2, pushed.y + pushed.height / 2 + 120, { steps: 10 });
    await window.mouse.up();
    await expect.poll(stored).not.toBe(layout);
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    // Where it was dropped, below where it was pushed to: stored, and drawn there.
    const shellId = below.slice('shell:'.length);
    const kept = (await storedShellPlaces(window)).find(([id]) => id === shellId)![1]!;
    expect(kept.y).toBeGreaterThan(during[below]!.y);
    // As drawn, which React Flow writes into the transform to three decimals: compared to two.
    const near = (n: number) => Math.round(n * 100) / 100;
    await expect
      .poll(async () => {
        const at = (await drawn())[below]!;
        return { x: near(at.x), y: near(at.y) };
      })
      .toEqual({ x: near(kept.x), y: near(kept.y) });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("an expanded tile in a zone grows the zone to hold it, rearranges the zone's other tiles clear within it, and both go back exactly on collapse", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    const zone = await zoneWithShells(window, 'Ideas', 3);
    const stored = async () => JSON.stringify([await storedShellPlaces(window), await storedZoneLayouts(window)]);
    const layout = await stored();
    const before = await zoneRect(zone);
    const ids = (await storedShellPlaces(window)).map(([id]) => id);
    const drawnTiles = () => Promise.all(ids.map((id) => nodeRect(shellNode(window, id))));
    const home = await drawnTiles();
    // The first in reading order: top left.
    const first = ids.toSorted((a, b) => home[ids.indexOf(a)]!.y - home[ids.indexOf(b)]!.y || home[ids.indexOf(a)]!.x - home[ids.indexOf(b)]!.x)[0]!;

    await window.locator(`.react-flow__node[data-id="shell:${first}"]`).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    // The zone grows to hold the expanded tile and every other tile, which go clear of it: only as drawn.
    await expect.poll(async () => holds(await zoneRect(zone), await nodeRect(shellNode(window, first)))).toBe(true);
    await expect
      .poll(async () => (await Promise.all(ids.map(async (id) => holds(await zoneRect(zone), await nodeRect(shellNode(window, id)))))).every(Boolean))
      .toBe(true);
    const open = await nodeRect(shellNode(window, first));
    const grown = await zoneRect(zone);
    for (const id of ids.filter((id) => id !== first)) {
      const rect = await nodeRect(shellNode(window, id));
      expect(holds(grown, rect), id).toBe(true);
      const clear = rect.x >= open.x + open.width || rect.x + rect.width <= open.x || rect.y >= open.y + open.height || rect.y + rect.height <= open.y;
      expect(clear, id).toBe(true);
    }
    expect(await stored()).toBe(layout);

    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await expect.poll(() => zoneRect(zone)).toEqual(before);
    await expect.poll(drawnTiles).toEqual(home);
    expect(await stored()).toBe(layout);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

for (const loose of [false, true]) {
  test(`expanding the centre tile of a ${loose ? 'loose' : "zone's"} 3×3 grid pushes the tiles right of it right and the rows below it down, as blocks, and collapsing puts them back`, async () => {
    const dataDir = tempDataDir();
    const { app, window } = await launch(dataDir, SHELL_ENV);
    try {
      await setClickOpens(window, 'Expand in place');
      if (!loose) await addEmptyZone(window, 'Grid');
      // A1 B1 C1 / A2 B2 C2 / A3 B3 C3, a tile gap apart, the room above each for its subagents.
      const cells = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'] as const;
      const STEP = { x: 256 + 16, y: 24 + 136 + 16 };
      const ids = await shellsAt(
        window,
        cells.map((cell) => ({ x: 20 + 'ABC'.indexOf(cell[0]!) * STEP.x, y: 44 + (Number(cell[1]) - 1) * STEP.y })),
        loose,
      );
      await expect(window.getByTestId('shell-tile')).toHaveCount(9);
      const idOf = (cell: (typeof cells)[number]) => ids[cells.indexOf(cell)]!;
      const drawn = async () =>
        Object.fromEntries(await Promise.all(cells.map(async (cell) => [cell, await nodeRect(shellNode(window, idOf(cell)))] as const))) as Record<(typeof cells)[number], Rect>;
      const stored = async () => JSON.stringify([await storedShellPlaces(window), await storedZoneLayouts(window)]);
      await expect.poll(async () => (await drawn()).C3.y - (await drawn()).A1.y).toBe(2 * STEP.y);
      const home = await drawn();
      const layout = await stored();

      await shellNode(window, idOf('B2')).dblclick();
      await expect(expandedTile(window)).toHaveCount(1);
      await expect.poll(async () => (await drawn()).B2.width).toBeGreaterThan(home.B2.width);
      const open = (await drawn()).B2;
      const grew = { x: open.width - home.B2.width, y: open.height - home.B2.height };
      // Right of it, in every row but those below it: by the width it grew. The rows below it: whole rows, by the
      // height it grew, and C3 does not also move right. The rest stay.
      await expect
        .poll(async () => {
          const now = await drawn();
          return Object.fromEntries(cells.map((cell) => [cell, { dx: now[cell].x - home[cell].x, dy: now[cell].y - home[cell].y }]));
        })
        .toEqual({
          A1: { dx: 0, dy: 0 },
          B1: { dx: 0, dy: 0 },
          C1: { dx: grew.x, dy: 0 },
          A2: { dx: 0, dy: 0 },
          B2: { dx: 0, dy: 0 },
          C2: { dx: grew.x, dy: 0 },
          A3: { dx: 0, dy: grew.y },
          B3: { dx: 0, dy: grew.y },
          C3: { dx: 0, dy: grew.y },
        });
      expect(await stored()).toBe(layout);

      await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
      await expect(expandedTile(window)).toHaveCount(0);
      await expect.poll(drawn).toEqual(home);
      expect(await stored()).toBe(layout);
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}

test("Tidy with a tile expanded lays the zone out round its expanded size, and expanding or collapsing it then moves nothing more", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    const zone = await zoneWithShells(window, 'Grid', 4);
    const ids = (await storedShellPlaces(window)).map(([id]) => id);
    await shellNode(window, ids[0]!).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    // The view follows a tile that opened past the edge, and where it stops the zone's chip can be off screen or under
    // the top chrome: wait for it to stop, then frame the zone on purpose (fitted, then a step out so its tab clears the
    // panels over the board) before pressing the chip.
    await viewSettled(window);
    await window.getByRole('button', { name: /^Fit view/ }).click();
    await viewSettled(window);
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await viewSettled(window);
    await zone.getByRole('button', { name: 'Tidy zone' }).click();
    // The board draws only the tiles in view, and Tidy may put some below the expanded one, past the window's edge.
    await window.getByRole('button', { name: /^Fit view/ }).click();
    const drawn = () => Promise.all(ids.map((id) => nodeRect(shellNode(window, id))));
    const apart = (rects: Rect[]) =>
      rects.every((a, i) => rects.every((b, j) => i === j || a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height));
    await expect.poll(async () => apart(await drawn())).toBe(true);
    // The layout was made for the expanded size, so nothing is pushed on top of it: the stored places are the drawn ones.
    const stored = async () => (await storedShellPlaces(window)).map(([id, place]) => [id, place!.x, place!.y]);
    const drawnAfter = await drawn();
    const places = await stored();
    for (const [index, id] of ids.entries()) {
      const place = places.find(([each]) => each === id)!;
      expect(drawnAfter[index]!.x - (await zoneRect(zone)).x).toBe(place[1]);
    }
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await shellNode(window, ids[0]!).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    await expect.poll(drawn).toEqual(drawnAfter);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test("an expanded tile in a zone resized by its corner grows the zone and moves the zone's other tiles as it is dragged, and remembers its size", async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    const zone = await zoneWithShells(window, 'Ideas', 2);
    const ids = (await storedShellPlaces(window)).map(([id]) => id);
    const rects = await Promise.all(ids.map((id) => nodeRect(shellNode(window, id))));
    const [first, other] = rects[0]!.x <= rects[1]!.x ? [ids[0]!, ids[1]!] : [ids[1]!, ids[0]!];

    await shellNode(window, first).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    await expect.poll(async () => holds(await zoneRect(zone), await nodeRect(shellNode(window, first)))).toBe(true);
    // All of it in view, with room for it to grow: only what is in view is drawn.
    await window.getByRole('button', { name: 'Fit View' }).click();
    for (let i = 0; i < 2; i++) await window.getByRole('button', { name: 'Zoom Out' }).click();
    // Done easing aside, so what moves next moves for the resize.
    await expect.poll(() => shellNode(window, other).evaluate((node) => node.getAnimations().length)).toBe(0);
    const zoneBefore = await zoneRect(zone);
    const otherBefore = await nodeRect(shellNode(window, other));

    const corner = await settledBox(bottomRight(window));
    await window.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await window.mouse.down();
    await window.mouse.move(corner.x + 60, corner.y + 50, { steps: 6 });
    await window.mouse.move(corner.x + 120, corner.y + 100, { steps: 6 });
    // Still held: the zone has grown, and the other tile, pushed clear of the expanded one, has moved on with the corner.
    await expect.poll(async () => (await zoneRect(zone)).width).toBeGreaterThan(zoneBefore.width);
    await expect.poll(() => nodeRect(shellNode(window, other))).not.toEqual(otherBefore);
    await expect
      .poll(async () => {
        const [held, moved, grown] = await Promise.all([nodeRect(shellNode(window, first)), nodeRect(shellNode(window, other)), zoneRect(zone)]);
        return { holds: holds(grown, held) && holds(grown, moved), clear: moved.x >= held.x + held.width || moved.y >= held.y + held.height };
      })
      .toEqual({ holds: true, clear: true });
    await window.mouse.up();
    const width = await boardWidthOf(window);
    expect(width).toBeGreaterThan(EXPANDED_WIDTH);

    // Collapsed and expanded again, it opens at the size it was let go at.
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await shellNode(window, first).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    expect(await boardWidthOf(window)).toBe(width);

    // And after a restart.
    await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    // Saved a moment after it changes.
    await expect.poll(() => savedSizes(window)).toContain(`"width":${width}`);
    await app.close();
    ({ app, window } = await launch(dataDir, SHELL_ENV));
    await window.getByRole('button', { name: 'Fit View' }).click();
    await shellNode(window, first).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    expect(await boardWidthOf(window)).toBe(width);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Tidy lays a messy zone out in rows in reading order, fitting the zone to them, and undo puts it back', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    const zone = await zoneWithShells(window, 'Ideas', 3);
    // Scattered about the zone.
    const ids = (await storedShellPlaces(window)).map(([id]) => id);
    const messy = [
      { x: 400, y: 380 },
      { x: 30, y: 300 },
      { x: 420, y: 60 },
    ];
    await scatter(window, ids, messy);
    const origin = await zoneRect(zone);
    await expect.poll(() => nodeRect(shellNode(window, ids[0]!))).toMatchObject({ x: origin.x + messy[0]!.x, y: origin.y + messy[0]!.y });
    const stored = async () => JSON.stringify([await storedShellPlaces(window), await storedZoneLayouts(window)]);
    const before = await stored();
    const zoneBefore = await zoneRect(zone);

    await zone.getByRole('button', { name: 'Tidy zone' }).click();
    // In reading order: the top one, then the one on the left, then the one below on the right; the zone keeps its
    // width and fits its height to one row of two and a second row, at a new zone's spacing (roomy).
    const { padding: PADDING, tile: GAP, lane: LANE } = SPACING_GAPS.roomy;
    const PERCH = 24;
    const STEP = { x: 256 + GAP, y: 136 + LANE };
    const slot = (index: number) => ({ x: PADDING + (index % 2) * STEP.x, y: PADDING + PERCH + Math.floor(index / 2) * STEP.y });
    await expect
      .poll(async () => Object.fromEntries((await storedShellPlaces(window)).map(([id, place]) => [id, { x: place!.x, y: place!.y }])))
      .toEqual({ [ids[2]!]: slot(0), [ids[1]!]: slot(1), [ids[0]!]: slot(2) });
    await expect.poll(async () => (await storedZoneLayouts(window))[0]).toMatchObject({ width: zoneBefore.width });
    expect((await storedZoneLayouts(window))[0]!.height).toBe(slot(2).y + 136 + GAP + PADDING);

    // One undo puts the tiles and the zone back.
    await window.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(stored).toBe(before);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/** The board's zoom, read off the expanded tile: its on-screen width over its width on the board. */
const tileScale = async (page: Page) => (await settledBox(expandedTile(page))).width / (await boardWidthOf(page));

test("an expanded tile resized from its top-left corner moves its top-left, saved in its zone's terms and undone in one step, and from an edge only grows", async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    const zone = await zoneWithShells(window, 'Ideas', 2);
    // One tile well off the zone's padding, the other in the first slot, where the expanded one will grow over it.
    const ids = (await storedShellPlaces(window)).map(([id]) => id);
    const [open, other] = ids as [string, string];
    const start = { x: 400, y: 300 };
    await scatter(window, [open, other], [start, { x: 20, y: 44 }]);
    const origin = await zoneRect(zone);
    await expect.poll(() => nodeRect(shellNode(window, open))).toMatchObject({ x: origin.x + start.x, y: origin.y + start.y });
    const storedPlace = async (id: string) => (await storedShellPlaces(window)).find(([known]) => known === id)![1]!;

    await shellNode(window, open).dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    await window.getByRole('button', { name: 'Fit View' }).click();
    for (let i = 0; i < 2; i++) await window.getByRole('button', { name: 'Zoom Out' }).click();
    await expect.poll(() => shellNode(window, other).evaluate((node) => node.getAnimations().length)).toBe(0);
    const otherBefore = await nodeRect(shellNode(window, other));
    const scale = await tileScale(window);

    // Up and left by 150 board px: over the other tile, which moves clear while the corner is held.
    const corner = await settledBox(expandedTile(window).locator('.expanded-tile-resize.top.left'));
    const from = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
    const by = { x: -150 * scale, y: -150 * scale };
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 6 });
    await window.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
    await expect.poll(() => nodeRect(shellNode(window, other))).not.toEqual(otherBefore);
    await window.mouse.up();

    // Saved relative to the zone, by the drag (give or take the pixel the pointer moves before the resize takes hold),
    // and drawn there.
    await expect.poll(async () => (await storedPlace(open)).x).toBeLessThan(start.x - 100);
    const moved = await storedPlace(open);
    expect(Math.abs(moved.x - (start.x - 150))).toBeLessThan(6);
    expect(Math.abs(moved.y - (start.y - 150))).toBeLessThan(6);
    const drawn = await nodeRect(shellNode(window, open));
    const zoneNow = await zoneRect(zone);
    expect(Math.abs(drawn.x - zoneNow.x - moved.x)).toBeLessThan(0.01);
    expect(Math.abs(drawn.y - zoneNow.y - moved.y)).toBeLessThan(0.01);
    // Grown the other way too, by as much.
    expect(Math.abs((await boardWidthOf(window)) - EXPANDED_WIDTH - (start.x - moved.x))).toBeLessThan(0.01);

    // One undo puts its place back.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedPlace(open)).toMatchObject(start);

    // Its right edge widens it and leaves its place alone.
    const placeNow = await storedPlace(open);
    const widthNow = await boardWidthOf(window);
    const edge = await settledBox(expandedTile(window).locator('.expanded-tile-resize.line.right'));
    const at = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
    await window.mouse.move(at.x, at.y);
    await window.mouse.down();
    await window.mouse.move(at.x + 40 * scale, at.y, { steps: 6 });
    await window.mouse.move(at.x + 80 * scale, at.y, { steps: 6 });
    await window.mouse.up();
    await expect.poll(() => boardWidthOf(window)).toBeGreaterThan(widthNow + 60);
    expect(await storedPlace(open)).toEqual(placeNow);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('Tidy loose tiles lays the tiles loose on the board out in a grid where they are, and undo puts them back', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    // Two on one row, one below; the first clear of the empty board's welcome in the middle.
    for (const [made, at] of [
      { x: 200, y: 220 },
      { x: 840, y: 220 },
      { x: 520, y: 460 },
    ].entries()) {
      await placeWithTool(window, 'New shell', at);
      await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
      await window.getByRole('button', { name: 'Close session window' }).click();
      await expect(window.getByTestId('shell-tile')).toHaveCount(made + 1);
    }
    const places = async () => Object.fromEntries((await storedShellPlaces(window)).map(([id, place]) => [id, { x: place!.x, y: place!.y }]));
    const before = await places();
    const ids = Object.keys(before);
    // In reading order: the row of two, left to right, then the one below.
    const order = ids.toSorted((a, b) => before[a]!.y - before[b]!.y || before[a]!.x - before[b]!.x);
    const origin = { x: Math.min(...ids.map((id) => before[id]!.x)), y: Math.min(...ids.map((id) => before[id]!.y)) };
    const STEP = { x: 256 + 16, y: 24 + 136 + 16 };

    await window.locator('.react-flow__pane').click({ button: 'right', position: { x: 60, y: 600 } });
    await window.getByRole('menuitem', { name: 'Tidy loose tiles' }).click();
    await expect.poll(places).toEqual({
      [order[0]!]: origin,
      [order[1]!]: { x: origin.x + STEP.x, y: origin.y },
      [order[2]!]: { x: origin.x, y: origin.y + STEP.y },
    });

    await window.locator('.react-flow__pane').click({ position: { x: 60, y: 600 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(places).toEqual(before);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a zone grown round an expanded tile still resizes, from the size it is drawn at, and saves the size it is let go at', async () => {
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    const zone = await zoneWithShells(window, 'Ideas', 1);
    await window.getByTestId('shell-tile').dblclick();
    await expect(expandedTile(window)).toHaveCount(1);
    await expect.poll(async () => holds(await zoneRect(zone), await nodeRect(window.locator('.react-flow__node-tile')))).toBe(true);
    await viewSettled(window);
    // Done growing: the same size twice running.
    let last = '';
    await expect
      .poll(async () => {
        const now = JSON.stringify(await zoneRect(zone));
        const same = now === last;
        last = now;
        return same;
      })
      .toBe(true);
    const grown: Rect = JSON.parse(last);
    // Selected with everything else, so the zone shows its handles.
    await window.keyboard.press('ControlOrMeta+a');
    await viewSettled(window);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await viewSettled(window);
    await expect(expandedTile(window)).toHaveCount(1);

    const edge = await settledBox(zone.locator('.react-flow__resize-control.line.right'));
    const scale = (await settledBox(zone)).width / grown.width;
    const at = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
    await window.mouse.move(at.x, at.y);
    await window.mouse.down();
    await window.mouse.move(at.x + 50 * scale, at.y, { steps: 6 });
    await window.mouse.move(at.x + 100 * scale, at.y, { steps: 6 });
    await window.mouse.up();
    // Wider than it was drawn, by the drag (give or take the pointer's first pixels), and as tall as it was drawn.
    await expect.poll(async () => (await storedZoneLayouts(window))[0]!.width).toBeGreaterThan(grown.width + 80);
    expect((await storedZoneLayouts(window))[0]!.height).toBe(grown.height);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('two tiles expanded in a zone stay apart and expanded, through clicks elsewhere, a session window and a restart; one dragged onto the other stays there; Delete on one asks first', async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    await setClickOpens(window, 'Expand in place');
    await zoneWithShells(window, 'Ideas', 3);
    // Found afresh each time: the window is a new one after the restart.
    const zone = () => window.getByTestId('zone');
    const places = await storedShellPlaces(window);
    // The first two in reading order expand; the third opens its session window.
    const [a, b, c] = places.toSorted(([, p], [, q]) => p!.y - q!.y || p!.x - q!.x).map(([id]) => id);
    const fitted = async () => {
      await viewSettled(window);
      await window.getByRole('button', { name: 'Fit View' }).click();
      await viewSettled(window);
      for (const id of [a!, b!, c!]) await settledBox(shellNode(window, id));
    };
    const expandedOf = (id: string) => window.locator(`[data-testid="expanded-tile"][data-shell-id="${id}"]`);
    const overlap = (p: Rect, q: Rect) => p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    /** The two expanded tiles, the third tile and the zone, as drawn. */
    const layout = async () => {
      const [ra, rb, rc] = await Promise.all([a!, b!, c!].map((id) => nodeRect(shellNode(window, id))));
      return { a: ra!, b: rb!, c: rc!, zone: await zoneRect(zone()) };
    };
    const expectApart = async () => {
      await expect
        .poll(async () => {
          const drawn = await layout();
          return {
            apart: !overlap(drawn.a, drawn.b) && !overlap(drawn.a, drawn.c) && !overlap(drawn.b, drawn.c),
            held: holds(drawn.zone, drawn.a) && holds(drawn.zone, drawn.b),
          };
        })
        .toEqual({ apart: true, held: true });
    };

    await shellNode(window, a!).dblclick();
    await expect(expandedOf(a!)).toHaveCount(1);
    await fitted();
    await shellNode(window, b!).dblclick();
    await expect(expandedTile(window)).toHaveCount(2);
    await fitted();
    await expectApart();

    // A click on bare board, or on the zone's floor, leaves both expanded.
    const zoneBox = await settledBox(zone());
    await window.mouse.click(zoneBox.x - 30, zoneBox.y + 30);
    await window.mouse.click(zoneBox.x + 8, zoneBox.y + zoneBox.height - 8);
    await expect(expandedTile(window)).toHaveCount(2);
    // So does the third tile's session window, opened and closed.
    await tileAction(window.locator(`[data-testid="shell-tile"][data-shell-id="${c}"]`), 'Open window');
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await expect(expandedTile(window)).toHaveCount(2);
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await expect(expandedTile(window)).toHaveCount(2);
    await fitted();
    await expectApart();
    const before = await layout();

    // After a restart, both are expanded again, laid out the same.
    await expect.poll(() => savedExpanded(window)).toContain(`shell:${b}`);
    expect(await savedExpanded(window)).toContain(`shell:${a}`);
    await app.close();
    ({ app, window } = await launch(dataDir, SHELL_ENV));
    await expect(expandedTile(window)).toHaveCount(2);
    await fitted();
    await expect.poll(layout).toEqual(before);

    // The one moved clear of the other, resized from its bottom-right, stays where it is drawn, and that place is saved.
    // Selected first, by its header, so it shows its handles.
    await expandedOf(b!).locator('.session-window-head-fill').click();
    const corner = await settledBox(expandedOf(b!).locator('.expanded-tile-resize.bottom.right'));
    await drag(window, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: corner.x + 60, y: corner.y + 40 }, { steps: 8 });
    const zoneAt = await zoneRect(zone());
    await expect.poll(async () => (await storedShellPlaces(window)).find(([id]) => id === b)![1]).toMatchObject({ x: before.b.x - zoneAt.x, y: before.b.y - zoneAt.y });
    await expect.poll(() => Promise.all([a!, b!, c!].map((id) => shellNode(window, id).evaluate((node) => node.getAnimations().length)))).toEqual([0, 0, 0]);
    const resized = await layout();
    expect({ x: resized.b.x, y: resized.b.y }).toEqual({ x: before.b.x, y: before.b.y });
    expect(resized.a).toEqual(before.a);

    // Dragged by its header onto the other, one stays there, over it, and neither is moved off.
    const head = await settledBox(expandedOf(b!).locator('.session-window-head-fill'));
    const target = await settledBox(expandedOf(a!));
    const grip = { x: head.x + head.width / 2, y: head.y + head.height / 2 };
    await drag(window, grip, { x: target.x + target.width / 2, y: target.y + 40 }, { steps: 16 });
    await expect.poll(() => savedOverlaps(window)).toBe(JSON.stringify([[`shell:${b}`, `shell:${a}`]]));
    // Still there once everything has finished easing to where it goes.
    const eased = () => Promise.all([a!, b!, c!].map((id) => shellNode(window, id).evaluate((node) => node.getAnimations().length)));
    await expect.poll(eased).toEqual([0, 0, 0]);
    const dropped = await layout();
    expect(overlap(dropped.a, dropped.b)).toBe(true);
    expect(await layout()).toEqual(dropped);

    // Delete on an expanded tile asks first, as its ⋯ menu does, then the tile goes and the rest close up round the other.
    await expandedOf(b!).getByRole('button', { name: 'Delete shell' }).click();
    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toContainText('still has running shells');
    await dialog.getByRole('button', { name: 'Delete anyway' }).click();
    await expect(expandedTile(window)).toHaveCount(1);
    await expect(window.getByTestId('shell-tile')).toHaveCount(1);
    await expect.poll(async () => (await storedShellPlaces(window)).map(([id]) => id).toSorted()).toEqual([a!, c!].toSorted());
    // The zone, grown to hold the deleted tile where it hung past the other, shrinks back round what is left.
    const area = ({ width, height }: Rect) => width * height;
    await expect.poll(async () => area(await zoneRect(zone()))).toBeLessThan(area(dropped.zone));
    await expect
      .poll(async () => {
        const [ra, rc] = await Promise.all([a!, c!].map((id) => nodeRect(shellNode(window, id))));
        return !overlap(ra!, rc!) && holds(await zoneRect(zone()), ra!) && holds(await zoneRect(zone()), rc!);
      })
      .toBe(true);
    // The pair went with it.
    await expect.poll(() => savedOverlaps(window)).toBe('[]');

    // An expanded tile dragged onto a compact one leaves it there, under it: both stay where they were dropped.
    await expect.poll(() => Promise.all([a!, c!].map((id) => shellNode(window, id).evaluate((node) => node.getAnimations().length)))).toEqual([0, 0]);
    const compact = await settledBox(shellNode(window, c!));
    const aHead = await settledBox(expandedOf(a!).locator('.session-window-head-fill'));
    const aBox = await settledBox(expandedOf(a!));
    // Its top-left onto the compact tile's middle.
    const to = { x: compact.x + compact.width / 2, y: compact.y + compact.height / 2 };
    const from = { x: aHead.x + aHead.width / 2, y: aHead.y + aHead.height / 2 };
    await drag(window, from, { x: to.x + (from.x - aBox.x), y: to.y + (from.y - aBox.y) }, { steps: 16 });
    await expect.poll(() => savedOverlaps(window)).toBe(JSON.stringify([[`shell:${a}`, `shell:${c}`]]));
    await expect.poll(() => Promise.all([a!, c!].map((id) => shellNode(window, id).evaluate((node) => node.getAnimations().length)))).toEqual([0, 0]);
    const [onTop, under] = await Promise.all([a!, c!].map((id) => nodeRect(shellNode(window, id))));
    expect(overlap(onTop!, under!)).toBe(true);
    expect((await storedShellPlaces(window)).find(([id]) => id === c)![1]).toMatchObject({ x: under!.x - (await zoneRect(zone())).x, y: under!.y - (await zoneRect(zone())).y });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

/**
 * Records, every frame until the returned function is called, where each agent tile is on screen less the view's pan:
 * the same frame to frame for a tile that stays put on the board, whatever the view does. Resolves to each frame.
 */
async function recordTilesOnBoard(page: Page): Promise<() => Promise<string[][]>> {
  await page.evaluate(() => {
    const record = window as unknown as { tileFrames: string[][]; recordingTiles: boolean };
    record.tileFrames = [];
    record.recordingTiles = true;
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
    const frame = () => {
      const { m41: panX, m42: panY } = new DOMMatrix(getComputedStyle(viewport).transform);
      record.tileFrames.push(
        [...document.querySelectorAll('[data-testid="agent-tile"]')].map((tile) => {
          const box = tile.getBoundingClientRect();
          return `${tile.getAttribute('data-session-id')} ${(box.x - panX).toFixed(1)},${(box.y - panY).toFixed(1)}`;
        }),
      );
      if (record.recordingTiles) requestAnimationFrame(frame);
    };
    frame();
  });
  return () =>
    page.evaluate(() => {
      const record = window as unknown as { tileFrames: string[][]; recordingTiles: boolean };
      record.recordingTiles = false;
      return record.tileFrames;
    });
}

/** Where the view is panned to. */
const panOf = (page: Page) =>
  page.locator('.react-flow__viewport').evaluate((viewport) => {
    const { m41: x, m42: y } = new DOMMatrix(getComputedStyle(viewport).transform);
    return { x, y };
  });

/** How many different layouts of the tiles `frames` show. */
const layoutsIn = (frames: string[][]) => new Set(frames.map((frame) => frame.join('\n'))).size;

test('tiles pushed clear of an expanded tile stay fixed to the board while it pans, and jump, never slide, when it moves', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    // Workers the daemon places beside their orchestrator, and a reviewer of one of them.
    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    await tileAction(tile(window).filter({ has: window.getByTitle('worker one', { exact: true }) }), 'Review its work');
    await expect(window.locator('[data-testid="agent-tile"][data-reviewer]')).toHaveCount(1);
    await tileAction(window.locator('[data-testid="agent-tile"][data-orchestrator]'), 'Expand in place');
    await expect(expandedTile(window)).toHaveCount(1);
    await viewSettled(window);
    // Its crew and the reviewer, pushed clear of it, done moving there.
    await expect.poll(() => window.locator('.react-flow__node-tile').evaluateAll((nodes) => nodes.flatMap((node) => node.getAnimations()).length)).toBe(0);
    // All of it in view, with board round it.
    await window.getByRole('button', { name: 'Fit View' }).click();
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await viewSettled(window);
    // They are pushed right of the expanded tile, past the edge of the view until it is fitted, so only now are all drawn.
    await expect(window.locator('.react-flow__node.displaced [data-testid="agent-tile"]')).toHaveCount(3);
    // The wheel over the board or the zone, clear of the tiles and the board's controls, pans it.
    const empty = await window.evaluate(() => {
      for (let y = innerHeight - 100; y > 100; y -= 20) {
        for (let x = 200; x < innerWidth - 200; x += 20) {
          const under = document.elementFromPoint(x, y);
          if (under?.classList.contains('react-flow__pane') || under?.matches('.react-flow__node-zone, .react-flow__node-zone > *')) return { x, y };
        }
      }
      throw new Error('no empty board in view');
    });
    await window.mouse.move(empty.x, empty.y);

    const before = await panOf(window);
    let stop = await recordTilesOnBoard(window);
    for (let step = 0; step < 6; step++) await window.mouse.wheel(30, 20);
    expect(layoutsIn(await stop()), 'every tile moved with the board').toBe(1);
    expect(await panOf(window)).not.toEqual(before);

    // Nudged while the board pans, the expanded tile pushes them on: each goes straight to its new place, as the board
    // pans, rather than sliding behind it.
    await window.locator('.react-flow__node').filter({ has: expandedTile(window) }).focus();
    stop = await recordTilesOnBoard(window);
    await window.keyboard.press('Shift+ArrowDown');
    for (let step = 0; step < 6; step++) {
      await window.mouse.wheel(-20, 10);
      await window.waitForTimeout(50);
    }
    // Longer than a tile could take to ease anywhere (--motion-base).
    await window.waitForTimeout(500);
    expect(layoutsIn(await stop()), 'each tile went from where it was to where it goes in one frame').toBe(2);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A box on screen. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the zone, its crew frame and each tile (by node id) are drawn on the board, whatever the view, with which agents
 * the frame holds. The view is fitted first: a tile out of view isn't drawn.
 */
async function crewLayout(page: Page): Promise<{ zone: Box; frame: Box; members: string[]; tiles: Record<string, Box> }> {
  await page.getByRole('button', { name: 'Fit View' }).click();
  await viewSettled(page);
  // Done moving and growing: no node, nor the frame, easing anywhere.
  await expect
    .poll(() => page.locator('.react-flow__node, [data-testid="crew-frame"]').evaluateAll((nodes) => nodes.flatMap((node) => node.getAnimations()).length))
    .toBe(0);
  return page.evaluate(() => {
    const flow = document.querySelector('.react-flow')!.getBoundingClientRect();
    const { a: scale, m41: panX, m42: panY } = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform);
    const box = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x: (x - flow.x - panX) / scale, y: (y - flow.y - panY) / scale, width: width / scale, height: height / scale };
    };
    const frame = document.querySelector('[data-testid="crew-frame"]')!;
    return {
      zone: box(document.querySelector('.react-flow__node-zone')!),
      frame: box(frame),
      members: frame.getAttribute('data-members')!.split(' '),
      tiles: Object.fromEntries([...document.querySelectorAll('.react-flow__node-tile')].map((node) => [node.getAttribute('data-id')!, box(node)])),
    };
  });
}

/** Whether `inner` lies inside `outer`, give or take a pixel. */
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;

/** Whether `a` and `b` share no place. */
const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** The same boxes, to the pixel. */
const rounded = (layout: Awaited<ReturnType<typeof crewLayout>>) =>
  JSON.stringify(layout, (_, value: unknown) => (typeof value === 'number' ? Math.round(value) : value));

test('an expanded tile reshapes its zone round a crew frame: the frame keeps its crew where they are drawn, a crew in the way moves as one, and collapsing puts it all back', async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Lead two: Fix the flaky test');
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await expect(tile(window)).toHaveCount(3, { timeout: 2 * TURN_MS });
    await newShell(window);
    await expect(sessionWindow(window)).toBeVisible();
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    // The lead with its crew stacked in a column beside it, and a shell, no part of the crew, above the crew.
    const lead = (await agents(window)).find((agent) => agent.spawnedBy === null)!;
    const crew = (await agents(window)).filter((agent) => agent.spawnedBy === lead.sessionId).toSorted((a, b) => a.name.localeCompare(b.name));
    const [zone] = await zones(window);
    await window.evaluate(
      async ({ zoneId, lead, crew }) => {
        const { agents, shells } = globalThis.window.agentBoard;
        await agents.move(lead, { zoneId, x: 40, y: 360 });
        await agents.move(crew[0]!, { zoneId, x: 336, y: 360 });
        await agents.move(crew[1]!, { zoneId, x: 336, y: 536 });
        const [shell] = await shells.list();
        await shells.move(shell!.id, { zoneId, x: 336, y: 40 });
      },
      { zoneId: zone!.id, lead: lead.sessionId, crew: crew.map((agent) => agent.sessionId) },
    );
    const crewIds = crew.map((agent) => `agent:${agent.sessionId}`);
    await expect(window.getByTestId('crew-frame')).toHaveAttribute('data-members', crew.map((agent) => agent.sessionId).join(' '));
    const atRest = await crewLayout(window);

    /** Expands `opened`, checks the frame holds its crew and the zone holds it all, collapses it, and checks it is all back. */
    const expandThenCollapse = async (opened: Locator, check: (layout: Awaited<ReturnType<typeof crewLayout>>) => void) => {
      await tileAction(opened, 'Expand in place');
      await expect(expandedTile(window)).toHaveCount(1);
      const layout = await crewLayout(window);
      expect(layout.members, 'the frame keeps its crew').toEqual(atRest.members);
      for (const id of crewIds) expect(inside(layout.tiles[id]!, layout.frame), `${id} inside its frame`).toBe(true);
      expect(inside(layout.frame, layout.zone), 'the frame inside the zone').toBe(true);
      for (const [id, box] of Object.entries(layout.tiles)) expect(inside(box, layout.zone), `${id} inside the zone`).toBe(true);
      check(layout);
      await expandedTile(window).getByRole('button', { name: 'Collapse' }).click();
      await expect(expandedTile(window)).toHaveCount(0);
      expect(rounded(await crewLayout(window)), 'all of it back where it was').toBe(rounded(atRest));
    };

    // The lead expanded: its crew pushed aside, in its frame.
    await expandThenCollapse(window.locator('[data-testid="agent-tile"][data-orchestrator]'), () => {});
    // One of the crew expanded: the frame round it at its size, and the other.
    await expandThenCollapse(tile(window).filter({ has: window.getByTitle(crew[0]!.name, { exact: true }) }), () => {});
    // The shell, no part of the crew, expanded over it: the crew and its frame move by one shift, keeping its layout.
    await expandThenCollapse(window.getByTestId('shell-tile'), (layout) => {
      const shift = (from: Box, to: Box) => ({ dx: Math.round(to.x - from.x), dy: Math.round(to.y - from.y) });
      const moved = shift(atRest.frame, layout.frame);
      expect(moved, 'the frame moved').not.toEqual({ dx: 0, dy: 0 });
      for (const id of crewIds) expect(shift(atRest.tiles[id]!, layout.tiles[id]!), `${id} moved with its frame`).toEqual(moved);
      const [, shell] = Object.entries(layout.tiles).find(([id]) => id.startsWith('shell:'))!;
      expect(apart(layout.frame, shell), 'the frame clear of the shell').toBe(true);
    });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
