import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { agents, launch, listFinishedTurns, sessionWindow, setClickOpens, tile, tileAction, untilStarted, windowKey, zoneNamed, zones } from './agent-helpers.ts';
import { untilStill } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

type Rect = { x: number; y: number; width: number; height: number };

const named = (page: Page, name: string) => tile(page).filter({ has: page.getByText(name, { exact: true }) });
const expandedTile = (page: Page) => page.getByTestId('expanded-tile');
const spotlight = (page: Page) => page.getByRole('dialog', { name: 'Jump to a session, zone or setting' });
/** Every agent's saved place, by name. */
const places = async (page: Page) => Object.fromEntries((await agents(page)).map((agent) => [agent.name, agent.position]));

/** Every agent's tile as the board draws it, compact or expanded: its rect on the board, unscaled by the zoom. */
const drawnTiles = (page: Page): Promise<Rect[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
      .filter((node) => node.querySelector('[data-testid="agent-tile"], [data-testid="expanded-tile"]') !== null)
      .map((node) => {
        const [x, y] = node.style.transform.match(/-?[\d.]+/g)!.map(Number);
        return { x: x!, y: y!, width: node.offsetWidth, height: node.offsetHeight };
      }),
  );

/** That no two of `rects` overlap. */
function expectNoOverlap(rects: Rect[]): void {
  const overlaps = rects.flatMap((a, i) =>
    rects.slice(i + 1).filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map((b) => [a, b]),
  );
  expect(overlaps).toEqual([]);
}

/** The tiles expanded on the board, by id, as the board keeps them: drawn or not. */
const openTiles = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    const saved = (await window.agentBoard.view.get('expandedTiles')) as { id: string }[] | null;
    return (saved ?? []).map((tile) => tile.id).sort();
  });

/**
 * Every agent's tile at its saved place, at the size it takes there: an expanded tile's (`expandedTiles`) for one open,
 * its compact size otherwise. Where the layout put them, whatever the board draws pushed aside.
 */
const savedRects = async (page: Page): Promise<Rect[]> => {
  const open = await page.evaluate(async () => ((await window.agentBoard.view.get('expandedTiles')) as { id: string; width: number; height: number }[] | null) ?? []);
  return (await agents(page)).map((agent) => {
    const size = open.find((each) => each.id === `agent:${agent.sessionId}`) ?? AGENT_TILE_SIZE;
    return { x: agent.position!.x, y: agent.position!.y, width: size.width, height: size.height };
  });
};

/** The tiles a session window has taken, by id, which open again as it closes. */
const hiddenTiles = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (((await window.agentBoard.view.get('expandedTiles.hidden')) as { id: string }[] | null) ?? []).map((tile) => tile.id));

/** Fits the view to the board, so every tile is drawn (one out of view is not), then waits for it to stop moving. */
const settled = async (page: Page) => {
  await page.getByRole('button', { name: 'Fit View' }).click();
  await untilStill(async () => JSON.stringify([await places(page), await drawnTiles(page)]));
};

async function jumpTo(page: Page, text: string): Promise<void> {
  await page.keyboard.press(windowKey('k'));
  await expect(spotlight(page)).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(spotlight(page)).toHaveCount(0);
}

