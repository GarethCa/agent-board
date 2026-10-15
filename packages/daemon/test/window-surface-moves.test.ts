import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { DaemonRpcError } from '../src/client.ts';
import type { DaemonEvent, WindowLayoutEvent, WindowOwner } from '../src/protocol.ts';
import { paneOfSurface, singlePane, surfaceKey, windowPanes, type Surface, type WindowLayout } from '../src/window-layout.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

async function setup(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  return { daemon, client, dataDir, recorder: recordEvents(client) };
}

async function twoAgents(client: Awaited<ReturnType<typeof setup>>['client']) {
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  const spawn = (prompt: string) => client.call('agent.spawn', { zoneId: zone.id, prompt, harness: 'claude', cols: 100, rows: 30 });
  const [one, two] = [await spawn('Wire it'), await spawn('Review it')];
  return { zone, one: { kind: 'agent', id: one.sessionId } as const, two: { kind: 'agent', id: two.sessionId } as const };
}

const rejects = async (call: Promise<unknown>, message: RegExp) => {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonRpcError);
  expect((error as Error).message).toMatch(message);
};

const pr: Surface = { kind: 'pr', repo: 'acme/app', number: 7 };
const web: Surface = { kind: 'web', id: 'w1', url: 'http://localhost:5173/' };

const holds = (layout: WindowLayout | null, surface: Surface) => layout !== null && paneOfSurface(layout, surfaceKey(surface)) !== undefined;

const layoutEvents = (events: readonly DaemonEvent[]) => events.filter((event): event is WindowLayoutEvent => event.type === 'window.layout');

