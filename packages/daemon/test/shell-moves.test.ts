import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { DaemonRpcError, type DaemonClient } from '../src/client.ts';
import type { Daemon } from '../src/daemon.ts';
import { readBoard } from '../src/board-ops.ts';
import { paneIds } from '../src/pane-layout.ts';
import { inTabOrder, isOwnedBy, type Shell, type ShellOwner, type ShellRemovedEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/** A daemon whose agents run the fake claude, waiting for an answer so they stay running. */
async function setup() {
  const home = tempDataDir();
  const daemon = await startTestDaemon({
    dataDir: tempDataDir(),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'waiting', home, idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client) };
}

async function spawnAgent(client: DaemonClient, x = 0) {
  const zone = await client.call('zone.add', { path: tempRepo(), x, y: 0 });
  return client.call('agent.spawn', { zoneId: zone.id, prompt: 'Wire the fallback', harness: 'claude', cols: 100, rows: 30 });
}

const agentOwner = (agentId: string): ShellOwner => ({ kind: 'agent', id: agentId });
const tileOwner = (tile: Shell): ShellOwner => ({ kind: 'shell', id: tile.id });
const ownedBy = (shells: Shell[], owner: ShellOwner) => inTabOrder(shells.filter((shell) => isOwnedBy(shell, owner)));
const listed = async (client: DaemonClient, id: string) => (await client.call('shell.list')).find((shell) => shell.id === id);
const onlyPane = (shell: Shell) => paneIds(shell.layout)[0]!;
const running = async (client: DaemonClient, sessionId: string) =>
  (await client.call('session.list')).some((session) => session.id === sessionId && session.endedAt === null);

const rejects = async (call: Promise<unknown>, message: RegExp) => {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonRpcError);
  expect((error as Error).message).toMatch(message);
};

/** Types `echo <marker>` into the pane and waits for it: output the pane must still show after it moves. */
async function mark(client: DaemonClient, recorder: ReturnType<typeof recordEvents>, pane: string, marker: string) {
  await client.call('session.attach', { sessionId: pane });
  await client.call('session.write', { sessionId: pane, data: `echo ${marker}-ok\r` });
  await recorder.waitForText(pane, `${marker}-ok\r\n`);
}

/** Who the pane's shell says it is, through its board token, asked on a connection of its own: one that presents a token is that session's. */
async function identify(client: DaemonClient, recorder: ReturnType<typeof recordEvents>, daemon: Daemon, pane: string) {
  await client.call('session.attach', { sessionId: pane });
  await client.call('session.write', { sessionId: pane, data: 'echo "token:$AGENT_BOARD_IDENTITY:end"\r' });
  await recorder.waitForText(pane, ':end\r\n');
  const token = /token:(.*):end\r\n/.exec(recorder.screenText(pane))![1]!;
  return (await connectTestClient(daemon)).call('board.identify', { token });
}

