import { expect, type Locator, type Page } from '@playwright/test';
import { connectDaemon } from '@agent-board/daemon/client';
import { daemonPaths } from '@agent-board/daemon/paths';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settledBox, withDaemon } from './board-helpers.ts';
import { launch, spawnAgent, tile } from './agent-helpers.ts';
import { scratch } from './scratch.ts';
import { test, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, stopDaemon, tempDataDir, browseForZone, addEmptyZone, openAddZone } from './launch.ts';
import { AGENT_TILE_SIZE, leastZoneSize, ZONE_PADDING } from '../src/renderer/src/board/layout.ts';

/** Zones as the daemon has stored them. */
function storedZones(dataDir: string): Promise<Zone[]> {
  return withDaemon(dataDir, (client) => client.call('zone.list'));
}

/** Agents as the daemon has stored them. */
function storedAgents(dataDir: string): Promise<Agent[]> {
  return withDaemon(dataDir, (client) => client.call('agent.list'));
}

/** How many screen pixels a board pixel is, for dragging by a board distance. */
async function zoneScale(zone: Locator): Promise<number> {
  const box = (await zone.boundingBox())!;
  return box.width / Number(await zone.getAttribute('data-width'));
}

/** Fits the board in view, then zooms out `times`, letting each step settle, so a zone clears the panels over the board. */
async function zoomOutFromFit(window: Page, zone: Locator, times: number): Promise<void> {
  await window.getByRole('button', { name: 'Fit View' }).click();
  await settledBox(zone);
  for (let step = 0; step < times; step++) {
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    await settledBox(zone);
  }
}

async function addZone(window: Page): Promise<void> {
  await browseForZone(window);
}

const zoneNamed = (window: Page, name: string): Locator =>
  window.getByTestId('zone').filter({ has: window.getByTestId('zone-tab').getByText(name, { exact: true }) });

