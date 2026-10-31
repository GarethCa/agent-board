import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, SHELL_ENV, spawnAgent, TURN_MS, windowKey } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { serveWebPages } from './web-server.ts';

// Dragging tabs to and from popped-out OS windows (slice 4). Popped-out windows paint offscreen here, where
// no pointer reaches across windows, so each drag between two windows is played as the platform would deliver it, to
// the app's own handlers: a `dragstart` on the tab in one window, the `dragover` and `drop` in the window it is let go
// over, and the `dragend` back in the first, with whether a window took it. Where the pointer is as a drag no window
// took ends is main's to read from the OS: the test sets it (`pointerAt`), the one stand-in for the platform in main.

const TAB_DRAG_TYPE = 'application/x-agent-board-tab';
const undoKey = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`;
const redoKey = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+z`;
/** Far off every window and display. */
const OFF_EVERY_WINDOW = { x: -40_000, y: -40_000 };

const agentTile = (page: Page, id: string) => page.locator(`[data-testid="agent-tile"][data-session-id="${id}"]`);
const tabsOf = (scope: Locator) => scope.getByTestId('session-tab');
const tabNamed = (scope: Locator, name: string) => tabsOf(scope).filter({ has: scope.page().getByRole('tab', { name, exact: true }) });
const shellTiles = (page: Page) => page.getByTestId('shell-tile');
const shownTab = (scope: Locator) => scope.locator('[data-testid="session-tab-view"]:not([hidden])');

const shells = (page: Page) => page.evaluate(() => window.agentBoard.shells.list());
const running = async (page: Page, sessionId: string) =>
  (await page.evaluate(() => window.agentBoard.sessions.list())).some((session) => session.id === sessionId && session.endedAt === null);
const ownerOf = async (page: Page, sessionId: string) => (await shells(page)).find((shell) => JSON.stringify(shell.layout).includes(sessionId))?.owner;

/** Starts dragging `from` as the platform would: returns the drag's data, for the window it is let go over. */
async function startDrag(from: Locator): Promise<string> {
  return from.evaluate((element, type) => {
    const data = new DataTransfer();
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    (window as unknown as { e2eDrag: { element: Element; data: DataTransfer } }).e2eDrag = { element, data };
    return data.getData(type);
  }, TAB_DRAG_TYPE);
}

/** Puts the OS pointer at `point` on the screen, as main reads it (`screen.getCursorScreenPoint`). */
async function pointerAt(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  await app.evaluate(({ screen }, at) => {
    screen.getCursorScreenPoint = () => at;
  }, point);
}

/** Ends the drag `startDrag` began in `page`: taken by a window (`move`) or by none (`none`). */
async function endDrag(page: Page, dropEffect: 'move' | 'none'): Promise<void> {
  await page.evaluate((dropEffect) => {
    const { element, data } = (window as unknown as { e2eDrag: { element: Element; data: DataTransfer } }).e2eDrag;
    // Chromium keeps a script-made DataTransfer's dropEffect at none: the platform's says what the drop did.
    Object.defineProperty(data, 'dropEffect', { value: dropEffect });
    element.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  }, dropEffect);
}

/** Ends the drag `startDrag` began in `page` taken by no window, let go with the pointer at `point` on the screen. */
async function letGo(app: ElectronApplication, page: Page, point: { x: number; y: number }): Promise<void> {
  await pointerAt(app, point);
  await endDrag(page, 'none');
}

/**
 * Fires a drag event at the point of `page`, at whatever is there, as the platform delivers it: a `dragover` names the
 * drag's type but can't read its data (Chromium hides it until the drop), and only the `drop` carries it. The app goes
 * by the drag main told every window of, not the data.
 */
async function dragEventAt(page: Page, type: 'dragover' | 'drop', point: { x: number; y: number }, json: string): Promise<boolean> {
  return page.evaluate(
    ({ type, point, json, dataType }) => {
      const data = new DataTransfer();
      data.setData(dataType, type === 'drop' ? json : '');
      const target = document.elementFromPoint(point.x, point.y) ?? document.body;
      if (type === 'dragover') target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: data }));
      // Whether the window took it: a drop target there cancels it.
      return !target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: data }));
    },
    { type, point, json, dataType: TAB_DRAG_TYPE },
  );
}

/** Holds the drag over the point of `page` until the window there would take it, as it does once it has heard of the drag. */
async function holdOver(page: Page, point: { x: number; y: number }, json: string): Promise<void> {
  await expect.poll(() => dragEventAt(page, 'dragover', point, json)).toBe(true);
}

