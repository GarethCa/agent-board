import { expect, type Locator, type Page } from '@playwright/test';
import { agents, launch, listFinishedTurns, sessionWindow, showDetails, spawnAgent, tile, TURN_MS } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';
import { crowdedPanel, LONG, PATH } from './master-helpers.ts';

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

    // Dragging the left edge in widens the panel, out narrows it; the arrow keys step it and a double-click resets it.
    await drag(window, handle, -100, 0);
    await expect.poll(() => widthOf(window)).toBe(460);
    await expect(handle).toHaveAttribute('aria-valuenow', '460');
    await handle.focus();
    await window.keyboard.press('ArrowRight');
    await expect.poll(() => widthOf(window)).toBe(444);
    await handle.dblclick();
    await expect.poll(() => widthOf(window)).toBe(360);
    await drag(window, handle, -100, 0);
    await expect.poll(() => widthOf(window)).toBe(460);

    // The For you list is as tall as its line is dragged to.
    const forYou = window.getByRole('region', { name: 'For you' });
    const before = Math.round((await forYou.boundingBox())!.height);
    await drag(window, window.getByTestId('master-for-you-handle'), 0, 60);
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
    await window.getByTestId('master-button').click();
    await expect.poll(() => widthOf(window)).toBe(460);
    await expect.poll(async () => Math.round((await window.getByRole('region', { name: 'For you' }).boundingBox())!.height)).toBe(taller);
    await expect(window.getByTestId('master-watch-row')).toHaveCount(0);
    await window.getByTestId('master-fold-watching').click();
    await expect(window.getByTestId('master-watch-row')).not.toHaveCount(0);
  } finally {
    await current.app.close();
    await removeDataDir(dataDir);
  }
});

test('the Captain’s panel sits above the dock: its bottom ends at the dock’s top and nothing of it is hidden behind', async () => {
  const { repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await longPanel(window, app, repo);
    const panel = panelOf(window);
    await expect(panel).toBeVisible();
    const bottomBefore = (await panel.boundingBox())!;
    await tile(window).first().dblclick();
    await window.getByRole('button', { name: 'Minimise session window' }).click();
    const dock = window.getByTestId('dock-item');
    await expect(dock).toHaveCount(1);
    const dockBox = async () => (await window.locator('.session-dock').boundingBox())!;
    // The panel gives way to the dock: it ends above the dock's top edge, and the zoom island is clear of both.
    await expect.poll(async () => (await panel.boundingBox())!.y + (await panel.boundingBox())!.height).toBeLessThanOrEqual((await dockBox()).y);
    const box = (await panel.boundingBox())!;
    expect(box.y + box.height).toBeLessThan(bottomBefore.y + bottomBefore.height);
    // Every corner of the panel is the panel's own: the dock isn't drawn over it, and it isn't drawn over the dock.
    const owner = await window.evaluate(
      ({ x, y }) => (document.elementFromPoint(x, y)?.closest('[data-testid="master-panel"]') ? 'panel' : 'other'),
      { x: box.x + box.width - 6, y: box.y + box.height - 6 },
    );
    expect(owner).toBe('panel');
    const dockNow = await dockBox();
    expect(dockNow.x + dockNow.width <= box.x || dockNow.y >= box.y + box.height).toBe(true);
    const zoom = (await window.locator('.island-bottom-right').boundingBox())!;
    expect(zoom.x + zoom.width).toBeLessThanOrEqual(box.x);
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

/** Whether any two of the boxes share area. */
const intersecting = (boxes: Record<string, { x: number; y: number; width: number; height: number } | null>) => {
  const named = Object.entries(boxes).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null);
  return named.flatMap(([a, p], i) =>
    named.slice(i + 1).flatMap(([b, q]) => (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height ? [`${a} / ${b}`] : [])),
  );
};

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
    await window.setViewportSize({ width: 1100, height: 760 });
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
