import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { TerminalBackend, TerminalExit, TerminalInfo, TerminalListener } from './terminal-backend.ts';

interface Entry {
  pty: IPty;
  listeners: Set<TerminalListener>;
  exit?: TerminalExit;
}

/** The built-in terminal backend (ADR-0006): each terminal is a node-pty PTY in this process. */
export function createNodePtyBackend(options: { log?: (message: string) => void } = {}): TerminalBackend {
  ensureSpawnHelperExecutable(options.log ?? (() => {}));
  const terminals = new Map<string, Entry>();

  const get = (id: string): Entry => {
    const entry = terminals.get(id);
    if (entry === undefined || entry.exit !== undefined) throw new Error(`no terminal ${id}`);
    return entry;
  };

  return {
    spawn(options) {
      if (terminals.has(options.id)) throw new Error(`a terminal with id ${options.id} already exists`);
      const pty = spawnPty(options.command, options.args, {
        name: options.env.TERM ?? 'xterm-256color',
        cwd: options.cwd,
        env: options.env,
        cols: options.cols,
        rows: options.rows,
      });
      const entry: Entry = { pty, listeners: new Set() };
      terminals.set(options.id, entry);
      pty.onData((data) => {
        for (const listener of entry.listeners) listener.onData(data);
      });
      pty.onExit(({ exitCode, signal }) => {
        entry.exit = signal ? { exitCode, signal } : { exitCode };
        // The leader is gone; whatever it left behind in its group must not keep writing into the agent's folder.
        if (process.platform !== 'win32') signalGroup(pty.pid, 'SIGKILL');
        terminals.delete(options.id);
        for (const listener of entry.listeners) listener.onExit(entry.exit);
        entry.listeners.clear();
      });
      return { id: options.id, pid: pty.pid };
    },
    write(id, data) {
      get(id).pty.write(data);
    },
    resize(id, cols, rows) {
      get(id).pty.resize(cols, rows);
    },
    kill(id, signal = 'SIGHUP') {
      const { pty } = get(id);
      if (process.platform === 'win32') return pty.kill();
      // The whole process group, so what the agent started (a build, a dev server) stops with it.
      signalGroup(pty.pid, signal);
      pty.kill(signal);
    },
    pause(id) {
      get(id).pty.pause();
    },
    resume(id) {
      get(id).pty.resume();
    },
    attach(id, listener) {
      const entry = get(id);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    list(): TerminalInfo[] {
      return [...terminals].map(([id, entry]) => ({ id, pid: entry.pty.pid }));
    },
  };
}

/** Signals the process group a PTY's child leads (`forkpty` makes it a session leader), ignoring an empty group. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  // `kill(0)` and `kill(-1)` would signal the daemon's own group, or every process there is.
  if (!(pid > 0)) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

/**
 * node-pty 1.1.0's prebuilt `spawn-helper` is published without its execute bit, so every spawn fails with
 * "posix_spawnp failed" (microsoft/node-pty#850). Restore the bit before the first spawn.
 */
function ensureSpawnHelperExecutable(log: (message: string) => void): void {
  if (process.platform === 'win32') return;
  const root = dirname(dirname(createRequire(import.meta.url).resolve('node-pty')));
  const candidates = [
    join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(root, 'build', 'Release', 'spawn-helper'),
  ];
  for (const helper of candidates) {
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch (error) {
        // A read-only install: spawns will fail, but the daemon (and its database) still comes up.
        log(`could not make ${helper} executable, so sessions cannot start: ${(error as Error).message}`);
      }
    }
  }
}
