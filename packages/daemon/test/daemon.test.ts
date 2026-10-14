import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DaemonRpcError } from '../src/client.ts';
import { DaemonAlreadyRunningError } from '../src/lock.ts';
import { MIGRATIONS } from '../src/migrate.ts';
import { daemonPaths } from '../src/paths.ts';
import { DAEMON_VERSION, PROTOCOL_VERSION } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

/** Sends raw lines on a fresh connection and collects the reply lines. */
async function rawExchange(socketPath: string, lines: string[], replies: number): Promise<unknown[]> {
  const socket = createConnection(socketPath);
  const received: unknown[] = [];
  let buffer = '';
  try {
    return await new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          received.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
        }
        if (received.length >= replies) resolve(received);
      });
      socket.write(lines.map((line) => `${line}\n`).join(''));
    });
  } finally {
    socket.destroy();
  }
}

describe('daemon API over the socket', () => {
  it('reports health: version, protocol, pid, schema version and hook port', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);

    const health = await client.call('daemon.health');

    expect(health).toMatchObject({
      version: DAEMON_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      schemaVersion: MIGRATIONS.length,
      hookPort: daemon.hookPort,
      clients: 1,
      liveSessions: 0,
      homeDir: expect.any(String),
    });
    expect(daemon.hookPort).toBeGreaterThan(0);
  });

  it('opens the database in the data dir and applies the migrations', async () => {
    const dataDir = tempDataDir();
    await startTestDaemon({ dataDir });
    expect(existsSync(daemonPaths(dataDir).database)).toBe(true);
  });

  it('answers an unknown method with a JSON-RPC method-not-found error', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);

    const error = await client.call('no.such.method' as never).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaemonRpcError);
    expect(error).toMatchObject({ code: -32601 });
  });

  it('answers a malformed line with a parse error and keeps the connection usable', async () => {
    const daemon = await startTestDaemon();

    const replies = await rawExchange(
      daemon.socketPath,
      ['{not json', JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'daemon.health' })],
      2,
    );

    expect(replies[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect(replies[1]).toMatchObject({ jsonrpc: '2.0', id: 7, result: { pid: process.pid } });
  });

  it('serves several clients at once', async () => {
    const daemon = await startTestDaemon();
    const first = await connectTestClient(daemon);
    const second = await connectTestClient(daemon);

    const [a, b] = await Promise.all([first.call('daemon.health'), second.call('daemon.health')]);

    expect(a.clients).toBe(2);
    expect(b.clients).toBe(2);
  });

  it('refuses to start a second daemon on the same data dir, leaving the first one serving', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });

    await expect(startTestDaemon({ dataDir })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);

    const client = await connectTestClient(first);
    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
  });

  it('takes over a data dir whose lock and socket were left by a daemon that died', async () => {
    const dataDir = tempDataDir();
    const paths = daemonPaths(dataDir);
    const deadPid = spawnSync('true').pid;
    writeFileSync(paths.lock, String(deadPid));
    writeFileSync(paths.socket, '');

    const daemon = await startTestDaemon({ dataDir });
    const client = await connectTestClient(daemon);

    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
  });

  it('takes over a lock whose pid is alive but whose socket has long stopped answering (a reused pid)', async () => {
    const dataDir = tempDataDir();
    const paths = daemonPaths(dataDir);
    writeFileSync(paths.lock, String(process.ppid));
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(paths.lock, longAgo, longAgo);

    const daemon = await startTestDaemon({ dataDir });
    const client = await connectTestClient(daemon);

    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
  });

  it('treats a young lock whose pid is alive as a daemon still starting', async () => {
    const dataDir = tempDataDir();
    writeFileSync(daemonPaths(dataDir).lock, String(process.ppid));

    await expect(startTestDaemon({ dataDir })).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it('serves from a data dir too long for a Unix socket path, via a short socket elsewhere', async () => {
    const dataDir = join(tempDataDir(), 'a-rather-long-directory-name'.repeat(5));
    mkdirSync(dataDir);
    const daemon = await startTestDaemon({ dataDir });

    expect(Buffer.byteLength(daemon.socketPath)).toBeLessThanOrEqual(100);
    const client = await connectTestClient(daemon);
    await expect(client.call('daemon.health')).resolves.toMatchObject({ pid: process.pid });
  });

  it('removes its socket and lock when stopped', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir });

    await daemon.stop();

    expect(await daemon.closed).toEqual({ reason: 'stopped' });
    expect(existsSync(daemonPaths(dataDir).socket)).toBe(false);
    expect(existsSync(daemonPaths(dataDir).lock)).toBe(false);
  });
});
