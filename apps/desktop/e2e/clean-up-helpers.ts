import { expect, type Page } from '@playwright/test';
import { agents, untilStarted, zoneNamed, zones } from './agent-helpers.ts';
import { untilStill } from './board-helpers.ts';

type Place = { x: number; y: number };
const at = (place: Place | null | undefined): Place => ({ x: place!.x, y: place!.y });

/** Every agent's place, by name. */
const places = async (page: Page) => Object.fromEntries((await agents(page)).map((agent) => [agent.name, at(agent.position)]));
export const items = (page: Page) => page.evaluate(() => window.agentBoard.items.list());

/** Every agent's and item's place, by name and id, and how many Done lines there are. */
export async function layout(page: Page) {
  const all = await items(page);
  return {
    agents: await places(page),
    items: Object.fromEntries(all.filter((item) => item.kind !== 'done-line').map((item) => [item.id, at(item)])),
    doneLines: all.filter((item) => item.kind === 'done-line').length,
  };
}

const moveByHand = (page: Page, sessionId: string, zoneId: string, place: Place) =>
  page.evaluate(async ({ sessionId, zoneId, place }) => window.agentBoard.agents.move(sessionId, { zoneId, ...place, byHand: true }), { sessionId, zoneId, place });

/**
 * A busy zone `monorepo` on Spine: two of the user's agents brought into the rule as bands (Resize images, then Pick a
 * cache), a third (Write docs) dragged clear of them and so placed by hand, a note Resize images wrote left far from
 * it, a sticky of the user's own, and Pick a cache's ticket finished. Resolves with the ids, once all of it is still.
 */
export async function busySpineZone(page: Page) {
  const [zone] = await zones(page);
  for (const [prompt, position] of [
    ['Resize images', { x: 40, y: 140 }],
    ['Pick a cache', { x: 40, y: 520 }],
    ['Write docs', { x: 1000, y: 160 }],
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
  await expect.poll(async () => (await agents(page)).length, { timeout: 30_000 }).toBe(3);
  await untilStill(async () => JSON.stringify(await places(page)));
  const sessionOf = async (name: string) => (await agents(page)).find((agent) => agent.name === name)!.sessionId;
  const [resize, cache, docs] = [await sessionOf('Resize images'), await sessionOf('Pick a cache'), await sessionOf('Write docs')];

  await zoneNamed(page, 'monorepo').getByRole('button', { name: 'Clean up and spacing' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: /^Spine/ }).click();
  await expect.poll(async () => (await zones(page))[0]!.layoutRule).toBe('spine');

  // The first joins wherever it is put, with nothing laid out yet; the next joins dropped on that band.
  await moveByHand(page, resize, zone!.id, { x: 60, y: 160 });
  await untilStill(async () => JSON.stringify(await places(page)));
  const band = (await places(page))['Resize images']!;
  await moveByHand(page, cache, zone!.id, { x: band.x + 40, y: band.y + 20 });
  await expect.poll(async () => (await places(page))['Pick a cache']!.y).toBeGreaterThan(band.y);
  await untilStill(async () => JSON.stringify(await places(page)));
  // Dragged clear of the bands, the third is placed by hand, and the rule leaves it there.
  await moveByHand(page, docs, zone!.id, { x: 1048, y: 192 });
  await expect.poll(async () => (await zones(page))[0]!.handPlaced).toEqual([`agent:${docs}`]);

  const note = await page.evaluate(
    async ({ zoneId, sessionId }) =>
      window.agentBoard.items.create({
        kind: 'agent-note',
        zoneId,
        x: 1000,
        y: 760,
        width: 240,
        height: 100,
        data: { text: 'The plan', agent: { sessionId, name: 'Resize images', harness: 'claude', role: 'implementer' }, writtenAt: '2026-10-16T09:00:00.000Z', editedByUser: false },
      }),
    { zoneId: zone!.id, sessionId: resize },
  );
  const sticky = await page.evaluate(
    async (zoneId) => window.agentBoard.items.create({ kind: 'sticky', zoneId, x: 1400, y: 560, width: 200, height: 200, data: { text: 'mine', color: '#fff3a3' } }),
    zone!.id,
  );
  await page.evaluate(async (sessionId) => window.agentBoard.agents.stop(sessionId), cache);
  await expect.poll(async () => (await agents(page)).find((agent) => agent.sessionId === cache)!.state).toBe('done');
  await untilStill(async () => JSON.stringify(await layout(page)));
  return { zone: zone!, resize, cache, docs, note, sticky };
}

/** Cleans the zone `monorepo` up from its ⋯ menu, and waits for the toast and for every place to hold. */
export async function cleanUpFromMenu(page: Page): Promise<void> {
  await zoneNamed(page, 'monorepo').getByRole('button', { name: 'Zone options' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^Clean up/ }).first().click();
  await expect(page.getByLabel('Notifications')).toContainText(/Cleaned up monorepo · \d+ moved · 1 to Done/);
  await untilStill(async () => JSON.stringify(await layout(page)));
}
