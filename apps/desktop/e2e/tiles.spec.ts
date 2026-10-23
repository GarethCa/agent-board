import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { Agent, ExternalSession, Shell, Zone } from '@agent-board/daemon/protocol';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { centreOf, drag, settledBox, withDaemon } from './board-helpers.ts';
import { launch, setClickOpens, SHELL_ENV, showDetails, spawnAgent, tile, windowKey } from './agent-helpers.ts';
import { test, addEmptyZone, browseForZone, connectedDaemonPid, pickFolderNext, removeDataDir, stopDaemon, tempDataDir, placeWithTool } from './launch.ts';
import { scratch } from './scratch.ts';

/** The board as the daemon has stored it. */
function stored(dataDir: string): Promise<{ zones: Zone[]; agents: Agent[]; shells: Shell[] }> {
  return withDaemon(dataDir, async (client) => ({ zones: await client.call('zone.list'), agents: await client.call('agent.list'), shells: await client.call('shell.list') }));
}

/** External sessions as the daemon has stored them. */
function storedExternals(dataDir: string): Promise<ExternalSession[]> {
  return withDaemon(dataDir, (client) => client.call('external.list'));
}

/** The board's zoom: a tile's drawn width over its board width. */
async function zoom(window: Page): Promise<number> {
  return window.locator('.react-flow__viewport').evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
}

/**
 * The box of the React Flow node holding `tile`, once still. Not the tile's own: lifted while dragged, the tile is
 * scaled, but its node is where it is.
 */
const nodeBox = (window: Page, tile: Locator) => settledBox(window.locator('.react-flow__node').filter({ has: tile }));

/** Presses on `from`, drags to `to`, and checks the tile under the pointer lands where it was held, on screen. */
async function dropKeepingPlace(window: Page, tile: Locator, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(to.x, to.y, { steps: 12 });
  const held = await nodeBox(window, tile);
  await window.mouse.up();
  const landed = await nodeBox(window, tile);
  expect(Math.abs(landed.x - held.x), 'x on screen').toBeLessThan(2);
  expect(Math.abs(landed.y - held.y), 'y on screen').toBeLessThan(2);
}

/** Where the node holding `tile` is on the board (its transform), whatever the view. */
const boardPlaceOf = (window: Page, tile: Locator) =>
  window.locator('.react-flow__node').filter({ has: tile }).evaluate((node) => (node as HTMLElement).style.transform);

/** Adds a zone for `path`, a repo or a folder in one, through Add zone's File browser tab. */
async function addZone(app: ElectronApplication, window: Page, path: string): Promise<void> {
  const before = await window.getByTestId('zone').count();
  await pickFolderNext(app, path);
  await browseForZone(window);
  await expect(window.getByTestId('zone')).toHaveCount(before + 1);
}

/** A full restart: the app and its daemon both go, so the board must come back from the database. */
async function restart(app: ElectronApplication, window: Page, dataDir: string, env: Record<string, string>) {
  const firstDaemon = await connectedDaemonPid(window);
  await app.close();
  // Stopped here, unless a slow quit (Linux) already let it idle out on its own.
  expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
  return launch(dataDir, env);
}

