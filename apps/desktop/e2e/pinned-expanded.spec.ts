import { expect, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { drag, settledBox } from './board-helpers.ts';
import { agents, launch, setClickOpens, spawnAgent, tile, tileAction } from './agent-helpers.ts';
import { test, pickFolderNext, removeDataDir, tempDataDir, browseForZone } from './launch.ts';
import { scratch } from './scratch.ts';

const expandedTile = (page: Page) => page.getByTestId('expanded-tile');
/** The board node the expanded tile is drawn in. */
const expandedNode = (page: Page) => page.locator('.react-flow__node').filter({ has: expandedTile(page) });

type Rect = { x: number; y: number; width: number; height: number };

/** A node's rect on the board, unscaled by the zoom: where React Flow draws it. */
const nodeRect = (node: Locator): Promise<Rect> =>
  node.evaluate((element) => {
    const [x, y] = (element as HTMLElement).style.transform.match(/-?[\d.]+/g)!.map(Number);
    return { x: x!, y: y!, width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight };
  });

// An agent pinned expanded stays open where it is, at its size, through everything that would fold or move it,
// a restart too; only Unpin, then Collapse, folds it.
test('an agent pinned expanded stays open at its place and size through Esc, Maximise, a drag, Arrange and a restart; Unpin, then Collapse, folds it', async () => {
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
    // Its header has its pin, shown on, where Collapse was: Unpin. Its window buttons wait for it.
    const head = () => expandedTile(window).locator('.expanded-tile-head');
    await expect(head().getByRole('button', { name: 'Unpin' })).toBeVisible();
    await expect(head().getByRole('button', { name: 'Pin expanded' })).toHaveCount(0);
    await expect(head().getByRole('button', { name: 'Collapse', exact: true })).toHaveCount(0);
    await expect(head().getByRole('button', { name: 'Maximise' })).toBeDisabled();
    await expect(head().getByRole('button', { name: 'Pop out' })).toBeDisabled();
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
    rmSync(dir, { recursive: true, force: true });
    await removeDataDir(dataDir);
  }
});
