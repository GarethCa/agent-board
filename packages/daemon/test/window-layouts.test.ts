import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { DaemonRpcError } from '../src/client.ts';
import { paneIds } from '../src/pane-layout.ts';
import type { ShellOwner } from '../src/protocol.ts';
import { placeSurface, singlePane, type WindowLayout } from '../src/window-layout.ts';
import { connectTestClient, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

async function setup(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }) });
  return { daemon, client: await connectTestClient(daemon), dataDir };
}

const rejects = async (call: Promise<unknown>, message: RegExp) => {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonRpcError);
  expect((error as Error).message).toMatch(message);
};

/** The window with a shell tab beside its own surface, in a pane of its own. */
const besideOwn = (shellId: string): WindowLayout => {
  let n = 0;
  return placeSurface(singlePane([{ kind: 'own' }, { kind: 'shell', shellId }]), { kind: 'shell', shellId }, { pane: 'main', edge: 'right' }, () => `id${++n}`);
};

describe("a session window's panes", () => {
  it('keeps the layout an agent\'s window saves, across a restart, and has none until one is saved', async () => {
    const dataDir = tempDataDir();
    const first = await setup(dataDir);
    const zone = await first.client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Wire it', harness: 'claude', cols: 100, rows: 30 });
    const owner: ShellOwner = { kind: 'agent', id: agent.sessionId };
    const tab = await first.client.call('shell.createTab', { owner });

    expect(await first.client.call('shell.windowLayout', { owner })).toBeNull();
    const layout = besideOwn(tab.id);
    expect(await first.client.call('shell.setWindowLayout', { owner, layout })).toEqual(layout);
    expect(await first.client.call('shell.windowLayout', { owner })).toEqual(layout);
    await first.daemon.stop();

    const second = await setup(dataDir);
    expect(await second.client.call('shell.windowLayout', { owner })).toEqual(layout);
  });

  it("keeps a shell tile's, and refuses a layout that isn't one, an unknown owner, and a tab as an owner", async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const owner: ShellOwner = { kind: 'shell', id: tile.id };
    const tab = await client.call('shell.createTab', { owner });

    await client.call('shell.setWindowLayout', { owner, layout: besideOwn(tab.id) });
    expect(await client.call('shell.windowLayout', { owner })).toEqual(besideOwn(tab.id));

    await rejects(client.call('shell.setWindowLayout', { owner, layout: { type: 'pane', id: 'p', tabs: [], active: 'own' } as unknown as WindowLayout }), /not a window layout/);
    await rejects(client.call('shell.setWindowLayout', { owner: { kind: 'shell', id: 'nope' }, layout: singlePane([{ kind: 'own' }]) }), /no shell nope/);
    await rejects(client.call('shell.setWindowLayout', { owner: { kind: 'agent', id: 'nope' }, layout: singlePane([{ kind: 'own' }]) }), /no agent nope/);
    await rejects(client.call('shell.setWindowLayout', { owner: { kind: 'shell', id: tab.id }, layout: singlePane([{ kind: 'own' }]) }), /is a tab/);
  });

  it('forgets the layout with its owner: an agent deleted, or a shell tile', async () => {
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Wire it', harness: 'claude', cols: 100, rows: 30 });
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const owners: ShellOwner[] = [
      { kind: 'agent', id: agent.sessionId },
      { kind: 'shell', id: tile.id },
    ];
    for (const owner of owners) await client.call('shell.setWindowLayout', { owner, layout: singlePane([{ kind: 'own' }]) });

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    await client.call('shell.delete', { shellId: tile.id });

    for (const owner of owners) expect(await client.call('shell.windowLayout', { owner })).toBeNull();
  });

  it('forgets a shell tile\'s layout when its last pane closes and the tile goes with it', async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const owner: ShellOwner = { kind: 'shell', id: tile.id };
    await client.call('shell.setWindowLayout', { owner, layout: singlePane([{ kind: 'own' }]) });

    expect(await client.call('shell.closePane', { shellId: tile.id, sessionId: paneIds(tile.layout)[0]! })).toBeNull();

    expect(await client.call('shell.windowLayout', { owner })).toBeNull();
  });

  it("lays tabs split inside themselves out as the window's panes, once, no shell restarting, and leaves a shell tile's own panes", async () => {
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Wire it', harness: 'claude', cols: 100, rows: 30 });
    const owner: ShellOwner = { kind: 'agent', id: agent.sessionId };
    const own = await client.call('shell.ownTab', { agentId: agent.sessionId });
    const beside = await client.call('shell.split', { shellId: own.id, sessionId: agent.sessionId, direction: 'vertical' });
    const tab = await client.call('shell.createTab', { owner });
    const split = await client.call('shell.split', { shellId: tab.id, sessionId: paneIds(tab.layout)[0]!, direction: 'horizontal' });
    const live = async () => (await client.call('session.list')).filter((session) => session.endedAt === null).map((session) => session.id).sort();
    const sessionsBefore = await live();

    const { layout, tabs: returned } = await client.call('shell.unsplitTabs', { owner });

    const tabs = (await client.call('shell.list')).filter((shell) => shell.owner?.id === agent.sessionId);
    expect(tabs.every((shell) => paneIds(shell.layout).length === 1)).toBe(true);
    expect(tabs).toHaveLength(4);
    const rowOf = (sessionId: string) => tabs.find((shell) => paneIds(shell.layout)[0] === sessionId)!.id;
    const [, besidePane] = paneIds(beside.layout);
    const [first, second] = paneIds(split.layout);
    // Each split is the window's now, where its tab was: the agent above its shell, and the shell tab's second pane
    // beside the pane holding that tab.
    expect(rowOf(first!)).toBe(tab.id);
    expect(layout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { id: 'main', tabs: [{ kind: 'own' }, { kind: 'shell', shellId: tab.id }] },
        second: { tabs: [{ kind: 'shell', shellId: rowOf(second!) }] },
      },
      second: { tabs: [{ kind: 'shell', shellId: rowOf(besidePane!) }] },
    });
    expect(await client.call('shell.windowLayout', { owner })).toEqual(layout);
    expect(await live()).toEqual(sessionsBefore);
    // Nothing left to lay out: the layout as kept.
    expect(returned.map((shell) => shell.id).sort()).toEqual(tabs.map((shell) => shell.id).sort());
    expect((await client.call('shell.unsplitTabs', { owner })).layout).toEqual(layout);

    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    await client.call('shell.split', { shellId: tile.id, sessionId: paneIds(tile.layout)[0]!, direction: 'horizontal' });
    expect((await client.call('shell.unsplitTabs', { owner: { kind: 'shell', id: tile.id } })).layout).toBeNull();
    expect(paneIds((await client.call('shell.list')).find((shell) => shell.id === tile.id)!.layout)).toHaveLength(2);
  });

  it('refuses a layout for a shell tile being deleted', async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const owner: ShellOwner = { kind: 'shell', id: tile.id };

    const deleting = client.call('shell.delete', { shellId: tile.id });
    await rejects(client.call('shell.setWindowLayout', { owner, layout: singlePane([{ kind: 'own' }]) }), /being deleted|no shell/);
    await deleting;
    expect(await client.call('shell.windowLayout', { owner })).toBeNull();
  });
});
