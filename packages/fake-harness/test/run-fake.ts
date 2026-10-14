import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeHarnessEnv, type FakeScenario, type HarnessName, type HookRecorder, type HookEvent } from '../src/index.ts';

export interface RunFakeOptions {
  scenario: FakeScenario;
  args?: string[];
  /** Lines written to the fake's stdin, one per prompt it waits for. stdin closes after them. */
  input?: string[];
  cwd?: string;
  home?: string;
  env?: Record<string, string>;
}

export interface RunFakeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  home: string;
  cwd: string;
}

export interface StartedFake {
  child: ChildProcessWithoutNullStreams;
  done: Promise<RunFakeResult>;
}

/** Starts a fake harness by name through PATH, exactly as a daemon would spawn the real one, with stdin left open. */
export function startFake(harness: HarnessName, options: Omit<RunFakeOptions, 'input'>): StartedFake {
  const home = options.home ?? tempDir('fake-home-');
  const cwd = options.cwd ?? tempDir('fake-cwd-');
  const child = spawn(harness, options.args ?? [], {
    cwd,
    env: { ...fakeHarnessEnv({ scenario: options.scenario, home }), ...options.env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const done = new Promise<RunFakeResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, home, cwd }));
  });
  return { child, done };
}

/** Runs a fake to completion, feeding `input` on stdin and then closing it. */
export function runFake(harness: HarnessName, options: RunFakeOptions): Promise<RunFakeResult> {
  const { child, done } = startFake(harness, options);
  child.stdin.end((options.input ?? []).map((line) => `${line}\n`).join(''));
  return done;
}

/** Resolves once the recorder has seen `count` events named `name`. */
export async function untilEvents(recorder: HookRecorder, name: string, count = 1, timeoutMs = 5000): Promise<HookEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = recorder.events.filter((event) => event.hook_event_name === name);
    if (found.length >= count) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${name} event(s)`);
    await sleep(20);
  }
}

/** Resolves once the fake has printed `text`. */
export function untilStdout(child: ChildProcessWithoutNullStreams, text: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timed out waiting for "${text}" on stdout`));
    }, timeoutMs);
    const onData = (chunk: string) => {
      seen += chunk;
      if (!seen.includes(text)) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const created: string[] = [];

/** A fresh temp dir by its real path (macOS /var is a symlink to /private/var, and process.cwd() reports the latter). */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `agent-board-test-${prefix}`)));
  created.push(dir);
  return dir;
}

/** Removes every temp dir made by `tempDir`. Call from afterAll. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
