import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { connectDaemon } from '../src/client.ts';
import { detachedDaemonLaunch, RESTART_FROM_INSIDE, runAgentBoardCli } from '../src/cli.ts';
import type { DaemonOptions } from '../src/daemon.ts';
import { paneIds } from '../src/pane-layout.ts';
import { daemonPaths } from '../src/paths.ts';
import type { AgentUpdatedEvent, BuildInfo, DaemonEvent } from '../src/protocol.ts';
import { restartDaemon } from '../src/restart.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const OLD_BUILD: BuildInfo = { sha: 'aaaaaaa', date: '2026-10-01T12:00:00Z' };
const NEW_BUILD: BuildInfo = { sha: 'bbbbbbb', date: '2026-10-02T12:00:00Z' };
const SIZE = { cols: 100, rows: 30 };

/** A daemon on `dataDir` whose agents run the fake claude's `scenario`, its conversations kept under `home`. */
function daemonOptions(dataDir: string, home: string, scenario: FakeScenario, extra: Partial<DaemonOptions> = {}): Partial<DaemonOptions> {
  return {
    dataDir,
    worktreesDir: home,
    agentEnv: fakeHarnessEnv({ scenario, home, idleNotifyMs: 200, hangTool: scenario === 'output' }),
    ...extra,
  };
}

async function untilState(recorder: ReturnType<typeof recordEvents>, sessionId: string, state: string) {
  await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && e.agent.state === state,
  );
}

describe('restartDaemon', () => {
  it('starts nothing when no daemon is running', async () => {
    const start = vi.fn();

    await expect(restartDaemon(tempDataDir(), { start })).resolves.toEqual({ status: 'not-running' });
    expect(start).not.toHaveBeenCalled();
  });

  it('restarts the daemon as this build and resumes the agents and panes it stopped, but not those an earlier restart stopped', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const first = await startTestDaemon(daemonOptions(dataDir, home, 'waiting', { build: OLD_BUILD }));
    const firstClient = await connectTestClient(first);
    const zone = await firstClient.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const earlier = await firstClient.call('agent.spawn', { zoneId: zone.id, prompt: 'Left stopped', name: 'Left stopped', ...SIZE });
    await untilState(recordEvents(firstClient), earlier.sessionId, 'waiting');
    await first.stop();

    const old = await startTestDaemon(daemonOptions(dataDir, home, 'waiting', { build: OLD_BUILD }));
    const client = await connectTestClient(old);
    const recorder = recordEvents(client);
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', name: 'Pick a database', ...SIZE });
    await untilState(recorder, agent.sessionId, 'waiting');
    const shell = await client.call('shell.create', { zoneId: zone.id });

    const result = await restartDaemon(dataDir, {
      start: () => void startTestDaemon(daemonOptions(dataDir, home, 'waiting', { build: NEW_BUILD })),
    });

    expect(result).toMatchObject({
      status: 'restarted',
      from: { build: OLD_BUILD },
      to: { build: NEW_BUILD },
      agents: ['Pick a database'],
      panes: 1,
      midTurn: [],
      notResumed: [],
    });
    const after = await connectDaemon(daemonPaths(dataDir).socket);
    onTestFinished(() => after.close());
    const states = Object.fromEntries((await after.call('agent.list')).map((a) => [a.name, { state: a.state, ended: a.endedAt !== null }]));
    expect(states).toEqual({ 'Left stopped': { state: 'stopped-by-restart', ended: true }, 'Pick a database': { state: 'idle', ended: false } });
    const [restored] = await after.call('shell.list');
    expect(restored!.stoppedPanes).toEqual([]);
    expect((await after.call('session.list')).map((s) => s.id).sort()).toEqual([agent.sessionId, ...paneIds(shell.layout)].sort());
  });

  it('names the agents it cut off mid-turn, and resumes them too', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const old = await startTestDaemon(daemonOptions(dataDir, home, 'output'));
    const client = await connectTestClient(old);
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Build it', name: 'Build it', ...SIZE });
    await untilState(recorder, agent.sessionId, 'running');

    const result = await restartDaemon(dataDir, { start: () => void startTestDaemon(daemonOptions(dataDir, home, 'waiting')) });

    expect(result).toMatchObject({ status: 'restarted', agents: ['Build it'], midTurn: ['Build it'] });
  });
});

