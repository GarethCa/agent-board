import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { drag, nodeRect, settledBox } from './board-helpers.ts';
import { agents, launch, sessionWindow, setClickOpens, spawnAgent, tile, tileAction, windowKey } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';
import { clickClosing } from './windows.ts';

const expandedTile = (page: Page) => page.getByTestId('expanded-tile');
/** The board node the expanded tile is drawn in. */
const expandedNode = (page: Page) => page.locator('.react-flow__node').filter({ has: expandedTile(page) });

/**
 * A click out onto the board: a point where the board's bare pane, or the pop-up's scrim, is on top, not a window, a
 * tile, a zone, the dock or the board's controls. It steps finely from the edges, as the pop-up leaves only a narrow
 * margin of its scrim. (An Electron window has no viewport of Playwright's to measure: viewportSize() is null.)
 */
const clickOut = async (page: Page) => {
  const point = await page.evaluate(() => {
    for (let y = innerHeight - 4; y > 0; y -= 6) {
      for (let x = 4; x < innerWidth; x += 6) {
        const top = document.elementFromPoint(x, y);
        if (top?.matches('[data-testid="agent-popup-scrim"]')) return { x, y };
        if (top?.closest('.react-flow__pane') && !top.closest('.react-flow__node, .react-flow__edge')) return { x, y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
};

/**
 * The menu item ⌘W stands for now, and, with `click`, clicks it as the menu bar does when ⌘W is pressed: a synthetic key
 * event doesn't reach the native menu. Only Close Tab is clicked, never Close Window, which would close the board itself.
 */
const menuCommandW = (app: ElectronApplication, click = false) =>
  app.evaluate(({ Menu }, click) => {
    const item = Menu.getApplicationMenu()!
      .items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((each) => each.enabled && /^(CommandOrControl|Command|Cmd)\+W$/i.test(String(each.accelerator ?? '')));
    if (click && item?.label === 'Close Tab') item.click();
    return item?.label ?? 'none';
  }, click);

// An agent pinned expanded stays open where it is, at its size, through everything that would fold or move it,
// a restart too; only Unpin, then Collapse, folds it.
test('an agent pinned expanded stays open at its place and size through Esc, a drag, Arrange, its session window and a restart; Unpin, then Collapse, folds it', async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window } = await launch(dataDir, env);
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await expect(window.getByTestId('zone')).toHaveCount(1);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await expect(tile(window)).toHaveAttribute('data-state', 'waiting');

    // Pinned from its compact tile's ⋯, it expands at once, and the daemon keeps the pin.
    await tileAction(tile(window), 'Pin expanded', 'Arrange');
    await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
    await expect.poll(async () => (await agents(window))[0]!.pinnedExpanded).toBe(true);
    // Its header has its pin, shown on, where Collapse was: Unpin. Its window buttons work as on any tile.
    const head = () => expandedTile(window).locator('.expanded-tile-head');
    await expect(head().getByRole('button', { name: 'Unpin' })).toBeVisible();
    await expect(head().getByRole('button', { name: 'Pin expanded' })).toHaveCount(0);
    await expect(head().getByRole('button', { name: 'Collapse', exact: true })).toHaveCount(0);
    await expect(head().getByRole('button', { name: 'Maximise' })).toBeEnabled();
    await expect(head().getByRole('button', { name: 'Pop out' })).toBeEnabled();
    // No resize handles: it keeps its size.
    await expect(expandedTile(window).locator('.expanded-tile-resize')).toHaveCount(0);
    await window.getByRole('button', { name: 'Fit View' }).click();
    await settledBox(expandedNode(window));
    const at = await nodeRect(expandedNode(window));

    // Esc, and a click on bare board, leave it open.
    await window.locator('.react-flow__pane').click({ position: { x: 20, y: 700 } });
    await window.keyboard.press('Escape');
    await expect(expandedTile(window)).toHaveCount(1);
    // Its header is no drag handle.
    const fill = await settledBox(head().locator('.session-window-head-fill'));
    await drag(window, { x: fill.x + fill.width / 2, y: fill.y + fill.height / 2 }, { x: fill.x + fill.width / 2 + 160, y: fill.y + 120 }, { steps: 8 });
    expect(await nodeRect(expandedNode(window))).toEqual(at);

    // Arrange the board goes round it.
    await window.locator('.react-flow__pane').click({ button: 'right', position: { x: 20, y: 700 } });
    await window.getByRole('menuitem', { name: 'Arrange the board' }).click();
    await expect(expandedTile(window)).toHaveCount(1);
    await expect.poll(() => nodeRect(expandedNode(window))).toEqual(at);

    // Maximise opens its session window, which has the session; closed with its –, the tile is back, pinned, where it was.
    await head().getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(window)).toHaveCount(1);
    await expect(expandedTile(window)).toHaveCount(0);
    await expect.poll(async () => (await agents(window))[0]!.pinnedExpanded).toBe(true);
    await sessionWindow(window).locator('.session-window-head').getByTestId('back-to-tile').click();
    await expect(sessionWindow(window)).toHaveCount(0);
    await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
    await expect.poll(() => nodeRect(expandedNode(window))).toEqual(at);

    // Under the pop-up's setting, ⤢ opens its pop-up instead; back from it, the tile is pinned where it was.
    await setClickOpens(window, 'Pop-up');
    await head().getByRole('button', { name: 'Open the pop-up' }).click();
    await expect(window.getByTestId('agent-popup')).toBeVisible();
    await expect(expandedTile(window)).toHaveCount(0);
    await window.getByTestId('agent-popup').getByRole('button', { name: 'Back to its tile' }).click();
    await expect(window.getByTestId('agent-popup')).toHaveCount(0);
    await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
    await expect.poll(() => nodeRect(expandedNode(window))).toEqual(at);
    await setClickOpens(window, 'Expand in place');

    // After a restart it is expanded again, at the same place and size.
    await app.close();
    ({ app, window } = await launch(dataDir, env));
    await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
    await expect.poll(() => nodeRect(expandedNode(window))).toEqual(at);

    // Unpin, then Collapse, folds it.
    await head().getByRole('button', { name: 'Unpin' }).click();
    await expect.poll(async () => (await agents(window))[0]!.pinnedExpanded).toBe(false);
    await expect(head().getByRole('button', { name: 'Maximise' })).toBeEnabled();
    await head().getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(expandedTile(window)).toHaveCount(0);
    await expect(tile(window)).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// However the agent's full screen is left (Esc, ⌘W, its close button, a click on the board, ⌘K to another agent, or
// its pop-up or pop-out window closed), a tile pinned expanded is back, pinned, at its place and size. Leaving by most
// of them only docks the window, which must not keep a pinned tile compact.
test('a pinned tile is back at its place and size however its full screen is left', async () => {
  test.setTimeout(120_000);
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await expect(window.getByTestId('zone')).toHaveCount(1);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await spawnAgent(window, 'monorepo', 'Tidy the docs');
    const pinnedTile = tile(window).filter({ hasText: 'Pick a database' });
    await expect(pinnedTile).toHaveAttribute('data-state', 'waiting');
    await tileAction(pinnedTile, 'Pin expanded', 'Arrange');
    await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
    await window.getByRole('button', { name: 'Fit View' }).click();
    await settledBox(expandedNode(window));
    const at = await nodeRect(expandedNode(window));
    const head = () => expandedTile(window).locator('.expanded-tile-head');
    const shown = () => sessionWindow(window).filter({ hasText: 'Pick a database' });

    const goIn = async () => {
      await head().getByRole('button', { name: 'Maximise' }).click();
      await expect(shown()).toHaveCount(1);
      await expect(shown()).toBeVisible();
      await expect(expandedTile(window)).toHaveCount(0);
    };
    const clickBoard = async () => {
      await settledBox(shown());
      await clickOut(window);
    };
    const isBack = async () => {
      await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
      await expect.poll(() => nodeRect(expandedNode(window))).toEqual(at);
    };

    // Esc from its header (⌘J takes the focus there) docks the window.
    await goIn();
    await window.keyboard.press(windowKey('j'));
    await window.keyboard.press('Escape');
    await isBack();

    // ⌘W, File › Close Tab while a session window is shown on the board, closes that window, wherever the focus is.
    await goIn();
    await expect.poll(() => menuCommandW(app)).toBe('Close Tab');
    expect(await menuCommandW(app, true)).toBe('Close Tab');
    await expect(shown()).toHaveCount(0);
    await isBack();

    // Its close button, and its – back to the tile.
    await goIn();
    await window.getByRole('button', { name: 'Close session window' }).click();
    await isBack();
    await goIn();
    await sessionWindow(window).locator('.session-window-head').getByTestId('back-to-tile').click();
    await isBack();

    // A click on the board docks it.
    await goIn();
    await clickBoard();
    await isBack();

    // ⌘K to another agent shows that one's window and docks this one's.
    await goIn();
    await window.keyboard.press(windowKey('k'));
    await window.keyboard.type('tidy');
    await window.keyboard.press(windowKey('Enter'));
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Tidy the docs');
    await isBack();
    await window.getByRole('button', { name: 'Close session window' }).click();
    await expect(sessionWindow(window)).toHaveCount(0);

    // Popped out, then closed; popped out, back to the board, then left with a click on the board.
    let [popped] = await Promise.all([app.waitForEvent('window'), head().getByRole('button', { name: 'Pop out', exact: true }).click()]);
    await expect(sessionWindow(popped)).toBeVisible();
    await expect(expandedTile(window)).toHaveCount(0);
    await popped.close();
    await isBack();
    [popped] = await Promise.all([app.waitForEvent('window'), head().getByRole('button', { name: 'Pop out', exact: true }).click()]);
    await expect(sessionWindow(popped)).toBeVisible();
    await clickClosing(popped, popped.getByRole('button', { name: 'Back to board' }));
    await expect(shown()).toHaveCount(1);
    await expect(expandedTile(window)).toHaveCount(0);
    await clickBoard();
    await isBack();

    // Its pop-up, left with Esc from its header (its terminal, where the focus starts, keeps Esc for the agent).
    await setClickOpens(window, 'Pop-up');
    await head().getByRole('button', { name: 'Open the pop-up' }).click();
    await expect(window.getByTestId('agent-popup')).toBeVisible();
    await expect(expandedTile(window)).toHaveCount(0);
    await window.getByTestId('agent-popup').locator('.session-window-head-fill').first().click();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('agent-popup')).toHaveCount(0);
    await isBack();
    // Still pinned in the daemon, the other agent left compact.
    await expect.poll(async () => (await agents(window)).find((agent) => agent.pinnedExpanded)?.sessionId).toBeDefined();
    await expect(tile(window).filter({ hasText: 'Tidy the docs' })).toHaveCount(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// From another agent's full screen, or its pop-up, ⌘K to the agent pinned expanded, then a click out
// onto the board. The pinned tile is back at its place and size each time, not folded to its compact tile.
test('⌘K to a pinned agent from another agent\'s full screen or pop-up, then a click out, leaves its tile pinned at its place and size', async () => {
  test.setTimeout(120_000);
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await setClickOpens(window, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await expect(window.getByTestId('zone')).toHaveCount(1);
    await spawnAgent(window, 'monorepo', 'Pick a database');
    await spawnAgent(window, 'monorepo', 'Tidy the docs');
    const pinnedTile = tile(window).filter({ hasText: 'Pick a database' });
    await expect(pinnedTile).toHaveAttribute('data-state', 'waiting');
    await tileAction(pinnedTile, 'Pin expanded', 'Arrange');
    await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
    await window.getByRole('button', { name: 'Fit View' }).click();
    await settledBox(expandedNode(window));
    const at = await nodeRect(expandedNode(window));
    const pinnedId = (await agents(window)).find((agent) => agent.pinnedExpanded)!.sessionId;
    const otherTile = tile(window).filter({ hasText: 'Tidy the docs' });
    const popup = () => window.getByTestId('agent-popup');
    const popupOf = (name: string) => window.getByRole('dialog', { name: `${name}, pop-up` });

    // ⌘K, the pinned agent's row picked, and plain ↵: "switch here", in the full screen or the pop-up it was pressed in.
    const toPinned = async () => {
      await window.keyboard.press(windowKey('k'));
      await expect(window.getByRole('combobox', { name: 'Jump to a session, zone or setting' })).toBeFocused();
      await window.keyboard.type('pick a database');
      await expect(window.locator('[data-testid="spotlight-row"][data-active]')).toContainText('Pick a database');
      await window.keyboard.press('Enter');
    };
    const isBack = async () => {
      await expect(popup()).toHaveCount(0);
      await expect(sessionWindow(window).filter({ visible: true })).toHaveCount(0);
      await expect(expandedTile(window)).toHaveAttribute('data-pinned', 'true');
      await expect.poll(() => nodeRect(expandedNode(window))).toEqual(at);
      await expect(pinnedTile).toHaveCount(0);
    };

    // From the other agent's full screen: the full screen switches to the pinned agent, and a click out docks it.
    await setClickOpens(window, 'Maximised session window');
    await otherTile.dblclick();
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Tidy the docs');
    await toPinned();
    await expect(sessionWindow(window).getByRole('heading')).toHaveText('Pick a database');
    await settledBox(sessionWindow(window));
    await clickOut(window);
    await isBack();

    // From the other agent's pop-up, as the user goes on: the pinned agent's window is still docked from the full
    // screen, and the pop-up, switched to the pinned agent and left with a click out, must not keep its tile compact.
    await setClickOpens(window, 'Pop-up');
    await otherTile.dblclick();
    await expect(popupOf('Tidy the docs')).toBeVisible();
    await toPinned();
    await expect(popupOf('Pick a database')).toBeVisible();
    await settledBox(popup());
    await clickOut(window);
    await isBack();
    await expect.poll(async () => (await agents(window)).filter((agent) => agent.pinnedExpanded).map((agent) => agent.sessionId)).toEqual([pinnedId]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
