import { existsSync, fstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isatty } from 'node:tty';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { isProcessAlive } from '../src/pid.ts';
import { createNodePtyBackend } from '../src/node-pty-backend.ts';
import type { TerminalBackend, TerminalExit, TerminalSpawnOptions } from '../src/terminal-backend.ts';

function backend(): TerminalBackend {
  const backend = createNodePtyBackend();
  onTestFinished(() => {
    for (const terminal of backend.list()) backend.kill(terminal.id, 'SIGKILL');
  });
  return backend;
}

function shOptions(id: string, script?: string): TerminalSpawnOptions {
  return {
    id,
    command: '/bin/sh',
    args: script === undefined ? [] : ['-c', script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PS1: '$ ', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
  };
}

/** Collects a terminal's output and exit. */
function watch(backend: TerminalBackend, id: string) {
  let output = '';
  let exit: TerminalExit | undefined;
  const waiters = new Set<() => void>();
  backend.attach(id, {
    onData: (data) => {
      output += data;
      for (const wake of waiters) wake();
    },
    onExit: (result) => {
      exit = result;
      for (const wake of waiters) wake();
    },
  });
  const until = (done: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      if (done()) return resolve();
      const timer = setTimeout(() => reject(new Error(`timed out; output so far: ${JSON.stringify(output)}`)), 5_000);
      const wake = () => {
        if (!done()) return;
        clearTimeout(timer);
        waiters.delete(wake);
        resolve();
      };
      waiters.add(wake);
    });
  return {
    output: () => output,
    exit: () => exit,
    waitForOutput: (text: string) => until(() => output.includes(text)),
    waitForExit: async () => {
      await until(() => exit !== undefined);
      return exit!;
    },
  };
}

describe('node-pty terminal backend', () => {
  it("spawns a process in a PTY and streams its output, then its exit", async () => {
    const terminals = backend();

    const terminal = terminals.spawn(shOptions('t1', 'echo hello from the pty; exit 3'));
    const watched = watch(terminals, 't1');

    expect(terminal).toMatchObject({ id: 't1', pid: expect.any(Number) });
    await watched.waitForOutput('hello from the pty');
    expect(await watched.waitForExit()).toMatchObject({ exitCode: 3 });
  });

  it('writes input to the process', async () => {
    const terminals = backend();
    terminals.spawn(shOptions('t1'));
    const watched = watch(terminals, 't1');

    terminals.write('t1', 'echo $((40 + 2))\r');

    await watched.waitForOutput('42');
  });

  it('resizes the PTY', async () => {
    const terminals = backend();
    terminals.spawn(shOptions('t1'));
    const watched = watch(terminals, 't1');

    terminals.resize('t1', 101, 33);
    terminals.write('t1', 'stty size\r');

    await watched.waitForOutput('33 101');
  });

  it('lists live terminals and drops them once they exit', async () => {
    const terminals = backend();
    terminals.spawn(shOptions('t1'));
    terminals.spawn(shOptions('t2'));
    const watched = watch(terminals, 't1');

    expect(terminals.list().map((terminal) => terminal.id).sort()).toEqual(['t1', 't2']);

    terminals.kill('t1');
    await watched.waitForExit();

    expect(terminals.list().map((terminal) => terminal.id)).toEqual(['t2']);
  });

  it('kills the process, even an interactive shell', async () => {
    const terminals = backend();
    terminals.spawn(shOptions('t1'));
    const watched = watch(terminals, 't1');

    terminals.kill('t1');

    expect(await watched.waitForExit()).toBeDefined();
  });

  it('refuses a second terminal with the same id, and calls for an unknown id', () => {
    const terminals = backend();
    terminals.spawn(shOptions('t1'));

    expect(() => terminals.spawn(shOptions('t1'))).toThrow(/already/);
    expect(() => terminals.write('nope', 'x')).toThrow(/no terminal/);
  });

  it.skipIf(process.platform === 'win32')('leaves no terminal open once its process has exited', async () => {
    const terminals = backend();
    const before = { terminals: openTerminals(), fds: openFds() };

    for (let i = 0; i < 20; i++) {
      terminals.spawn(shOptions(`t${i}`, 'exit 0'));
      await watch(terminals, `t${i}`).waitForExit();
    }

    // Each terminal the backend opened, and every other it made on the way, is closed: a long-running daemon
    // that kept even one per spawn would run the machine out of PTYs. (An earlier test's may close meanwhile.)
    expect(openTerminals()).toBeLessThanOrEqual(before.terminals);
    // Nor does a spawn keep any other descriptor, such as the kqueue that watches for its exit. A few may come and
    // go with the test runner's own work; one per spawn is twenty.
    expect(openFds()).toBeLessThanOrEqual(before.fds + 5);
  });

  it('reports a command that cannot be started as an exit with a failure code', async () => {
    const terminals = backend();
    terminals.spawn({ ...shOptions('t1'), command: '/no/such/shell' });
    const watched = watch(terminals, 't1');

    expect((await watched.waitForExit()).exitCode).not.toBe(0);
    expect(terminals.list()).toEqual([]);
  });
});

/** How many file descriptors this process has open. */
function openFds(): number {
  return readdirSync('/dev/fd').length;
}

/** How many of this process's file descriptors are terminals: a PTY's master or slave side. */
function openTerminals(): number {
  return readdirSync('/dev/fd').filter((name) => {
    const fd = Number(name);
    try {
      return fstatSync(fd).isCharacterDevice() && isatty(fd);
    } catch {
      // The descriptor `readdirSync` itself had open, closed again since.
      return false;
    }
  }).length;
}

/** Reads the pid a script wrote to `file`, once it has, and kills that process when the test ends. */
async function recordedPid(file: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, 'utf8').trim()).toBeTruthy(), { timeout: 5_000 });
  const pid = Number(readFileSync(file, 'utf8'));
  onTestFinished(() => {
    if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
  });
  return pid;
}

describe('a terminal that started a background process', () => {
  const pidFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-group-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'pid');
  };

  it('signals the whole process group on kill, not only the leader', async () => {
    const b = backend();
    const file = pidFile();
    // The leader catches TERM and carries on; its background child has the default action from the moment it forks.
    b.spawn(shOptions('t', `trap 'true' TERM; (exec sleep 30) & echo $! > ${file}; while :; do sleep 1; done`));
    const child = await recordedPid(file);
    b.kill('t', 'SIGTERM');
    await vi.waitFor(() => expect(isProcessAlive(child)).toBe(false));
    expect(b.list().map((terminal) => terminal.id)).toEqual(['t']);
  });

  it('kills what the leader leaves behind when it exits, even a process that ignores the hang-up', async () => {
    const b = backend();
    const file = pidFile();
    b.spawn(shOptions('t', `(trap '' HUP; exec sleep 30) & echo $! > ${file}; sleep 0.2`));
    const w = watch(b, 't');
    const straggler = await recordedPid(file);
    await w.waitForExit();
    await vi.waitFor(() => expect(isProcessAlive(straggler)).toBe(false));
  });
});
