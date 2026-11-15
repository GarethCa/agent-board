import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { daemonPaths, listenOnSocket, prepareDataDir } from '../src/paths.ts';
import { tempDataDir } from './helpers.ts';

/** A server, closed when the test ends. */
function testServer() {
  const server = createServer((socket) => socket.end());
  onTestFinished(() => void server.close());
  return server;
}

describe.skipIf(process.platform === 'win32')("the daemon's socket", () => {
  it('is 0600 from the moment it is at its path, even under an open umask, and leaves nothing else behind', async () => {
    const dir = tempDataDir();
    const socketPath = join(dir, 'daemon.sock');
    const before = process.umask(0o000);
    onTestFinished(() => void process.umask(before));
    const server = testServer();
    let thereOnBind: boolean | undefined;
    server.on('listening', () => (thereOnBind = existsSync(socketPath)));

    await listenOnSocket(server, socketPath);

    expect(thereOnBind).toBe(false);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['daemon.sock']);
    expect(process.umask()).toBe(0o000);
    await new Promise<void>((resolve, reject) => connect(socketPath, resolve).once('error', reject).unref());
  });

  it('replaces a stale socket file', async () => {
    const socketPath = join(tempDataDir(), 'daemon.sock');
    writeFileSync(socketPath, 'stale');

    await listenOnSocket(testServer(), socketPath);

    expect(statSync(socketPath).isSocket()).toBe(true);
  });

  it('leaves no folder behind when the listen fails', async () => {
    const dir = tempDataDir();
    const server = testServer();
    await listenOnSocket(server, join(dir, 'daemon.sock'));
    // A server already listening can't listen again.
    await expect(listenOnSocket(server, join(dir, 'other.sock'))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['daemon.sock']);
  });
});

describe.skipIf(process.platform === 'win32')("the daemon's data dir", () => {
  it('is set to 0700 when it already exists', () => {
    const dataDir = join(tempDataDir(), 'data');
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o755);

    prepareDataDir(daemonPaths(dataDir), () => {});

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  // As root the chmod would succeed, on a folder that isn't the test's.
  it.skipIf(process.getuid?.() === 0)("is logged and left when its mode can't be changed", () => {
    const logged: string[] = [];
    const mode = statSync('/usr').mode;

    prepareDataDir(daemonPaths('/usr'), (line) => logged.push(line));

    expect(logged).toEqual([expect.stringMatching(/^could not make the data dir \/usr private \(0700\): EPERM/)]);
    expect(statSync('/usr').mode).toBe(mode);
  });
});
