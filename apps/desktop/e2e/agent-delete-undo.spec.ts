import { expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import type { BoardItem, Connector } from '@agent-board/daemon/protocol';
import { agents, launch, spawnAgent, tile } from './agent-helpers.ts';
import { tokenOf, withDaemon } from './board-helpers.ts';
import { browseForZone, pickFolderNext, removeDataDir, tempDataDir, test } from './launch.ts';
import { scratch } from './scratch.ts';

// An agent's delete of a board item it made is one step on the board's undo: ⌘Z brings the item back with its
// connector, and ⇧⌘Z deletes it again.

test("an agent deletes a queue it made, ⌘Z brings it back with its connector, and ⇧⌘Z deletes it again", async () => {
  const { dir, repo, env } = scratch('orchestrate');
  const dataDir = tempDataDir();
  const { app, window } = await launch(dataDir, env);
  try {
    await pickFolderNext(app, repo);
    await browseForZone(window);
    await spawnAgent(window, 'monorepo', 'Print your board identity');
    await expect(tile(window)).toHaveCount(1);
    const [lead] = await agents(window);
    const token = await withDaemon(dataDir, (client) => tokenOf(client, lead!.sessionId));

    const queue = await withDaemon(dataDir, (client) => client.call('board.newQueue', { token, title: 'Stray' }));
    const note = await window.evaluate(() =>
      globalThis.window.agentBoard.items.create({ kind: 'sticky', zoneId: null, x: 900, y: 600, width: 160, height: 120, data: { text: 'next to it', color: '#fff3a3' } }),
    );
    const line = await window.evaluate(
      ({ from, to }) => globalThis.window.agentBoard.connectors.create({ from: { type: 'item', id: from, side: 'right' }, to: { type: 'item', id: to, side: 'left' } }),
      { from: queue.id, to: note.id },
    );
    const items = () => window.evaluate(() => globalThis.window.agentBoard.items.list());
    const lines = () => window.evaluate(() => globalThis.window.agentBoard.connectors.list());
    const hasQueue = async () => (await items()).some((item: BoardItem) => item.id === queue.id);
    const hasLine = async () => (await lines()).some((each: Connector) => each.id === line.id);
    await expect.poll(hasQueue).toBe(true);

    const told = await withDaemon(dataDir, (client) => client.call('orchestrator.deleteItem', { token, id: queue.id }));
    expect(told.outcome).toBe('deleted');
    await expect.poll(hasQueue).toBe(false);
    await expect.poll(hasLine).toBe(false);

    // ⌘Z: the queue under its id, where it was, with its title, and its connector to the note.
    await window.keyboard.press('ControlOrMeta+Z');
    await expect.poll(hasQueue).toBe(true);
    expect((await items()).find((item: BoardItem) => item.id === queue.id)).toMatchObject({ kind: 'queue', x: queue.x, y: queue.y, data: { title: 'Stray' } });
    await expect.poll(hasLine).toBe(true);

    // ⇧⌘Z: deleted again, its connector with it; the user's note stays throughout.
    await window.keyboard.press('ControlOrMeta+Shift+Z');
    await expect.poll(hasQueue).toBe(false);
    await expect.poll(hasLine).toBe(false);
    expect((await items()).some((item: BoardItem) => item.id === note.id)).toBe(true);
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
