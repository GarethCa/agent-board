import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeInTerminal, launch, spawnAgent, tile } from './agent-helpers.ts';
import { drag, settledBox } from './board-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone, connectedDaemonPid, launchApp, placeWithTool, stopDaemon } from './launch.ts';
import { scratch } from './scratch.ts';

async function addRepoZone(page: Page, app: Parameters<typeof pickFolderNext>[0], repo: string): Promise<void> {
  await pickFolderNext(app, repo);
  await browseForZone(page);
  await expect(page.getByTestId('zone')).toHaveCount(1);
}

/** Whether `inner`'s box has some height and lies inside `outer`'s. */
async function expectInside(inner: Locator, outer: Locator, what: string): Promise<void> {
  await expect(inner, what).toBeVisible();
  const [i, o] = [await settledBox(inner), await settledBox(outer)];
  expect(i.height, `${what} has height`).toBeGreaterThan(0);
  expect(i.y, `${what} top`).toBeGreaterThanOrEqual(o.y - 0.5);
  expect(i.y + i.height, `${what} bottom`).toBeLessThanOrEqual(o.y + o.height + 0.5);
}

const LONG_PROMPT = Array.from({ length: 40 }, (_, n) => `Line ${n + 1} of a very long prompt that goes on and on about the task`).join('\n');

test('a 40-line prompt never pushes a tile’s branch or state pill off its bottom', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await addRepoZone(window, app, repo);
    await spawnAgent(window, 'monorepo', LONG_PROMPT);
    await expect(tile(window)).toHaveCount(1);
    await expectInside(tile(window).locator('.hybrid-tile-branch'), tile(window), 'branch');
    await expectInside(tile(window).locator('.hybrid-tile-footer'), tile(window), 'footer');
    await expectInside(tile(window).locator('.hybrid-tile-footer .ui-status-pill, .hybrid-tile-footer [data-state]').last(), tile(window), 'state pill');
    // Whatever the tile says in place of its task, waiting or not, stays inside it.
    await expectInside(tile(window).locator('.hybrid-tile-body').first(), tile(window), 'body');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The size the board has saved for each resized tile, as JSON. */
const savedSizes = (page: Page) => page.evaluate(async () => JSON.stringify(await window.agentBoard.view.get('tileSizes')));

/** The selected tile's resize handle at `corner`. */
const handle = (page: Page, corner: string) => page.locator(`.react-flow__node.selected .tile-resize.${corner}`);

/** The node size of `of` (the agent tile unless told) on the board, unscaled by the zoom. */
const sizeOf = (page: Page, of: Locator = tile(page)) =>
  page.locator('.react-flow__node').filter({ has: of }).evaluate((node) => ({ width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));

/** Selects the tile `of` with a click on its body and drags its bottom-right handle by (dx, dy) on the screen. */
async function resizeBy(page: Page, of: Locator, dx: number, dy: number): Promise<void> {
  if ((await page.locator('.react-flow__node.selected .tile-resize').count()) === 0) {
    const box = await settledBox(of);
    await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
  }
  const corner = await settledBox(handle(page, 'bottom.right'));
  await drag(page, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: corner.x + corner.width / 2 + dx, y: corner.y + corner.height / 2 + dy });
}

/** How many lines of its task the tile shows. */
const shownLines = (page: Page) =>
  tile(page).getByTestId('tile-description').evaluate((element) => Math.round(element.clientHeight / parseFloat(getComputedStyle(element).lineHeight)));

test('a selected tile resizes from its handles, shows more of its task when bigger, keeps its footer at the least size, undoes, resets on a double-click and keeps its size across a restart', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await addRepoZone(window, app, repo);
    await spawnAgent(window, 'monorepo', LONG_PROMPT);
    await expect(tile(window)).toHaveCount(1);
    const initial = await sizeOf(window);
    const zoneBefore = await settledBox(window.getByTestId('zone'));

    // Handles only on a selected tile.
    await expect(window.locator('.tile-resize')).toHaveCount(0);
    const box = await settledBox(tile(window));
    await window.mouse.click(box.x + 40, box.y + box.height - 12);
    await expect(handle(window, 'bottom.right')).toBeVisible();
    const before = await shownLines(window);

    // Bigger: it shows more of its task, and its zone grows to hold it.
    const corner = await settledBox(handle(window, 'bottom.right'));
    await drag(window, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: corner.x + 300, y: corner.y + 380 });
    const bigger = await sizeOf(window);
    expect(bigger.width).toBeGreaterThan(initial.width + 100);
    expect(bigger.height).toBeGreaterThan(initial.height + 100);
    expect(await shownLines(window)).toBeGreaterThan(before);
    const zoneAfter = await settledBox(window.getByTestId('zone'));
    expect(zoneAfter.width * zoneAfter.height).toBeGreaterThan(zoneBefore.width * zoneBefore.height);
    await expect.poll(() => savedSizes(window)).toContain('"width"');

    // One undo takes the whole drag back; redo does it again.
    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => sizeOf(window)).toEqual(initial);
    await window.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => sizeOf(window)).toEqual(bigger);

    // Smallest, a long task still leaves its branch and state pill in view.
    const small = await settledBox(handle(window, 'bottom.right'));
    await drag(window, { x: small.x + small.width / 2, y: small.y + small.height / 2 }, { x: small.x - 600, y: small.y - 600 });
    const least = await sizeOf(window);
    expect(least.width).toBeLessThan(initial.width);
    await expectInside(tile(window).locator('.hybrid-tile-branch'), tile(window), 'branch at the least size');
    await expectInside(tile(window).locator('.hybrid-tile-footer'), tile(window), 'footer at the least size');

    // Resized again, it keeps the size across a restart.
    const again = await settledBox(handle(window, 'bottom.right'));
    await drag(window, { x: again.x + again.width / 2, y: again.y + again.height / 2 }, { x: again.x + 200, y: again.y + 120 });
    const kept = await sizeOf(window);
    await expect.poll(() => savedSizes(window)).toContain(`"width":${kept.width}`);
    ({ app, window } = await restart(app, window, dataDir, env));
    await expect(tile(window)).toHaveCount(1);
    await expect.poll(() => sizeOf(window)).toEqual(kept);

    // A double-click on a handle puts it back to the default.
    await tile(window).click({ position: { x: 40, y: 60 } });
    await handle(window, 'bottom.right').dblclick();
    await expect.poll(() => sizeOf(window)).toEqual(initial);
    await expect(window.getByTestId('expanded-tile')).toHaveCount(0);
    await expect.poll(() => savedSizes(window)).toBe('{}');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A full restart: the app and its daemon both go, so the board must come back from the database. */
