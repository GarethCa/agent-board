import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { agents, launch, setClickOpens, spawnAgent, TURN_MS, windowKey } from './agent-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const middleOf = async (element: Locator) => {
  const box = (await element.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Zooms the board out a step, and waits for the view to show it: the board applies it on a later frame. */
async function zoomOut(page: Page): Promise<void> {
  const viewport = page.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(viewport).not.toHaveAttribute('style', before!);
}

/** Whether every node is in view, clear of the islands at the board's top and corners. */
async function inView(page: Page, nodes: Locator[]): Promise<boolean> {
  const boxes = await Promise.all(nodes.map((node) => node.boundingBox()));
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return boxes.every((box) => box !== null && box.y > 70 && box.x > 0 && box.y + box.height < size.height - 80 && box.x + box.width < size.width - 220);
}

/** A point of bare board in view with bare board 140 x 80 round it too, zooming out to make one. */
async function bareBoard(page: Page): Promise<{ x: number; y: number }> {
  const find = () =>
    page.evaluate(() => {
      for (let y = 90; y < window.innerHeight - 90; y += 20) {
        for (let x = window.innerWidth - 150; x > 150; x -= 20) {
          const bare = (element: Element | null) => element?.classList.contains('react-flow__pane') === true || element?.classList.contains('zone') === true;
          if ([-140, 0, 140].every((dx) => [-80, 0, 80].every((dy) => bare(document.elementFromPoint(x + dx, y + dy))))) return { x, y };
        }
      }
      return undefined;
    });
  for (let step = 0; step < 6; step += 1) {
    const found = await find();
    if (found !== undefined) return found;
    await zoomOut(page);
  }
  throw new Error('no bare board in view');
}

/** Drags `from` (HTML5 drag and drop) to the point on the screen, in steps, as a hand would, running `hold` once it is over the target and before letting go. */
async function dragTo(from: Locator, to: { x: number; y: number }, hold?: () => Promise<void>): Promise<void> {
  const page = from.page();
  const start = (await from.boundingBox())!;
  await page.mouse.move(start.x + Math.min(20, start.width / 2), start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await hold?.();
  await page.mouse.up();
}

// A tab dropped on a shell tile lights it and joins it. Under the Simplified design that tile is the calm shell tile, which
// copies Classic's root attributes by hand, so this is what would break if they drifted.
test("a shell tab dropped on a shell tile in the Simplified design lights the tile while it is over it and joins it", async () => {
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env, [], { design: 'simplified' });
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await setClickOpens(window, 'Expand in place');
    await spawnAgent(window, 'monorepo', 'Wire the fallback');
    await expect(window.getByTestId('agent-tile')).toHaveCount(1, { timeout: TURN_MS });
    const [impl] = await agents(window);
    await window.locator(`[data-testid="agent-tile"][data-session-id="${impl!.sessionId}"]`).dblclick();
    const expanded = window.locator(`[data-testid="expanded-tile"][data-session-id="${impl!.sessionId}"]`);
    const tabs = expanded.getByTestId('session-tab');
    const tabNamed = (name: string) => tabs.filter({ has: window.getByRole('tab', { name, exact: true }) });
    await expanded.getByTestId('session-terminal').first().click();
    await window.keyboard.press(windowKey('t'));
    await expect(tabs).toHaveCount(2);
    for (let step = 0; step < 6 && !(await inView(window, [expanded])); step += 1) await zoomOut(window);

    // The first shell tab onto bare board: a shell tile of its own, the calm one.
    await dragTo(tabNamed('sh'), await bareBoard(window));
    const shellTile = window.getByTestId('shell-tile');
    await expect(shellTile).toHaveCount(1);
    await expect(shellTile).toHaveClass(/calm-tile/);
    await expect(tabs).toHaveCount(1);

    // A second tab onto that tile: it is lit while the tab is over it, and the tab joins it.
    await expanded.getByTestId('session-terminal').first().click();
    await window.keyboard.press(windowKey('t'));
    await expect(tabs).toHaveCount(2);
    for (let step = 0; step < 6 && !(await inView(window, [expanded, shellTile])); step += 1) await zoomOut(window);
    await dragTo(tabNamed('sh'), await middleOf(shellTile), () => expect(shellTile).toHaveAttribute('data-drop-over', 'true'));
    await expect(tabs).toHaveCount(1);
    await expect(shellTile).not.toHaveAttribute('data-drop-over', 'true');
    await expect(shellTile).toHaveCount(1);
    const tileId = (await shellTile.getAttribute('data-shell-id'))!;
    // The dropped tab is one of the tile's now, owned by it.
    const owned = await window.evaluate((id) => globalThis.window.agentBoard.shells.list().then((all) => all.filter((shell) => shell.owner?.id === id).length), tileId);
    expect(owned).toBe(1);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
