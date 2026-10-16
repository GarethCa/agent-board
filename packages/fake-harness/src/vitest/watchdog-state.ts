/**
 * What a Vitest fork's main thread tells its watchdog thread (watchdog.ts): where it is (a test, or the file's loading or
 * hooks), since when, and how long that may take. It lives in shared memory, so the watchdog reads it even while the
 * main thread is stuck in a synchronous loop and can't send anything.
 */

/** The least any phase gets: loading a file, its hooks, and a test with a short or no timeout. */
export const WATCHDOG_FLOOR_MS = 60_000;

const LABEL_BYTES = 2_048;
/**
 * [since (awake ms), limit (ms), label length (bytes), awake ms now (published by the watchdog)], then the label's
 * UTF-8 bytes.
 */
const HEADER = Float64Array.BYTES_PER_ELEMENT * 4;

export type WatchdogState = SharedArrayBuffer;

/**
 * A clock of time spent awake, for the watchdog thread to call at a steady interval: each call advances it by the wall
 * time since the last, but never by more than `capMs`, nor backwards. A longer gap means the machine slept (no clock
 * Node offers stops for sleep on macOS), and sleep is not time a test spent running.
 */
export function awakeClock(wallNow: () => number = Date.now, capMs = 1_000): () => number {
  let last = wallNow();
  let awake = 0;
  return () => {
    const now = wallNow();
    awake += Math.min(Math.max(now - last, 0), capMs);
    last = now;
    return awake;
  };
}

export function createState(): WatchdogState {
  return new SharedArrayBuffer(HEADER + LABEL_BYTES);
}

/** The watchdog's awake time now, for the main thread's next mark. */
export function publishAwake(state: WatchdogState, awakeMs: number): void {
  new Float64Array(state, 0, 4)[3] = awakeMs;
}

/** Starts a phase named `where`, which may run `limitMs` of awake time from `now`: the watchdog's last published time. */
export function mark(state: WatchdogState, where: string, limitMs: number, now = new Float64Array(state, 0, 4)[3]!): void {
  const header = new Float64Array(state, 0, 4);
  const label = new Uint8Array(state, HEADER, LABEL_BYTES);
  const fits = Buffer.byteLength(where) <= LABEL_BYTES ? where : `${cut(where, LABEL_BYTES - 3)}…`;
  // A limit of 0 means no phase, so the watchdog never pairs the old start with the new limit while this writes.
  header[1] = 0;
  const { written } = new TextEncoder().encodeInto(fits, label);
  header[2] = written;
  header[0] = now;
  header[1] = limitMs;
}

/** The current phase, if it has run past its limit at awake time `now`. */
export function overdue(state: WatchdogState, now: number): { where: string; elapsedMs: number; limitMs: number } | undefined {
  const [since, limitMs, length] = new Float64Array(state, 0, 3) as unknown as [number, number, number];
  if (limitMs === 0 || now - since <= limitMs) return undefined;
  // TextDecoder won't read a view on shared memory: copy it out.
  const where = new TextDecoder().decode(new Uint8Array(state, HEADER, length).slice());
  return { where, elapsedMs: now - since, limitMs };
}

/**
 * How long a phase may run: `TEST_WATCHDOG_MS` if set, else three times the test's timeout, never under the floor.
 * A test that times out on its own fails long before; only one that never yields to its timer gets this far.
 */
export function limitFor(timeoutMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fixed = Number(env.TEST_WATCHDOG_MS);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  return Math.max(WATCHDOG_FLOOR_MS, 3 * (timeoutMs ?? 0));
}

/** `text` cut to at most `bytes` UTF-8 bytes, on a character boundary. */
function cut(text: string, bytes: number): string {
  let out = '';
  let used = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > bytes) break;
    out += char;
  }
  return out;
}