describe('moving a tab that is only a place in a window, between windows (slice 4)', () => {
  it('moves a pull request tab into another window where it was dropped, keeps both and tells every client, and says where it was', async () => {
    const { client, recorder } = await setup();
    const { one, two } = await twoAgents(client);
    await client.call('shell.setWindowLayout', { owner: one, layout: singlePane([{ kind: 'own' }, pr]) });
    const tab = await client.call('shell.createTab', { owner: two });
    const target = singlePane([{ kind: 'own' }, { kind: 'shell', shellId: tab.id }]);
    await client.call('shell.setWindowLayout', { owner: two, layout: target });

    const moved = await client.call('shell.moveSurface', { surface: pr, from: one, to: { owner: two, placement: { pane: 'main', edge: 'right' } }});

    expect(moved.was).toEqual({ pane: 'main', index: 1 });
    expect(holds(moved.from, pr)).toBe(false);
    expect(holds(moved.to, pr)).toBe(true);
    expect(windowPanes(moved.to!)).toHaveLength(2);
    expect(await client.call('shell.windowLayout', { owner: one })).toEqual(moved.from);
    expect(await client.call('shell.windowLayout', { owner: two })).toEqual(moved.to);
    await expect.poll(() => layoutEvents(recorder.events).map((event) => [event.owner.id, holds(event.layout, pr)])).toEqual([
      [one.id, false],
      [two.id, true],
    ]);
  });

  it('pops a web tab out into a tab window of its own, which goes once its last tab leaves', async () => {
    const { client, recorder } = await setup();
    const { one } = await twoAgents(client);
    await client.call('shell.setWindowLayout', { owner: one, layout: singlePane([{ kind: 'own' }, web]) });
    const tabs: WindowOwner = { kind: 'tabs', id: 'popped-1' };

    const out = await client.call('shell.moveSurface', { surface: web, from: one, to: { owner: tabs } });
    expect(out.to).toEqual(singlePane([web]));
    expect(await client.call('shell.windowLayout', { owner: tabs })).toEqual(singlePane([web]));

    const back = await client.call('shell.moveSurface', { surface: web, from: tabs, to: { owner: one, placement: { pane: 'main', index: 1 } } });
    expect(back.from).toBeNull();
    expect(back.was).toEqual({ pane: 'main', index: 0 });
    expect(await client.call('shell.windowLayout', { owner: tabs })).toBeNull();
    expect(await client.call('shell.windowLayout', { owner: one })).toEqual(singlePane([{ kind: 'own' }, web]));
    await expect.poll(() => layoutEvents(recorder.events).some((event) => event.owner.kind === 'tabs' && event.layout === null)).toBe(true);
  });

  it('takes a tab out of a window into none, and puts one into a window from none', async () => {
    const { client } = await setup();
    const { one, two } = await twoAgents(client);
    const session: Surface = { kind: 'session', target: { kind: 'agent', id: two.id } };
    await client.call('shell.setWindowLayout', { owner: one, layout: singlePane([{ kind: 'own' }, session]) });

    const out = await client.call('shell.moveSurface', { surface: session, from: one, to: null });
    expect(out.to).toBeNull();
    expect(holds(out.from, session)).toBe(false);

    const back = await client.call('shell.moveSurface', { surface: session, from: null, to: { owner: one, placement: { pane: 'main', index: 1 } } });
    expect(back.was).toBeNull();
    expect(back.to).toEqual(singlePane([{ kind: 'own' }, session]));
  });

  it("lays out a window that never kept a layout from its tabs before a tab joins it", async () => {
    const { client } = await setup();
    const { one, two } = await twoAgents(client);
    const tab = await client.call('shell.createTab', { owner: two });
    await client.call('shell.setWindowLayout', { owner: one, layout: singlePane([{ kind: 'own' }, pr]) });

    const moved = await client.call('shell.moveSurface', { surface: pr, from: one, to: { owner: two } });

    expect(moved.to).toEqual(singlePane([{ kind: 'own' }, { kind: 'shell', shellId: tab.id }, pr]));
  });

  it("refuses an agent's own tab or a shell's, a tab not in the window it is said to leave, one already in the window it would join, a session into its own window, and an owner being deleted", async () => {
    const { client } = await setup();
    const { one, two } = await twoAgents(client);
    const tab = await client.call('shell.createTab', { owner: one });
    await client.call('shell.setWindowLayout', { owner: one, layout: singlePane([{ kind: 'own' }, { kind: 'shell', shellId: tab.id }, pr]) });
    await client.call('shell.setWindowLayout', { owner: two, layout: singlePane([{ kind: 'own' }, pr]) });

    await rejects(client.call('shell.moveSurface', { surface: { kind: 'own' }, from: one, to: { owner: two } }), /only a pull request, a web page, a gate, plans or another session/);
    await rejects(client.call('shell.moveSurface', { surface: { kind: 'shell', shellId: tab.id }, from: one, to: { owner: two } }), /only a pull request/);
    await rejects(client.call('shell.moveSurface', { surface: web, from: one, to: { owner: two } }), /is not in agent/);
    await rejects(client.call('shell.moveSurface', { surface: pr, from: one, to: { owner: two } }), /already shows/);
    await rejects(
      client.call('shell.moveSurface', { surface: { kind: 'session', target: { kind: 'agent', id: two.id } }, from: null, to: { owner: two } }),
      /its own window/,
    );
    await rejects(client.call('shell.moveSurface', { surface: web, from: null, to: { owner: { kind: 'agent', id: 'nope' } } }), /no agent nope/);

    const tile = await client.call('shell.create', { zoneId: null, position: { x: 0, y: 0 } });
    const deleting = client.call('shell.delete', { shellId: tile.id });
    await rejects(client.call('shell.moveSurface', { surface: web, from: null, to: { owner: { kind: 'shell', id: tile.id } } }), /being deleted|no shell/);
    await deleting;
    // Nothing moved by a refusal.
    expect(holds(await client.call('shell.windowLayout', { owner: one }), pr)).toBe(true);
  });

  it("keeps a window's own write only over the layout it was made from: one made before a tab moved out can't put it back", async () => {
    const { client } = await setup();
    const { one, two } = await twoAgents(client);
    const before = singlePane([{ kind: 'own' }, pr]);
    await client.call('shell.setWindowLayout', { owner: one, layout: before, base: null });
    const moved = await client.call('shell.moveSurface', { surface: pr, from: one, to: { owner: two } });

    // Written from the layout before the move, which still shows the tab: the daemon keeps what it has.
    const stale = { ...before, active: 'pr:acme/app#7' };
    expect(await client.call('shell.setWindowLayout', { owner: one, layout: stale, base: before })).toEqual(moved.from);
    expect(await client.call('shell.windowLayout', { owner: one })).toEqual(moved.from);
    // Written from the layout it heard of since, it is kept; and with no base, as ever.
    const next = { ...moved.from!, active: 'own' };
    expect(await client.call('shell.setWindowLayout', { owner: one, layout: next, base: moved.from })).toEqual(next);
    expect(await client.call('shell.setWindowLayout', { owner: one, layout: before })).toEqual(before);
  });

  it("keeps a tab window's layout across a restart, lists it, refuses one holding a session's own or shell tabs, and forgets it as it closes only as it last showed it", async () => {
    const dataDir = tempDataDir();
    const first = await setup(dataDir);
    const tabs: WindowOwner = { kind: 'tabs', id: 'popped-2' };
    await first.client.call('shell.setWindowLayout', { owner: tabs, layout: singlePane([pr, web]) });
    await rejects(first.client.call('shell.setWindowLayout', { owner: tabs, layout: singlePane([{ kind: 'own' }]) }), /a tab window holds only/);
    expect(await first.client.call('shell.unsplitTabs', { owner: tabs })).toEqual({ layout: singlePane([pr, web]), tabs: [] });
    await first.daemon.stop();

    const second = await setup(dataDir);
    expect(await second.client.call('shell.windowLayout', { owner: tabs })).toEqual(singlePane([pr, web]));
    expect(await second.client.call('shell.tabWindows')).toEqual([{ owner: tabs, layout: singlePane([pr, web]) }]);
    // Not as the window last showed it: a tab moved in since keeps it.
    expect(await second.client.call('shell.forgetWindow', { owner: tabs, layout: singlePane([pr]) })).toBe(false);
    expect(await second.client.call('shell.windowLayout', { owner: tabs })).toEqual(singlePane([pr, web]));
    expect(await second.client.call('shell.forgetWindow', { owner: tabs, layout: singlePane([pr, web]) })).toBe(true);
    expect(await second.client.call('shell.windowLayout', { owner: tabs })).toBeNull();
    expect(await second.client.call('shell.tabWindows')).toEqual([]);
    await rejects(second.client.call('shell.forgetWindow', { owner: { kind: 'agent', id: 'x' }, layout: singlePane([pr]) }), /only a tab window/);
  });
});