describe('moving a tab', () => {
  it("moves an agent's shell tab into another agent's tabs, after its others, the same process speaking for its new owner", async () => {
    const { daemon, client, recorder } = await setup();
    const from = await spawnAgent(client);
    const to = await spawnAgent(client, 900);
    const tab = await client.call('shell.createTab', { owner: agentOwner(from.sessionId) });
    const kept = await client.call('shell.createTab', { owner: agentOwner(to.sessionId) });
    const pane = onlyPane(tab);
    await mark(client, recorder, pane, 'before');
    const sessions = (await client.call('session.list')).length;

    const [moved] = await client.call('shell.moveTab', { shellId: tab.id, to: { owner: agentOwner(to.sessionId) } });

    expect(moved).toMatchObject({ id: tab.id, owner: agentOwner(to.sessionId), layout: tab.layout, cwd: tab.cwd, name: tab.name, zoneId: null, position: null });
    expect(ownedBy(await client.call('shell.list'), agentOwner(to.sessionId)).map((shell) => shell.id)).toEqual([kept.id, tab.id]);
    expect(ownedBy(await client.call('shell.list'), agentOwner(from.sessionId))).toEqual([]);
    // Never restarted: the same session, still live, its output kept.
    const session = (await client.call('session.list')).find((listedSession) => listedSession.id === pane);
    expect(session?.endedAt ?? null).toBeNull();
    expect((await client.call('session.list')).length).toBe(sessions);
    expect(recorder.screenText(pane)).toContain('before-ok');
    expect(await identify(client, recorder, daemon, pane)).toMatchObject({ kind: 'agent', tileId: to.sessionId, name: to.name, orchestrate: null });
  });

  it('moves a tab onto the board as a shell tile, keeping its name and folder, and back into its tabs where it was', async () => {
    const { daemon, client, recorder } = await setup();
    const agent = await spawnAgent(client);
    const first = await client.call('shell.createTab', { owner: agentOwner(agent.sessionId) });
    const tab = await client.call('shell.createTab', { owner: agentOwner(agent.sessionId) });
    const last = await client.call('shell.createTab', { owner: agentOwner(agent.sessionId) });
    const zone = await client.call('zone.add', { path: tempRepo(), x: 1200, y: 0 });

    const [tile] = await client.call('shell.moveTab', { shellId: tab.id, to: { tile: { zoneId: zone.id, x: 40, y: 60, toFront: true } } });

    expect(tile).toMatchObject({ id: tab.id, owner: null, zoneId: zone.id, position: { x: 40, y: 60 }, name: tab.name, cwd: tab.cwd, layout: tab.layout });
    expect((await readBoard(client)).shells.map((shell) => shell.id)).toEqual([tab.id]);
    expect(await identify(client, recorder, daemon, onlyPane(tab))).toMatchObject({ kind: 'shell', tileId: tab.id, zoneId: zone.id });

    // An undo puts it back at its order.
    await client.call('shell.moveTab', { shellId: tab.id, to: { owner: agentOwner(agent.sessionId) }, order: tab.tabOrder });
    expect(ownedBy(await client.call('shell.list'), agentOwner(agent.sessionId)).filter((shell) => shell.id !== agent.sessionId).map((shell) => shell.id)).toEqual([
      first.id,
      tab.id,
      last.id,
    ]);
    expect((await readBoard(client)).shells).toEqual([]);
  });

  it("takes a shell tile into an agent's tabs with its own tabs after it, and puts them all back", async () => {
    const { daemon, client, recorder } = await setup();
    const agent = await spawnAgent(client);
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 2000, y: 0 } });
    const second = await client.call('shell.createTab', { owner: tileOwner(tile) });

    const moved = await client.call('shell.moveTab', { shellId: tile.id, to: { owner: agentOwner(agent.sessionId) } });

    expect(moved.map((shell) => [shell.id, shell.owner])).toEqual([
      [tile.id, agentOwner(agent.sessionId)],
      [second.id, agentOwner(agent.sessionId)],
    ]);
    expect(moved[0]).toMatchObject({ zoneId: null, position: null });
    expect((await readBoard(client)).shells).toEqual([]);
    // A pane of its former tab speaks for the agent, not for a tile that is no longer on the board.
    expect(await identify(client, recorder, daemon, onlyPane(second))).toMatchObject({ kind: 'agent', tileId: agent.sessionId });

    await client.call('shell.moveTab', { shellId: tile.id, to: { tile: { zoneId: null, x: 2000, y: 0, z: tile.position!.z! } } });
    await client.call('shell.moveTab', { shellId: second.id, to: { owner: tileOwner(tile) }, order: second.tabOrder });
    expect(await listed(client, tile.id)).toMatchObject({ owner: null, position: tile.position, layout: tile.layout });
    expect(ownedBy(await client.call('shell.list'), tileOwner(tile)).map((shell) => shell.id)).toEqual([second.id]);
  });

  it("moves a shell tile's tab to another shell tile, and leaves a move into its own owner be", async () => {
    const { client } = await setup();
    const one = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const two = await client.call('shell.create', { zoneId: null, position: { x: 600, y: 0 } });
    const tab = await client.call('shell.createTab', { owner: tileOwner(one) });

    expect(await client.call('shell.moveTab', { shellId: tab.id, to: { owner: tileOwner(one) } })).toEqual([tab]);
    await client.call('shell.moveTab', { shellId: tab.id, to: { owner: tileOwner(two) } });

    expect(ownedBy(await client.call('shell.list'), tileOwner(two)).map((shell) => shell.id)).toEqual([tab.id]);
  });

  it("refuses the agent's own tab, an owner that is a tab, the shell itself, an unknown owner or zone", async () => {
    const { client } = await setup();
    const agent = await spawnAgent(client);
    const own = await client.call('shell.ownTab', { agentId: agent.sessionId });
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 2000, y: 0 } });
    const tab = await client.call('shell.createTab', { owner: tileOwner(tile) });

    await rejects(client.call('shell.moveTab', { shellId: own.id, to: { tile: { zoneId: null, x: 0, y: 0 } } }), /own tab stays with its agent/);
    await rejects(client.call('shell.moveTab', { shellId: tile.id, to: { owner: tileOwner(tab) } }), /a tab has no tile/);
    await rejects(client.call('shell.moveTab', { shellId: tile.id, to: { owner: tileOwner(tile) } }), /can't be a tab of its own/);
    await rejects(client.call('shell.moveTab', { shellId: tab.id, to: { owner: agentOwner('nobody') } }), /no agent nobody/);
    await rejects(client.call('shell.moveTab', { shellId: tab.id, to: { tile: { zoneId: 'nowhere', x: 0, y: 0 } } }), /no zone nowhere/);
    await rejects(client.call('shell.moveTab', { shellId: tab.id, to: { somewhere: true } as never }), /owner or a tile/);
  });

  it('refuses a move into an agent being deleted, after its own tabs have gone, so no shell is left running in no window', async () => {
    const { client, recorder } = await setup();
    const agent = await spawnAgent(client);
    const tab = await client.call('shell.createTab', { owner: agentOwner(agent.sessionId) });
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 2000, y: 0 } });
    const pane = onlyPane(tile);

    // Its tabs end first; its worktree goes after, while the agent is still listed.
    const deleted = client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    await recorder.waitFor((event): event is ShellRemovedEvent => event.type === 'shell.removed' && event.shellId === tab.id);
    await rejects(client.call('shell.moveTab', { shellId: tile.id, to: { owner: agentOwner(agent.sessionId) } }), /being deleted/);
    await rejects(client.call('shell.createTab', { owner: agentOwner(agent.sessionId) }), /being deleted/);
    await deleted;

    expect((await listed(client, tile.id))?.owner).toBeNull();
    expect(await running(client, pane)).toBe(true);
  });
});

