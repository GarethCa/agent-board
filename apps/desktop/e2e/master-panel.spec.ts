import { expect, type Locator, type Page } from '@playwright/test';
import { agents, launch, listFinishedTurns, sessionWindow, showDetails, spawnAgent, tile, TURN_MS, useFullSidebar } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { crowdedPanel, intersecting, LONG, PATH, topRowMeets } from './master-helpers.ts';

const panelOf = (window: Page) => window.getByTestId('master-panel');
const widthOf = async (window: Page) => Math.round((await panelOf(window).boundingBox())!.width);

async function drag(window: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await window.mouse.move(x + dx, y + dy, { steps: 4 });
  await window.mouse.up();
}

/** The Captain's panel with a waiting agent and everything long in it. */
async function longPanel(window: Page, app: Parameters<typeof pickFolderNext>[0], repo: string): Promise<void> {
  await listFinishedTurns(window);
  await pickFolderNext(app, repo);
  await browseForZone(window);
  await spawnAgent(window, 'monorepo', 'Pick a database', { name: LONG });
  await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
  await crowdedPanel(window);
  await expect(window.getByTestId('master-digest')).toBeVisible();
  await expect(window.getByTestId('master-for-you-item')).toHaveCount(1);
}

test('the Captain’s panel never scrolls sideways, whatever its zones, agents and digest hold', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await longPanel(window, app, repo);
    const panel = panelOf(window);
    const overflows = () =>
      panel.evaluate((root) => {
        const right = root.getBoundingClientRect().right;
        const named = (el: Element) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`;
        // Clipped counts as much as scrollable: a box with `overflow: hidden` still scrolls sideways when something in it takes
        // focus. Only a single line cut with an ellipsis, which has nothing to scroll to, is let off.
        const ellipsed = (el: Element) => getComputedStyle(el).textOverflow === 'ellipsis';
        const scrolls = [root, ...root.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && !ellipsed(el)).map(named);
        const beyond = [...root.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > right + 1).map(named);
        return { scrolls, beyond };
      });
    await expect.poll(overflows).toEqual({ scrolls: [], beyond: [] });
    // Narrower, where it is likelier still.
    await drag(window, window.getByTestId('master-panel-handle'), 80, 0);
    await expect.poll(() => widthOf(window)).toBe(280);
    await expect.poll(overflows).toEqual({ scrolls: [], beyond: [] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('the Captain’s panel resizes on its edge and the line under For you, folds its sections, and keeps all three across a restart', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let current = await launch(dataDir, env);
  try {
    let { window } = current;
    await longPanel(window, current.app, repo);
    const handle = window.getByTestId('master-panel-handle');
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect.poll(() => widthOf(window)).toBe(360);

    // Dragging the left edge in widens the panel (up to 400 px on a 1280 px window), out narrows it; the arrow keys step it and a double-click resets it.
    await drag(window, handle, -30, 0);
    await expect.poll(() => widthOf(window)).toBe(390);
    await expect(handle).toHaveAttribute('aria-valuenow', '390');
    await handle.focus();
    await window.keyboard.press('ArrowRight');
    await expect.poll(() => widthOf(window)).toBe(374);
    await handle.dblclick();
    await expect.poll(() => widthOf(window)).toBe(360);
    await drag(window, handle, -30, 0);
    await expect.poll(() => widthOf(window)).toBe(390);

    // The For you list is as tall as its line is dragged to (the window is made taller to give it room).
    const shorter = (await panelOf(window).boundingBox())!.height;
    await window.setViewportSize({ width: 1280, height: 1000 });
    await expect.poll(async () => (await panelOf(window).boundingBox())!.height).toBeGreaterThan(shorter);
    const forYou = window.getByRole('region', { name: 'For you' });
    // A drag starts from the height the handle reports (aria-valuenow), which follows the list a frame after the resize: wait for the two to agree.
    const forYouHandle = window.getByTestId('master-for-you-handle');
    const settled = async () => ({ list: Math.round((await forYou.boundingBox())!.height), handle: Number(await forYouHandle.getAttribute('aria-valuenow')) });
    await expect.poll(async () => {
      const { list, handle } = await settled();
      return list - handle;
    }).toBe(0);
    const before = (await settled()).list;
    await drag(window, forYouHandle, 0, 60);
    await expect.poll(async () => Math.round((await forYou.boundingBox())!.height)).toBe(before + 60);
    const taller = before + 60;

    // A folded section keeps its heading only.
    await window.getByTestId('master-fold-watching').click();
    await expect(window.getByTestId('master-watch-row')).toHaveCount(0);

    // The renderer writes its storage to disk a moment later: have it written before the app closes.
    await current.app.evaluate(({ session }) => session.defaultSession.flushStorageData());
    await current.app.close();
    current = await launch(dataDir, env);
    window = current.window;
    await window.setViewportSize({ width: 1280, height: 1000 });
    await window.getByTestId('master-button').click();
    await expect.poll(() => widthOf(window)).toBe(390);
    await expect.poll(async () => Math.round((await window.getByRole('region', { name: 'For you' }).boundingBox())!.height)).toBe(taller);
    await expect(window.getByTestId('master-watch-row')).toHaveCount(0);
    await window.getByTestId('master-fold-watching').click();
    await expect(window.getByTestId('master-watch-row')).not.toHaveCount(0);
  } finally {
    await current.app.close();
    await removeDataDir(dataDir);
  }
});

test('the Captain’s panel pushes the board in: flush and full height, no tile moves, the controls and the dock end left of it, and ⌘⇧M in it closes it', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await longPanel(window, app, repo);
    const panel = panelOf(window);
    const tileBox = async () => (await tile(window).first().boundingBox())!;
    const right = (box: { x: number; width: number } | null) => (box === null ? 0 : box.x + box.width);
    // Closed with the button, then opened with ⌘⇧M from the board: the tile is where it was, both times.
    await window.getByTestId('master-button').click();
    await expect(panel).toHaveCount(0);
    const still = await tileBox();
    await window.locator('.react-flow__pane').click({ position: { x: 40, y: 200 } });
    await window.keyboard.press('ControlOrMeta+Shift+M');
    await expect(panel).toHaveAttribute('data-mode', 'push');
    await expect.poll(() => window.evaluate(() => document.activeElement?.closest('[data-testid="master-panel"]') !== null)).toBe(true);
    expect(await tileBox()).toEqual(still);
    // Flush to the window's right edge, top and bottom.
    const size = await window.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    const box = (await panel.boundingBox())!;
    expect([Math.round(box.x + box.width), Math.round(box.y), Math.round(box.y + box.height)]).toEqual([size.width, 0, size.height]);
    // The zoom bar, the minimap and the top-right island end left of it; so does the dock, with a window in it.
    for (const selector of ['.island-bottom-right', '.board-minimap', '.island-top-right']) {
      expect(right(await window.locator(selector).first().boundingBox()), selector).toBeLessThanOrEqual(box.x);
    }
    // The top row fits the narrower board: no island meets another, or the pane.
    await expect.poll(() => topRowMeets(window)).toEqual([]);
    await tile(window).first().dblclick();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(window.getByTestId('dock-item')).toHaveCount(1);
    await expect.poll(async () => right(await window.locator('.session-dock').boundingBox())).toBeLessThanOrEqual(box.x);
    expect((await panel.boundingBox())!).toEqual(box);
    // ⌘⇧M with the focus in it closes it, and the tile still hasn't moved.
    await panel.getByRole('button').first().focus();
    await window.keyboard.press('ControlOrMeta+Shift+M');
    await expect(panel).toHaveCount(0);
    expect(await tileBox()).toEqual(still);
    // On the narrowest board it pushes, at its least width, the top row still fits.
    await window.setViewportSize({ width: 1160, height: 800 });
    await window.getByTestId('master-button').click();
    await expect(panel).toHaveAttribute('data-mode', 'push');
    await expect.poll(() => widthOf(window)).toBe(280);
    await expect.poll(() => topRowMeets(window)).toEqual([]);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('every agent’s details strip, which shares nothing with the Captain’s panel, never scrolls sideways either', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await useFullSidebar(window);
    await listFinishedTurns(window);
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', `Pick a database in ${PATH}`, { name: LONG });
    await expect(tile(window).first()).toHaveAttribute('data-state', 'waiting', { timeout: TURN_MS });
    await tile(window).first().dblclick();
    const strip = window.locator('.session-details');
    await expect(strip).toBeVisible();
    await showDetails(sessionWindow(window));
    const overflows = () =>
      strip.evaluate((root) => {
        const right = root.getBoundingClientRect().right;
        const named = (el: Element) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`;
        const scrollers = [root, ...root.querySelectorAll('*')].filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
        const beyond = [...root.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > right + 1).map(named);
        return { scrolls: scrollers.map(named), beyond };
      });
    await expect.poll(overflows).toEqual({ scrolls: [], beyond: [] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});

test('dragged as wide as it goes, the Captain’s panel leaves the zones pill, the dock, the zoom bar and Edge rules their room, on the board', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await longPanel(window, app, repo);
    const row = async (label: string) => {
      const box = async (selector: string) => ((await window.locator(selector).count()) === 0 ? null : window.locator(selector).first().boundingBox());
      const boxes = { pill: await box('.island-bottom-left'), zoom: await box('.island-bottom-right'), panel: await box('[data-testid="master-panel"]'), dock: await box('.session-dock'), rules: await box('.edge-rules') };
      expect(intersecting(boxes), `${label}: ${JSON.stringify(boxes)}`).toEqual([]);
      const board = (await window.locator('.board').boundingBox())!;
      expect(boxes.zoom!.x, label).toBeGreaterThanOrEqual(board.x);
      expect(boxes.zoom!.x + boxes.zoom!.width, label).toBeLessThanOrEqual(board.x + board.width);
    };
    // Past its widest the panel stops where the zones pill and a dock still fit beside the zoom bar.
    await tile(window).first().dblclick();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(window.getByTestId('dock-item')).toHaveCount(1);
    await window.setViewportSize({ width: 1280, height: 760 });
    await drag(window, window.getByTestId('master-panel-handle'), -2000, 0);
    await expect.poll(() => widthOf(window)).toBeGreaterThan(360);
    await row('the widest panel, with a docked window');

    // With Edge rules open too, the widest is narrower still (in a window the least panel fits in beside them).
    await window.setViewportSize({ width: 1400, height: 800 });
    await spawnAgent(window, 'monorepo', 'Tidy the tokens');
    const [first, second] = (await agents(window)).filter((agent) => !agent.master).map((agent) => agent.sessionId);
    await window.evaluate(([from, to]) => globalThis.window.agentBoard.flowEdges.create({ from: from!, to: to! }), [first, second] as const);
    await window.getByTestId('flow-edge').first().click({ force: true });
    await expect(window.getByRole('complementary', { name: 'Edge rules' })).toBeVisible();
    await drag(window, window.getByTestId('master-panel-handle'), -2000, 0);
    await expect.poll(() => widthOf(window)).toBeGreaterThanOrEqual(280);
    await row('the widest panel, with Edge rules open');
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
