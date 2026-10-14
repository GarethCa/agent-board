import { describe, expect, it, onTestFinished } from 'vitest';
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

  it('reports a command that cannot be started as an exit with a failure code', async () => {
    const terminals = backend();
    terminals.spawn({ ...shOptions('t1'), command: '/no/such/shell' });
    const watched = watch(terminals, 't1');

    expect((await watched.waitForExit()).exitCode).not.toBe(0);
    expect(terminals.list()).toEqual([]);
  });
});
