import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDaemon } from '../src/client.ts';
import { runAgentBoardCli } from '../src/cli.ts';
import { daemonPaths } from '../src/paths.ts';
import { startTestDaemon, tempDataDir } from './helpers.ts';

describe('agent-board daemon', () => {
  let home: string;
  // The daemon writes the hook shim under ~/.agent-board: never the real one.
  beforeEach(() => {
    home = tempDataDir();
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('runs a daemon on --data-dir until it goes idle, then exits 0', async () => {
    const dataDir = tempDataDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exit = runAgentBoardCli(['daemon', '--data-dir', dataDir, '--idle-timeout-ms', '300']);
    const client = await vi.waitFor(() => connectDaemon(daemonPaths(dataDir).socket));
    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
    client.close();
    // Codex's hooks run this app's CLI through the shim, the way this process was started.
    const shim = readFileSync(join(home, '.agent-board', 'bin', 'agent-board-hook'), 'utf8');
    expect(shim).toContain(`'${process.execPath}' '${process.argv[1]}' hook "$@"`);

    await expect(exit).resolves.toBe(0);
  });

  it('prints the brand banner as it starts, with its build and what it found', async () => {
    const dataDir = tempDataDir();
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exit = runAgentBoardCli(['daemon', '--data-dir', dataDir, '--idle-timeout-ms', '300'], {
      build: { sha: 'abc1234', date: '2026-10-12T10:00:00Z' },
    });
    await expect(exit).resolves.toBe(0);

    const banner = logged.mock.calls.map(([line]) => String(line)).find((line) => line.includes('daemon up'));
    expect(banner).toContain('agent-board abc1234 · 2026-10-12');
    expect(banner).toContain('daemon up · 0 sessions reattached');
    expect(banner).toContain('0 agents need you');
  });

  it('exits 0 at once when another daemon already owns the data dir', async () => {
    const dataDir = tempDataDir();
    await startTestDaemon({ dataDir });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runAgentBoardCli(['daemon', '--data-dir', dataDir])).resolves.toBe(0);
  });

  it('exits 1 with a one-line reason when the daemon cannot start', async () => {
    const dataDir = tempDataDir();
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.exec('PRAGMA user_version = 99');
    db.close();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runAgentBoardCli(['daemon', '--data-dir', dataDir])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not start: .*newer than this daemon knows/));
  });

  it('exits 2 with usage on bad arguments', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runAgentBoardCli([])).resolves.toBe(2);
    await expect(runAgentBoardCli(['serve'])).resolves.toBe(2);
    await expect(runAgentBoardCli(['hook', 'claude'])).resolves.toBe(2);
    await expect(runAgentBoardCli(['hook'])).resolves.toBe(2);
    await expect(runAgentBoardCli(['daemon'])).resolves.toBe(2);
    await expect(runAgentBoardCli(['daemon', '--data-dir', '/tmp/x', '--bogus'])).resolves.toBe(2);
    await expect(runAgentBoardCli(['daemon', '--data-dir', '/tmp/x', '--idle-timeout-ms', 'soon'])).resolves.toBe(2);
    await expect(runAgentBoardCli(['daemon', '--data-dir', '/tmp/x', '--permission-hold-ms', '-1'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('usage: agent-board daemon'));
  });
});
