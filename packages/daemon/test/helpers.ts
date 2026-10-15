import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished } from 'vitest';
import { createMemoryCredentialStore } from '@agent-board/tracker/testing';
import { startDaemon, type Daemon, type DaemonOptions } from '../src/daemon.ts';
import { connectDaemon, type DaemonClient } from '../src/client.ts';
import type { CliLauncher } from '../src/hook-forwarder.ts';
import { hashToken } from '../src/tokens.ts';
import { migrate } from '../src/migrate.ts';
import type { DaemonEvent } from '../src/protocol.ts';
import { daemonPaths } from '../src/paths.ts';

/** A fresh data dir, removed when the test ends. */
export function tempDataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-daemon-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Runs the hook forwarder from source, as the hook shim does in tests. The shim passes `hook codex`, which this
 * entry ignores.
 */
export const TEST_HOOK_FORWARDER: CliLauncher = {
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/hook-main.ts', import.meta.url))],
};

/** Runs the whole `agent-board` CLI from source, as the CLI launcher sessions find on their PATH does in tests. */
export const TEST_CLI_LAUNCHER: CliLauncher = {
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/cli-main.ts', import.meta.url))],
};

/** A fresh git repo with one commit and an `apps/web` folder, removed when the test ends. */
export function tempRepo(name = 'monorepo'): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ab-repo-')));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const repo = join(parent, name);
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'web', 'index.ts'), 'export {};\n');
  git(repo, 'init', '--quiet');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial');
  return repo;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Starts a daemon in `dataDir` (a fresh temp dir by default), with credentials in memory, and stops it when the test ends. */
export async function startTestDaemon(options: Partial<DaemonOptions> = {}): Promise<Daemon> {
  const daemon = await startDaemon({
    dataDir: options.dataDir ?? tempDataDir(),
    log: () => {},
    // Never the user's own shell and its rc files, nor their keychain.
    shell: '/bin/sh',
    shellArgs: [],
    // Never the user's home directory, where a shell with no folder starts.
    homeDir: tempDataDir(),
    // Never a harness the developer has installed (/opt/homebrew/bin, ~/.local/bin…).
    harnessDirs: [],
    // Never the real ~/.agent-board/bin, ~/.claude or ~/.codex.
    hookShimPath: join(tempDataDir(), 'bin', 'agent-board-hook'),
    externalHookFile: join(tempDataDir(), 'external-hook.json'),
    externalHookFiles: { claude: join(tempDataDir(), 'settings.json'), codex: join(tempDataDir(), 'hooks.json') },
    hookForwarder: TEST_HOOK_FORWARDER,
    cli: TEST_CLI_LAUNCHER,
    credentials: createMemoryCredentialStore(),
    // Never asks gh for pull requests unless a test wants it to, with a fake gh.
    pullRequestPollMs: 0,
    ...options,
  });
  onTestFinished(() => daemon.stop());
  return daemon;
}

/** Connects to `daemon` and closes the connection when the test ends. */
export async function connectTestClient(daemon: Daemon): Promise<DaemonClient> {
  const client = await connectDaemon(daemon.socketPath);
  onTestFinished(() => client.close());
  return client;
}

/**
 * Writes a fake session record straight into the data dir's database, the way a spawned session will be recorded
 * once sessions exist. Safe while a daemon has the database open.
 */
export function insertFakeSession(dataDir: string, session: { id: string; hookToken: string }): { end(): void } {
  const db = new DatabaseSync(daemonPaths(dataDir).database);
  try {
    migrate(db);
    db.prepare("INSERT INTO sessions (id, harness, hook_token_sha256) VALUES (?, 'claude', ?)").run(
      session.id,
      hashToken(session.hookToken),
    );
  } finally {
    db.close();
  }
  return {
    end() {
      const db = new DatabaseSync(daemonPaths(dataDir).database);
      try {
        db.prepare("UPDATE sessions SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(session.id);
      } finally {
        db.close();
      }
    },
  };
}

/** Records a client's events, and waits for conditions on them. */
export function recordEvents(client: DaemonClient) {
  const events: DaemonEvent[] = [];
  /** Per session, everything it showed this client: its snapshots and output, in order. */
  const texts = new Map<string, string>();
  const waiters = new Set<() => void>();
  client.onEvent((event) => {
    events.push(event);
    if (event.type === 'session.snapshot' || event.type === 'session.output') {
      texts.set(event.sessionId, (texts.get(event.sessionId) ?? '') + event.data);
    }
    for (const wake of waiters) wake();
  });

  /**
   * Resolves once `condition` holds, checking now and after every event. Gives up only once `progress` has stood still
   * for `idleMs`, so a slow machine still streaming what was asked for is never mistaken for a stuck one.
   */
  const until = (condition: () => boolean, progress: () => number, describe: () => string, idleMs = 10_000) =>
    new Promise<void>((resolve, reject) => {
      let seen = progress();
      const giveUp = () => {
        waiters.delete(check);
        reject(new Error(`no progress for ${idleMs} ms waiting for ${describe().slice(-2_000)}`));
      };
      let timer = setTimeout(giveUp, idleMs);
      const check = () => {
        if (condition()) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
          return true;
        }
        if (progress() !== seen) {
          seen = progress();
          clearTimeout(timer);
          timer = setTimeout(giveUp, idleMs);
        }
        return false;
      };
      if (!check()) waiters.add(check);
    });

  const screenText = (sessionId: string) => texts.get(sessionId) ?? '';

  return {
    events,
    screenText,
    /** Resolves with the first event, seen or still to come, that matches. */
    async waitFor<E extends DaemonEvent>(match: (event: DaemonEvent) => event is E): Promise<E> {
      await until(
        () => events.some(match),
        () => events.length,
        () => `a matching event; saw ${JSON.stringify(events)}`,
      );
      return events.find(match)!;
    },
    /** Resolves once the client has been shown `text` from the session. */
    waitForText: (sessionId: string, text: string) =>
      until(
        () => screenText(sessionId).includes(text),
        () => screenText(sessionId).length,
        () => `${JSON.stringify(text)} from ${sessionId}; got ${JSON.stringify(screenText(sessionId))}`,
      ),
  };
}