describe('restartDaemon, when something goes wrong', () => {
  it('resumes nothing when another build answers after the stop, as an app still open on it would start', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const client = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'waiting', { build: OLD_BUILD })));
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    await client.call('shell.create', { zoneId: zone.id });

    await expect(
      restartDaemon(dataDir, { build: NEW_BUILD, start: () => void startTestDaemon(daemonOptions(dataDir, home, 'waiting', { build: OLD_BUILD })) }),
    ).rejects.toThrow('stopped the old daemon, but one from build aaaaaaa · 2026-10-01 started in its place, not this build\'s bbbbbbb · 2026-10-02, so nothing was resumed');
    const after = await connectDaemon(daemonPaths(dataDir).socket);
    onTestFinished(() => after.close());
    expect((await after.call('shell.list'))[0]!.stoppedPanes).toHaveLength(1);
  });

  it('says the old daemon was stopped when this build\'s does not start', async () => {
    const dataDir = tempDataDir();
    await startTestDaemon({ dataDir });

    await expect(restartDaemon(dataDir, { start: () => Promise.reject(new Error('daemon exited with code 1')) })).rejects.toThrow(
      /^stopped the old daemon, but this build's did not start: .*daemon exited with code 1/,
    );
  });

  it('carries on past an agent it cannot resume, and names it', async () => {
    const [dataDir, home] = [tempDataDir(), tempDataDir()];
    const client = await connectTestClient(await startTestDaemon(daemonOptions(dataDir, home, 'waiting')));
    const recorder = recordEvents(client);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Lost', name: 'Lost', ...SIZE });
    await untilState(recorder, agent.sessionId, 'waiting');
    await client.call('shell.create', { zoneId: zone.id });
    // Its worktree removed by hand: there is nowhere to resume it.
    rmSync(agent.cwd, { recursive: true, force: true });

    const result = await restartDaemon(dataDir, { start: () => void startTestDaemon(daemonOptions(dataDir, home, 'waiting')) });

    expect(result).toMatchObject({ status: 'restarted', agents: [], panes: 1, notResumed: [{ name: 'Lost', message: expect.any(String) }] });
  });
});

describe('detachedDaemonLaunch', () => {
  it('runs the same executable and script as this command, as the daemon, with the env cleaned', () => {
    expect(detachedDaemonLaunch('/data', '/App/MacOS/agent-board', ['/App/MacOS/agent-board', '/App/out/main/daemon.js', 'restart-daemon'], {
      PATH: '/repo/node_modules/.bin:/usr/bin',
      AGENT_BOARD_SOCKET: '/tmp/board.sock',
    })).toEqual({
      command: '/App/MacOS/agent-board',
      args: ['/App/out/main/daemon.js', 'daemon', '--data-dir', '/data'],
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    });
  });
});

describe('agent-board restart-daemon', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('says what it restarted and resumed, and exits 0', async () => {
    const dataDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ dataDir, build: OLD_BUILD }));
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    await client.call('shell.create', { zoneId: zone.id });

    const code = await runAgentBoardCli(['restart-daemon', '--data-dir', dataDir], {
      startDaemon: () => void startTestDaemon({ dataDir, build: NEW_BUILD }),
    });

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^restarted the daemon: aaaaaaa · 2026-10-01 \(pid \d+\) → bbbbbbb · 2026-10-02 \(pid \d+\)\nresumed 1 shell pane$/),
    );
  });

  it('says there was nothing to restart when no daemon is running', async () => {
    await expect(runAgentBoardCli(['restart-daemon', '--data-dir', tempDataDir()], { startDaemon: () => {} })).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no daemon is running'));
  });

  it('refuses, stopping nothing, inside a session of the daemon it would restart', async () => {
    const dataDir = tempDataDir();
    mkdirSync(dataDir, { recursive: true });
    // As in a board shell: the daemon owning the data dir is an ancestor of this process.
    writeFileSync(daemonPaths(dataDir).lock, String(process.ppid));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const start = vi.fn();

    await expect(runAgentBoardCli(['restart-daemon', '--data-dir', dataDir], { startDaemon: start })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(RESTART_FROM_INSIDE);
    expect(start).not.toHaveBeenCalled();
  });

  it('exits 2 with usage without --data-dir', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runAgentBoardCli(['restart-daemon'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('agent-board restart-daemon --data-dir'));
  });
});