test('adds repo and folder zones from the folder picker, rejects non-git folders, and keeps the layout across an app and daemon restart', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-zones-')));
  const repo = join(scratch, 'monorepo');
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  const plain = join(scratch, 'not-a-repo');
  mkdirSync(plain);
  const dataDir = tempDataDir();

  let app = await launchApp(dataDir);
  try {
    let window = await app.firstWindow();
    await connectedDaemonPid(window);

    await pickFolderNext(app, repo);
    await addZone(window);
    const whole = zoneNamed(window, 'monorepo');
    await expect(whole).toHaveAttribute('data-kind', 'repo');

    await pickFolderNext(app, join(repo, 'apps', 'web'));
    await addZone(window);
    const web = zoneNamed(window, 'monorepo/apps/web');
    await expect(web).toHaveAttribute('data-kind', 'folder');

    // Both zones share the repo but sit apart on the board: compared as stored, since the view is still moving to the
    // new one and two screen boxes read a frame apart can overlap.
    const [a, b] = await storedZones(dataDir);
    expect(a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y).toBe(true);

    // A folder the daemon refuses keeps Add zone open, saying why.
    await pickFolderNext(app, plain);
    const popover = await openAddZone(window, 'Recent');
    await popover.getByRole('button', { name: 'Browse…' }).click();
    await expect(popover.getByRole('alert')).toHaveText(`${plain} is not inside a git repository`);
    await window.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    // Counted in the daemon, not on screen: the board draws only the zones in view, and the view has just moved to
    // show the last one added.
    expect(await storedZones(dataDir)).toHaveLength(2);

    // Move the folder zone down by its tab, then widen and deepen it from its bottom-left corner (the bottom-right
    // one sits under the minimap).
    const before = (await storedZones(dataDir)).find((zone) => zone.folder === 'apps/web')!;
    const tab = web.getByTestId('zone-tab');
    const tabBox = (await tab.boundingBox())!;
    await window.mouse.move(tabBox.x + 10, tabBox.y + tabBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(tabBox.x + 60, tabBox.y + 80, { steps: 8 });
    await window.mouse.up();
    await window.getByRole('button', { name: 'Fit View' }).click();
    const cornerBox = await settledBox(web.locator('.react-flow__resize-control.handle.bottom.left'));
    await window.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(cornerBox.x - 100, cornerBox.y + 60, { steps: 8 });
    await window.mouse.up();

    let layout: Zone | undefined;
    await expect
      .poll(async () => {
        layout = (await storedZones(dataDir)).find((zone) => zone.folder === 'apps/web');
        return (
          layout !== undefined &&
          layout.x !== before.x &&
          layout.y > before.y &&
          layout.width > before.width &&
          layout.height > before.height
        );
      })
      .toBe(true);

    // A full restart: the app and its daemon both go, so the zones must come back from the database.
    const firstDaemon = await connectedDaemonPid(window);
    await app.close();
    expect(await stopDaemon(dataDir)).toBe(firstDaemon);
    app = await launchApp(dataDir);
    window = await app.firstWindow();
    expect(await connectedDaemonPid(window)).not.toBe(firstDaemon);

    await expect(window.getByTestId('zone')).toHaveCount(2);
    const restored = zoneNamed(window, 'monorepo/apps/web');
    await expect(restored).toHaveAttribute('data-x', String(layout!.x));
    await expect(restored).toHaveAttribute('data-y', String(layout!.y));
    await expect(restored).toHaveAttribute('data-width', String(layout!.width));
    await expect(restored).toHaveAttribute('data-height', String(layout!.height));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a zone grows to hold more tiles than its initial height, and cannot be resized smaller than they fit', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await addZone(window);
    const zone = zoneNamed(window, 'monorepo');
    await expect(zone).toBeVisible();
    const initialHeight = (await storedZones(dataDir))[0]!.height;

    // Two tiles fit a row of the default zone and two rows fit its height; the fifth needs a third row.
    for (let n = 1; n <= 5; n++) await spawnAgent(window, 'monorepo', `Task ${n}`);
    await expect(tile(window)).toHaveCount(5);
    await expect.poll(async () => Number(await zone.getAttribute('data-height'))).toBeGreaterThan(initialHeight);

    const insideZone = async () => {
      // Tiles off-screen aren't rendered, so bring the whole zone into view first.
      await window.getByRole('button', { name: 'Fit View' }).click();
      const box = (await settledBox(zone))!;
      for (const tileBox of await Promise.all((await tile(window).all()).map((one) => one.boundingBox()))) {
        expect(tileBox!.x).toBeGreaterThanOrEqual(box.x);
        expect(tileBox!.x + tileBox!.width).toBeLessThanOrEqual(box.x + box.width + 1);
        expect(tileBox!.y).toBeGreaterThanOrEqual(box.y);
        expect(tileBox!.y + tileBox!.height).toBeLessThanOrEqual(box.y + box.height + 1);
      }
    };
    await insideZone();
    const grown = Number(await zone.getAttribute('data-height'));

    // Drag the bottom-left corner up past the tiles: the zone stops at the height its tiles need.
    // On the tab's kind label: its middle is one of its buttons.
    await zone.getByTestId('zone-tab').click({ position: { x: 12, y: 12 } });
    await window.getByRole('button', { name: 'Fit View' }).click();
    // Zoomed out, the corner clears the controls and minimap whatever the window size.
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    const corner = await settledBox(zone.locator('.react-flow__resize-control.handle.bottom.left'));
    await window.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await window.mouse.down();
    // By the whole grown height, so unclamped the zone would end up far shorter than its tiles.
    await window.mouse.move(corner.x, corner.y - grown * (await zoneScale(zone)), { steps: 8 });
    await window.mouse.up();

    await expect.poll(async () => (await storedZones(dataDir))[0]!.height).toBeGreaterThanOrEqual(grown);
    expect(Number(await zone.getAttribute('data-height'))).toBeGreaterThanOrEqual(grown);
    await insideZone();

    // Narrowed sideways from its bottom-left corner, zoomed out so it clears the minimap and inbox: its tiles fill its
    // rows, so a tile the edge cuts has nowhere to go: the zone stops at its tiles, and none of them moves on the board.
    const onBoard = async () => {
      const { x, y } = (await storedZones(dataDir))[0]!;
      return (await storedAgents(dataDir)).map((agent) => ({ x: x + agent.position!.x, y: y + agent.position!.y }));
    };
    const tilesOnBoard = await onBoard();
    const widthBefore = (await storedZones(dataDir))[0]!.width;
    await window.getByRole('button', { name: 'Zoom Out' }).click();
    const edge = await settledBox(zone.locator('.react-flow__resize-control.handle.bottom.left'));
    await window.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await window.mouse.down();
    await window.mouse.move(edge.x + 400 * (await zoneScale(zone)), edge.y + edge.height / 2, { steps: 16 });
    await window.mouse.up();
    await expect.poll(async () => (await storedZones(dataDir))[0]!.width).toBeLessThanOrEqual(widthBefore);
    expect((await storedZones(dataDir))[0]!.width).toBeGreaterThan(widthBefore - AGENT_TILE_SIZE.width);
    expect(await onBoard()).toEqual(tilesOnBoard);
    await insideZone();

    // Widened from its left edge, its origin moves left and its tiles stay where they were on the board, kept in the
    // zone's new terms.
    const tilesBefore = await Promise.all((await tile(window).all()).map((one) => settledBox(one)));
    const placesBefore = (await storedAgents(dataDir)).map((agent) => agent.position!.x);
    const left = await settledBox(zone.locator('.react-flow__resize-control.handle.bottom.left'));
    const widenBy = 100;
    await window.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
    await window.mouse.down();
    await window.mouse.move(left.x + left.width / 2 - widenBy * (await zoneScale(zone)), left.y + left.height / 2, { steps: 8 });
    await window.mouse.up();
    await expect
      .poll(async () => (await storedAgents(dataDir)).map((agent, index) => Math.round(agent.position!.x - placesBefore[index]!)))
      .toEqual(placesBefore.map(() => widenBy));
    const tilesAfter = await Promise.all((await tile(window).all()).map((one) => settledBox(one)));
    tilesAfter.forEach((box, index) => expect(box.x).toBeCloseTo(tilesBefore[index]!.x, 0));
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shrinking a zone past hand-placed tiles packs them inward as it goes, stops at the least size, and keeps them across a restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await addZone(window);
    const zone = zoneNamed(window, 'monorepo');
    await spawnAgent(window, 'monorepo', 'Fix the login page');
    await spawnAgent(window, 'monorepo', 'Write the release notes');
    await expect(tile(window)).toHaveCount(2);
    await expect.poll(async () => (await storedAgents(dataDir)).every((agent) => agent.position !== null)).toBe(true);
    const [kept, far] = await storedAgents(dataDir);
    // Placed by hand at the far right of the zone, low down.
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    try {
      await client.call('agent.move', { sessionId: far!.sessionId, zoneId: far!.zoneId, x: 440, y: 300 });
    } finally {
      client.close();
    }
    const farTile = tile(window).filter({ hasText: 'Write the release notes' });
    await expect.poll(async () => (await storedAgents(dataDir))[1]!.position).toMatchObject({ x: 440, y: 300 });
    await zoomOutFromFit(window, zone, 3);

    // Its right edge dragged in far past both tiles: the far one moves in, live, and the zone stops at one tile's width.
    // By its name, clear of the tab's buttons.
    await zone.getByTestId('zone-tab').getByText('monorepo', { exact: true }).click();
    const height = Number(await zone.getAttribute('data-height'));
    const least = leastZoneSize(2, { width: 0, height }).width;
    expect(least).toBe(2 * ZONE_PADDING + AGENT_TILE_SIZE.width);
    // The top-right corner, clear of the minimap.
    const handle = await settledBox(zone.locator('.react-flow__resize-control.handle.top.right'));
    const scale = await zoneScale(zone);
    await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle.x - 300 * scale, handle.y + handle.height / 2, { steps: 12 });
    // Mid-drag, the far tile is already inside the narrowed zone.
    const midZone = await settledBox(zone);
    const midTile = await settledBox(farTile);
    expect(midTile.x + midTile.width).toBeLessThanOrEqual(midZone.x + midZone.width + 1);
    await window.mouse.move(handle.x - 700 * scale, handle.y + handle.height / 2, { steps: 12 });
    await window.mouse.up();

    await expect.poll(async () => (await storedZones(dataDir))[0]!.width).toBe(least);
    expect(Number(await zone.getAttribute('data-width'))).toBe(least);
    // The far tile moved inward only as far as it had to, keeping its height; the other never moved.
    await expect.poll(async () => (await storedAgents(dataDir)).map((agent) => agent.position && { x: agent.position.x, y: agent.position.y })).toEqual([
      { x: kept!.position!.x, y: kept!.position!.y },
      { x: ZONE_PADDING, y: 300 },
    ]);
    const packed = (await storedAgents(dataDir)).map((agent) => agent.position);

    await app.close();
    await stopDaemon(dataDir);
    ({ app, window } = await launch(dataDir, env));

    await expect(tile(window)).toHaveCount(2);
    expect((await storedAgents(dataDir)).map((agent) => agent.position)).toEqual(packed);
    expect((await storedZones(dataDir))[0]!.width).toBe(least);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shrinking a zone from its left edge moves only the tile the edge cuts, keeping the other where it is on the board, across a restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await addZone(window);
    const zone = zoneNamed(window, 'monorepo');
    await spawnAgent(window, 'monorepo', 'Fix the login page');
    await spawnAgent(window, 'monorepo', 'Write the release notes');
    await expect.poll(async () => (await storedAgents(dataDir)).every((agent) => agent.position !== null)).toBe(true);
    const [near, far] = await storedAgents(dataDir);
    const client = await connectDaemon(daemonPaths(dataDir).socket);
    try {
      await client.call('agent.move', { sessionId: far!.sessionId, zoneId: far!.zoneId, x: 440, y: 300 });
    } finally {
      client.close();
    }
    const farTile = tile(window).filter({ hasText: 'Write the release notes' });
    await expect.poll(async () => (await storedAgents(dataDir))[1]!.position).toMatchObject({ x: 440, y: 300 });
    await zoomOutFromFit(window, zone, 3);
    const zoneBefore = (await storedZones(dataDir))[0]!;

    await zone.getByTestId('zone-tab').getByText('monorepo', { exact: true }).click();
    const farBefore = await settledBox(farTile);
    const handle = await settledBox(zone.locator('.react-flow__resize-control.handle.top.left'));
    const scale = await zoneScale(zone);
    await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await window.mouse.down();
    await window.mouse.move(handle.x + 300 * scale, handle.y + handle.height / 2, { steps: 12 });
    // Mid-drag, the far tile still fits, so it hasn't moved on the board.
    const farMid = await settledBox(farTile);
    expect(Math.abs(farMid.x - farBefore.x)).toBeLessThan(1);
    expect(Math.abs(farMid.y - farBefore.y)).toBeLessThan(1);
    await window.mouse.move(handle.x + 700 * scale, handle.y + handle.height / 2, { steps: 16 });
    await window.mouse.up();

    // Stopped at one tile's width: the near tile moved with the edge, the far one only once the edge reached it.
    const least = 2 * ZONE_PADDING + AGENT_TILE_SIZE.width;
    await expect.poll(async () => (await storedZones(dataDir))[0]!.width).toBe(least);
    expect((await storedZones(dataDir))[0]!.x).toBe(zoneBefore.x + zoneBefore.width - least);
    await expect
      .poll(async () => (await storedAgents(dataDir)).map((agent) => agent.position && { x: agent.position.x, y: agent.position.y }))
      .toEqual([
        { x: ZONE_PADDING, y: near!.position!.y },
        { x: ZONE_PADDING, y: 300 },
      ]);
    const packed = (await storedAgents(dataDir)).map((agent) => agent.position);

    await app.close();
    await stopDaemon(dataDir);
    ({ app, window } = await launch(dataDir, env));

    await expect(tile(window)).toHaveCount(2);
    expect((await storedAgents(dataDir)).map((agent) => agent.position)).toEqual(packed);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a group holds shells, asks for a repo for an agent until it is bound as a new project, then starts a fake Claude agent there', async () => {
  const { dir, env } = scratch('waiting');
  const project = join(dir, 'new-project');
  const dataDir = tempDataDir();
  // A plain sh, never the developer's own shell and its rc files.
  const { app, window } = await launch(dataDir, { ...env, SHELL: '/bin/sh' });
  try {
    await addEmptyZone(window, 'Ideas', 'Violet');

    const zone = zoneNamed(window, 'Ideas');
    await expect(zone).toHaveAttribute('data-kind', 'unbound');
    await expect(zone.getByTestId('zone-tab')).toContainText('group');
    // With no repo of its own, its New agent asks for one with the repo picker (AJ2).
    await zone.getByRole('button', { name: 'New agent' }).click();
    const picker = window.getByRole('dialog', { name: 'Choose where the agent works' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(picker).toHaveCount(0);
    await expect(window.getByRole('dialog', { name: 'New agent' })).toHaveCount(0);
    expect(await storedZones(dataDir)).toMatchObject([{ name: 'Ideas', color: '#7950f2', repoRoot: null }]);

    // A shell in it starts in the home directory, as the zone has no folder of its own.
    await zone.getByRole('button', { name: 'New shell in zone' }).click();
    const sessionWindow = window.getByTestId('session-window');
    await expect(sessionWindow).toHaveAttribute('data-state', 'attached');
    await window.keyboard.type('pwd -P');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('shell-pane')).toContainText(env.HOME!);
    await sessionWindow.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow).toBeHidden();
    await expect(window.getByTestId('shell-tile')).toHaveCount(1);

    await pickFolderNext(app, project);
    await zone.getByRole('button', { name: 'Bind zone' }).click();
    await window.getByRole('menuitem', { name: 'Open as project…' }).click();

    await expect(zone).toHaveAttribute('data-kind', 'repo');
    await expect(zone.getByRole('button', { name: 'Bind zone' })).toHaveCount(0);
    expect(await storedZones(dataDir)).toMatchObject([{ name: 'Ideas', kind: 'repo', repoRoot: project }]);
    expect(execFileSync('git', ['-C', project, 'log', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Initial commit');

    // Closing a dialog gives focus back to what opened it.
    await zone.getByRole('button', { name: 'New agent' }).focus();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('dialog', { name: 'New agent' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'New agent' })).toHaveCount(0);
    await expect(zone.getByRole('button', { name: 'New agent' })).toBeFocused();

    // The shell stays where it started, alongside the agent.
    await spawnAgent(window, 'Ideas', 'Sketch the first screen');
    await expect(window.getByTestId('shell-tile')).toHaveCount(1);
    await expect(tile(window)).toHaveCount(1);
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Zone tool (Z) drags out where a zone goes, a group by default, which can start agents', async () => {
  const { dir, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    const zoneTool = window.getByRole('button', { name: 'Zone', exact: true });
    const popover = window.getByRole('dialog', { name: 'Add zone' });
    const board = window.getByTestId('board-tool');

    // Z arms it; a click on the board outlines a zone there and opens Add zone beside it. Escape adds nothing.
    await window.locator('.react-flow__pane').click({ position: { x: 400, y: 300 } });
    await window.keyboard.press('z');
    await expect(zoneTool).toHaveAttribute('aria-pressed', 'true');
    // Clear of the empty board's welcome in the middle.
    await board.click({ position: { x: 200, y: 200 } });
    await expect(popover).toBeVisible();
    await expect(window.getByTestId('zone-outline')).toBeVisible();
    await expect(zoneTool).toHaveAttribute('aria-pressed', 'false');
    await window.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(window.getByTestId('zone-outline')).toHaveCount(0);
    expect(await storedZones(dataDir)).toEqual([]);

    // A drag sizes the zone; its name and colour are set at the foot of the popover (T1). The colours have names.
    await zoneTool.click();
    const box = (await board.boundingBox())!;
    await window.mouse.move(box.x + 150, box.y + 150);
    await window.mouse.down();
    await window.mouse.move(box.x + 350, box.y + 250, { steps: 4 });
    await window.mouse.move(box.x + 650, box.y + 510, { steps: 4 });
    await window.mouse.up();
    // A group first (AI1).
    await expect(popover.getByRole('tab', { name: 'Group' })).toHaveAttribute('aria-selected', 'true');
    await popover.getByRole('textbox', { name: 'Zone name' }).fill('Ideas');
    await expect(popover.getByRole('radio', { name: 'Teal' })).toHaveAttribute('title', '#12b886');
    await popover.getByRole('radio', { name: 'Teal' }).check();
    await popover.getByRole('textbox', { name: 'Zone name' }).press('Enter');
    await expect(popover).toBeHidden();
    const [stored] = await storedZones(dataDir);
    expect(stored).toMatchObject({ name: 'Ideas', color: '#12b886', repoRoot: null });
    // The board opens unzoomed, so the zone is as big as the drag.
    expect(stored!.width).toBeCloseTo(500, -1);
    expect(stored!.height).toBeCloseTo(360, -1);

    // A group starts agents too: its New agent isn't held back.
    await expect(zoneNamed(window, 'Ideas').getByRole('button', { name: 'New agent' })).not.toHaveAttribute('aria-disabled', 'true');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recolours a zone from 16 colours and sets its fill opacity, both saved and undone, the drag as one step', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await addEmptyZone(window, 'Ideas', 'Teal');
    const zone = zoneNamed(window, 'Ideas');
    await expect(zone).toBeVisible();
    const [stored] = await storedZones(dataDir);
    expect(stored).toMatchObject({ color: '#12b886', fillOpacity: null });

    // The zone menu offers all 16 colours by name, and the slider; a new colour is saved.
    const options = zone.getByRole('button', { name: 'Zone options' });
    await options.click();
    const colours = window.getByRole('group', { name: 'Colour' }).getByRole('menuitem');
    await expect(colours).toHaveCount(16);
    await window.getByRole('group', { name: 'Colour' }).getByRole('menuitem', { name: 'Graphite' }).click();
    await expect.poll(async () => (await storedZones(dataDir))[0]?.color).toBe('#495057');

    // Dragging the slider to 30% saves once the drag ends; the zone's fill and edge follow it.
    await options.click();
    const slider = window.locator('.ui-menu-slider input[type=range]');
    const track = (await slider.boundingBox())!;
    const y = track.y + track.height / 2;
    await window.mouse.move(track.x + track.width / 2, y);
    await window.mouse.down();
    for (const fraction of [0.6, 0.7, 0.75]) await window.mouse.move(track.x + track.width * fraction, y);
    await window.mouse.up();
    const percent = Number(await slider.inputValue());
    expect(percent).toBeGreaterThan(8);
    await expect.poll(async () => (await storedZones(dataDir))[0]?.fillOpacity).toBe(percent);
    await expect(zone).toHaveAttribute('data-fill', String(percent));
    await window.keyboard.press('Escape');

    // Outline only: 0% is a valid fill, and the zone keeps a visible edge.
    await options.click();
    await window.locator('.ui-menu-slider input[type=range]').fill('0');
    await window.locator('.ui-menu-slider input[type=range]').dispatchEvent('pointerup');
    await expect.poll(async () => (await storedZones(dataDir))[0]?.fillOpacity).toBe(0);
    await window.keyboard.press('Escape');

    // One undo takes back the whole 0% change (not a tick of the drag), the next the 30% before it.
    // Clicking empty zone floor gives the board the keyboard.
    const box = (await zone.boundingBox())!;
    await window.mouse.click(box.x + 12, box.y + box.height - 12);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await storedZones(dataDir))[0]?.fillOpacity).toBe(percent);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await storedZones(dataDir))[0]).toMatchObject({ fillOpacity: null, color: '#495057' });
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await storedZones(dataDir))[0]?.color).toBe('#12b886');
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});