// A zone's Clean up keeps room for every expanded tile at its expanded size, pinned or not, and for one its session window has
// taken: nothing overlaps once it opens again, and nothing moves as a tile is collapsed and opened again, as ⌘K flies away and
// back, or across a restart and a Clean up after it.
test('Clean up lays a zone out clear of a pinned tile and of one its session window has, at their sizes; collapse and expand, ⌘K away and back, and a restart move nothing', async () => {
  test.setTimeout(150_000);
  const { dir, repo, env } = scratch('waiting');
  const dataDir = tempDataDir();
  let { app, window: page } = await launch(dataDir, env);
  try {
    await listFinishedTurns(page);
    await setClickOpens(page, 'Expand in place');
    await pickFolderNext(app, repo);
    await browseForZone(page);
    const [zone] = await zones(page);
    for (const [prompt, position] of [
      ['Pin the plan', { x: 40, y: 140 }],
      ['Open the docs', { x: 400, y: 140 }],
      ['Fold the cache', { x: 40, y: 380 }],
      ['Fold the images', { x: 400, y: 380 }],
    ] as const) {
      await page.evaluate(
        async ({ zoneId, prompt, position }) => {
          const result = await window.agentBoard.agents.spawn({ zoneId, prompt, position, cols: 100, rows: 30 });
          if (result.status !== 'started') throw new Error(result.message);
        },
        { zoneId: zone!.id, prompt, position },
      );
    }
    await untilStarted(page);
    await expect.poll(async () => (await agents(page)).length, { timeout: 30_000 }).toBe(4);

    // One pinned expanded, one expanded in place and not pinned, two compact.
    await tileAction(named(page, 'Pin the plan'), 'Pin expanded', 'Arrange');
    await expect(expandedTile(page).and(page.locator('[data-pinned="true"]'))).toHaveCount(1);
    await settled(page);
    await named(page, 'Open the docs').dblclick();
    await expect(expandedTile(page)).toHaveCount(2);

    // Its session window takes the unpinned one: compact on the board while it is open, expanded again once it closes.
    const docs = (await agents(page)).find((agent) => agent.name === 'Open the docs')!.sessionId;
    const open = page.locator(`[data-testid="expanded-tile"][data-session-id="${docs}"]`);
    await settled(page);
    await open.getByRole('button', { name: 'Maximise' }).click();
    await expect(sessionWindow(page)).toHaveAttribute('data-state', 'attached');
    await page.getByRole('button', { name: 'Minimise session window' }).click();
    await expect(page.getByTestId('dock-item')).toHaveAttribute('data-placement', 'docked');
    await expect(expandedTile(page)).toHaveCount(1);
    await expect.poll(() => hiddenTiles(page)).toEqual([`agent:${docs}`]);

    // The zone's Clean up arranges what is in it, the room of the tile its window has kept.
    const cleanUp = async () => {
      await settled(page);
      // Its header can sit past the window's edge once the view is fitted round an expanded tile: its Clean up button is
      // pressed from the keyboard, which needs it on screen no more than the keyboard does.
      const button = zoneNamed(page, 'monorepo').getByRole('button', { name: 'Clean up zone' });
      await button.focus();
      await page.keyboard.press('Enter');
      await settled(page);
    };
    await cleanUp();
    const arranged = await places(page);

    // Its window closed, the tile opens in its room: nothing moves, and nothing overlaps where it is laid out.
    await page.getByTestId('dock-item').getByRole('button', { name: 'Close Open the docs' }).click();
    await expect(expandedTile(page)).toHaveCount(2);
    await settled(page);
    expect(await places(page)).toEqual(arranged);
    expect(await openTiles(page)).toHaveLength(2);
    expectNoOverlap(await savedRects(page));
    expectNoOverlap(await drawnTiles(page));

    // Collapsed and expanded again, the unpinned tile comes back to the same room, and nothing moves.
    await open.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(expandedTile(page)).toHaveCount(1);
    await settled(page);
    await named(page, 'Open the docs').dblclick();
    await expect(expandedTile(page)).toHaveCount(2);
    await settled(page);
    expect(await places(page)).toEqual(arranged);
    expectNoOverlap(await drawnTiles(page));

    // ⌘K away to a compact tile and back to the expanded one moves nothing.
    const openBefore = await openTiles(page);
    expect(openBefore).toHaveLength(2);
    await jumpTo(page, 'Fold the images');
    await jumpTo(page, 'Open the docs');
    // The board draws only what is in view, and ⌘K flies the view to the tile picked: an expanded tile out of view is
    // open but not drawn, so the tiles open are read from what the board keeps, then counted on screen once fitted.
    await expect.poll(() => openTiles(page)).toEqual(openBefore);
    await settled(page);
    await expect(expandedTile(page)).toHaveCount(2);
    expect(await places(page)).toEqual(arranged);
    expectNoOverlap(await drawnTiles(page));

    // After a restart, the same zone: the same places, and still nothing overlaps.
    await app.close();
    ({ app, window: page } = await launch(dataDir, env));
    await expect(expandedTile(page).and(page.locator('[data-pinned="true"]'))).toHaveCount(1);
    await settled(page);
    expect(await places(page)).toEqual(arranged);
    expectNoOverlap(await savedRects(page));
    // Cleaned up again, the zone is laid out as it was.
    await cleanUp();
    expect(await places(page)).toEqual(arranged);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
