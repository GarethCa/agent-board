/**
 * Vitest runner with a wall-clock watchdog for each fork. Vitest's `testTimeout` is a timer on the test's own
 * event loop, so a test stuck in a synchronous loop never times out and its fork spins at full CPU forever. This runner
 * marks each phase the fork enters in shared memory (watchdog-state.ts): loading a file, each suite's `beforeAll`
 * hooks, the tests running now, and the hooks after them. A watchdog thread (watchdog-thread.ts) kills the fork when a
 * phase runs past its limit (`limitFor`) and names it; Vitest then fails the run with "Worker exited unexpectedly …
 * while running test file …". No watchdog in a worker thread (the `threads` pool), where killing the process would kill
 * the whole run, or under a debugger, where a paused fork is not a stuck one.
 */
import inspector from 'node:inspector';
import { relative } from 'node:path';
import { isMainThread, Worker } from 'node:worker_threads';
import { TestRunner } from 'vitest';
import { createState, limitFor, mark, type WatchdogState } from './watchdog-state.ts';

type File = Parameters<TestRunner['onCollectStart']>[0];
type Suite = Parameters<TestRunner['onBeforeRunSuite']>[0];
type Test = Parameters<TestRunner['onAfterTryTask']>[0];

const KEY = Symbol.for('agent-board.test-watchdog');

/** This fork's watchdog state, starting its thread on first use; undefined where there is no watchdog. */
function watchdog(): WatchdogState | undefined {
  if (!isMainThread || inspector.url() !== undefined || process.execArgv.some((arg) => arg.startsWith('--inspect'))) return undefined;
  const holder = process as unknown as Record<symbol, WatchdogState | undefined>;
  if (holder[KEY] === undefined) {
    const state = createState();
    const thread = new Worker(new URL('./watchdog-thread.ts', import.meta.url), { workerData: { state, ppid: process.ppid } });
    thread.unref();
    holder[KEY] = state;
  }
  return holder[KEY];
}

export default class WatchdogRunner extends TestRunner {
  private readonly state = watchdog();
  /** The tests between their start and end now: more than one when they run concurrently. */
  private readonly running = new Set<Test>();

  private mark(where: string, timeoutMs?: number): void {
    if (this.state !== undefined) mark(this.state, where, limitFor(timeoutMs));
  }

  private name(task: File | Suite | Test): string {
    return task.file === task ? relative(this.config.root, task.file.filepath) : task.fullName;
  }

  override onCollectStart(file: File): void {
    this.mark(`${this.name(file)} (loading)`);
    super.onCollectStart(file);
  }

  override async onBeforeRunSuite(suite: Suite): Promise<void> {
    this.mark(`${this.name(suite)} (beforeAll hooks)`, this.config.hookTimeout);
    await super.onBeforeRunSuite(suite);
  }

  override onBeforeTryTask(test: Test, options: Parameters<TestRunner['onBeforeTryTask']>[1]): void {
    this.running.add(test);
    this.markRunning(test);
    super.onBeforeTryTask(test, options);
  }

  override onAfterTryTask(test: Test): void {
    super.onAfterTryTask(test);
    this.running.delete(test);
    this.markRunning(test);
  }

  /** Marks the tests running now; once none is, the hooks after `last`, which just ended. */
  private markRunning(last: Test): void {
    const tests = [...this.running];
    const timeout = Math.max(this.config.hookTimeout, ...tests.map((t) => t.timeout ?? 0));
    if (tests.length === 0) this.mark(`${this.name(last.suite ?? last.file)} (hooks after "${last.name}")`, this.config.hookTimeout);
    else if (tests.length === 1) this.mark(this.name(tests[0]!), timeout);
    else this.mark(`${this.name(last.file)}, one of the concurrent tests ${tests.map((t) => `"${t.name}"`).join(', ')}`, timeout);
  }
}
