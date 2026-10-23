import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { connectDaemon, createDaemonLink, ensureDaemon } from '../src/client.ts';
import { startDaemon, type Daemon } from '../src/daemon.ts';
import { daemonPaths } from '../src/paths.ts';
import { daemonStdio, inheritableDescriptors, spawnDetachedDaemon } from '../src/spawn.ts';
import { insertFakeSession, startTestDaemon, tempDataDir } from './helpers.ts';

const IDLE = { idleTimeoutMs: 150, idleCheckIntervalMs: 20 };

/** Whether the daemon is still up after `ms`. */
async function stillRunningAfter(daemon: Daemon, ms: number): Promise<boolean> {
  const exited = await Promise.race([daemon.closed.then(() => true), sleep(ms).then(() => false)]);
  return !exited;
}

describe('daemon lifetime', () => {
  it('exits when it has had no clients and no live sessions for the idle timeout', async () => {
    const daemon = await startTestDaemon(IDLE);
    await expect(daemon.closed).resolves.toEqual({ reason: 'idle' });
  });

  it('stays up while a client is connected, and exits after the last one leaves', async () => {
    const daemon = await startTestDaemon(IDLE);
    const client = await connectDaemon(daemon.socketPath);

    expect(await stillRunningAfter(daemon, 600)).toBe(true);

    client.close();
    await expect(daemon.closed).resolves.toEqual({ reason: 'idle' });
  });

  it('stays up while a session is live, and exits once it has ended', async () => {
    const daemon = await startTestDaemon(IDLE);
    const client = await connectDaemon(daemon.socketPath);
    const session = await client.call('session.createShell', { cols: 80, rows: 24 });
    client.close();

    expect(await stillRunningAfter(daemon, 600)).toBe(true);

    process.kill(session.pid, 'SIGKILL');
    await expect(daemon.closed).resolves.toEqual({ reason: 'idle' });
  });

  it('marks sessions a crashed daemon left live as ended, so they do not keep it up', async () => {
    const dataDir = tempDataDir();
    insertFakeSession(dataDir, { id: 'left-by-a-crash', hookToken: 'token' });

    const daemon = await startTestDaemon({ dataDir, ...IDLE });

    await expect(daemon.closed).resolves.toEqual({ reason: 'idle' });
  });

  it('stays up when a session goes live during the idle countdown', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, ...IDLE });
    await sleep(IDLE.idleTimeoutMs / 2);

    insertFakeSession(dataDir, { id: 'session-1', hookToken: 'token' });

    expect(await stillRunningAfter(daemon, 600)).toBe(true);
  });

  it('stays up while a clock is set to message an agent, though its session has ended', async () => {
    const dataDir = tempDataDir();
    insertFakeSession(dataDir, { id: 'scheduled', hookToken: 'token' }).end();
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.prepare("INSERT INTO zones (id, repo_root, name, color, x, y, width, height) VALUES ('z', '/repo', 'repo', '#fff', 0, 0, 1, 1)").run();
    db.prepare(
      "INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, name, description, branch, worktree, state) VALUES ('scheduled', 'z', '/r', 1, 'a', '', 'b', '/w', 'done')",
    ).run();
    const data = {
      cron: '@daily',
      enabled: true,
      does: 'message',
      agent: 'scheduled',
      prompt: 'Sweep',
      fresh: { harness: 'claude', model: null, role: null, closeWhenDone: true },
      result: 'history',
      handoffTo: null,
      folded: false,
    };
    db.prepare("INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, data) VALUES ('c', 'clock', 'z', 0, 0, 256, 76, 1, ?)").run(JSON.stringify(data));
    db.close();

    const daemon = await startTestDaemon({ dataDir, ...IDLE });
    expect(await stillRunningAfter(daemon, 600)).toBe(true);

    const client = await connectDaemon(daemon.socketPath);
    await client.call('agent.setSchedule', { sessionId: 'scheduled', schedule: { cron: '@daily', prompt: 'Sweep', enabled: false } });
    client.close();
    await expect(daemon.closed).resolves.toEqual({ reason: 'idle' });
  });

  it('exits when its data dir is removed, though a client is connected and a session is live', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, ...IDLE, dataDirGraceMs: 100 });
    const client = await connectDaemon(daemon.socketPath);
    await client.call('session.createShell', { cols: 80, rows: 24 });

    rmSync(dataDir, { recursive: true, force: true });

    await expect(daemon.closed).resolves.toEqual({ reason: 'data-dir-removed' });
  });

  it('stays up when its data dir is missing only for less than the grace period', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, ...IDLE, dataDirGraceMs: 400 });
    const client = await connectDaemon(daemon.socketPath);
    const moved = `${dataDir}-moved`;
    renameSync(dataDir, moved);
    await sleep(100);
    renameSync(moved, dataDir);

    expect(await stillRunningAfter(daemon, 700)).toBe(true);
    client.close();
  });

  it('stays up when its data dir cannot be statted for a reason other than ENOENT', async () => {
    // A parent that cannot be searched makes the stat fail with EACCES, as an unreachable volume would.
    const parent = join(tempDataDir(), 'parent');
    mkdirSync(parent);
    const daemon = await startTestDaemon({ dataDir: join(parent, 'data'), ...IDLE, dataDirGraceMs: 100 });
    const client = await connectDaemon(daemon.socketPath);
    chmodSync(parent, 0o000);
    try {
      expect(await stillRunningAfter(daemon, 600)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
      client.close();
    }
  });

  it('closes client connections when it shuts down', async () => {
    const daemon = await startTestDaemon();
    const client = await connectDaemon(daemon.socketPath);

    await daemon.stop();

    await expect(client.closed).resolves.toBeUndefined();
    await expect(client.call('daemon.health')).rejects.toThrow(/closed/);
  });
});