const middleOf = async (element: Locator) => {
  const box = (await element.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/**
 * Drags `from` (in one window) and lets it go over `onto` (in another), which shows it would land there first (once
 * that window has heard of the drag): played as the platform would deliver it.
 */
/**
 * …and the drag ends back in the first window as the platform says it went (`ended`): `none` when the drop over another
 * window doesn't reach it, which must still pop nothing out, as that window took it.
 */
async function dragAcross(
  from: Locator,
  onto: Locator,
  halo: Locator = onto,
  shows: { attribute: string; value: string } = { attribute: 'data-drop-over', value: 'true' },
  ended: 'move' | 'none' = 'move',
): Promise<void> {
  const json = await startDrag(from);
  const point = await middleOf(onto);
  await expect
    .poll(async () => {
      await dragEventAt(onto.page(), 'dragover', point, json);
      return halo.getAttribute(shows.attribute);
    })
    .toBe(shows.value);
  await dragEventAt(onto.page(), 'drop', point, json);
  // The window it came from may have closed with it, its last tab gone: its drag ends with it.
  if (!from.page().isClosed()) await endDrag(from.page(), ended).catch((error: unknown) => {
    if (!from.page().isClosed()) throw error;
  });
}

/** Drags `from` out of every window and lets it go: it pops out into an OS window of its own, which is returned. */
async function dragOut(app: ElectronApplication, from: Locator): Promise<Page> {
  await startDrag(from);
  // A pop-out's page, not a web tab's loading meanwhile.
  const [popped] = await Promise.all([app.waitForEvent('window', (page) => page.url().includes('popOut=')), letGo(app, from.page(), OFF_EVERY_WINDOW)]);
  return popped;
}

/** Presses ⌘Z (⇧⌘Z to redo) in `page` once its keyboard is out of its terminals. */
async function undoIn(page: Page, redo = false): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.xterm, input, textarea') == null)).toBe(true);
  await page.keyboard.press(redo ? redoKey : undoKey);
}

/** A point of bare board in view on the board's window. */
const bareBoard = (page: Page) =>
  page.evaluate(() => {
    for (let y = 120; y < window.innerHeight - 120; y += 20) {
      for (let x = window.innerWidth - 260; x > 160; x -= 20) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane') === true) return { x, y };
      }
    }
    throw new Error('no bare board in view');
  });

/** Pops the session window shown on the board out, by its button. */
async function popOutShown(app: ElectronApplication, board: Page): Promise<Locator> {
  const [popped] = await Promise.all([app.waitForEvent('window'), sessionWindow(board).getByRole('button', { name: 'Pop out session window' }).click()]);
  const shown = sessionWindow(popped);
  await expect(shown).toBeVisible();
  return shown;
}

