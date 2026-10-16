/**
 * The watchdog thread of a Vitest fork (watchdog.ts). It runs beside the fork's main thread, so it keeps ticking when a
 * test spins in a synchronous loop that Vitest's own timeout, a timer on the stuck main thread, never sees. It kills its
 * fork with SIGKILL when the current phase runs past its limit, or when the Vitest run that started the fork is gone.
 * It writes straight to fd 2: the main thread, which would otherwise carry its output, is the one that's stuck.
 */
import { writeSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { awakeClock, overdue, publishAwake, type WatchdogState } from './watchdog-state.ts';

const { state, ppid } = workerData as { state: WatchdogState; ppid: number };
const TICK_MS = 250;
/** Time spent awake: a gap between ticks longer than a few ticks is the machine sleeping, not the test running. */
const awake = awakeClock(Date.now, 4 * TICK_MS);

function stop(why: string): void {
  try { writeSync(2, `\ntest watchdog: ${why}\n`); } catch { /* no stderr left */ }
  process.kill(process.pid, 'SIGKILL');
}

setInterval(() => {
  if (process.ppid !== ppid) {
    stop(`the Vitest run that started worker ${process.pid} is gone, so the worker stops too.`);
    return;
  }
  const now = awake();
  publishAwake(state, now);
  const late = overdue(state, now);
  if (late !== undefined) {
    const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
    stop(
      `${late.where} has run for ${seconds(late.elapsedMs)}, past its ${seconds(late.limitMs)} limit, without yielding: ` +
        `likely a synchronous loop that never ends. Killing worker ${process.pid}.`,
    );
  }
}, TICK_MS);
