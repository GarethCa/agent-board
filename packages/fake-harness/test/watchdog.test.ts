/**
 * A test stuck in a synchronous loop, and a run whose starter is gone, must not spin on. Each case runs a
 * fixture under its own Vitest (fixtures/watchdog) and checks that every process it started is gone after.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { alive } from '../src/processes.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/watchdog/', import.meta.url));
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');

const started: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  // Whatever happened, nothing a case started may outlive it: each leads its own process group.
  for (const child of started.splice(0)) try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone already */ }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Starts `argv` on the fixture `fixture`, in its own process group; `pid()` reads the pid of the fork running it once it has started. */
function run(fixture: 'spin' | 'spin-load' | 'spin-hook' | 'spin-concurrent' | 'sleep' | 'pass', argv: string[], env: NodeJS.ProcessEnv = {}, cwd = fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-watchdog-'));
  dirs.push(dir);
  const pidFile = join(dir, 'pid');
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WATCHDOG_FIXTURE: fixture, WATCHDOG_PID_FILE: pidFile, ...env },
  });
  started.push(child);
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
  const pid = async (): Promise<number> => {
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 10_000);
    return Number(readFileSync(pidFile, 'utf8'));
  };
  return { child, closed, pid, pidFile, output: () => output };
}

async function until(done: () => boolean, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`not within ${withinMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const vitestRun = [process.execPath, vitest, 'run', '--config', 'vitest.config.ts'];
/** As an agent runs it: `pnpm exec` from the worktree, which starts Vitest's main process through a relative path. */
const pnpmExecRun = ['pnpm', 'exec', 'vitest', 'run', '--root', fixtures, '--config', join(fixtures, 'vitest.config.ts')];

describe('the test watchdog', () => {
  it('kills a test stuck in a synchronous loop, naming its file and test, and leaves no process behind', async () => {
    const begun = Date.now();
    const { closed, pid, output } = run('spin', vitestRun, { TEST_WATCHDOG_MS: '1500' });
    const fork = await pid();
    const code = await closed;
    expect(code).not.toBe(0);
    expect(output()).toContain('test watchdog: spin.fixture.ts > a loop > that never ends has run for');
    expect(output()).toContain('past its 1.5 s limit');
    expect(output()).toMatch(/Worker exited unexpectedly with signal SIGKILL .*spin\.fixture\.ts/);
    expect(Date.now() - begun).toBeLessThan(15_000);
    expect(alive(fork)).toBe(false);
  });

  it('names a file stuck while it loads', async () => {
    const { closed, pid, output } = run('spin-load', vitestRun, { TEST_WATCHDOG_MS: '1500' });
    const fork = await pid();
    expect(await closed).not.toBe(0);
    expect(output()).toContain('test watchdog: spin-load.fixture.ts (loading) has run for');
    expect(alive(fork)).toBe(false);
  });

  it('names the describe whose beforeAll is stuck, not the test before it', async () => {
    const { closed, pid, output } = run('spin-hook', vitestRun, { TEST_WATCHDOG_MS: '1500' });
    const fork = await pid();
    expect(await closed).not.toBe(0);
    expect(output()).toContain('test watchdog: spin-hook.fixture.ts > outer > inner (beforeAll hooks) has run for');
    expect(alive(fork)).toBe(false);
  });

  it('names the concurrent test that is still running, not one that finished', async () => {
    const { closed, pid, output } = run('spin-concurrent', vitestRun, { TEST_WATCHDOG_MS: '1500' });
    const fork = await pid();
    expect(await closed).not.toBe(0);
    expect(output()).toContain('test watchdog: spin-concurrent.fixture.ts > together > spins has run for');
    expect(alive(fork)).toBe(false);
  });

  it('leaves a fork alone while a debugger is attached', async () => {
    const { child, pid, output } = run('spin', [...vitestRun, '--inspect=0', '--no-file-parallelism'], { TEST_WATCHDOG_MS: '1000' });
    const fork = await pid();
    await new Promise((r) => setTimeout(r, 3_000));
    expect(alive(fork)).toBe(true);
    expect(output()).not.toContain('test watchdog:');
    process.kill(-child.pid!, 'SIGKILL');
  });

  it('stops a spinning fork once its Vitest run is killed', async () => {
    const { child, pid } = run('spin', vitestRun);
    const fork = await pid();
    process.kill(child.pid!, 'SIGKILL');
    await until(() => !alive(fork), 5_000);
  });
});

describe('a run whose starter is gone', () => {
  it('stops, with its forks, a few seconds after the shell that started it is killed', async () => {
    const shell = run('sleep', ['sh', '-c', '"$@" & wait', 'sh', ...vitestRun]);
    const fork = await shell.pid();
    const info = JSON.parse(readFileSync(`${shell.pidFile}.run`, 'utf8')) as { dataDir: string; main: number };
    const record = join(tmpdir(), 'agent-board-vitest-runs', `${info.main}.json`);
    expect(existsSync(info.dataDir)).toBe(true);
    expect(existsSync(record)).toBe(true);
    process.kill(shell.child.pid!, 'SIGKILL');
    await until(() => !alive(fork) && !alive(info.main), 8_000);
    // It ran its teardown on the way out.
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(record)).toBe(false);
    // Its output pipes close once the last process holding them, the run's main process included, has gone.
    let closed = false;
    void shell.closed.then(() => (closed = true));
    await until(() => closed, 3_000);
  });
});

describe('the stale-run reaper', () => {
  it("leaves a live `pnpm exec` run's forks alone when a second run starts in the same worktree", async () => {
    const live = run('sleep', pnpmExecRun, {}, root);
    const fork = await live.pid();
    const second = run('pass', pnpmExecRun, {}, root);
    expect(await second.closed).toBe(0);
    expect(alive(fork)).toBe(true);
    expect(live.child.exitCode).toBeNull();
    expect(live.output()).not.toContain('Worker exited unexpectedly');
  });
});