test('a shell tab drags out to a window of its own, from a pop-out onto another window and the board, between two pop-outs, each undone with ⌘Z from any window, the shell never restarting', async () => {
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

    // A shell tab in the implementer's window, with output of its own.
    await agentTile(window, impl!.sessionId).dblclick();
    const implWindow = sessionWindow(window);
    await expect(implWindow).toBeVisible();
    await window.keyboard.press(windowKey('t'));
    await expect(tabsOf(implWindow)).toHaveCount(2);
    await shownTab(implWindow).getByTestId('session-terminal').click();
    await window.keyboard.type('echo moved-$((6 * 7))');
    await window.keyboard.press('Enter');
    await expect(shownTab(implWindow).locator('.xterm-rows')).toContainText('moved-42');
    const pane = JSON.stringify((await shells(window)).find((shell) => shell.owner?.id === impl!.sessionId)!.layout).match(/"sessionId":"([^"]+)"/)![1]!;

    // Out of every window: a shell tile beside the agent's, whose window is out on its own, the same shell running.
    const tilePopped = await dragOut(app, tabNamed(implWindow, 'sh'));
    await expect(sessionWindow(tilePopped).locator('.xterm-rows')).toContainText('moved-42');
    await expect(tabsOf(implWindow)).toHaveCount(1);
    await expect(shellTiles(window)).toHaveCount(1);
    expect(await ownerOf(window, pane)).toBeNull();
    expect(await running(window, pane)).toBe(true);

    // ⌘Z on the board: a tab of the implementer's again, its own window gone.
    await Promise.all([tilePopped.waitForEvent('close'), undoIn(window)]);
    await expect(tabsOf(implWindow)).toHaveCount(2);
    await expect(shellTiles(window)).toHaveCount(0);
    expect(await ownerOf(window, pane)).toEqual({ kind: 'agent', id: impl!.sessionId });

    // From the implementer's popped-out window onto the reviewer's tab strip on the board.
    const implPopped = await popOutShown(app, window);
    await expect(tabsOf(implPopped)).toHaveCount(2);
    await agentTile(window, review!.sessionId).dblclick();
    const reviewWindow = sessionWindow(window);
    await expect(reviewWindow.getByTestId('session-tabs')).toBeVisible();
    // Its end says no window took it, with the pointer off every window: the reviewer's window did, and nothing pops out.
    await pointerAt(app, OFF_EVERY_WINDOW);
    const windowsBefore = app.windows().length;
    await dragAcross(tabNamed(implPopped, 'sh'), reviewWindow.getByTestId('session-tabs'), undefined, undefined, 'none');
    await expect(tabsOf(reviewWindow)).toHaveCount(2);
    await expect(tabsOf(implPopped)).toHaveCount(1);
    expect(await ownerOf(window, pane)).toEqual({ kind: 'agent', id: review!.sessionId });
    expect(await running(window, pane)).toBe(true);
    await window.waitForTimeout(500);
    expect(app.windows()).toHaveLength(windowsBefore);

    // ⌘Z in the pop-out takes it back there, through the board's history; ⇧⌘Z does it again, ⌘Z undoes that.
    await undoIn(implPopped.page());
    await expect(tabsOf(implPopped)).toHaveCount(2);
    await expect(tabsOf(reviewWindow)).toHaveCount(1);
    await undoIn(implPopped.page(), true);
    await expect(tabsOf(reviewWindow)).toHaveCount(2);
    await undoIn(implPopped.page());
    await expect(tabsOf(implPopped)).toHaveCount(2);

    // Between two pop-outs, onto the body of the reviewer's, and back with ⌘Z on the board.
    const reviewPopped = await popOutShown(app, window);
    await expect(tabsOf(reviewPopped)).toHaveCount(1);
    await dragAcross(tabNamed(implPopped, 'sh'), reviewPopped.getByTestId('session-terminal').first(), reviewPopped.getByTestId('window-pane-drop'), { attribute: 'data-zone', value: 'center' });
    await expect(tabsOf(reviewPopped)).toHaveCount(2);
    await expect(tabsOf(implPopped)).toHaveCount(1);
    expect(await ownerOf(window, pane)).toEqual({ kind: 'agent', id: review!.sessionId });
    await expect(reviewPopped.getByTestId('session-window-astray')).toHaveText(`sh runs in ${impl!.name}'s worktree`);
    await tabNamed(reviewPopped, 'sh').getByRole('tab').click();
    await expect(shownTab(reviewPopped).locator('.xterm-rows')).toContainText('moved-42');
    await undoIn(window);
    await expect(tabsOf(implPopped)).toHaveCount(2);
    await expect(tabsOf(reviewPopped)).toHaveCount(1);

    // From a pop-out onto bare board: a shell tile there, and ⌘Z in the pop-out takes it back.
    const json = await startDrag(tabNamed(implPopped, 'sh'));
    const bare = await bareBoard(window);
    await holdOver(window, bare, json);
    await dragEventAt(window, 'drop', bare, json);
    await endDrag(implPopped.page(), 'move');
    await expect(shellTiles(window)).toHaveCount(1);
    await expect(tabsOf(implPopped)).toHaveCount(1);
    expect(await ownerOf(window, pane)).toBeNull();
    await undoIn(implPopped.page());
    await expect(shellTiles(window)).toHaveCount(0);
    await expect(tabsOf(implPopped)).toHaveCount(2);
    expect(await running(window, pane)).toBe(true);

    // Let go over a window that won't take it (its own pop-out), a drag pops nothing out.
    await startDrag(tabNamed(implPopped, 'sh'));
    const bounds = await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.getAllWindows().find((each) => each.webContents.getURL().includes(`popOut=${id}`))!.getBounds(),
      impl!.sessionId,
    );
    await letGo(app, implPopped.page(), { x: bounds.x + 40, y: bounds.y + 20 });
    await implPopped.page().waitForTimeout(500);
    expect(app.windows()).toHaveLength(3);
    expect(await ownerOf(window, pane)).toEqual({ kind: 'agent', id: impl!.sessionId });

    // With the board's window closed, a tab dragged out of a pop-out opens the board, and pops out as ever.
    await Promise.all([
      window.waitForEvent('close'),
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((each) => !each.webContents.getURL().includes('popOut='))!.close()),
    ]);
    await startDrag(tabNamed(implPopped, 'sh'));
    const opened: Page[] = [];
    const boardAndPopOut = new Promise<void>((resolve) => {
      const heard = (page: Page) => {
        opened.push(page);
        if (opened.length < 2) return;
        app.off('window', heard);
        resolve();
      };
      app.on('window', heard);
    });
    await letGo(app, implPopped.page(), OFF_EVERY_WINDOW);
    await boardAndPopOut;
    const board = opened.find((page) => !page.url().includes('popOut='))!;
    const outAgain = opened.find((page) => page.url().includes('kind=shell'))!;
    await expect(sessionWindow(outAgain).locator('.xterm-rows')).toContainText('moved-42');
    await expect(shellTiles(board)).toHaveCount(1);
    await expect(tabsOf(implPopped)).toHaveCount(1);
    expect(await ownerOf(board, pane)).toBeNull();
    expect(await running(board, pane)).toBe(true);

    // The agent's own tab let go on bare board pops its window back in.
    const own = await startDrag(tabNamed(implPopped, 'claude'));
    const spot = await bareBoard(board);
    await holdOver(board, spot, own);
    await Promise.all([implPopped.page().waitForEvent('close'), dragEventAt(board, 'drop', spot, own)]);
    await expect(sessionWindow(board)).toHaveAttribute('data-session-id', impl!.sessionId);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pane of a shell tile's split drags out to a window of its own, and ⌘Z puts it back in the split", async () => {
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    const tileWindow = sessionWindow(window);
    await expect(tileWindow).toBeVisible();
    // Its own panes split from its details, tmux-style.
    await tileWindow.getByRole('navigation', { name: 'Session controls' }).getByRole('button', { name: 'Split horizontally' }).click();
    const panes = shownTab(tileWindow).getByTestId('shell-pane');
    await expect(panes).toHaveCount(2);
    const pane = (await panes.nth(1).getAttribute('data-session-id'))!;

    const popped = await dragOut(app, panes.nth(1).getByTestId('shell-pane-head'));
    await expect(sessionWindow(popped)).toBeVisible();
    await expect(panes).toHaveCount(1);
    expect(await ownerOf(window, pane)).toBeNull();
    await expect(shellTiles(window)).toHaveCount(2);
    expect(await running(window, pane)).toBe(true);

    await Promise.all([popped.waitForEvent('close'), undoIn(window)]);
    await expect(panes).toHaveCount(2);
    await expect(shellTiles(window)).toHaveCount(1);
    expect(await running(window, pane)).toBe(true);
  } finally {
    await app.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a web tab pops out into a tab window and back with its page as it was, never reloaded; the tab window closes with its last tab; another session's tab pops that session's window out, and a window's own tab pops its window out", async () => {
  const server = await serveWebPages();
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const newShell = window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' });
    // Two shell tiles: the second's window is the one on the board, a web tab in it.
    await newShell.click();
    await expect(shellTiles(window)).toHaveCount(1);
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    await newShell.click();
    await expect(shellTiles(window)).toHaveCount(2);
    const tileWindow = sessionWindow(window);
    await expect(tileWindow).toBeVisible();
    const tileId = (await tileWindow.getAttribute('data-shell-id'))!;
    const otherId = (await shells(window)).find((shell) => shell.owner === null && shell.id !== tileId)!.id;
    await tileWindow.getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: /^Web…/ }).click();
    // A new tab has no page and its address bar is focused: the URL typed there loads.
    const address = window.getByTestId('web-address');
    await expect(address).toBeFocused();
    await address.fill(server.url);
    await address.press('Enter');
    const host = new URL(server.url).host;
    await expect(tabNamed(tileWindow, host)).toHaveAttribute('data-active', 'true');
    const page = app.windows().find((each) => each.url().startsWith(server.url)) ?? (await app.waitForEvent('window'));
    await expect(page.locator('h1')).toHaveText('Dev home');
    // Something only this load of the page has, which a reload would lose; and a cookie, which clearing its partition would.
    await page.evaluate(() => {
      (window as unknown as { kept: number }).kept = 42;
      document.cookie = 'kept=yes';
    });
    const loads = () => server.hits().filter((path) => path === '/').length;
    const loaded = loads();
    const pageStill = async () => {
      expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(42);
      expect(await page.evaluate(() => document.cookie)).toContain('kept=yes');
      expect(loads()).toBe(loaded);
      // One page, never two.
      expect(app.windows().filter((each) => each.url().startsWith(server.url))).toHaveLength(1);
    };

    // Out of every window: a tab window of its own, showing the page as it was.
    const tabWindow = await dragOut(app, tabNamed(tileWindow, host));
    await expect(tabNamed(sessionWindow(tabWindow), host)).toHaveAttribute('data-active', 'true');
    await expect(tabNamed(tileWindow, host)).toHaveCount(0);
    await pageStill();
    await expect.poll(() => app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().filter((each) => each.contentView.children.some((view) => (view as Electron.WebContentsView).webContents.getURL().startsWith(url))).length, server.url)).toBe(1);

    // ⌘Z on the board: back in the tile's window, the tab window closed with its last tab; ⇧⌘Z out again.
    await Promise.all([tabWindow.waitForEvent('close'), undoIn(window)]);
    await expect(tabNamed(tileWindow, host)).toHaveCount(1);
    await pageStill();
    const [again] = await Promise.all([app.waitForEvent('window'), undoIn(window, true)]);
    await expect(tabNamed(sessionWindow(again), host)).toHaveCount(1);
    await pageStill();

    // Dragged from the tab window onto the tile's tab strip: its last tab gone, the tab window closes.
    await Promise.all([again.waitForEvent('close'), dragAcross(tabNamed(sessionWindow(again), host), tileWindow.getByTestId('session-tabs'))]);
    await expect(tabNamed(tileWindow, host)).toHaveCount(1);
    await pageStill();

    // Another session shown as a tab, let go outside every window: that session's own window pops out. Refused (the tab
    // gone from the window meanwhile), nothing pops out.
    const showOther = async () => {
      await tileWindow.getByRole('button', { name: 'New tab' }).click();
      await window.getByRole('menuitem', { name: 'Shell 1' }).click();
      await expect(tabNamed(tileWindow, 'Shell 1')).toHaveAttribute('data-active', 'true');
    };
    await showOther();
    // Its drag ends untaken just after the tab left the window some other way: the board's move is refused.
    const other = { kind: 'session', target: { kind: 'shell', id: otherId } } as const;
    const from = { kind: 'shell', id: tileId } as const;
    await window.evaluate(({ surface, from }) => globalThis.window.agentBoard.shells.moveSurface(surface, from, null), { surface: other, from });
    await expect(tabNamed(tileWindow, 'Shell 1')).toHaveCount(0);
    const windowCount = app.windows().length;
    await pointerAt(app, OFF_EVERY_WINDOW);
    await window.evaluate((drag) => globalThis.window.agentBoard.tabDrags.untaken(drag), { kind: 'surface', surface: other, from } as const);
    await expect(window.getByText(/Could not move the tab/)).toBeVisible();
    await window.waitForTimeout(500);
    expect(app.windows()).toHaveLength(windowCount);
    await showOther();
    const otherPopped = await dragOut(app, tabNamed(tileWindow, 'Shell 1'));
    await expect(sessionWindow(otherPopped)).toHaveAttribute('data-shell-id', otherId);
    await expect(tabNamed(tileWindow, 'Shell 1')).toHaveCount(0);

    // The tile's own tab, with the web tab beside it, let go outside every window: its window pops out, the web tab in it.
    const [tilePopped] = await Promise.all([
      app.waitForEvent('window', (each) => each.url().includes('popOut=')),
      (async () => {
        await startDrag(tabsOf(tileWindow).first());
        await letGo(app, window, OFF_EVERY_WINDOW);
      })(),
    ]);
    await expect(sessionWindow(tilePopped)).toHaveAttribute('data-shell-id', tileId);
    await expect(tabNamed(sessionWindow(tilePopped), host)).toHaveCount(1);
    // Its web tab's page went with it, as it was.
    await pageStill();
    // And back to the board, the same.
    await Promise.all([tilePopped.waitForEvent('close'), sessionWindow(tilePopped).getByRole('button', { name: 'Back to board' }).click()]);
    await expect(tabNamed(sessionWindow(window), host)).toHaveCount(1);
    await pageStill();
  } finally {
    await app.close();
    await server.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a web tab dropped on a tile whose window isn't open keeps its cookies: its page goes, and loads afresh, still signed in, when the window opens", async () => {
  const server = await serveWebPages();
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  // A page handed off waits this long for a window to take it.
  const { app, window } = await launch(dataDir, { ...env, ...SHELL_ENV, AGENT_BOARD_HAND_OFF_MS: '300' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    const newShell = window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' });
    await newShell.click();
    await expect(shellTiles(window)).toHaveCount(1);
    await sessionWindow(window).getByRole('button', { name: 'Close session window' }).click();
    const closedId = (await shells(window)).find((shell) => shell.owner === null)!.id;
    await newShell.click();
    await expect(shellTiles(window)).toHaveCount(2);
    const tileWindow = sessionWindow(window);
    const tileId = (await tileWindow.getAttribute('data-shell-id'))!;
    await tileWindow.getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: /^Web…/ }).click();
    // A new tab has no page and its address bar is focused: the URL typed there loads.
    const address = window.getByTestId('web-address');
    await expect(address).toBeFocused();
    await address.fill(server.url);
    await address.press('Enter');
    const host = new URL(server.url).host;
    await expect(tabNamed(tileWindow, host)).toHaveCount(1);
    await expect.poll(() => app.windows().some((each) => each.url().startsWith(server.url))).toBe(true);
    const page = app.windows().find((each) => each.url().startsWith(server.url))!;
    await expect(page.locator('h1')).toHaveText('Dev home');
    await page.evaluate(() => (document.cookie = 'kept=yes'));

    // Into the other tile's window, which isn't open, as a drop on its tile makes the move (the board's own, through
    // main): the tab joins that window's layout, and its page, handed off, waits for a window that doesn't open.
    const web = (await window.evaluate((id) => globalThis.window.agentBoard.shells.windowLayout({ kind: 'shell', id }), tileId))!;
    const surface = JSON.stringify(web).match(/\{"kind":"web"[^}]*\}/)![0];
    await Promise.all([
      page.waitForEvent('close'),
      window.evaluate(
        ({ surface, from, to }) => globalThis.window.agentBoard.tabDrags.move({ kind: 'surface', surface: JSON.parse(surface), from, to: { owner: to } }),
        { surface, from: { kind: 'shell', id: tileId } as const, to: { kind: 'shell', id: closedId } as const },
      ),
    ]);
    await expect(tabNamed(tileWindow, host)).toHaveCount(0);

    // Its window opened: the page loads afresh, its cookie kept.
    await tileWindow.getByRole('button', { name: 'Close session window' }).click();
    await window.locator(`[data-testid="shell-tile"][data-shell-id="${closedId}"]`).dblclick();
    await expect(tabNamed(sessionWindow(window), host)).toHaveCount(1);
    await tabNamed(sessionWindow(window), host).getByRole('tab').click();
    await expect.poll(() => app.windows().some((each) => !each.isClosed() && each.url().startsWith(server.url))).toBe(true);
    const again = app.windows().find((each) => !each.isClosed() && each.url().startsWith(server.url))!;
    await expect(again.locator('h1')).toHaveText('Dev home');
    expect(await again.evaluate(() => document.cookie)).toContain('kept=yes');
  } finally {
    await app.close();
    await server.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tab window open as the app quits comes back, with its tabs, at the next start', async () => {
  const server = await serveWebPages();
  const { dir, repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const appEnv = { ...env, ...SHELL_ENV };
  let { app, window } = await launch(dataDir, appEnv);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await window.getByTestId('zone').getByRole('button', { name: 'New shell in zone' }).click();
    const tileWindow = sessionWindow(window);
    await tileWindow.getByRole('button', { name: 'New tab' }).click();
    await window.getByRole('menuitem', { name: /^Web…/ }).click();
    // A new tab has no page and its address bar is focused: the URL typed there loads.
    const address = window.getByTestId('web-address');
    await expect(address).toBeFocused();
    await address.fill(server.url);
    await address.press('Enter');
    const host = new URL(server.url).host;
    await expect(tabNamed(tileWindow, host)).toHaveCount(1);
    const tabWindow = await dragOut(app, tabNamed(tileWindow, host));
    await expect(tabNamed(sessionWindow(tabWindow), host)).toHaveCount(1);
    const id = (await sessionWindow(tabWindow).getAttribute('data-tab-window-id'))!;

    await app.close();
    ({ app, window } = await launch(dataDir, appEnv));
    await expect.poll(() => app.windows().some((page) => page.url().includes(`popOut=${id}`))).toBe(true);
    const again = app.windows().find((page) => page.url().includes(`popOut=${id}`))!;
    await expect(tabNamed(sessionWindow(again), host)).toHaveCount(1);
  } finally {
    await app.close();
    await server.close();
    removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
