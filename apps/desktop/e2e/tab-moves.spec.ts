import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, setClickOpens, SHELL_ENV, spawnAgent, TURN_MS, windowKey } from './agent-helpers.ts';
import { browseForZone, connectedDaemonPid, launchApp, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const undoKey = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`;

const agentTile = (page: Page, id: string) => page.locator(`[data-testid="agent-tile"][data-session-id="${id}"]`);
const expandedAgent = (page: Page, id: string) => page.locator(`[data-testid="expanded-tile"][data-session-id="${id}"]`);
const tabsOf = (scope: Locator) => scope.getByTestId('session-tab');
const tabNamed = (scope: Locator, name: string) => tabsOf(scope).filter({ has: scope.page().getByRole('tab', { name, exact: true }) });
const shellTiles = (page: Page) => page.getByTestId('shell-tile');
/** A window's panes, each with a strip of its own once there are several. */
const panesOf = (scope: Locator) => scope.getByTestId('window-pane');
/** The tab views its panes show. */
const shownViews = (scope: Locator) => scope.locator('[data-testid="session-tab-view"]:not([hidden])');
/** A point just inside the right or bottom edge of the element, where a dropped tab splits it. */
const nearEdge = async (element: Locator, edge: 'right' | 'bottom') => {
  const box = (await element.boundingBox())!;
  return edge === 'right' ? { x: box.x + box.width - 12, y: box.y + box.height / 2 } : { x: box.x + box.width / 2, y: box.y + box.height - 12 };
};

/** Every shell the daemon has, tiles and tabs. */
const shells = (page: Page) => page.evaluate(() => window.agentBoard.shells.list());
/** Whether the session still runs, never restarted. */
const running = async (page: Page, sessionId: string) =>
  (await page.evaluate(() => window.agentBoard.sessions.list())).some((session) => session.id === sessionId && session.endedAt === null);
/** The shell holding the pane, and whose it is. */
const holderOf = async (page: Page, sessionId: string) => {
  const holder = (await shells(page)).find((shell) => JSON.stringify(shell.layout).includes(sessionId));
  return holder && { id: holder.id, owner: holder.owner, name: holder.name };
};

/** Drags `from` (HTML5 drag and drop) to the point on the screen, in steps, as a hand would. */
async function dragTo(from: Locator, to: { x: number; y: number }): Promise<void> {
  const page = from.page();
  const start = (await from.boundingBox())!;
  await page.mouse.move(start.x + Math.min(20, start.width / 2), start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.mouse.up();
}

/** Zooms the board out until `nodes` are all in view: an expanded tile is as big as the window at full size. */
async function zoomOutTo(page: Page, ...nodes: Locator[]): Promise<void> {
  const inView = async () => {
    const boxes = await Promise.all(nodes.map((node) => node.boundingBox()));
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    // Clear of the islands at the board's top and corners.
    return boxes.every((box) => box !== null && box.y > 70 && box.x > 0 && box.y + box.height < size.height - 80 && box.x + box.width < size.width - 220);
  };
  for (let step = 0; step < 6 && !(await inView()); step += 1) {
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.waitForTimeout(300);
  }
  expect(await inView()).toBe(true);
}

/** Waits for opened tiles to finish opening and everything moved out of their way to stop, then for them all to be in view. */
async function settled(page: Page, ...nodes: Locator[]): Promise<void> {
  await expect(page.locator('[data-testid="expanded-tile"][data-opening]')).toHaveCount(0);
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await Promise.all(nodes.map((node) => node.boundingBox())));
        const still = now === last;
        last = now;
        return still;
      },
      // Under a loaded machine the board takes a while to ease everything clear.
      { intervals: [300], timeout: 20_000 },
    )
    .toBe(true);
  await zoomOutTo(page, ...nodes);
}

/** Presses ⌘Z (Ctrl+Z off macOS) once the board has the keyboard back from the window a move changed. */
async function undo(page: Page, redo = false): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.xterm, input, textarea') == null)).toBe(true);
  await page.keyboard.press(redo ? `${undoKey.split('+')[0]}+Shift+z` : undoKey);
}

/** A point of bare board on the screen, clear of tiles, windows and the islands over the board, zoomed out to make one. */
async function bareBoard(page: Page): Promise<{ x: number; y: number }> {
  for (let step = 0; step < 6; step += 1) {
    const found = await bareBoardInView(page, { x: 140, y: 80 });
    if (found !== undefined) return found;
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.waitForTimeout(300);
  }
  throw new Error('no bare board in view');
}

/** A point of bare board in view with bare board `reach` round it too, if there is one. */
const bareBoardInView = (page: Page, reach: { x: number; y: number }) =>
  page.evaluate((reach) => {
    for (let y = reach.y + 10; y < window.innerHeight - reach.y - 10; y += 20) {
      for (let x = window.innerWidth - reach.x - 10; x > reach.x + 10; x -= 20) {
        const bare = (element: Element | null) => element?.classList.contains('react-flow__pane') === true || element?.classList.contains('zone') === true;
        const clear = [-reach.x, 0, reach.x].every((dx) => [-reach.y, 0, reach.y].every((dy) => bare(document.elementFromPoint(x + dx, y + dy))));
        if (clear) return { x, y };
      }
    }
    return undefined;
  }, reach);

/** The middle of the element on the screen. */
const middleOf = async (element: Locator) => {
  const box = (await element.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("a shell tab drags onto another agent's tile, the board and another window's tabs, a shell tile onto an agent, and each move undoes with ⌘Z, the shell never restarting", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await setClickOpens(window, 'Expand in place');
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    await spawnAgent(window, 'monorepo', 'Review the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(2, { timeout: TURN_MS });
    const [impl, review] = await agents(window);

    // A shell tab in the implementer's window, with output of its own.
    await agentTile(window, impl!.sessionId).dblclick();
    const implWindow = expandedAgent(window, impl!.sessionId);
    await implWindow.getByTestId('session-terminal').first().click();
    await window.keyboard.press(windowKey('t'));
    await expect(tabsOf(implWindow)).toHaveCount(2);
    // An expanded tile's terminal waits to be clicked before it takes the keyboard.
    await implWindow.locator('[data-testid="session-tab-view"]:not([hidden])').getByTestId('session-terminal').click();
    await window.keyboard.type('echo moved-$((6 * 7))');
    await window.keyboard.press('Enter');
    await expect(implWindow.locator('[data-testid="session-tab-view"]:not([hidden]) .xterm-rows')).toContainText('moved-42');
    const tab = (await shells(window)).find((shell) => shell.owner?.id === impl!.sessionId)!;
    const pane = JSON.stringify(tab.layout).match(/"sessionId":"([^"]+)"/)![1]!;
    await zoomOutTo(window, implWindow, agentTile(window, review!.sessionId));

    // Onto the reviewer's tile: one of its tabs now, the same shell running.
    await dragTo(tabNamed(implWindow, 'sh'), await middleOf(agentTile(window, review!.sessionId)));
    await expect(tabsOf(implWindow)).toHaveCount(1);
    await expect(agentTile(window, review!.sessionId).getByTestId('tile-shells')).toContainText('1 shell');
    expect(await holderOf(window, pane)).toEqual({ id: tab.id, owner: { kind: 'agent', id: review!.sessionId }, name: 'sh' });
    expect(await running(window, pane)).toBe(true);

    // ⌘Z puts it back in the implementer's tabs.
    await undo(window);
    await expect(tabsOf(implWindow)).toHaveCount(2);
    await expect(agentTile(window, review!.sessionId).getByTestId('tile-shells')).toHaveCount(0);

    // Onto bare board: a shell tile of its own where it is dropped, named as the tab was.
    await dragTo(tabNamed(implWindow, 'sh'), await bareBoard(window));
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(shellTiles(window)).toContainText('sh');
    await expect(tabsOf(implWindow)).toHaveCount(1);
    expect((await holderOf(window, pane))?.owner).toBeNull();
    expect(await running(window, pane)).toBe(true);

    // The shell tile dragged onto the implementer's window: one of its tabs again, not a tile.
    const tileBox = (await shellTiles(window).boundingBox())!;
    const windowBox = (await implWindow.getByTestId('session-terminal').first().boundingBox())!;
    await window.mouse.move(tileBox.x + 40, tileBox.y + 20);
    await window.mouse.down();
    await window.mouse.move(windowBox.x + windowBox.width / 2, windowBox.y + windowBox.height / 2, { steps: 16 });
    await expect(implWindow.locator('.session-window-body')).toHaveAttribute('data-drop-over', 'true');
    await window.mouse.up();
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(tabsOf(implWindow)).toHaveCount(2);
    expect((await holderOf(window, pane))?.owner).toEqual({ kind: 'agent', id: impl!.sessionId });

    // ⌘Z: a tile again, where it was.
    await undo(window);
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(tabsOf(implWindow)).toHaveCount(1);
    await undo(window, true);
    await expect(tabsOf(implWindow)).toHaveCount(2);

    // Into the reviewer's own window's tabs, where an amber hint says whose worktree it runs in.
    await agentTile(window, review!.sessionId).dblclick();
    const reviewWindow = expandedAgent(window, review!.sessionId);
    await expect(tabsOf(reviewWindow)).toHaveCount(1);
    await settled(window, implWindow, reviewWindow);
    await dragTo(tabNamed(implWindow, 'sh'), await middleOf(reviewWindow.getByTestId('session-tabs')));
    await expect(tabsOf(reviewWindow)).toHaveCount(2);
    await expect(tabsOf(implWindow)).toHaveCount(1);
    await expect(reviewWindow.getByTestId('session-window-astray')).toHaveText(`sh runs in ${impl!.name}'s worktree`);
    await tabNamed(reviewWindow, 'sh').getByRole('tab').click();
    await expect(reviewWindow.locator('[data-testid="session-tab-view"]:not([hidden]) .xterm-rows')).toContainText('moved-42');
    expect(await running(window, pane)).toBe(true);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pane of a shell tile's split drags out onto the board as a shell tile of its own, and ⌘Z puts it back in the split", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await setClickOpens(window, 'Expand in place');
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    await expect(shellTiles(window)).toHaveCount(1);
    if (await sessionWindow(window).isVisible()) await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await shellTiles(window).dblclick();
    const tileWindow = window.getByTestId('expanded-tile');
    // Its own panes split from its details, tmux-style.
    await tileWindow.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Split horizontally' }).click();
    const panes = tileWindow.locator('[data-testid="session-tab-view"]:not([hidden])').getByTestId('shell-pane');
    await expect(panes).toHaveCount(2);
    const pane = (await panes.nth(1).getAttribute('data-session-id'))!;
    const tileId = (await holderOf(window, pane))!.id;

    // The tile itself shows expanded, so the only shell tile on the board is the pane's own.
    await dragTo(panes.nth(1).getByTestId('shell-pane-head'), await bareBoard(window));
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(panes).toHaveCount(1);
    expect(await holderOf(window, pane)).toMatchObject({ owner: null });
    expect((await holderOf(window, pane))?.id).not.toBe(tileId);
    expect(await running(window, pane)).toBe(true);

    await undo(window);
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(panes).toHaveCount(2);
    expect((await holderOf(window, pane))?.id).toBe(tileId);
    expect(await running(window, pane)).toBe(true);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shell tab drags out of an agent's session window onto the board beside it, the window staying open, and ⌘Z takes it back", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    const [impl] = await agents(window);
    await agentTile(window, impl!.sessionId).dblclick();
    const implWindow = sessionWindow(window);
    await expect(implWindow).toBeVisible();
    await window.keyboard.press(windowKey('t'));
    await expect(tabsOf(implWindow)).toHaveCount(2);
    const tab = (await shells(window)).find((shell) => shell.owner?.id === impl!.sessionId)!;
    const pane = JSON.stringify(tab.layout).match(/"sessionId":"([^"]+)"/)![1]!;

    // Onto the board beside the window: a tile there, the window left open.
    // Not zoomed out to make room: a click on the board's chrome would minimise the window.
    const beside = await bareBoardInView(window, { x: 20, y: 12 });
    expect(beside).toBeDefined();
    await dragTo(tabNamed(implWindow, 'sh'), beside!);
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(tabsOf(implWindow)).toHaveCount(1);
    await expect(implWindow).toBeVisible();
    expect(await running(window, pane)).toBe(true);

    await undo(window);
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(tabsOf(implWindow)).toHaveCount(2);
    expect((await holderOf(window, pane))?.owner).toEqual({ kind: 'agent', id: impl!.sessionId });
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a window's tabs drag onto a pane's edge to split it and onto another pane's strip, a pane that loses its last tab closes, another agent shows as a tab, and the panes are kept across a restart", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  let relaunched: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    await spawnAgent(window, 'monorepo', 'Review the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(2, { timeout: TURN_MS });
    const [impl, review] = await agents(window);
    await agentTile(window, impl!.sessionId).dblclick();
    const win = sessionWindow(window);
    const agentView = win.locator('[data-testid="session-tab-view"][data-tab="own"]');
    await expect(agentView).toContainText('Which database should I use', { timeout: TURN_MS });
    // Its terminal is tagged, to tell that the moves keep it, attached, rather than mounting it afresh.
    await agentView.locator('.xterm').evaluate((element) => ((element as HTMLElement).dataset.kept = 'yes'));
    // The agent's own tab, alone, let go in the middle of its pane, stays where it is, and nothing throws.
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(error.message));
    await dragTo(tabNamed(win, 'claude'), await middleOf(agentView));
    await expect(tabsOf(win)).toHaveText(['claude']);
    expect(errors).toEqual([]);
    await window.keyboard.press(windowKey('t'));
    await window.keyboard.press(windowKey('t'));
    await expect(tabsOf(win)).toHaveText(['claude', 'sh', 'sh 2']);
    // A tab dropped back where it is stays: let go on its own strip or in the middle of its pane.
    await dragTo(tabNamed(win, 'sh 2'), await middleOf(shownViews(win)));
    await expect(tabsOf(win)).toHaveText(['claude', 'sh', 'sh 2']);
    // The agent's own tab has no ×; every other does.
    await expect(tabNamed(win, 'claude').getByRole('button', { name: 'Close claude' })).toHaveCount(0);

    // Onto the right edge of its pane: a new pane there, holding and showing it.
    await dragTo(tabNamed(win, 'sh 2'), await nearEdge(shownViews(win), 'right'));
    await expect(panesOf(win)).toHaveCount(2);
    await expect(panesOf(win).nth(0).getByTestId('session-tab')).toHaveText(['claude', 'sh']);
    await expect(panesOf(win).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);
    // A pane's only tab let go on its own strip, or in the middle of its own pane, leaves the pane as it is.
    await dragTo(tabNamed(win, 'sh 2'), await middleOf(panesOf(win).nth(1).getByTestId('session-tabs')));
    await expect(panesOf(win)).toHaveCount(2);
    await expect(panesOf(win).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);
    await dragTo(tabNamed(win, 'sh 2'), await middleOf(win.locator('[data-testid="session-tab-view"][data-pane]:not([hidden])').nth(1)));
    await expect(panesOf(win)).toHaveCount(2);
    await expect(panesOf(win).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);

    // Onto the other pane's strip, after its tab; then the agent's own too, and the pane it leaves closes.
    await dragTo(tabNamed(win, 'sh'), await middleOf(panesOf(win).nth(1).getByTestId('session-tabs')));
    await expect(panesOf(win).nth(0).getByTestId('session-tab')).toHaveText(['claude']);
    await expect(panesOf(win).nth(1).getByTestId('session-tab')).toHaveText(['sh 2', 'sh']);
    await dragTo(tabNamed(win, 'claude'), await middleOf(panesOf(win).nth(1).getByTestId('session-tabs')));
    await expect(panesOf(win)).toHaveCount(0);
    await expect(tabsOf(win)).toHaveText(['sh 2', 'sh', 'claude']);
    await expect(tabNamed(win, 'claude')).toHaveAttribute('data-active', 'true');
    await expect(agentView.locator('.xterm[data-kept="yes"]')).toHaveCount(1);

    // + shows another agent's session as a tab, its own still: × only takes the tab away.
    await win.getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: review!.name }).click();
    await expect(tabNamed(win, review!.name)).toHaveAttribute('data-active', 'true');
    const reviewView = win.locator(`[data-testid="session-tab-view"][data-tab="session:agent:${review!.sessionId}"]`);
    await expect(reviewView).toContainText('Which database should I use', { timeout: TURN_MS });
    await tabNamed(win, review!.name).getByRole('button', { name: `Close ${review!.name}` }).click();
    await expect(tabsOf(win)).toHaveCount(3);
    expect(await running(window, review!.sessionId)).toBe(true);

    // Shown again, below the rest: the window is kept as it is laid out, across a restart.
    await win.getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: review!.name }).click();
    await dragTo(tabNamed(win, review!.name), await nearEdge(shownViews(win), 'bottom'));
    await expect(panesOf(win)).toHaveCount(2);
    await expect(panesOf(win).nth(1).getByTestId('session-tab')).toHaveText([review!.name]);
    // No shell is lost, restarted or doubled by the restart: the same rows, the same live sessions.
    const sessionsNow = async (page: Page) => (await page.evaluate(() => globalThis.window.agentBoard.sessions.list())).filter((session) => session.endedAt === null).map((session) => session.id).sort();
    const shellsBefore = (await shells(window)).map((shell) => shell.id).sort();
    const sessionsBefore = await sessionsNow(window);
    await app.close();
    relaunched = await launchApp(dataDir, env);
    const again = await relaunched.firstWindow();
    await connectedDaemonPid(again);
    const winAgain = sessionWindow(again);
    expect((await shells(again)).map((shell) => shell.id).sort()).toEqual(shellsBefore);
    expect(await sessionsNow(again)).toEqual(sessionsBefore);
    await expect(panesOf(winAgain)).toHaveCount(2);
    await expect(panesOf(winAgain).nth(0).getByTestId('session-tab')).toHaveText(['sh 2', 'sh', 'claude']);
    await expect(panesOf(winAgain).nth(1).getByTestId('session-tab')).toHaveText([review!.name]);
  } finally {
    await (relaunched ?? app).close().catch(() => {});
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tab dropped on the edge of a pane in another agent's window splits it there, and ⌘Z puts it back in the pane it left", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await setClickOpens(window, 'Expand in place');
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    await spawnAgent(window, 'monorepo', 'Review the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(2, { timeout: TURN_MS });
    const [impl, review] = await agents(window);

    // The implementer's window: the agent, and a pane beside it with two shell tabs.
    await agentTile(window, impl!.sessionId).dblclick();
    const implWindow = expandedAgent(window, impl!.sessionId);
    await implWindow.getByTestId('session-terminal').first().click();
    await window.keyboard.press(windowKey('d'));
    await expect(panesOf(implWindow)).toHaveCount(2);
    await window.keyboard.press(windowKey('t'));
    await expect(panesOf(implWindow).nth(1).getByTestId('session-tab')).toHaveText(['sh', 'sh 2']);
    const moved = (await shells(window)).find((shell) => shell.owner?.id === impl!.sessionId && shell.name === 'sh')!;
    const pane = JSON.stringify(moved.layout).match(/"sessionId":"([^"]+)"/)![1]!;

    await agentTile(window, review!.sessionId).dblclick();
    const reviewWindow = expandedAgent(window, review!.sessionId);
    await settled(window, implWindow, reviewWindow);

    // Onto the right edge of the reviewer's pane: a pane of its own there, the same shell running.
    await dragTo(tabNamed(implWindow, 'sh'), await nearEdge(shownViews(reviewWindow), 'right'));
    await expect(panesOf(reviewWindow)).toHaveCount(2);
    await expect(panesOf(reviewWindow).nth(1).getByTestId('session-tab')).toHaveText(['sh']);
    await expect(panesOf(implWindow).nth(1).getByTestId('session-tab')).toHaveText(['sh 2']);
    expect((await holderOf(window, pane))?.owner).toEqual({ kind: 'agent', id: review!.sessionId });
    expect(await running(window, pane)).toBe(true);

    // ⌘Z: back in the implementer's window, in the pane and place it left, and the reviewer's pane closes.
    await undo(window);
    await expect(panesOf(implWindow).nth(1).getByTestId('session-tab')).toHaveText(['sh', 'sh 2']);
    await expect(panesOf(reviewWindow)).toHaveCount(0);
    expect(await running(window, pane)).toBe(true);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a window whose shells can't be listed, or whose layout can't be read, says so and keeps the saved layout rather than saving over it", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    const [impl] = await agents(window);
    await agentTile(window, impl!.sessionId).dblclick();
    const win = sessionWindow(window);
    await expect(win.locator('[data-testid="session-tab-view"][data-tab="own"]')).toContainText('Which database should I use', { timeout: TURN_MS });
    await window.keyboard.press(windowKey('t'));
    await expect(tabsOf(win)).toHaveCount(2);
    await window.keyboard.press(windowKey('d'));
    await expect(panesOf(win)).toHaveCount(2);
    await win.getByRole('button', { name: 'Close session window' }).click();
    const owner = { kind: 'agent', id: impl!.sessionId } as const;
    const kept = await window.evaluate((owner) => globalThis.window.agentBoard.shells.windowLayout(owner), owner);
    expect(kept).not.toBeNull();

    // The main process refuses the list, and records any save rather than making it.
    await app.evaluate(({ ipcMain }) => {
      const saves: unknown[] = [];
      (globalThis as unknown as { saves: unknown[] }).saves = saves;
      ipcMain.removeHandler('shell:list');
      ipcMain.handle('shell:list', () => {
        throw new Error('refused for the test');
      });
      ipcMain.removeHandler('shell:setWindowLayout');
      ipcMain.handle('shell:setWindowLayout', (_event, _owner, layout) => {
        saves.push(layout);
        throw new Error('not saved in the test');
      });
    });
    const saves = () => app.evaluate(() => (globalThis as unknown as { saves: unknown[] }).saves.length);
    await agentTile(window, impl!.sessionId).dblclick();
    await window.waitForTimeout(1500);
    expect(await saves()).toBe(0);
    await expect(win.getByTestId('session-window-status')).toContainText('could not list the shells');
    await win.getByRole('button', { name: 'Close session window' }).click();

    // Its layout can't be read either: it says so, and still saves nothing.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('shell:unsplitTabs');
      ipcMain.handle('shell:unsplitTabs', () => {
        throw new Error('refused for the test');
      });
    });
    await agentTile(window, impl!.sessionId).dblclick();
    await window.waitForTimeout(1500);
    expect(await saves()).toBe(0);
    await expect(win.getByTestId('session-window-status')).toContainText('could not read how the window was laid out');
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another agent shown as a tab in the background neither resizes its terminal nor marks its ask seen; shown, it does", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    await spawnAgent(window, 'monorepo', 'Review the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(2, { timeout: TURN_MS });
    const [impl, review] = await agents(window);
    const sizeOf = async (sessionId: string) => {
      const session = (await window.evaluate(() => globalThis.window.agentBoard.sessions.list())).find((each) => each.id === sessionId)!;
      return { cols: session.cols, rows: session.rows };
    };
    const seen = async (sessionId: string) => (await agents(window)).find((agent) => agent.sessionId === sessionId)!.seen;
    await expect.poll(async () => (await agents(window)).find((agent) => agent.sessionId === review!.sessionId)!.state, { timeout: TURN_MS }).toBe('waiting');
    expect(await seen(review!.sessionId)).toBe(false);
    const size = await sizeOf(review!.sessionId);
    expect(size.cols).not.toBe(80);

    // The implementer's window keeps the reviewer as a tab behind its own.
    await window.evaluate(
      ({ owner, target }) =>
        globalThis.window.agentBoard.shells.setWindowLayout(owner, {
          type: 'pane',
          id: 'main',
          tabs: [{ kind: 'own' }, { kind: 'session', target }],
          active: 'own',
        }),
      { owner: { kind: 'agent', id: impl!.sessionId } as const, target: { kind: 'agent', id: review!.sessionId } as const },
    );
    await agentTile(window, impl!.sessionId).dblclick();
    const win = sessionWindow(window);
    await expect(tabNamed(win, review!.name)).toBeVisible();
    await expect(win.locator(`[data-testid="session-tab-view"][data-tab="session:agent:${review!.sessionId}"]`)).toBeHidden();
    await window.waitForTimeout(1500);
    expect(await sizeOf(review!.sessionId)).toEqual(size);
    expect(await seen(review!.sessionId)).toBe(false);

    // Shown, it is seen.
    await tabNamed(win, review!.name).getByRole('tab').click();
    await expect.poll(() => seen(review!.sessionId)).toBe(true);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tab split inside itself before windows had panes is laid out as panes as its window opens, no shell restarting", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    const [impl] = await agents(window);
    // The agent's own tab split as AS3's ⌘D split it: a shell beside the agent, in the same tab.
    const old = await window.evaluate(async (agentId) => {
      const own = await globalThis.window.agentBoard.shells.ownTab(agentId);
      return globalThis.window.agentBoard.shells.split(own.id, agentId, 'horizontal');
    }, impl!.sessionId);
    const shellPane = JSON.stringify(old.layout).match(/"sessionId":"([^"]+)"[^"]*$/)![1]!;
    expect(shellPane).not.toBe(impl!.sessionId);

    await agentTile(window, impl!.sessionId).dblclick();
    const win = sessionWindow(window);
    await expect(panesOf(win)).toHaveCount(2);
    await expect(panesOf(win).nth(0).getByTestId('session-tab')).toHaveText(['claude']);
    await expect(panesOf(win).nth(1).getByTestId('session-tab')).toHaveText(['sh']);
    expect((await holderOf(window, shellPane))?.owner).toEqual({ kind: 'agent', id: impl!.sessionId });
    expect(await running(window, shellPane)).toBe(true);
    // The agent's own tab holds the agent alone again.
    await expect.poll(async () => (await shells(window)).filter((shell) => shell.owner?.id === impl!.sessionId).map((shell) => JSON.stringify(shell.layout).match(/sessionId/g)!.length)).toEqual([1, 1]);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