test('the fill opacity slider is reached and set with the keyboard alone, and a drag that is put back or abandoned leaves nothing behind', async () => {
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir);
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await addEmptyZone(window, 'Ideas');
    const zone = zoneNamed(window, 'Ideas');
    const options = zone.getByRole('button', { name: 'Zone options' });
    const slider = window.getByRole('slider', { name: 'Fill opacity' });
    const fill = async () => (await storedZones(dataDir))[0]?.fillOpacity;

    // Arrowing down the menu from the last colour reaches the slider (not skipped, no focus trap): Right steps it, Down leaves it.
    await options.focus();
    await window.keyboard.press('Enter');
    await window.getByRole('menuitem', { name: 'Graphite' }).focus();
    await window.keyboard.press('ArrowDown');
    await expect(slider).toBeFocused();
    const start = Number(await slider.getAttribute('aria-valuenow'));
    await window.keyboard.press('ArrowRight');
    await window.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', String(start + 4));
    await expect.poll(fill).toBe(start + 4);
    await window.keyboard.press('End');
    await expect.poll(fill).toBe(40);
    await window.keyboard.press('Home');
    await expect.poll(fill).toBe(0);
    await window.keyboard.press('ArrowDown');
    await expect(slider).not.toBeFocused();
    await expect(window.getByRole('menuitem').filter({ hasText: /default repo/ })).toBeFocused();
    await window.keyboard.press('Escape');

    // Dragged away and back to where it began: nothing is saved, and the zone is drawn as saved.
    await options.click();
    const input = window.locator('.ui-menu-slider input[type=range]');
    const box = (await input.boundingBox())!;
    const y = box.y + box.height / 2;
    const begin = { x: box.x + 2, y };
    await window.mouse.move(begin.x, y);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width * 0.6, y);
    await expect(zone).toHaveAttribute('data-fill', /^(?!0$)\d+$/);
    await window.mouse.move(begin.x, y);
    await window.mouse.up();
    await expect(zone).toHaveAttribute('data-fill', '0');
    expect(await fill()).toBe(0);
    await window.keyboard.press('Escape');

    // Closed mid-drag: the preview is taken back.
    await options.click();
    await window.mouse.move(box.x + 2, y);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width * 0.8, y);
    await expect(zone).not.toHaveAttribute('data-fill', '0');
    await window.keyboard.press('Escape');
    await window.mouse.up();
    await expect(zone).toHaveAttribute('data-fill', '0');
    expect(await fill()).toBe(0);

    // Neither left an undo step: one undo takes back the keyboard's last change (End then Home: 40 to 0), not a drag.
    const floor = (await zone.boundingBox())!;
    await window.mouse.click(floor.x + 12, floor.y + floor.height - 12);
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(fill).toBe(40);
  } finally {
    await app.close().catch(() => {});
    await removeDataDir(dataDir);
  }
});
