import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { connectDaemon } from '../src/client.ts';
import { runAgentBoardCli } from '../src/cli.ts';
import { daemonPaths } from '../src/paths.ts';
import { describeBuild, sameBuild } from '../src/protocol.ts';
import { isProcessAlive } from '../src/pid.ts';
import { stopDaemon } from '../src/stop.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

const BUILD = { sha: 'abc1234', date: '2026-10-09T12:00:00Z' };

describe('build identity', () => {
  it('is reported by daemon.health, and is null for a daemon started without one', async () => {
    const built = await connectTestClient(await startTestDaemon({ build: BUILD }));
    const unbuilt = await connectTestClient(await startTestDaemon());

    await expect(built.call('daemon.health')).resolves.toMatchObject({ build: BUILD });
    await expect(unbuilt.call('daemon.health')).resolves.toMatchObject({ build: null });
  });

  it('matches only the same commit: an unknown daemon build never matches', () => {
    expect(sameBuild(BUILD, { ...BUILD })).toBe(true);
    expect(sameBuild(BUILD, { sha: 'def5678', date: BUILD.date })).toBe(false);
    expect(sameBuild(BUILD, null)).toBe(false);
  });

  it('is quoted as the short SHA and the commit day', () => {
    expect(describeBuild(BUILD)).toBe('abc1234 · 2026-10-09');
    expect(describeBuild(null)).toBe('unknown build');
  });
});

describe('daemon.stop', () => {
  it('shuts the daemon down when no session is live', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);

    await expect(client.call('daemon.stop', { force: false })).resolves.toEqual({ stopped: true, liveSessions: 0 });
    await expect(daemon.closed).resolves.toEqual({ reason: 'stopped' });
  });

  it('refuses while sessions are live unless forced, then ends them', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);
    await client.call('session.createShell', { cols: 80, rows: 24 });

    await expect(client.call('daemon.stop', { force: false })).resolves.toEqual({ stopped: false, liveSessions: 1 });
    await expect(client.call('daemon.health')).resolves.toMatchObject({ liveSessions: 1 });

    await expect(client.call('daemon.stop', { force: true })).resolves.toEqual({ stopped: true, liveSessions: 1 });
    await expect(daemon.closed).resolves.toEqual({ reason: 'stopped' });
  });
});

describe('stopDaemon', () => {
  it('reports a data dir with no daemon as not running', async () => {
    await expect(stopDaemon(tempDataDir())).resolves.toEqual({ status: 'not-running' });
  });

  it('stops the daemon and resolves once it has let go of the data dir', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir });
    let closed = false;
    void daemon.closed.then(() => (closed = true));

    await expect(stopDaemon(dataDir)).resolves.toEqual({ status: 'stopped', pid: process.pid });
    expect(closed).toBe(true);
    await expect(connectDaemon(daemonPaths(dataDir).socket)).rejects.toThrow();
  });

  it('leaves a daemon with live sessions running unless forced', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir });
    const client = await connectTestClient(daemon);
    await client.call('session.createShell', { cols: 80, rows: 24 });

    await expect(stopDaemon(dataDir)).resolves.toEqual({ status: 'sessions-live', liveSessions: 1 });
    await expect(stopDaemon(dataDir, { force: true })).resolves.toMatchObject({ status: 'stopped' });
  });
});

/** Starts test/fixtures/old-daemon.ts on `dataDir` as a child process, and returns its pid once it listens. */
async function startOldDaemon(dataDir: string, liveSessions: number, mode?: 'leave-lock'): Promise<number> {
  const paths = daemonPaths(dataDir);
  const fixture = fileURLToPath(new URL('./fixtures/old-daemon.ts', import.meta.url));
  const child = spawn(process.execPath, [fixture, paths.socket, paths.lock, String(liveSessions), ...(mode ? [mode] : [])], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  onTestFinished(() => {
    child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  return child.pid!;
}

describe('stopDaemon with a daemon from before daemon.stop', () => {
  it('stops it with SIGTERM', async () => {
    const dataDir = tempDataDir();
    const pid = await startOldDaemon(dataDir, 0);

    await expect(stopDaemon(dataDir)).resolves.toEqual({ status: 'stopped', pid });
    await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false));
  });

  it('leaves it running while it reports live sessions, unless forced', async () => {
    const dataDir = tempDataDir();
    const pid = await startOldDaemon(dataDir, 2);

    await expect(stopDaemon(dataDir)).resolves.toEqual({ status: 'sessions-live', liveSessions: 2 });
    expect(isProcessAlive(pid)).toBe(true);

    await expect(stopDaemon(dataDir, { force: true })).resolves.toEqual({ status: 'stopped', pid });
  });

  it('stops waiting once the daemon has died, even if it left its lock behind', async () => {
    const dataDir = tempDataDir();
    const pid = await startOldDaemon(dataDir, 0, 'leave-lock');

    await expect(stopDaemon(dataDir, { timeoutMs: 60_000 })).resolves.toEqual({ status: 'stopped', pid });
  }, 5_000);
});

describe('agent-board stop', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('exits 0 when it stopped the daemon or none was running', async () => {
    const dataDir = tempDataDir();
    await startTestDaemon({ dataDir });

    await expect(runAgentBoardCli(['stop', '--data-dir', dataDir])).resolves.toBe(0);
    await expect(runAgentBoardCli(['stop', '--data-dir', dataDir])).resolves.toBe(0);
  });

  it('exits 3 with a warning while sessions are live, and stops them with --force', async () => {
    const dataDir = tempDataDir();
    const client = await connectTestClient(await startTestDaemon({ dataDir }));
    await client.call('session.createShell', { cols: 80, rows: 24 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runAgentBoardCli(['stop', '--data-dir', dataDir])).resolves.toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^The daemon has 1 running session, which stopping it would end\.\nRe-run with --force/));

    await expect(runAgentBoardCli(['stop', '--data-dir', dataDir, '--force'])).resolves.toBe(0);
  });

  it('exits 2 with usage without --data-dir', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runAgentBoardCli(['stop'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('agent-board stop --data-dir'));
  });
});