test('the Shell tool puts a loose shell tile where the board is clicked, which drags into a zone and stays there across a restart', async () => {
  const { dir, repo, env } = scratch('output');
  const appEnv = { ...env, ...SHELL_ENV };
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, appEnv);
  try {
    await placeWithTool(window, 'New shell', { x: 300, y: 260 });

    // A tile, loose on the board centred where it was clicked (its corner on the 20px grid), and its window open.
    const shellTile = window.getByTestId('shell-tile');
    await expect(shellTile).toHaveCount(1);
    await expect(shellTile).toHaveAttribute('data-zone', '');
    await expect(window.getByTestId('session-window')).toBeVisible();
    const board = (await window.locator('.board').boundingBox())!;
    const first = centreOf(await settledBox(shellTile));
    expect(Math.abs(first.x - (board.x + 300))).toBeLessThan(12);
    expect(Math.abs(first.y - (board.y + 260))).toBeLessThan(12);
    // It starts at home: the test's home, never the real one.
    await expect.poll(async () => (await stored(dataDir)).shells.map((shell) => [shell.zoneId, shell.cwd])).toEqual([[null, join(dir, 'home')]]);
    await window.getByRole('button', { name: 'Close session window' }).click();

    // A new zone keeps clear of it, and dragging the tile onto the zone puts it in.
    await addZone(app, window, repo);
    await window.getByRole('button', { name: 'Fit View' }).click();
    const zone = window.getByTestId('zone');
    const zoneId = (await stored(dataDir)).zones[0]!.id;
    await expect(shellTile).toHaveAttribute('data-zone', '');
    const from = await settledBox(shellTile);
    const into = await settledBox(zone);
    // It lands where it was let go, on screen: in the zone's terms now.
    await dropKeepingPlace(window, shellTile, { x: from.x + 30, y: from.y + from.height / 2 }, { x: into.x + into.width / 2, y: into.y + into.height / 2 });
    await expect(shellTile).toHaveAttribute('data-zone', zoneId);
    await expect.poll(async () => (await stored(dataDir)).shells[0]?.zoneId).toBe(zoneId);
    // Its shell stays where it started.
    expect((await stored(dataDir)).shells[0]!.cwd).toBe(join(dir, 'home'));

    const placeInZone = async () => (await stored(dataDir)).shells[0]!.position;
    const placed = await placeInZone();
    expect(placed).not.toBeNull();

    // Dragged out onto bare board, left of the zone, it leaves the zone and stays where it was let go.
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    const inZone = await settledBox(shellTile);
    const zoneBox = await settledBox(zone);
    const grip = { x: inZone.x + 30, y: inZone.y + inZone.height / 2 };
    const outside = { x: zoneBox.x - inZone.width - 40 + 30, y: grip.y };
    expect(outside.x - 30, 'room left of the zone').toBeGreaterThan(0);
    await dropKeepingPlace(window, shellTile, grip, outside);
    await expect(shellTile).toHaveAttribute('data-zone', '');
    await expect.poll(async () => (await stored(dataDir)).shells[0]?.zoneId).toBeNull();
    const loose = await placeInZone();

    // And back in, for the restart.
    const back = await settledBox(shellTile);
    await dropKeepingPlace(window, shellTile, { x: back.x + 30, y: back.y + back.height / 2 }, centreOf(zoneBox));
    await expect(shellTile).toHaveAttribute('data-zone', zoneId);
    await expect.poll(placeInZone).not.toEqual(loose);
    const placedAgain = await placeInZone();

    ({ app, window } = await restart(app, window, dataDir, appEnv));

    await expect(window.getByTestId('shell-tile')).toHaveAttribute('data-zone', zoneId);
    expect(await placeInZone()).toEqual(placedAgain);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent tile drags within its zone, out onto the board and into another zone, nudges with the arrow keys, and keeps its place across a restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await addZone(app, window, repo);
    await addZone(app, window, join(repo, 'apps', 'web'));
    // The view has moved to the folder zone, beside the repo's: show both.
    await window.getByRole('button', { name: 'Fit View' }).click();
    await spawnAgent(window, 'monorepo', 'Fix the login page');
    await expect(tile(window)).toHaveCount(1);
    const [repoZone, folderZone] = (await stored(dataDir)).zones;
    await expect(tile(window)).toHaveAttribute('data-zone', repoZone!.id);
    // Its first place, a free slot, is saved.
    await expect.poll(async () => (await stored(dataDir)).agents[0]?.position).not.toBeNull();
    const slot = (await stored(dataDir)).agents[0]!.position!;
    await window.getByRole('button', { name: 'Fit View' }).click();

    // With the click set to Expand in place, a plain click selects it and expands it where it is, without moving it (the view may move to show it); Esc
    // returns it to its tile, which keeps the focus (React Flow's Esc unselects it), so the arrow keys still nudge it.
    await setClickOpens(window, 'Expand in place');
    const place = await boardPlaceOf(window, tile(window));
    const pressed = await settledBox(tile(window));
    await tile(window).dblclick({ position: { x: 40, y: pressed.height - 12 } });
    const expandedTile = window.locator('.react-flow__node.selected').getByTestId('expanded-tile');
    await expect(expandedTile).toHaveCount(1);
    expect(await boardPlaceOf(window, window.getByTestId('expanded-tile'))).toBe(place);
    await window.keyboard.press('Escape');
    await expect(expandedTile).toHaveCount(0);
    await expect.poll(() => window.evaluate(() => document.activeElement?.querySelector('[data-testid="agent-tile"]') != null)).toBe(true);
    expect(await boardPlaceOf(window, tile(window))).toBe(place);
    expect((await stored(dataDir)).agents[0]!.position).toEqual(slot);
    await window.getByRole('button', { name: 'Fit View' }).click();
    const before = await settledBox(tile(window));

    // Dragged from its body within its zone, it follows the pointer and comes to the front.
    const scale = await zoom(window);
    const grip = { x: before.x + 40, y: before.y + before.height - 12 };
    await drag(window, grip, { x: grip.x + 60, y: grip.y + 30 });
    // A press that moved is a drag, and never expands the tile.
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);
    // 1:1, give or take the pixel the pointer lands on.
    await expect
      .poll(async () => {
        const position = (await stored(dataDir)).agents[0]!.position!;
        return [Math.abs(position.x - (slot.x + 60 / scale)) < 2, Math.abs(position.y - (slot.y + 30 / scale)) < 2, position.z !== slot.z];
      })
      .toEqual([true, true, true]);
    const dragged = (await stored(dataDir)).agents[0]!.position!;
    await expect(tile(window)).toHaveAttribute('data-zone', repoZone!.id);

    // Arrow keys nudge the selected tile 1px, Shift 10px.
    await window.keyboard.press('ArrowRight');
    await window.keyboard.press('ArrowRight');
    await window.keyboard.press('Shift+ArrowDown');
    await expect
      .poll(async () => (await stored(dataDir)).agents[0]!.position)
      .toEqual({ ...dragged, x: dragged.x + 2, y: dragged.y + 10 });

    // Dropped on bare board, it leaves its zone where it was let go, and says which repo it works in.
    await expect(tile(window).getByTestId('tile-repo')).toHaveCount(0);
    const kept = await settledBox(tile(window));
    const zoneBox = await settledBox(window.getByTestId('zone').first());
    await dropKeepingPlace(window, tile(window), { x: kept.x + 40, y: kept.y + kept.height - 12 }, { x: kept.x + 40, y: zoneBox.y + zoneBox.height + 160 });
    await expect(tile(window)).toHaveAttribute('data-zone', '');
    await expect.poll(async () => (await stored(dataDir)).agents[0]!.zoneId).toBeNull();
    await expect(tile(window).getByTestId('tile-repo')).toHaveText('monorepo');
    expect((await stored(dataDir)).agents[0]).toMatchObject({ repoRoot: repo });

    // Dragged into the folder zone of the same repo, it moves there; the zone shows it is the drop target meanwhile.
    const folder = window.getByTestId('zone').filter({ has: window.getByTestId('zone-tab').getByText('monorepo/apps/web') });
    const target = await settledBox(folder);
    // Measured again: the drag towards the window's edge may have panned the view. Gripped by its middle: low on the
    // board, its foot may sit under the zones island.
    const back = await settledBox(tile(window));
    const start = { x: back.x + 40, y: back.y + back.height / 2 };
    await window.mouse.move(start.x, start.y);
    await window.mouse.down();
    await window.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await expect(folder).toHaveAttribute('data-drop-target', 'true');
    // Held, it lifts: bigger, with the grabbing cursor and a deeper shadow.
    await expect(tile(window)).toHaveCSS('cursor', 'grabbing');
    expect(await tile(window).evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a)).toBeGreaterThan(1);
    const held = await nodeBox(window, tile(window));
    await window.mouse.up();
    // It lands where it was let go, on screen.
    const landed = await nodeBox(window, tile(window));
    expect(Math.abs(landed.x - held.x)).toBeLessThan(2);
    expect(Math.abs(landed.y - held.y)).toBeLessThan(2);
    await expect(tile(window)).toHaveCSS('transform', 'none');
    await expect(folder).not.toHaveAttribute('data-drop-target');
    await expect(tile(window)).toHaveAttribute('data-zone', folderZone!.id);
    await expect.poll(async () => (await stored(dataDir)).agents[0]!.zoneId).toBe(folderZone!.id);
    // Back in a zone of its repo, it needs no repo chip.
    await expect(tile(window).getByTestId('tile-repo')).toHaveCount(0);
    const moved = (await stored(dataDir)).agents[0]!.position;

    ({ app, window } = await restart(app, window, dataDir, env));

    await expect(tile(window)).toHaveAttribute('data-zone', folderZone!.id);
    expect((await stored(dataDir)).agents[0]!.position).toEqual(moved);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent tiles drop into an empty zone and loose on the board, say which repo they work in, and stay there across a restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await addZone(app, window, repo);
    await spawnAgent(window, 'monorepo', 'Sketch the first screen');
    await spawnAgent(window, 'monorepo', 'Write the release notes');
    await expect(tile(window)).toHaveCount(2);
    await addEmptyZone(window, 'Ideas');
    await expect(window.getByTestId('zone')).toHaveCount(2);
    const ideas = (await stored(dataDir)).zones.find((zone) => zone.name === 'Ideas')!;
    const sketch = tile(window).filter({ hasText: 'Sketch the first screen' });
    const notes = tile(window).filter({ hasText: 'Write the release notes' });
    await window.getByRole('button', { name: 'Fit View' }).click();

    // Into the empty zone, which holds no agent of its own.
    const ideasZone = window.getByTestId('zone').filter({ has: window.getByTestId('zone-tab').getByText('Ideas', { exact: true }) });
    const from = await settledBox(sketch);
    await dropKeepingPlace(window, sketch, { x: from.x + 40, y: from.y + from.height - 12 }, centreOf(await settledBox(ideasZone)));
    await expect(sketch).toHaveAttribute('data-zone', ideas.id);
    await expect(sketch.getByTestId('tile-repo')).toHaveText('monorepo');

    // Out onto bare board, below the zones.
    const loose = await settledBox(notes);
    const lowest = Math.max(...(await Promise.all((await window.getByTestId('zone').all()).map(settledBox))).map((box) => box.y + box.height));
    await dropKeepingPlace(window, notes, { x: loose.x + 40, y: loose.y + loose.height - 12 }, { x: loose.x + 40, y: lowest + 120 });
    await expect(notes).toHaveAttribute('data-zone', '');
    await expect(notes.getByTestId('tile-repo')).toHaveText('monorepo');

    const placed = async () =>
      Object.fromEntries((await stored(dataDir)).agents.map((agent) => [agent.name, { zoneId: agent.zoneId, position: agent.position }]));
    await expect
      .poll(async () => Object.values(await placed()).map((agent) => agent.zoneId))
      .toEqual([ideas.id, null]);
    const before = await placed();

    ({ app, window } = await restart(app, window, dataDir, env));

    await expect(tile(window).filter({ hasText: 'Sketch the first screen' })).toHaveAttribute('data-zone', ideas.id);
    await expect(tile(window).filter({ hasText: 'Write the release notes' })).toHaveAttribute('data-zone', '');
    await expect(tile(window).getByTestId('tile-repo')).toHaveCount(2);
    expect(await placed()).toEqual(before);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tile for a session started in another terminal drags within its zone, out onto the board and out of the Unsorted group, and keeps its place across a restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const home = env.HOME!;
  // Never the developer's own ~/.claude or ~/.codex.
  const appEnv = { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') };
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, appEnv);
  let session: ChildProcessWithoutNullStreams | undefined;
  let other: ChildProcessWithoutNullStreams | undefined;
  try {
    await addZone(app, window, repo);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    await window.getByRole('switch', { name: 'Show sessions from other terminals' }).click();
    await expect(window.getByRole('switch', { name: 'Show sessions from other terminals' })).toBeChecked();
    await window.keyboard.press('Escape');
    // The fake claude, as if typed into another terminal.
    session = spawn('claude', ['Pick a database'], { cwd: repo, env: fakeHarnessEnv({ scenario: 'waiting', home, stepDelayMs: 100, idleNotifyMs: 300 }) });
    session.stdout.resume();
    session.stderr.resume();
    const externalTile = window.getByTestId('external-tile');
    const zoneId = (await stored(dataDir)).zones[0]!.id;
    await expect(externalTile).toHaveAttribute('data-zone', zoneId);
    await window.getByRole('button', { name: 'Fit View' }).click();

    // A click expands it in place with what its hooks told the board, in the details strip, and no terminal: its own
    // is wherever it was started. The strip collapses to its icon rail like any other.
    await externalTile.dblclick();
    const expanded = window.getByTestId('expanded-tile');
    await expect(expanded).toHaveAttribute('data-external-id', /^claude:/);
    // It opens collapsed to the icon rail, like every session window.
    await expect(expanded.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Show details' })).toBeVisible();
    await showDetails(expanded);
    const details = expanded.getByRole('complementary', { name: 'Session details' });
    await expect(details).toContainText('First prompt');
    await expect(details).toContainText('Pick a database');
    await expect(expanded).toContainText('Its terminal is wherever it was started');
    await expect(expanded.getByTestId('session-terminal')).toHaveCount(0);
    await expect(expanded.getByRole('button', { name: 'Maximise' })).toHaveCount(0);
    await details.getByRole('button', { name: 'Hide details' }).click();
    await expect(expanded.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Show details' })).toBeVisible();
    await expanded.getByRole('button', { name: 'Collapse' }).click();
    await expect(expanded).toHaveCount(0);
    await window.getByRole('button', { name: 'Fit View' }).click();

    const box = await settledBox(externalTile);
    const grip = { x: box.x + 40, y: box.y + box.height - 12 };
    const before = await boardPlaceOf(window, externalTile);
    await dropKeepingPlace(window, externalTile, grip, { x: grip.x + 50, y: grip.y + 20 });
    await expect.poll(async () => (await storedExternals(dataDir))[0]?.position).not.toBeNull();
    const placed = (await storedExternals(dataDir))[0]!.position;
    expect(await boardPlaceOf(window, externalTile)).not.toBe(before);

    // Dropped outside its zone, it stays where it was let go, loose on the board: only its tile moves. Zoomed out, so
    // there is board below the zone in view.
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    const moved = await settledBox(externalTile);
    const zoneBox = await settledBox(window.getByTestId('zone'));
    await dropKeepingPlace(window, externalTile, { x: moved.x + 40, y: moved.y + moved.height - 12 }, { x: moved.x + 40, y: zoneBox.y + zoneBox.height + 80 });
    await expect(externalTile).toHaveAttribute('data-zone', '');
    await expect.poll(async () => (await storedExternals(dataDir))[0]?.zoneId).toBeNull();
    expect((await storedExternals(dataDir))[0]!.position).not.toEqual(placed);

    // One started outside every zone is in the Unsorted group, and leaves it by being dragged out onto the board.
    other = spawn('claude', ['Sketch an idea'], { cwd: dir, env: fakeHarnessEnv({ scenario: 'waiting', home, stepDelayMs: 100, idleNotifyMs: 300 }) });
    other.stdout.resume();
    other.stderr.resume();
    await expect.poll(async () => (await storedExternals(dataDir)).length).toBe(2);
    // The group is right of the zones, maybe out of view, where tiles aren't drawn. Zoomed out, there's board below it.
    const unsortedZone = window.getByTestId('zone').filter({ hasText: 'Unsorted' });
    await expect(unsortedZone).toHaveCount(1);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await settledBox(unsortedZone);
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await settledBox(unsortedZone);
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    // Named after its folder.
    const unsortedTile = window.getByTestId('external-tile').filter({ hasText: basename(dir) });
    const unsortedId = (await withDaemon(dataDir, (client) => client.call('zone.list'))).find((known) => known.name === 'Unsorted')!.id;
    await expect(unsortedTile).toHaveAttribute('data-zone', unsortedId);
    // Slotted in the group like any tile of a zone, and that place saved.
    await expect.poll(async () => (await storedExternals(dataDir)).find((external) => external.cwd === dir)?.position).not.toBeNull();

    const inUnsorted = await settledBox(unsortedTile);
    const unsortedBox = await settledBox(unsortedZone);
    await dropKeepingPlace(
      window,
      unsortedTile,
      { x: inUnsorted.x + 40, y: inUnsorted.y + inUnsorted.height - 12 },
      { x: inUnsorted.x + 40, y: unsortedBox.y + unsortedBox.height + 80 },
    );
    await expect(window.getByTestId('external-tile').and(window.locator('[data-zone=""]'))).toHaveCount(2);
    await expect.poll(async () => (await storedExternals(dataDir)).map((external) => external.position !== null)).toEqual([true, true]);
    const placedLoose = await storedExternals(dataDir);

    ({ app, window } = await restart(app, window, dataDir, appEnv));

    await expect(window.getByTestId('external-tile').and(window.locator('[data-zone=""]'))).toHaveCount(2);
    expect((await storedExternals(dataDir)).map(({ zoneId, position }) => ({ zoneId, position }))).toEqual(
      placedLoose.map(({ zoneId, position }) => ({ zoneId, position })),
    );
  } finally {
    session?.kill();
    other?.kill();
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent is found by name from ⌘K, and its tile’s More menu works from the keyboard, Esc giving the focus back', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await addZone(app, window, repo);
    await spawnAgent(window, 'monorepo', 'Pick a database');

    // ⌘K finds the agent by name, with its state; picking it shows its tile.
    const switcher = window.getByRole('dialog', { name: 'Jump to a session or zone' });
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('database');
    const found = switcher.getByTestId('spotlight-row');
    await expect(found).toHaveCount(1);
    await expect(found).toContainText('Pick a database');
    await expect(found).toContainText(/thinking|waiting|running|idle|asks you/);
    await found.click();
    await expect(switcher).toHaveCount(0);
    await expect(window.locator('.react-flow__node.selected').getByTestId('agent-tile')).toHaveCount(1);

    const more = tile(window).getByRole('button', { name: 'More' });
    await more.focus();
    await window.keyboard.press('Enter');
    const menu = window.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Schedule…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete agent' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    // Opened again from the keyboard, a pick does what it says.
    await window.keyboard.press('Enter');
    await window.getByRole('menuitem', { name: 'Schedule…' }).focus();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('dialog', { name: 'Clock' })).toBeVisible();
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hovering a tile moves nothing on it: its state stays at the bottom and only the actions show', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await addZone(app, window, repo);
    await spawnAgent(window, 'monorepo', 'Hold still');
    const card = tile(window);
    const parts = [card.locator('.ui-pill'), card.locator('.hybrid-tile-name'), card.locator('.hybrid-tile-body')];
    const actions = card.locator('.hybrid-tile-actions');
    const boxes = () => Promise.all(parts.map((part) => settledBox(part)));

    await window.mouse.move(0, 0);
    // Its state settles first: the fake agent works, then waits, and the pill's label (so its width) follows.
    await expect(card).toHaveAttribute('data-state', 'waiting');
    await expect(card.locator('.ui-pill')).toHaveCount(1);
    await expect(actions).toHaveCSS('opacity', '0');
    const before = await boxes();

    await card.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(card.locator('.ui-pill')).toHaveCount(1);
    await expect(card.locator('.ui-pill')).toBeVisible();
    // The same either way: its parts are where they were.
    expect(await boxes()).toEqual(before);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tile moved from elsewhere stays moved when the answer to its own slotting comes after', async () => {
  // The board slots a new tile in and saves the slot; on a busy machine the answer to that save can reach it after the
  // daemon's event of a later move. Held back here so it always does.
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, AGENT_BOARD_MOVE_ANSWER_DELAY_MS: '1500' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Fix the login page');
    await expect.poll(async () => (await stored(dataDir)).agents[0]?.position ?? null).not.toBeNull();
    const [agent] = (await stored(dataDir)).agents;

    // Moved by another client while the board's save of its slot is still unanswered.
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    try {
      await client.call('agent.move', { sessionId: agent!.sessionId, zoneId: agent!.zoneId, x: 440, y: 300 });
    } finally {
      client.close();
    }

    // Where the board draws it, on the board: its zone's corner plus its place there. Its slot shows until the save is
    // answered, so it gets there only once the late answer has come and not put it back.
    const [zone] = (await stored(dataDir)).zones;
    const drawnAt = () => window.locator(`.react-flow__node[data-id="agent:${agent!.sessionId}"]`).evaluate((node) => (node as HTMLElement).style.transform);
    await expect.poll(drawnAt, { timeout: 10_000 }).toBe(`translate(${zone!.x + 440}px, ${zone!.y + 300}px)`);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