async function restart(app: ElectronApplication, window: Page, dataDir: string, env: Record<string, string>) {
  const firstDaemon = await connectedDaemonPid(window);
  await app.close();
  expect([firstDaemon, undefined]).toContain(await stopDaemon(dataDir));
  return launch(dataDir, env);
}

/** Drags the tile `of` to its least size, from wherever it is, and returns that size. */
async function toLeastSize(page: Page, of: Locator) {
  await resizeBy(page, of, -700, -700);
  return sizeOf(page, of);
}

const LONG_COMMAND = Array.from({ length: 12 }, (_, n) => `echo step-${n + 1} && sleep 1`).join(' && ');

test('what a waiting agent asks never pushes its branch or state pill off the tile, at the default and the least size', async () => {
  const { dir, repo, env } = scratch('long-permission');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await addRepoZone(window, app, repo);
    await spawnAgent(window, 'monorepo', LONG_COMMAND);
    const ask = tile(window).getByTestId('tile-ask');
    await expect(ask).toBeVisible();
    // The ask is 300 characters or so: more than two lines of the tile.
    expect(await ask.evaluate((element) => element.querySelector('.hybrid-tile-text')!.scrollHeight > element.querySelector('.hybrid-tile-text')!.clientHeight)).toBe(true);
    for (const [where, check] of [['default', async () => {}], ['least', async () => void (await toLeastSize(window, tile(window)))]] as const) {
      await check();
      const agentTile = tile(window);
      await expectInside(agentTile.locator('.hybrid-tile-branch'), agentTile, `branch at the ${where} size`);
      await expectInside(agentTile.locator('.hybrid-tile-footer'), agentTile, `footer at the ${where} size`);
      // The ask never covers the footer: it is whole lines above it, or hidden when not one fits.
      const shown = await ask.evaluate((element) => getComputedStyle(element).visibility !== 'hidden');
      if (shown) {
        const [askBox, footerBox] = [await settledBox(ask), await settledBox(agentTile.locator('.hybrid-tile-footer'))];
        expect(askBox.y + askBox.height, `ask above the footer at the ${where} size`).toBeLessThanOrEqual(footerBox.y + 0.5);
      }
      await expect(ask).toHaveAttribute('title', /step-10/);
    }
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell tile resizes, keeps its size across a restart and resets on a double-click', async () => {
  const { dir, env } = scratch('output');
  const appEnv = { ...env, SHELL: '/bin/sh', AGENT_BOARD_LOGIN_SHELL: '0' };
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, appEnv);
  try {
    await placeWithTool(window, 'New shell', { x: 300, y: 260 });
    const shellTile = () => window.getByTestId('shell-tile');
    await expect(shellTile()).toHaveCount(1);
    // Its session window opened with it; the board is clear to select the tile once it is closed.
    await window.getByTestId('session-window').getByRole('button', { name: 'Close session window' }).click();
    await expect(window.getByTestId('session-window')).toHaveCount(0);
    const initial = await sizeOf(window, shellTile());
    await resizeBy(window, shellTile(), 160, 120);
    const bigger = await sizeOf(window, shellTile());
    expect(bigger.width).toBeGreaterThan(initial.width + 100);
    await expect.poll(() => savedSizes(window)).toContain(`"width":${bigger.width}`);
    ({ app, window } = await restart(app, window, dataDir, appEnv));
    await expect.poll(() => sizeOf(window, shellTile())).toEqual(bigger);
    await shellTile().click({ position: { x: 40, y: 60 } });
    await handle(window, 'bottom.right').dblclick();
    await expect.poll(() => sizeOf(window, shellTile())).toEqual(initial);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an external session tile resizes and resets on a double-click', async () => {
  const { dir, repo, env } = scratch('waiting');
  const home = env.HOME!;
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  const dataDir = tempDataDir();
  const app = await launchApp(dataDir, { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') });
  let session: ReturnType<typeof claudeInTerminal> | undefined;
  try {
    const window = await app.firstWindow();
    await connectedDaemonPid(window);
    await addRepoZone(window, app, repo);
    await window.getByRole('button', { name: 'Settings', exact: true }).click();
    const toggle = window.getByRole('switch', { name: 'Show sessions from other terminals' });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await window.keyboard.press('Escape');
    // Started once the hooks are on, as the session is then reported.
    session = claudeInTerminal(repo, home, ['Pick a database'], 'waiting');
    session.stdout.resume();
    session.stderr.resume();
    const external = window.getByTestId('external-tile');
    await expect(external).toHaveCount(1);
    const initial = await sizeOf(window, external);
    await resizeBy(window, external, 140, 100);
    const bigger = await sizeOf(window, external);
    expect(bigger.width).toBeGreaterThan(initial.width + 80);
    await handle(window, 'bottom.right').dblclick();
    await expect.poll(() => sizeOf(window, external)).toEqual(initial);
  } finally {
    session?.kill();
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shrinking a zone stops at a resized tile, which never moves', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await addRepoZone(window, app, repo);
    await spawnAgent(window, 'monorepo', 'Fix the login page');
    await expect(tile(window)).toHaveCount(1);
    await resizeBy(window, tile(window), 200, 80);
    const place = () => window.locator('.react-flow__node').filter({ has: tile(window) }).evaluate((node) => (node as HTMLElement).style.transform);
    const placed = await place();
    const zone = window.getByTestId('zone');
    const before = await settledBox(zone);
    // Selected by its tab's kind label: its middle is one of its buttons.
    await zone.getByTestId('zone-tab').click({ position: { x: 12, y: 12 } });
    const corner = await settledBox(zone.locator('.react-flow__resize-control.handle.bottom.right'));
    await drag(window, { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }, { x: corner.x - 500, y: corner.y - 300 });
    const after = await settledBox(zone);
    const held = await settledBox(tile(window));
    expect(after.width).toBeLessThan(before.width);
    // It stopped at the tile's edge, and the tile stayed where it was.
    expect(held.x + held.width).toBeLessThanOrEqual(after.x + after.width + 0.5);
    expect(held.y + held.height).toBeLessThanOrEqual(after.y + after.height + 0.5);
    expect(await place()).toBe(placed);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
