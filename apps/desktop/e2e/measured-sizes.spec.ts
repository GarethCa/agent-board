import { expect, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { DaemonClient } from '@agent-board/daemon/client';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { agents, launch, spawnAgent, tile, zones } from './agent-helpers.ts';
import { withDaemon } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// An orchestrator's arrange sizes each lane's note to what the app measures its text at, not to the daemon's estimate,
// and its zone map knows the board was measured.

/** The board token of the agent `sessionId`, which the fake harness prints when asked for its identity. */
async function tokenOf(client: DaemonClient, sessionId: string): Promise<string> {
  let text = '';
  const printed = new Promise<string>((resolve) =>
    client.onEvent((event) => {
      if ((event.type === 'session.snapshot' || event.type === 'session.output') && event.sessionId === sessionId) text += event.data;
      const token = /identity:(.*):end\r\n/.exec(text)?.[1];
      if (token !== undefined) resolve(token);
    }),
  );
  await client.call('session.attach', { sessionId });
  return printed;
}

const fitView = (window: Page) => window.getByRole('button', { name: /^Fit view/ }).click();

test("arranges a lane round its note at the height the app measures its text at, and maps the zone as measured", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Print your board identity');
    await expect(tile(window)).toHaveCount(1);
    const [lead] = await agents(window);
    const [zone] = await zones(window);
    const token = await withDaemon(dataDir, (client) => tokenOf(client, lead!.sessionId));
    await withDaemon(dataDir, async (client) => {
      await client.call('orchestrator.spawn', { token, name: 'worker', prompt: 'Do the work' });
      await client.call('orchestrator.arrange', { token });
    });
    await fitView(window);
    const noteOf = () => window.evaluate(async () => (await globalThis.window.agentBoard.items.list()).find((item: BoardItem) => item.kind === 'agent-note')!);
    const written = await noteOf();

    // The user writes the lane's note long: far more than a tile's height, and less than the daemon reckons it needs.
    const long = Array.from({ length: 12 }, (_, index) => `- step ${index + 1} is done`).join('\n');
    await window.evaluate(({ id, text }) => globalThis.window.agentBoard.items.update({ id, data: { text, editedByUser: true } }), { id: written.id, text: long });
    await fitView(window);
    const arranged = await withDaemon(dataDir, (client) => client.call('orchestrator.arrange', { token }));
    expect(arranged.unmeasured).toBe(false);
    // Its text shows whole, with no room to spare under it, and nothing is laid on top of anything.
    const body = window.getByTestId('agent-note').locator('.agent-note-body');
    const room = () =>
      body.evaluate((element: HTMLElement) => {
        const drawn = element.clientHeight;
        element.style.flex = '0 0 auto';
        const own = element.clientHeight;
        element.style.flex = '';
        return drawn - own;
      });
    await expect.poll(room).toBeGreaterThanOrEqual(-1);
    await expect.poll(room).toBeLessThanOrEqual(2);
    expect((await noteOf()).data.text).toBe(long);
    const map = await withDaemon(dataDir, (client) => client.call('orchestrator.map', { zoneId: zone!.id }));
    expect({ unmeasured: map.unmeasured, overlaps: map.overlaps, offGrid: map.offGrid }).toEqual({ unmeasured: false, overlaps: [], offGrid: [] });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