describe('ensureDaemon', () => {
  it('connects to a running daemon without starting another', async () => {
    const daemon = await startTestDaemon();
    let starts = 0;

    const client = await ensureDaemon({ socketPath: daemon.socketPath, start: () => void starts++ });

    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
    expect(starts).toBe(0);
    client.close();
  });

  it('starts the daemon when none is listening, then connects', async () => {
    const dataDir = tempDataDir();
    let daemon: Daemon | undefined;

    const client = await ensureDaemon({
      socketPath: daemonPaths(dataDir).socket,
      start: () => {
        void startDaemon({ dataDir, log: () => {} }).then((started) => (daemon = started));
      },
    });

    await expect(client.call('daemon.health')).resolves.toMatchObject({ clients: 1 });
    client.close();
    await daemon?.stop();
  });

  it('gives up if the daemon never starts listening', async () => {
    const dataDir = tempDataDir();
    await expect(
      ensureDaemon({ socketPath: daemonPaths(dataDir).socket, start: () => {}, timeoutMs: 100 }),
    ).rejects.toThrow(/did not start/);
  });

  it('lets racing callers share one daemon', async () => {
    const dataDir = tempDataDir();
    const daemons: Daemon[] = [];
    const start = () => {
      startDaemon({ dataDir, log: () => {} }).then(
        (daemon) => daemons.push(daemon),
        () => {}, // lost the race for the lock
      );
    };

    const clients = await Promise.all(
      [1, 2, 3].map(() => ensureDaemon({ socketPath: daemonPaths(dataDir).socket, start })),
    );
    const healths = await Promise.all(clients.map((client) => client.call('daemon.health')));

    expect(daemons).toHaveLength(1);
    expect(new Set(healths.map((health) => health.startedAt)).size).toBe(1);
    for (const client of clients) client.close();
    await daemons[0]?.stop();
  });
});