describe('moving a pane', () => {
  it("moves a pane out of a split into another agent's tabs, and puts it back as it was", async () => {
    const { daemon, client, recorder } = await setup();
    const from = await spawnAgent(client);
    const to = await spawnAgent(client, 900);
    const tab = await client.call('shell.createTab', { owner: agentOwner(from.sessionId) });
    const split = await client.call('shell.split', { shellId: tab.id, sessionId: onlyPane(tab), direction: 'horizontal' });
    const named = await client.call('shell.setPaneName', { shellId: tab.id, sessionId: paneIds(split.layout)[1]!, name: 'dev server' });
    const pane = paneIds(named.layout)[1]!;
    await mark(client, recorder, pane, 'split');

    const { moved, source, layoutBefore } = await client.call('shell.movePane', { shellId: tab.id, sessionId: pane, to: { owner: agentOwner(to.sessionId) } });

    expect(moved).toMatchObject({ owner: agentOwner(to.sessionId), name: 'dev server', layout: { type: 'pane', sessionId: pane } });
    expect(paneIds(source.layout)).toEqual([onlyPane(tab)]);
    expect(layoutBefore).toEqual(named.layout);
    expect(recorder.screenText(pane)).toContain('split-ok');
    expect(await identify(client, recorder, daemon, pane)).toMatchObject({ kind: 'agent', tileId: to.sessionId });

    const back = await client.call('shell.returnPane', { shellId: tab.id, sessionId: pane, layout: layoutBefore });

    expect(back.layout).toEqual(named.layout);
    expect(await listed(client, moved.id)).toBeUndefined();
    expect((await client.call('session.list')).find((session) => session.id === pane)?.endedAt ?? null).toBeNull();

    // A redo makes the same shell again.
    const again = await client.call('shell.movePane', { shellId: tab.id, sessionId: pane, to: { owner: agentOwner(to.sessionId) }, id: moved.id });
    expect(again.moved.id).toBe(moved.id);
  });

  it('moves a pane onto the board as a shell tile, or into a tab of its own shell tile', async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const split = await client.call('shell.split', { shellId: tile.id, sessionId: onlyPane(tile), direction: 'vertical' });
    const third = await client.call('shell.split', { shellId: tile.id, sessionId: onlyPane(tile), direction: 'vertical' });
    const [, second, last] = paneIds(third.layout);
    expect(paneIds(split.layout)).toContain(last);

    const { moved } = await client.call('shell.movePane', { shellId: tile.id, sessionId: second!, to: { tile: { zoneId: null, x: 500, y: 80 } } });
    const { moved: asTab } = await client.call('shell.movePane', { shellId: tile.id, sessionId: last!, to: { owner: tileOwner(tile) } });

    expect(moved).toMatchObject({ owner: null, position: { x: 500, y: 80 }, name: tile.name, layout: { type: 'pane', sessionId: second } });
    expect(asTab.owner).toEqual(tileOwner(tile));
    expect((await readBoard(client)).shells.map((shell) => shell.id).sort()).toEqual([tile.id, moved.id].sort());
  });

  it("refuses a pane alone in its shell, the agent's own pane, a taken id, or a layout of other panes", async () => {
    const { client } = await setup();
    const agent = await spawnAgent(client);
    const own = await client.call('shell.ownTab', { agentId: agent.sessionId });
    const withShell = await client.call('shell.split', { shellId: own.id, sessionId: agent.sessionId, direction: 'horizontal' });
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 2000, y: 0 } });
    const board = { tile: { zoneId: null, x: 0, y: 0 } };

    await rejects(client.call('shell.movePane', { shellId: tile.id, sessionId: onlyPane(tile), to: board }), /only pane .* move the shell/);
    await rejects(client.call('shell.movePane', { shellId: own.id, sessionId: agent.sessionId, to: board }), /agent's own pane/);
    const shellPane = paneIds(withShell.layout)[1]!;
    await rejects(client.call('shell.movePane', { shellId: own.id, sessionId: shellPane, to: board, id: tile.id }), /already exists/);
    const { moved } = await client.call('shell.movePane', { shellId: own.id, sessionId: shellPane, to: board });
    await rejects(client.call('shell.returnPane', { shellId: own.id, sessionId: onlyPane(tile), layout: withShell.layout }), /must hold the panes/);
    await rejects(client.call('shell.returnPane', { shellId: own.id, sessionId: 'nobody', layout: withShell.layout }), /not alone/);
    expect((await client.call('shell.returnPane', { shellId: own.id, sessionId: shellPane, layout: withShell.layout })).layout).toEqual(withShell.layout);
    expect(await listed(client, moved.id)).toBeUndefined();
  });

  it("refuses to put back a pane whose own shell was closed while the undo waited its turn, leaving no dead pane in the split", async () => {
    const { client } = await setup();
    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const split = await client.call('shell.split', { shellId: tile.id, sessionId: onlyPane(tile), direction: 'horizontal' });
    const pane = paneIds(split.layout)[1]!;
    const { moved, layoutBefore } = await client.call('shell.movePane', { shellId: tile.id, sessionId: pane, to: { tile: { zoneId: null, x: 600, y: 0 } } });

    const closed = client.call('shell.delete', { shellId: moved.id });
    const back = client.call('shell.returnPane', { shellId: tile.id, sessionId: pane, layout: layoutBefore });
    await closed;
    await rejects(back, /not alone in a shell of its own/);

    expect(paneIds((await listed(client, tile.id))!.layout)).toEqual([onlyPane(tile)]);
  });
});
