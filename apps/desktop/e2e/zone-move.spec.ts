import { expect, type Locator, type Page } from '@playwright/test';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { centreOf, drag, settledBox } from './board-helpers.ts';
import { launch, sessionWindow, setClickOpens, SHELL_ENV, zoneNamed } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, openAddZone, pickFolderNext, removeDataDir, stopDaemon, tempDataDir } from './launch.ts';
import { scratch } from './scratch.ts';

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/** The desk's dot spacing, which a zone's corner lands on with Snap to grid on (`--desk-dot-gap`). */
const GRID = 24;

/** A zone's layout as the daemon stores it: the one zone, or the one named `name`. */
const storedZone = (page: Page, name?: string) =>
  page.evaluate(async (name) => {
    const zones = await window.agentBoard.zones.list();
    const zone = name === undefined ? zones[0] : zones.find((one) => one.name === name);
    return { x: zone!.x, y: zone!.y, width: zone!.width, height: zone!.height };
  }, name);

/** Sets the size of the zone named `name`, as the daemon stores it. */
const resizeZone = (page: Page, name: string, width: number) =>
  page.evaluate(
    async ({ name, width }) => {
      const zone = (await window.agentBoard.zones.list()).find((one) => one.name === name)!;
      await window.agentBoard.zones.update(zone.id, { x: zone.x, y: zone.y, width, height: 200 });
    },
    { name, width },
  );

/** The first shell's place as the daemon stores it. */
const firstShellPlace = (page: Page) => page.evaluate(async () => (await window.agentBoard.shells.list())[0]!.position);

/** The first board item as the daemon stores it. */
const firstItem = (page: Page) => page.evaluate(async () => (await window.agentBoard.items.list())[0]!);

/** The zone's place on the board as drawn. */
const drawnAt = async (zone: Locator): Promise<Point> => ({
  x: Number(await zone.getAttribute('data-x')),
  y: Number(await zone.getAttribute('data-y')),
});

/** Where `inner` sits relative to `outer` on screen, in board pixels at `scale`. */
const offsetIn = (outer: Box, inner: Box, scale: number): Point => ({
  x: Math.round((inner.x - outer.x) / scale),
  y: Math.round((inner.y - outer.y) / scale),
});

/** How many screen pixels a board pixel is. */
const scaleOf = async (zone: Locator): Promise<number> => (await settledBox(zone)).width / Number(await zone.getAttribute('data-width'));

/** Whether the zone is selected. */
const isSelected = (zone: Locator) => zone.evaluate((element) => element.closest('.react-flow__node')!.classList.contains('selected'));

/** A point on the zone's bare body, near its bottom left: checked, so a press there lands on the zone itself. */
async function bareZonePoint(page: Page, zone: Locator): Promise<Point> {
  const box = await settledBox(zone);
  const point = { x: box.x + 40, y: box.y + box.height - 30 };
  const onZone = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('zone') ?? false, point);
  expect(onZone, 'the point is bare zone').toBe(true);
  return point;
}

/** Drags from the middle of `what` by `by` board pixels at `scale`. */
async function dragFrom(page: Page, what: Locator, by: Point, scale: number): Promise<void> {
  const from = centreOf(await settledBox(what));
  await drag(page, from, { x: from.x + by.x * scale, y: from.y + by.y * scale });
}

/** Adds the group `name` holding a shell (made from its tab, its window closed) and a sticky note clear of it. */
async function zoneWithShellAndNote(page: Page, name: string): Promise<Locator> {
  await addEmptyZone(page, name);
  const zone = page.getByTestId('zone');
  await zone.getByRole('button', { name: 'New shell in zone' }).click();
  await expect(sessionWindow(page)).toHaveAttribute('data-state', 'attached');
  await page.getByRole('button', { name: 'Close session window' }).click();
  await expect(page.getByTestId('shell-tile')).toHaveCount(1);
  await page.evaluate(async () => {
    const [zone] = await window.agentBoard.zones.list();
    await window.agentBoard.items.create({
      kind: 'sticky',
      zoneId: zone!.id,
      x: zone!.width - 160,
      y: 60,
      width: 120,
      height: 120,
      data: { text: 'moves with it', color: '#fff3a3' },
    });
  });
  await expect(page.getByTestId('sticky')).toHaveCount(1);
  await page.getByRole('button', { name: 'Fit View' }).click();
  await page.getByRole('button', { name: 'Zoom Out' }).click();
  await settledBox(zone);
  return zone;
}

