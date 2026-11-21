import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, sessionWindow, SHELL_ENV, showTerminalView, spawnAgent, TURN_MS, windowKey } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test, newShellInZone } from './launch.ts';
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

// Shell tabs drag between windows from the board's session window and from shell and tab windows. An agent's pop-out
// is its pop-up, whose tab row reorders its own tabs but has no drag to another window and takes none: dragging a
// shell tab out of a pop-out, or onto one, is a follow-up.
test('a shell tab drags out of the board\'s session window to a window of its own, and ⌘Z on the board puts it back, the shell never restarting', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    const [impl] = await agents(window);

    // A shell tab in the implementer's window, with output of its own.
    await agentTile(window, impl!.sessionId).dblclick();
    const implWindow = sessionWindow(window);
    await expect(implWindow).toBeVisible();
    await showTerminalView(window);
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
  } finally {
    await app.close();
    await removeDataDir(dataDir);
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
    await newShellInZone(window);
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
    await removeDataDir(dataDir);
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
    // Two shell tiles: the second's window is the one on the board, a web tab in it.
    await newShellInZone(window);
    await expect(shellTiles(window)).toHaveCount(1);
    await sessionWindow(window).getByRole('button', { name: /^(Close session window|Done, close)/u }).click();
    await newShellInZone(window);
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
    await removeDataDir(dataDir);
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
    await newShellInZone(window);
    await expect(shellTiles(window)).toHaveCount(1);
    await sessionWindow(window).getByRole('button', { name: /^(Close session window|Done, close)/u }).click();
    const closedId = (await shells(window)).find((shell) => shell.owner === null)!.id;
    await newShellInZone(window);
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
    await tileWindow.getByRole('button', { name: /^(Close session window|Done, close)/u }).click();
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
    await removeDataDir(dataDir);
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
    await newShellInZone(window);
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
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
