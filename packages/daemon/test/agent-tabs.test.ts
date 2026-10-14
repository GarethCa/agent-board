import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { DaemonRpcError, type DaemonClient } from '../src/client.ts';
import { readBoard } from '../src/board-ops.ts';
import { paneIds } from '../src/pane-layout.ts';
import type { AgentUpdatedEvent, DaemonEvent, Shell, ShellUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/** A daemon whose agents run the fake claude, waiting for an answer so they stay running. */
async function setup(options: { dataDir?: string; worktreesDir?: string; home?: string } = {}) {
  const dataDir = options.dataDir ?? tempDataDir();
  const worktreesDir = options.worktreesDir ?? tempDataDir();
  const home = options.home ?? tempDataDir();
  const daemon = await startTestDaemon({ dataDir, worktreesDir, agentEnv: fakeHarnessEnv({ scenario: 'waiting', home, idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client), dataDir, worktreesDir, home };
}

async function spawnAgent(client: DaemonClient) {
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Wire the fallback', harness: 'claude', cols: 100, rows: 30 });
  return { zone, agent };
}

const tabsOf = (shells: Shell[], agentId: string) => shells.filter((shell) => shell.owner?.id === agentId);

const rejects = async (call: Promise<unknown>, message: RegExp) => {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DaemonRpcError);
  expect((error as Error).message).toMatch(message);
};

describe("an agent's tabs", () => {
  it("opens a shell tab in the agent's worktree, owned by the agent and no tile on the board", async () => {
    const { client } = await setup();
    const { agent } = await spawnAgent(client);

    const tab = await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });

    expect(tab).toMatchObject({ owner: { kind: 'agent', id: agent.sessionId }, zoneId: null, position: null, cwd: agent.worktree, name: 'sh' });
    const [pane] = paneIds(tab.layout);
    const session = (await client.call('session.list')).find((listed) => listed.id === pane);
    expect(session).toMatchObject({ harness: null, cwd: agent.worktree });
    expect((await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } })).name).toBe('sh 2');
    expect(tabsOf(await client.call('shell.list'), agent.sessionId)).toHaveLength(2);
  });

  it('opens a tab at a folder the user picks, and refuses one that is not a folder', async () => {
    const { client } = await setup();
    const { agent } = await spawnAgent(client);
    const folder = tempDataDir();

    expect((await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId }, cwd: folder })).cwd).toBe(folder);
    await rejects(client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId }, cwd: join(folder, 'nope') }), /not a folder/);
    await rejects(client.call('shell.createTab', { owner: { kind: 'agent', id: 'no-such-agent' } }), /no agent/);
  });

  it("lists the worktree's package scripts, and runs one in a new tab named after it", async () => {
    const { client, recorder } = await setup();
    const { agent } = await spawnAgent(client);
    writeFileSync(join(agent.worktree, 'package.json'), JSON.stringify({ scripts: { dev: 'echo dev-server-up', test: 'vitest' } }));
    writeFileSync(join(agent.worktree, 'pnpm-lock.yaml'), '');

    expect(await client.call('shell.scripts', { owner: { kind: 'agent', id: agent.sessionId } })).toEqual({ runner: 'pnpm', scripts: ['dev', 'test'] });

    const tab = await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId }, script: 'dev' });
    expect(tab.name).toBe('pnpm dev');
    const pane = paneIds(tab.layout)[0]!;
    await client.call('session.attach', { sessionId: pane });
    await recorder.waitForText(pane, 'pnpm run dev');
    await rejects(client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId }, script: 'nope' }), /no script nope/);
  });

  it('says a folder with no package.json has no scripts, and picks npm without a lockfile', async () => {
    const { client } = await setup();
    const { agent } = await spawnAgent(client);
    expect(await client.call('shell.scripts', { owner: { kind: 'agent', id: agent.sessionId } })).toEqual({ runner: 'npm', scripts: [] });
    mkdirSync(join(agent.worktree, 'sub'));
    writeFileSync(join(agent.worktree, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    expect(await client.call('shell.scripts', { owner: { kind: 'agent', id: agent.sessionId } })).toEqual({ runner: 'npm', scripts: ['build'] });
  });

  it("splits the agent's own tab: its pane stays first, a shell beside it, and neither can be closed through the other", async () => {
    const { client } = await setup();
    const { agent } = await spawnAgent(client);

    const own = await client.call('shell.ownTab', { agentId: agent.sessionId });
    expect(own).toMatchObject({ owner: { kind: 'agent', id: agent.sessionId }, layout: { type: 'pane', sessionId: agent.sessionId } });
    expect((await client.call('shell.ownTab', { agentId: agent.sessionId })).id).toBe(own.id);
    // Its shell panes go by the shell's name, which a shell tab still gets first.
    expect(own.name).toBe('sh');
    expect((await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } })).name).toBe('sh');

    const split = await client.call('shell.split', { shellId: own.id, sessionId: agent.sessionId, direction: 'horizontal' });
    const [first, second] = paneIds(split.layout);
    expect(first).toBe(agent.sessionId);
    expect((await client.call('session.list')).find((session) => session.id === second)).toMatchObject({ harness: null, cwd: agent.worktree });

    await rejects(client.call('shell.closePane', { shellId: own.id, sessionId: agent.sessionId }), /agent's own pane/);
    await rejects(client.call('shell.delete', { shellId: own.id }), /agent's own tab/);
    await rejects(client.call('shell.move', { shellId: own.id, zoneId: null, x: 0, y: 0 }), /a tab has no tile/);

    const closed = await client.call('shell.closePane', { shellId: own.id, sessionId: second! });
    expect(closed?.layout).toEqual({ type: 'pane', sessionId: agent.sessionId });
    expect((await client.call('agent.list')).find((listed) => listed.sessionId === agent.sessionId)?.endedAt).toBeNull();
  });

  it("never counts the agent's own pane as an ended or stopped shell", async () => {
    const { client } = await setup();
    const { agent } = await spawnAgent(client);
    await client.call('shell.ownTab', { agentId: agent.sessionId });
    await client.call('agent.stop', { sessionId: agent.sessionId });

    const own = (await client.call('shell.list')).find((shell) => shell.owner?.id === agent.sessionId)!;
    expect(own.endedPanes).toEqual([]);
    expect(own.stoppedPanes).toEqual([]);
  });

  it('ends its shell tabs with the agent when the agent is deleted', async () => {
    const { client, recorder } = await setup();
    const { agent } = await spawnAgent(client);
    const tab = await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    const own = await client.call('shell.split', {
      shellId: (await client.call('shell.ownTab', { agentId: agent.sessionId })).id,
      sessionId: agent.sessionId,
      direction: 'vertical',
    });

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });

    expect(tabsOf(await client.call('shell.list'), agent.sessionId)).toEqual([]);
    const live = (await client.call('session.list')).map((session) => session.id);
    for (const pane of [...paneIds(tab.layout), ...paneIds(own.layout)]) expect(live).not.toContain(pane);
    const removed = recorder.events.filter((event) => event.type === 'shell.removed').map((event) => (event as { shellId: string }).shellId);
    expect(removed.sort()).toEqual([tab.id, own.id].sort());
  });

  it('keeps its tabs across a daemon restart, their shells stopped by it and resumable', async () => {
    const dataDir = tempDataDir();
    const worktreesDir = tempDataDir();
    const home = tempDataDir();
    const first = await setup({ dataDir, worktreesDir, home });
    const { agent } = await spawnAgent(first.client);
    const tab = await first.client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    await first.daemon.stop();

    const second = await setup({ dataDir, worktreesDir, home });
    const [after] = tabsOf(await second.client.call('shell.list'), agent.sessionId);
    const pane = paneIds(tab.layout)[0]!;
    expect(after).toMatchObject({ id: tab.id, name: tab.name, stoppedPanes: [pane] });
    const resumed = await second.client.call('shell.resumePane', { shellId: tab.id, sessionId: pane });
    expect(resumed.endedPanes).toEqual([]);
  });

  it("tells a pane that exited non-zero by its exit code, one running a command as busy with the ports it listens on, and one whose last command failed, none of it the agent's", async () => {
    const { client, recorder } = await setup();
    const { agent } = await spawnAgent(client);
    await recorder.waitFor((event): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === agent.sessionId && event.agent.state === 'waiting');
    const seen = recorder.events.length;
    const [busy, failing, failed] = [
      await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } }),
      await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } }),
      await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } }),
    ];
    const pane = (shell: Shell) => paneIds(shell.layout)[0]!;
    const isTab = (id: string, check: (shell: Shell) => boolean) => (event: DaemonEvent): event is ShellUpdatedEvent =>
      event.type === 'shell.updated' && event.shell.id === id && check(event.shell);

    const server = "require('http').createServer().listen(0, '127.0.0.1', () => console.log('listening'))";
    await client.call('session.write', { sessionId: pane(busy), data: `'${process.execPath}' -e "${server}"\r` });
    await client.call('session.write', { sessionId: pane(failing), data: 'exit 3\r' });
    await client.call('session.write', { sessionId: pane(failed), data: 'false\r' });

    const ran = await recorder.waitFor(isTab(busy.id, (shell) => (shell.panePorts[pane(busy)]?.length ?? 0) > 0));
    expect(ran.shell.busyPanes).toEqual([pane(busy)]);
    expect(ran.shell.panePorts[pane(busy)]![0]).toBeGreaterThan(0);
    const exited = await recorder.waitFor(isTab(failing.id, (shell) => shell.endedPanes.includes(pane(failing))));
    expect(exited.shell.exitCodes).toEqual({ [pane(failing)]: 3 });
    const lastFailed = await recorder.waitFor(isTab(failed.id, (shell) => pane(failed) in shell.failedCommands));
    expect(lastFailed.shell.failedCommands).toEqual({ [pane(failed)]: 1 });

    // The next command that succeeds clears it.
    await client.call('session.write', { sessionId: pane(failed), data: 'true\r' });
    await recorder.waitFor(isTab(failed.id, (shell) => !(pane(failed) in shell.failedCommands)));

    // None of it touched the agent: still waiting, and never told of in another state meanwhile.
    expect((await client.call('agent.list')).find((listed) => listed.sessionId === agent.sessionId)?.state).toBe('waiting');
    const states = recorder.events.slice(seen).flatMap((event) => (event.type === 'agent.updated' && event.agent.sessionId === agent.sessionId ? [event.agent.state] : []));
    expect(states.every((state) => state === 'waiting')).toBe(true);
  });
});