test('a zone drags by its header and by its empty body, snapped, its tile and note with it, kept across a restart; a click only selects it, a drag on what is in it moves only that, Shift drags a marquee inside it, and undo puts it back', async () => {
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, SHELL_ENV);
  try {
    const zone = await zoneWithShellAndNote(window, 'Moves');
    const shell = window.getByTestId('shell-tile');
    const note = window.getByTestId('sticky');
    const tab = zone.getByTestId('zone-tab');
    const pane = window.locator('.react-flow__pane');
    const scale = await scaleOf(zone);

    // It shows it can be grabbed, its name too.
    const cursor = (one: Locator) => one.evaluate((element) => getComputedStyle(element).cursor);
    expect(await cursor(zone)).toBe('grab');
    expect(await cursor(tab.locator('.zone-tab-name'))).toBe('grab');

    // A click on its body, with nothing selected, selects it and moves nothing.
    const placed = await storedZone(window);
    await pane.click({ position: { x: 20, y: 300 } });
    await expect.poll(() => isSelected(zone)).toBe(false);
    const body = await bareZonePoint(window, zone);
    await window.mouse.click(body.x, body.y);
    await expect.poll(() => isSelected(zone)).toBe(true);
    expect(await storedZone(window)).toEqual(placed);
    expect(await drawnAt(zone)).toEqual({ x: placed.x, y: placed.y });

    // A drag that starts on what is in it moves only that: its shell, its note, a chip on its tab. Its right edge
    // resizes it, from where it is.
    const storedShell = () => firstShellPlace(window);
    const shellWas = await storedShell();
    await dragFrom(window, shell, { x: 30, y: 20 }, scale);
    await expect.poll(storedShell).not.toEqual(shellWas);
    expect(await storedZone(window)).toEqual(placed);
    const storedNote = () => firstItem(window);
    const noteWas = await storedNote();
    await dragFrom(window, note, { x: -20, y: 30 }, scale);
    await expect.poll(async () => (await storedNote()).y).not.toBe(noteWas.y);
    expect(await storedZone(window)).toEqual(placed);
    await dragFrom(window, tab.getByRole('button', { name: 'Zone tracker' }), { x: 60, y: 60 }, scale);
    expect(await storedZone(window)).toEqual(placed);
    expect(await drawnAt(zone)).toEqual({ x: placed.x, y: placed.y });
    await window.mouse.click(body.x, body.y);
    await dragFrom(window, zone.locator('.react-flow__resize-control.line.right'), { x: 48, y: 0 }, scale);
    await expect.poll(async () => (await storedZone(window)).width).toBeGreaterThan(placed.width);
    expect(await storedZone(window)).toMatchObject({ x: placed.x, y: placed.y });

    // Shift and a drag from its body draws a marquee instead, round the shell: the zone stays put.
    await pane.click({ position: { x: 20, y: 300 } });
    const start = await storedZone(window);
    const tileBox = await settledBox(shell);
    const from = { x: tileBox.x - 10, y: tileBox.y + tileBox.height + 10 };
    expect(await window.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('zone') ?? false, from)).toBe(true);
    await drag(window, from, { x: tileBox.x + tileBox.width + 10, y: tileBox.y - 10 }, { hold: 'Shift' });
    await expect(window.locator('.react-flow__node.selected').getByTestId('shell-tile')).toHaveCount(1);
    expect(await isSelected(zone)).toBe(false);
    expect(await storedZone(window)).toEqual(start);

    // By its header, pressed on the name, with Snap to grid on: its corner lands on the desk's dots.
    await pane.click({ position: { x: 20, y: 300 } });
    await window.getByRole('button', { name: 'Snap to grid' }).click();
    let zoneBox = await settledBox(zone);
    const tileOffset = offsetIn(zoneBox, await settledBox(shell), scale);
    const noteOffset = offsetIn(zoneBox, await settledBox(note), scale);
    await dragFrom(window, tab.locator('.zone-tab-name'), { x: 130, y: 85 }, scale);
    await expect.poll(async () => (await storedZone(window)).x).toBeGreaterThan(start.x + 80);
    const byHeader = await storedZone(window);
    expect(byHeader.y).toBeGreaterThan(start.y + 40);
    expect([byHeader.x % GRID, byHeader.y % GRID]).toEqual([0, 0]);
    expect({ width: byHeader.width, height: byHeader.height }).toEqual({ width: start.width, height: start.height });
    zoneBox = await settledBox(zone);
    expect(offsetIn(zoneBox, await settledBox(shell), scale)).toEqual(tileOffset);
    expect(offsetIn(zoneBox, await settledBox(note), scale)).toEqual(noteOffset);

    // By its empty body.
    const bare = await bareZonePoint(window, zone);
    await drag(window, bare, { x: bare.x - 100 * scale, y: bare.y + 60 * scale });
    await expect.poll(async () => (await storedZone(window)).x).toBeLessThan(byHeader.x - 60);
    const byBody = await storedZone(window);
    expect(byBody.y).toBeGreaterThan(byHeader.y + 20);
    expect([byBody.x % GRID, byBody.y % GRID]).toEqual([0, 0]);
    zoneBox = await settledBox(zone);
    expect(offsetIn(zoneBox, await settledBox(shell), scale)).toEqual(tileOffset);
    expect(offsetIn(zoneBox, await settledBox(note), scale)).toEqual(noteOffset);

    // Undo takes the body drag back, then the header drag; redo does the header drag again.
    await pane.click({ position: { x: 20, y: 300 } });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedZone(window)).toEqual(byHeader);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedZone(window)).toEqual(start);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => storedZone(window)).toEqual(byHeader);

    // A full restart: the zone, its tile and its note come back where they were left.
    await app.close();
    await stopDaemon(dataDir);
    ({ app, window } = await launch(dataDir, SHELL_ENV));
    const restored = window.getByTestId('zone');
    await expect(restored).toHaveAttribute('data-x', String(byHeader.x));
    await expect(restored).toHaveAttribute('data-y', String(byHeader.y));
    const restoredScale = await scaleOf(restored);
    const restoredBox = await settledBox(restored);
    expect(offsetIn(restoredBox, await settledBox(window.getByTestId('shell-tile')), restoredScale)).toEqual(tileOffset);
    expect(offsetIn(restoredBox, await settledBox(window.getByTestId('sticky')), restoredScale)).toEqual(noteOffset);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('a repo zone drags by its header with an expanded tile in it, which moves with it and stays expanded', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const zone = zoneNamed(window, 'monorepo');
    await expect(zone).toHaveAttribute('data-kind', 'repo');
    await zone.getByRole('button', { name: 'New shell in zone' }).click();
    await expect(sessionWindow(window)).toHaveAttribute('data-state', 'attached');
    await window.getByRole('button', { name: 'Close session window' }).click();
    await window.getByTestId('shell-tile').dblclick();
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toBeVisible();
    await window.getByRole('button', { name: 'Fit View' }).click();
    const scale = await scaleOf(zone);

    const before = await storedZone(window, 'monorepo');
    const offset = offsetIn(await settledBox(zone), await settledBox(expanded), scale);
    await dragFrom(window, zone.getByTestId('zone-tab').locator('.zone-tab-name'), { x: 0, y: 120 }, scale);
    await expect.poll(async () => (await storedZone(window, 'monorepo')).y).toBeGreaterThan(before.y + 60);
    expect(offsetIn(await settledBox(zone), await settledBox(expanded), scale)).toEqual(offset);
    await expect(expanded).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The right edge of everything on the zone's tab, the tab's own box too, on screen. */
const tabRight = (zone: Locator) =>
  zone.getByTestId('zone-tab').evaluate((tab) => Math.max(...[tab, ...tab.querySelectorAll('*')].map((one) => one.getBoundingClientRect().right)));

/** Checks the zone's tab ends inside it at this zoom, then one step in and two out, measured after each. */
async function expectTabFits(page: Page, zone: Locator): Promise<void> {
  for (const zoom of [undefined, 'Zoom In', 'Zoom Out', 'Zoom Out']) {
    if (zoom !== undefined) await page.getByRole('button', { name: zoom }).click();
    const zoneBox = await settledBox(zone);
    await expect.poll(() => tabRight(zone), `the tab fits after ${zoom ?? 'no zoom'}`).toBeLessThanOrEqual(zoneBox.x + zoneBox.width + 0.5);
  }
}

/** What ⋯ offers in each folded chip's place: the start of its name, which goes on with its hint if it has one. */
const FOLDED_ENTRY: Record<string, RegExp> = {
  tidy: /^Tidy/,
  issue: /^Add issue…/,
  tracker: /^Issues from acme\//,
  bind: /^Bind…/,
  'default-repo': /^monorepo/,
  shell: /^New shell/,
  agent: /^New agent/,
  'cancel-clone': /^Cancel clone/,
};

/**
 * Opens the zone's ⋯ and checks it offers each of `chips` that is no longer on the tab; resolves with the menu, open,
 * and the chips that folded.
 */
async function expectFoldedInMenu(page: Page, zone: Locator, chips: readonly string[]): Promise<{ menu: Locator; folded: string[] }> {
  const tab = zone.getByTestId('zone-tab');
  const shown = await tab.locator('[data-fold]').evaluateAll((slots) => slots.map((slot) => (slot as HTMLElement).dataset.fold));
  const folded = chips.filter((chip) => !shown.includes(chip));
  await tab.getByRole('button', { name: 'Zone options' }).click();
  const menu = page.getByRole('menu');
  for (const chip of folded) {
    await expect(menu.getByRole('menuitem', { name: FOLDED_ENTRY[chip] }), `${chip} is in ⋯`).toBeVisible();
  }
  return { menu, folded };
}

test("a narrow zone's tab fits inside it at any zoom, its lower chips folded into ⋯, where they still work; a cloning one's too", async () => {
  const { dir, repo, env } = scratch('waiting');
  const github = createFakeGitHub({
    ...FAKE_GITHUB_STATE,
    repos: [
      { nameWithOwner: 'acme/app', description: 'The app', cloneFrom: repo },
      { nameWithOwner: 'acme/web', description: 'The site', cloneFrom: repo },
    ],
    cloneDelayMs: 120_000,
  });
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, AGENT_BOARD_GH: github.gh, AGENT_BOARD_REPOS_DIR: join(dir, 'repos') });
  try {
    // A zone that will be cloning throughout, slowly, made first, on an empty board.
    const popover = await openAddZone(page, 'GitHub');
    await popover.getByRole('option').filter({ hasText: 'The site' }).click();
    await popover.getByRole('button', { name: /^Clone and add/ }).click();
    await expect(popover).toBeHidden();
    const cloning = zoneNamed(page, 'web');
    await expect(cloning.getByTestId('zone-clone')).toBeVisible();

    // A group with every chip a group can show: a default repo, a tracker and its Add issue, Bind….
    const name = 'A group with a rather long name';
    await addEmptyZone(page, name);
    const zone = zoneNamed(page, name);
    await page.evaluate(
      async ({ name, repo }) => {
        const zone = (await window.agentBoard.zones.list()).find((one) => one.name === name)!;
        await window.agentBoard.zones.setDefaultRepo(zone.id, repo);
        await window.agentBoard.zones.setTracker(zone.id, { provider: 'github', scope: 'acme/app' });
      },
      { name, repo },
    );
    await expect.poll(() => zone.getByTestId('zone-tab').locator('[data-fold]').count()).toBeGreaterThan(0);
    await resizeZone(page, name, 240);
    await expect(zone).toHaveAttribute('data-width', '240');
    await page.getByRole('button', { name: 'Fit View' }).click();
    await expectTabFits(page, zone);

    // Each folded chip is in ⋯, and works from there.
    const { menu, folded } = await expectFoldedInMenu(page, zone, ['tidy', 'issue', 'tracker', 'bind', 'default-repo', 'shell', 'agent']);
    expect(folded).toEqual(expect.arrayContaining(['tidy', 'issue', 'tracker', 'shell']));
    await menu.getByRole('menuitem', { name: 'New shell', exact: true }).click();
    await expect(sessionWindow(page)).toHaveAttribute('data-state', 'attached');
    await page.getByRole('button', { name: 'Close session window' }).click();

    // Widened, its chips come back out of ⋯.
    await resizeZone(page, name, 1400);
    await expect(zone.getByRole('button', { name: 'New shell in zone' })).toBeVisible();
    await expect(zone.getByRole('button', { name: 'Tidy zone' })).toBeVisible();

    // The zone still cloning, as narrow: its tab fits too, and what folded, Tidy first, is in a ⋯ of its own.
    await resizeZone(page, 'web', 240);
    await expect(cloning).toHaveAttribute('data-width', '240');
    await page.getByRole('button', { name: 'Fit View' }).click();
    await expectTabFits(page, cloning);
    const clone = await expectFoldedInMenu(page, cloning, ['tidy', 'issue', 'tracker', 'shell', 'agent', 'cancel-clone']);
    expect(clone.folded).toContain('tidy');
    await clone.menu.getByRole('menuitem', { name: FOLDED_ENTRY.tidy }).click();
    await expect(clone.menu).toBeHidden();
    await expect(cloning.getByTestId('zone-clone')).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
