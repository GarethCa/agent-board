import { expect, type Page } from '@playwright/test';
import { agents, launch, listFinishedTurns, tile, tileAction, untilStarted, zoneNamed, zones } from './agent-helpers.ts';
import { centreOf, drag, settledBox, untilStill } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

const named = (page: Page, name: string) => tile(page).filter({ has: page.getByText(name, { exact: true }) });
/** Every agent's saved place, by name. */
const places = async (page: Page) => Object.fromEntries((await agents(page)).map((agent) => [agent.name, agent.position]));

test('a zone on Lanes by ticket lays its agents out by the rule; a tile dragged away is pinned and left alone, until it is put back', async () => {
  const { repo, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, env);
  try {
    await listFinishedTurns(page);
    await pickFolderNext(app, repo);
    await browseForZone(page);
    const [zone] = await zones(page);
    for (const [prompt, position] of [
      ['Pick a cache', { x: 40, y: 520 }],
      ['Resize images', { x: 760, y: 140 }],
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
    await expect.poll(async () => (await agents(page)).length, { timeout: 30_000 }).toBe(2);
    await expect(tile(page)).toHaveCount(2);
    const scattered = await places(page);

    // The rule is picked in the same Layout list as the views.
    await zoneNamed(page, 'monorepo').getByRole('button', { name: 'Tidy and spacing' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio', { name: /^Free/ })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: /Lanes by ticket/ }).click();
    await expect(menu).toBeHidden();
    await expect.poll(async () => (await zones(page))[0]!.layoutRule).toBe('lanes');
    // The daemon lays the zone out by it: the agents leave where they were put.
    await expect.poll(async () => JSON.stringify(await places(page))).not.toBe(JSON.stringify(scattered));
    await untilStill(async () => JSON.stringify(await places(page)));
    const laidOut = await places(page);
    await expect(page.getByTestId('tile-hand-placed')).toHaveCount(0);

    // Dragged by hand, a tile leaves the rule: it keeps the place it was put down at, with a pin beside its title.
    const cache = named(page, 'Pick a cache');
    const head = centreOf(await settledBox(cache.locator('.hybrid-tile-head')));
    // A short drag, so it is put down still inside the zone (sized to its lanes).
    await drag(page, head, { x: head.x + 48, y: head.y + 32 });
    await expect.poll(async () => (await agents(page)).find((agent) => agent.name === 'Pick a cache')!.zoneId).toBe(zone!.id);
    await expect(cache.getByTestId('tile-hand-placed')).toBeVisible();
    await expect.poll(async () => (await zones(page))[0]!.handPlaced).toHaveLength(1);
    const dropped = (await places(page))['Pick a cache'];
    expect(dropped).not.toEqual(laidOut['Pick a cache']);
    // A change to what the zone holds lays it out again, and still leaves the pinned tile where it is. A new agent is
    // that change: it leaves the place it was started at only once the zone has been laid out again.
    const startedAt = { x: 420, y: 330 };
    await page.evaluate(
      async ({ zoneId, position }) => {
        const result = await window.agentBoard.agents.spawn({ zoneId, prompt: 'Trim the logs', position, cols: 100, rows: 30 });
        if (result.status !== 'started') throw new Error(result.message);
      },
      { zoneId: zone!.id, position: startedAt },
    );
    await untilStarted(page);
    await expect.poll(async () => (await agents(page)).length, { timeout: 30_000 }).toBe(3);
    const trim = async () => {
      const position = (await agents(page)).find((agent) => agent.name === 'Trim the logs')?.position;
      return position ? { x: position.x, y: position.y } : startedAt;
    };
    await expect.poll(trim).not.toEqual(startedAt);
    await untilStill(async () => JSON.stringify(await places(page)));
    expect((await places(page))['Pick a cache']).toEqual(dropped);

    // Put back under the rule, it goes back into its lane and loses the pin.
    // From the tile's own menu, which is the same whatever else is selected.
    await settledBox(cache);
    await tileAction(cache, 'Put back under the rule', 'Arrange');
    await expect(cache.getByTestId('tile-hand-placed')).toHaveCount(0);
    await expect.poll(async () => (await zones(page))[0]!.handPlaced).toEqual([]);
    await expect.poll(async () => (await places(page))['Pick a cache']).not.toEqual(dropped);
    await untilStill(async () => JSON.stringify(await places(page)));
    // Laid out with the others again: it sits apart from where it was dropped, and no other tile is where it is.
    const back = await places(page);
    expect(Object.values(back).filter((place) => JSON.stringify(place) === JSON.stringify(back['Pick a cache']))).toHaveLength(1);
  } finally {
    await app.close();
    removeDataDir(dataDir);
  }
});
