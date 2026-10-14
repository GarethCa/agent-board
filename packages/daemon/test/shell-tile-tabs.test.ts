import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonRpcError } from '../src/client.ts';
import { readBoard } from '../src/board-ops.ts';
import { paneIds } from '../src/pane-layout.ts';
import type { Shell, ShellOwner } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

async function setup(options: { dataDir?: string; home?: string } = {}) {
  const dataDir = options.dataDir ?? tempDataDir();
  const daemon = await startTestDaemon({ dataDir, ...(options.home === undefined ? {} : { homeDir: options.home }) });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client), dataDir };
}

const ownerOf = (tile: Shell): ShellOwner => ({ kind: 'shell', id: tile.id });
const tabsOf = (shells: Shell[], tileId: string) => shells.filter((shell) => shell.owner?.kind === 'shell' && shell.owner.id === tileId);

const rejects = async (call: Promise<unknown>, message: RegExp) => {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonRpcError);
  expect((error as Error).message).toMatch(message);
};

describe("a shell tile's tabs", () => {
  it("opens a tab in the tile's folder, owned by the tile and no tile of its own, its first tab the tile's own panes", async () => {
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const tile = await client.call('shell.create', { zoneId: zone.id });

    const tab = await client.call('shell.createTab', { owner: ownerOf(tile) });

    expect(tab).toMatchObject({ owner: { kind: 'shell', id: tile.id }, zoneId: null, position: null, cwd: tile.cwd, name: 'sh' });
    const pane = paneIds(tab.layout)[0]!;
    expect((await client.call('session.list')).find((session) => session.id === pane)).toMatchObject({ harness: null, cwd: tile.cwd });
    expect((await client.call('shell.createTab', { owner: ownerOf(tile) })).name).toBe('sh 2');
    // The tile keeps its own panes, as its first tab.
    expect((await client.call('shell.list')).find((shell) => shell.id === tile.id)?.layout).toEqual(tile.layout);
    expect((await readBoard(client)).shells.map((shell) => shell.id)).toEqual([tile.id]);
    await rejects(client.call('shell.move', { shellId: tab.id, zoneId: null, x: 0, y: 0 }), /a tab has no tile/);
  });

  it("opens a tab at a folder or running one of the tile's folder's scripts, and refuses an unknown or tabbed owner", async () => {
    const { client, recorder } = await setup();
    const repo = tempRepo();
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'echo up' } }));
    const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
    const tile = await client.call('shell.create', { zoneId: zone.id });
    const folder = tempDataDir();

    expect((await client.call('shell.createTab', { owner: ownerOf(tile), cwd: folder })).cwd).toBe(folder);
    expect(await client.call('shell.scripts', { owner: ownerOf(tile) })).toEqual({ runner: 'npm', scripts: ['dev'] });
    const script = await client.call('shell.createTab', { owner: ownerOf(tile), script: 'dev' });
    expect(script.name).toBe('npm dev');
    const pane = paneIds(script.layout)[0]!;
    await client.call('session.attach', { sessionId: pane });
    await recorder.waitForText(pane, 'npm run dev');

    await rejects(client.call('shell.createTab', { owner: { kind: 'shell', id: 'nope' } }), /no shell nope/);
    // A tab is no tile, so it has no tabs of its own.
    await rejects(client.call('shell.createTab', { owner: ownerOf(script) }), /is a tab/);
    await rejects(client.call('shell.createTab', { owner: { kind: 'zone', id: zone.id } as unknown as ShellOwner }), /owner/);
  });

  it('ends and removes its tabs with the tile when the tile is deleted', async () => {
    const { client, recorder } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const tab = await client.call('shell.createTab', { owner: ownerOf(tile) });

    await client.call('shell.delete', { shellId: tile.id });

    expect(await client.call('shell.list')).toEqual([]);
    const live = (await client.call('session.list')).map((session) => session.id);
    for (const pane of [...paneIds(tile.layout), ...paneIds(tab.layout)]) expect(live).not.toContain(pane);
    const removed = recorder.events.filter((event) => event.type === 'shell.removed').map((event) => (event as { shellId: string }).shellId);
    expect(removed.sort()).toEqual([tile.id, tab.id].sort());
  });

  it('closing the last pane of its first tab brings the next tab first, keeping the tile and its place', async () => {
    const { client, recorder } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 40, y: 60 } });
    // Opened elsewhere, it doesn't move the tile's folder when it becomes its first.
    const tab = await client.call('shell.createTab', { owner: ownerOf(tile), cwd: tempDataDir() });
    const later = await client.call('shell.createTab', { owner: ownerOf(tile) });

    const closed = await client.call('shell.closePane', { shellId: tile.id, sessionId: paneIds(tile.layout)[0]! });

    expect(closed).toMatchObject({ id: tile.id, name: tile.name, layout: tab.layout, cwd: tile.cwd, position: { x: 40, y: 60 }, owner: null });
    const shells = await client.call('shell.list');
    expect(shells.map((shell) => shell.id)).toEqual([tile.id, later.id]);
    expect((await client.call('session.list')).map((session) => session.id)).toContain(paneIds(tab.layout)[0]);
    expect(recorder.events).toContainEqual({ type: 'shell.removed', shellId: tab.id });

    // With no tab left after it, the tile goes, as before.
    await client.call('shell.delete', { shellId: later.id });
    expect(await client.call('shell.closePane', { shellId: tile.id, sessionId: paneIds(tab.layout)[0]! })).toBeNull();
    expect(await client.call('shell.list')).toEqual([]);
  });

  it('passes over a tab closed while the first tab is being closed, taking the next', async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const closing = await client.call('shell.createTab', { owner: ownerOf(tile) });
    const next = await client.call('shell.createTab', { owner: ownerOf(tile) });
    const own = paneIds(tile.layout)[0]!;
    // Its shell already ended, closing the tile's pane is quick, while closing the tab waits for its shell to end.
    await client.call('session.kill', { sessionId: own });

    const [, closed] = await Promise.all([
      client.call('shell.delete', { shellId: closing.id }),
      client.call('shell.closePane', { shellId: tile.id, sessionId: own }),
    ]);

    expect(closed).toMatchObject({ id: tile.id, layout: next.layout });
    expect((await client.call('shell.list')).map((shell) => shell.id)).toEqual([tile.id]);
  });

  it('opens no tab for a tile while it is being deleted', async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    await client.call('shell.createTab', { owner: ownerOf(tile) });

    const [, opened] = await Promise.allSettled([
      client.call('shell.delete', { shellId: tile.id }),
      client.call('shell.createTab', { owner: ownerOf(tile) }),
    ]);

    expect(opened).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/being deleted/) } });
    expect(await client.call('shell.list')).toEqual([]);
  });

  it("splits a tab's pane, and keeps the tabs across a daemon restart", async () => {
    const dataDir = tempDataDir();
    const home = tempDataDir();
    const first = await setup({ dataDir, home });
    const zone = await first.client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const tile = await first.client.call('shell.create', { zoneId: zone.id });
    const tab = await first.client.call('shell.createTab', { owner: ownerOf(tile) });
    const split = await first.client.call('shell.split', { shellId: tab.id, sessionId: paneIds(tab.layout)[0]!, direction: 'vertical' });
    expect(paneIds(split.layout)).toHaveLength(2);
    await first.daemon.stop();

    const second = await setup({ dataDir, home });
    const [after] = tabsOf(await second.client.call('shell.list'), tile.id);
    expect(after).toMatchObject({ id: tab.id, layout: split.layout, stoppedPanes: paneIds(split.layout) });
  });

  it("closes a shell tile's own panes as one step, its next tab becoming its own, and refuses with no other tab to take their place", async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    await client.call('shell.split', { shellId: tile.id, sessionId: paneIds(tile.layout)[0]!, direction: 'horizontal' });
    const ownPanes = paneIds((await client.call('shell.list')).find((shell) => shell.id === tile.id)!.layout);
    await rejects(client.call('shell.closeOwnPanes', { shellId: tile.id }), /no other tab/);
    const tab = await client.call('shell.createTab', { owner: ownerOf(tile) });

    const closed = await client.call('shell.closeOwnPanes', { shellId: tile.id });

    expect(closed).toMatchObject({ promoted: tab.id, tile: { id: tile.id, layout: tab.layout } });
    const shells = await client.call('shell.list');
    expect(shells.map((shell) => shell.id)).toEqual([tile.id]);
    const live = (await client.call('session.list')).map((session) => session.id);
    for (const pane of ownPanes) expect(live).not.toContain(pane);
    expect(live).toContain(paneIds(tab.layout)[0]);
    await rejects(client.call('shell.closeOwnPanes', { shellId: tab.id }), /no shell/);
  });
});