describe('the board', () => {
  it("identifies a shell in one of an agent's tabs as the agent's tile, never orchestrating", async () => {
    const { client, recorder } = await setup();
    const { agent } = await spawnAgent(client);
    const tab = await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    const pane = paneIds(tab.layout)[0]!;
    await client.call('session.attach', { sessionId: pane });
    await client.call('session.write', { sessionId: pane, data: 'echo "token:$AGENT_BOARD_IDENTITY:end"\r' });
    await recorder.waitForText(pane, ':end\r\n');
    const token = /token:(.*):end\r\n/.exec(recorder.screenText(pane))![1]!;

    expect(await client.call('board.identify', { token })).toEqual({
      sessionId: pane,
      kind: 'agent',
      tileId: agent.sessionId,
      name: agent.name,
      zoneId: agent.zoneId,
      orchestrate: null,
    });
  });

  it("reads an agent's tabs as the agent's, not as shell tiles", async () => {
    const { client } = await setup();
    const { agent } = await spawnAgent(client);
    await client.call('shell.createTab', { owner: { kind: 'agent', id: agent.sessionId } });
    const zone = await client.call('zone.add', { path: tempRepo(), x: 900, y: 0 });
    const tile = await client.call('shell.create', { zoneId: zone.id });

    expect((await readBoard(client)).shells.map((shell) => shell.id)).toEqual([tile.id]);
  });
});