describe('ensureDaemon when the daemon fails to start', () => {
  it('fails straight away with the reason the start reports, instead of waiting out the timeout', async () => {
    const dataDir = tempDataDir();
    const startedAt = Date.now();

    const result = ensureDaemon({
      socketPath: daemonPaths(dataDir).socket,
      start: () => Promise.reject(new Error('daemon exited with code 1: file is not a database')),
      timeoutMs: 10_000,
    });

    await expect(result).rejects.toThrow(/failed to start: daemon exited with code 1: file is not a database/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('keeps waiting when the started process exits cleanly (it lost the start race)', async () => {
    const dataDir = tempDataDir();
    let daemon: Daemon | undefined;

    const client = await ensureDaemon({
      socketPath: daemonPaths(dataDir).socket,
      start: async () => {
        setTimeout(() => void startDaemon({ dataDir, log: () => {} }).then((started) => (daemon = started)), 50);
      },
    });

    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
    client.close();
    await daemon?.stop();
  });
});

describe('spawnDetachedDaemon', () => {
  it('rejects with the exit code and the end of the log when the process dies at startup', async () => {
    const dataDir = tempDataDir();
    const script = join(dataDir, 'dies.mjs');
    writeFileSync(script, "console.error('[agent-board daemon] could not start: file is not a database'); process.exit(1);");
    const logPath = daemonPaths(dataDir).log;
    writeFileSync(logPath, 'an older run\n');

    const started = spawnDetachedDaemon({ command: process.execPath, args: [script], logPath });

    await expect(started).rejects.toThrow('daemon exited with code 1: [agent-board daemon] could not start: file is not a database');
    await expect(started).rejects.not.toThrow(/older run/);
  });

  it('lists the descriptors a child would inherit: open ones past stdio without close-on-exec', () => {
    const fdinfo = tempDataDir();
    const write = (fd: number, flags: string) => writeFileSync(join(fdinfo, String(fd)), `pos:\t0\nflags:\t${flags}\nmnt_id:\t15\n`);
    write(0, '0100002');
    write(2, '0100001');
    write(5, '02000002');
    write(7, '0100002');
    write(12, '04');
    write(13, '02004002');

    expect(inheritableDescriptors(fdinfo)).toEqual([7, 12]);
    expect(inheritableDescriptors(join(fdinfo, 'missing'))).toEqual([]);
  });

  it('points each descriptor the daemon would inherit at /dev/null, so it holds none of its caller’s', () => {
    expect(daemonStdio(20, [], 21)).toEqual(['ignore', 20, 20]);
    expect(daemonStdio(20, [4, 6], 21)).toEqual(['ignore', 20, 20, 'ignore', 21, 'ignore', 21]);
  });

  it('rejects when the command cannot be run', async () => {
    const dataDir = tempDataDir();
    await expect(
      spawnDetachedDaemon({ command: join(dataDir, 'missing'), args: [], logPath: daemonPaths(dataDir).log }),
    ).rejects.toThrow(/could not run/);
  });
});

describe('createDaemonLink', () => {
  it('connects on first call and, after the daemon goes away, restarts it on the next call', async () => {
    const dataDir = tempDataDir();
    const daemons: Daemon[] = [];
    const link = createDaemonLink({
      socketPath: daemonPaths(dataDir).socket,
      start: async () => {
        daemons.push(await startDaemon({ dataDir, log: () => {} }));
      },
    });

    const first = await link.call('daemon.health');
    await daemons[0]!.stop();
    await sleep(20); // let the link see the drop
    const second = await link.call('daemon.health');

    expect(daemons).toHaveLength(2);
    expect(second.startedAt).not.toBe(first.startedAt);
    link.close();
    await expect(link.call('daemon.health')).rejects.toThrow(/closed/);
    await daemons[1]!.stop();
  });

  it('tells its listeners each time it connects and each time a connection drops, but not when closed', async () => {
    const dataDir = tempDataDir();
    const daemons: Daemon[] = [];
    const link = createDaemonLink({
      socketPath: daemonPaths(dataDir).socket,
      start: async () => {
        daemons.push(await startDaemon({ dataDir, log: () => {} }));
      },
    });
    const heard: string[] = [];
    link.onConnected(() => heard.push('connected'));
    link.onDisconnected(() => heard.push('disconnected'));

    await link.call('daemon.health');
    await link.call('daemon.health');
    await daemons[0]!.stop();
    await sleep(20); // let the link see the drop
    await link.call('daemon.health');
    link.close();
    await sleep(20);

    expect(heard).toEqual(['connected', 'disconnected', 'connected']);
    await daemons[1]!.stop();
  });

  it('delivers events to its listeners across a reconnect', async () => {
    const dataDir = tempDataDir();
    // Never the real home: the shell below starts there.
    const homeDir = tempDataDir();
    const daemons: Daemon[] = [];
    const start = async () => {
      daemons.push(await startDaemon({ dataDir, log: () => {}, shell: '/bin/sh', shellArgs: [], homeDir }));
    };
    const link = createDaemonLink({ socketPath: daemonPaths(dataDir).socket, start });
    const exited: string[] = [];
    link.onEvent((event) => {
      if (event.type === 'session.exited') exited.push(event.sessionId);
    });

    await link.call('daemon.health');
    await daemons[0]!.stop();
    await sleep(20); // let the link see the drop
    const session = await link.call('session.createShell', { cols: 80, rows: 24 });
    expect(session.cwd).toBe(homeDir);
    await link.call('session.kill', { sessionId: session.id });

    expect(exited).toEqual([session.id]);
    link.close();
    await daemons[1]!.stop();
  });
});
