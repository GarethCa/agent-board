import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { isProcessAlive } from '../src/pid.ts';
import { daemonPaths } from '../src/paths.ts';
import { RPC_ERROR, type DaemonEvent, type SessionExitedEvent, type SessionSnapshotEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir } from './helpers.ts';

const SIZE = { cols: 80, rows: 24 };

const isSnapshot = (event: DaemonEvent): event is SessionSnapshotEvent => event.type === 'session.snapshot';
const isExited = (event: DaemonEvent): event is SessionExitedEvent => event.type === 'session.exited';

async function daemonWithClient(options: Parameters<typeof startTestDaemon>[0] = {}) {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({ dataDir, ...options });
  const client = await connectTestClient(daemon);
  return { dataDir, daemon, client, recorder: recordEvents(client) };
}

function sessionRow(dataDir: string, id: string) {
  const db = new DatabaseSync(daemonPaths(dataDir).database);
  try {
    return db.prepare('SELECT harness, cwd, ended_at, exit_code FROM sessions WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

describe('shell sessions', () => {
  it('starts a shell session, recorded as a session with no harness', async () => {
    const { dataDir, client } = await daemonWithClient();

    const session = await client.call('session.createShell', SIZE);

    expect(session).toMatchObject({ harness: null, endedAt: null, exitCode: null, ...SIZE });
    expect(isProcessAlive(session.pid)).toBe(true);
    expect(await client.call('session.list')).toEqual([session]);
    expect(await client.call('daemon.health')).toMatchObject({ liveSessions: 1 });
    expect(sessionRow(dataDir, session.id)).toMatchObject({ harness: null, ended_at: null });
  });

  it('starts in the given directory', async () => {
    const { client, recorder } = await daemonWithClient();
    const cwd = tempDataDir();

    const session = await client.call('session.createShell', { ...SIZE, cwd });
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', { sessionId: session.id, data: 'pwd -P\r' });

    expect(session.cwd).toBe(cwd);
    await recorder.waitForText(session.id, `\n${realpathSync(cwd)}`);
  });

  it('refuses a working directory that does not exist', async () => {
    const { client } = await daemonWithClient();
    await expect(client.call('session.createShell', { ...SIZE, cwd: '/no/such/dir' })).rejects.toThrow(/directory/);
  });

  it('refuses a relative working directory', async () => {
    const { client } = await daemonWithClient();
    await expect(client.call('session.createShell', { ...SIZE, cwd: '.' })).rejects.toThrow(/absolute/);
  });

  it('refuses bad params', async () => {
    const { client } = await daemonWithClient();
    await expect(client.call('session.createShell', { cols: -1, rows: 24 })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/cols/),
    });
    await expect(client.call('session.write', { sessionId: 'nope', data: 'x' })).rejects.toThrow(/no live session/);
    await expect(client.call('session.write', { sessionId: 'nope' } as never)).rejects.toThrow(/data/);
  });

  it('does not leak the daemon-as-Node switch into the shell', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    const { client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    await client.call('session.attach', { sessionId: session.id });

    await client.call('session.write', { sessionId: session.id, data: 'echo "[${ELECTRON_RUN_AS_NODE-un}${ELECTRON_RUN_AS_NODE-set}]"\r' });

    await recorder.waitForText(session.id, '[unset]');
  });

  it('streams output to an attached client and takes its input', async () => {
    const { client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);

    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', { sessionId: session.id, data: 'echo $((40 + 2))\r' });

    await recorder.waitForText(session.id, '42');
    expect(recorder.events.find((event) => event.type === 'session.output' || isSnapshot(event))?.type).toBe('session.snapshot');
  });

  it('sends no output to a client that has not attached, or has detached', async () => {
    const { daemon, client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    const other = await connectTestClient(daemon);
    const otherRecorder = recordEvents(other);
    await other.call('session.attach', { sessionId: session.id });

    await other.call('session.write', { sessionId: session.id, data: 'echo $((1 + 1))one\r' });
    await otherRecorder.waitForText(session.id, '2one');
    await other.call('session.detach', { sessionId: session.id });
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', { sessionId: session.id, data: 'echo $((1 + 2))two\r' });
    await recorder.waitForText(session.id, '3two');

    expect(otherRecorder.screenText(session.id)).not.toContain('3two');
    expect(recorder.events.filter((event) => event.type === 'session.output' && event.data.includes('2one'))).toEqual([]);
  });

  it('resizes the session', async () => {
    const { client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    await client.call('session.attach', { sessionId: session.id });

    await client.call('session.resize', { sessionId: session.id, cols: 101, rows: 33 });
    await client.call('session.write', { sessionId: session.id, data: 'stty size\r' });

    await recorder.waitForText(session.id, '33 101');
    expect(await client.call('session.list')).toMatchObject([{ cols: 101, rows: 33 }]);
  });

  it('keeps running when its client goes away, and a new client attaching sees what it printed', async () => {
    const { daemon, client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', { sessionId: session.id, data: 'echo before-$((6 * 7))\r' });
    await recorder.waitForText(session.id, 'before-42');

    client.close();
    await client.closed;
    const later = await connectTestClient(daemon);
    const laterRecorder = recordEvents(later);
    await later.call('session.attach', { sessionId: session.id });

    const snapshot = await laterRecorder.waitFor(isSnapshot);
    expect(snapshot).toMatchObject({ sessionId: session.id, ...SIZE });
    expect(snapshot.data).toContain('before-42');
    expect(isProcessAlive(session.pid)).toBe(true);
    await later.call('session.write', { sessionId: session.id, data: 'echo after-$((6 * 8))\r' });
    await laterRecorder.waitForText(session.id, 'after-48');
  });

  it('gives a reattaching client the scrollback, not just the visible screen', async () => {
    const { daemon, client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', { cols: 80, rows: 5 });
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', { sessionId: session.id, data: 'for i in 1 2 3 4 5 6 7 8 9; do echo line-$i; done; echo $((5 * 5))done\r' });
    await recorder.waitForText(session.id, '25done');

    const later = await connectTestClient(daemon);
    const laterRecorder = recordEvents(later);
    await later.call('session.attach', { sessionId: session.id });

    expect((await laterRecorder.waitFor(isSnapshot)).data).toMatch(/line-1\b[\s\S]*line-9[\s\S]*25done/);
  });

  it('kills a session: the process ends, every client hears, and it leaves the list', async () => {
    const { dataDir, daemon, client } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    const bystander = recordEvents(await connectTestClient(daemon));

    const ended = await client.call('session.kill', { sessionId: session.id });

    expect(ended).toMatchObject({ id: session.id, endedAt: expect.any(String) });
    expect(isProcessAlive(session.pid)).toBe(false);
    expect((await bystander.waitFor(isExited)).session).toEqual(ended);
    expect(await client.call('session.list')).toEqual([]);
    expect(sessionRow(dataDir, session.id)).toMatchObject({ ended_at: ended.endedAt });
    await expect(client.call('session.write', { sessionId: session.id, data: 'x' })).rejects.toThrow(/no live session/);
  });

  it.skipIf(process.platform === 'win32')('says where a session is now: after a cd while it runs, and where it was last seen once it has ended', async () => {
    const { client } = await daemonWithClient();
    const elsewhere = realpathSync(tempDataDir());
    const session = await client.call('session.createShell', SIZE);
    client.call('session.write', { sessionId: session.id, data: `cd ${elsewhere}\r` });
    await vi.waitFor(async () => expect((await client.call('session.cwd', { sessionId: session.id })).cwd).toBe(elsewhere), { timeout: 5_000 });

    await client.call('session.kill', { sessionId: session.id });
    await expect(client.call('session.cwd', { sessionId: 'nope' })).rejects.toThrow(/no session/);
  });

  it('records a shell that exits on its own, with its exit code', async () => {
    const { dataDir, client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    await client.call('session.attach', { sessionId: session.id });

    await client.call('session.write', { sessionId: session.id, data: 'exit 7\r' });

    expect((await recorder.waitFor(isExited)).session).toMatchObject({ id: session.id, exitCode: 7 });
    expect(sessionRow(dataDir, session.id)).toMatchObject({ exit_code: 7, ended_at: expect.any(String) });
  });

  it('kills its sessions when it is stopped', async () => {
    const { dataDir, daemon, client } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);

    await daemon.stop();

    expect(isProcessAlive(session.pid)).toBe(false);
    expect(sessionRow(dataDir, session.id)).toMatchObject({ ended_at: expect.any(String) });
  });

  it('hands a client that attaches mid-stream every line exactly once, across the snapshot and the output', async () => {
    const { daemon, client, recorder } = await daemonWithClient();
    const session = await client.call('session.createShell', SIZE);
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', {
      sessionId: session.id,
      data: 'i=0; while [ $i -lt 6000 ]; do echo n$i; i=$((i+1)); done; echo $((2 + 2))end\r',
    });
    await recorder.waitForText(session.id, 'n500\r');

    const later = await connectTestClient(daemon);
    const laterRecorder = recordEvents(later);
    await later.call('session.attach', { sessionId: session.id });
    await laterRecorder.waitForText(session.id, '4end');

    // Drop CSI sequences, which the snapshot may put between the last line's text and the output that continues it.
    const text = laterRecorder.screenText(session.id).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g'), '');
    // Under load a macOS PTY sometimes ends a line with \r\r\n, which a terminal shows just like \r\n.
    const numbers = [...text.matchAll(/\bn(\d+)\r*\n/g)].map((match) => Number(match[1]));
    expect(numbers.at(-1)).toBe(5999);
    expect(numbers.length).toBeGreaterThan(1000);
    expect(numbers.filter((n, i) => i > 0 && n !== numbers[i - 1]! + 1)).toEqual([]);
  });

  it('sends a large, heavily coloured scrollback to a reattaching client in bounded pieces', async () => {
    const chunkLength = 16 * 1024;
    const { daemon, client, recorder } = await daemonWithClient({ snapshotChunkLength: chunkLength });
    const session = await client.call('session.createShell', { cols: 200, rows: 24 });
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', {
      sessionId: session.id,
      data: `awk 'BEGIN { for (i = 0; i < 300; i++) { s = ""; for (j = 0; j < 150; j++) s = s sprintf("\\033[38;5;%dmx", (i + j) % 256); print s } }'; echo $((3 + 3))fin\r`,
    });
    await recorder.waitForText(session.id, '6fin');

    const later = await connectTestClient(daemon);
    const laterRecorder = recordEvents(later);
    await later.call('session.attach', { sessionId: session.id });
    await later.call('session.write', { sessionId: session.id, data: 'echo $((4 + 4))more\r' });
    await laterRecorder.waitForText(session.id, '8more');

    const pieces = laterRecorder.events.flatMap((event) =>
      event.type === 'session.snapshot' || event.type === 'session.output' ? [event.data.length] : [],
    );
    expect(pieces.reduce((a, b) => a + b, 0)).toBeGreaterThan(2 * chunkLength);
    expect(Math.max(...pieces)).toBeLessThanOrEqual(chunkLength);
    expect(laterRecorder.screenText(session.id)).toContain('6fin');
  });

  it('sends SIGKILL to a session that ignores SIGHUP, after the grace period', async () => {
    const { client, recorder } = await daemonWithClient({ killGraceMs: 200 });
    const session = await client.call('session.createShell', SIZE);
    await client.call('session.attach', { sessionId: session.id });
    await client.call('session.write', { sessionId: session.id, data: "trap '' HUP; echo $((5 + 5))trapped\r" });
    await recorder.waitForText(session.id, '10trapped');

    const startedAt = Date.now();
    await client.call('session.kill', { sessionId: session.id });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(isProcessAlive(session.pid)).toBe(false);
  });
});
