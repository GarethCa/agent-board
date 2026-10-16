/**
 * Machine sleep during a gate. A Mac left alone on battery idle-sleeps, and wakes for under a minute every quarter
 * hour or so ("DarkWake") before sleeping again. The gate's processes freeze with it, and on waking each test finds
 * its wall-clock time gone: a 20-second test reads as running for 1 000 s and fails on its timeout though nothing in
 * it blocked. So the gate holds a sleep assertion while it runs (`keepAwake`) and, when the machine slept anyway (lid
 * closed, or a critical battery), says so beside its table (`sleepNote`), so nobody hunts for a hang in the tests.
 * On battery it warns at the start and, read again, under the table (`batteryNote`), as the assertion can't stop those sleeps.
 */
import { execFile, spawn } from 'node:child_process';

export interface Sleep {
  at: Date;
  /** The log's own clock time, HH:MM, in the time zone it was written in. */
  clock: string;
  /** How long it lasted; undefined while the log has not recorded it yet. */
  seconds: number | undefined;
  /** Why it slept, as the log puts it: 'Idle Sleep', 'Maintenance Sleep', 'Clamshell Sleep'… */
  reason: string;
}

const SLEEP_LINE = /^(\d{4}-\d{2}-\d{2}) ((\d{2}:\d{2}):\d{2}) ([+-]\d{2})(\d{2}) Sleep\s+\tEntering Sleep state due to '([^']*)'(?:.*?\s(\d+) secs)?/;

/** The sleeps in `pmset -g log` output, oldest first. */
export function parseSleeps(log: string): Sleep[] {
  const sleeps: Sleep[] = [];
  for (const line of log.split('\n')) {
    const match = SLEEP_LINE.exec(line);
    if (match === null) continue;
    const [, day, time, clock, offsetHours, offsetMinutes, reason, seconds] = match;
    sleeps.push({
      at: new Date(`${day}T${time}${offsetHours}:${offsetMinutes}`),
      clock: clock!,
      seconds: seconds === undefined ? undefined : Number(seconds),
      reason: reason!,
    });
  }
  return sleeps;
}

/** The note about the sleeps that overlap `from`..`to`, or undefined when the machine stayed awake throughout. */
export function sleepNote(sleeps: readonly Sleep[], from: Date, to: Date): string | undefined {
  const lasted = (sleep: Sleep): number => sleep.seconds ?? Math.max(0, Math.round((to.getTime() - sleep.at.getTime()) / 1000));
  const during = sleeps.filter((sleep) => sleep.at <= to && sleep.at.getTime() + lasted(sleep) * 1000 >= from.getTime());
  if (during.length === 0) return undefined;
  const total = during.reduce((sum, sleep) => sum + lasted(sleep), 0);
  const times = during.length === 1 ? 'once' : `${during.length} times`;
  const each = during.map((sleep) => `${sleep.clock} for ${lasted(sleep)} s`).join(', ');
  const reasons = [...new Set(during.map((sleep) => sleep.reason))].join(', ');
  return (
    `The machine slept ${times} during this run, ${total} s in all (${each}; ${reasons}). Times in the table include it, ` +
    'and a test that spans a sleep can fail on its timeout without any fault of its own: plug the machine in and keep it awake, then run again.'
  );
}

/** When the machine last went to sleep, from `sysctl -n kern.sleeptime`; undefined if it hasn't since boot. */
export function lastSleepAt(sysctl: string): Date | undefined {
  const seconds = Number(/sec = (\d+)/.exec(sysctl)?.[1] ?? 0);
  return seconds > 0 ? new Date(seconds * 1000) : undefined;
}

const run = (command: string, args: string[], timeout: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout }, (error, stdout) => resolve(error === null ? stdout : undefined));
  });

/**
 * The sleeps macOS logged since `since`; none elsewhere, or when the log can't be read in time. Reading the log takes
 * ten seconds or more, so it is read only when the kernel's last sleep (milliseconds to ask) is after `since`: a run
 * can't start while the machine sleeps, so any sleep that overlaps it began during it.
 */
export async function readSleeps(since: Date): Promise<Sleep[]> {
  if (process.platform !== 'darwin') return [];
  const sysctl = await run('sysctl', ['-n', 'kern.sleeptime'], 5_000);
  const last = sysctl === undefined ? undefined : lastSleepAt(sysctl);
  if (sysctl !== undefined && (last === undefined || last < since)) return [];
  const log = await run('pmset', ['-g', 'log'], 60_000);
  return log === undefined ? [] : parseSleeps(log);
}

/** The warning for `pmset -g batt` output that shows the machine on battery, with its charge; undefined on AC power. */
export function batteryNote(batt: string): string | undefined {
  if (!batt.includes("drawing from 'Battery Power'")) return undefined;
  const charge = /\t(\d+)%;/.exec(batt)?.[1];
  return `On battery${charge === undefined ? '' : ` at ${charge}%`}: plug in, a closed lid or a low battery will still sleep the machine mid-run.`;
}

/** The battery warning for this Mac now (see `batteryNote`); undefined elsewhere, on AC power, or when pmset fails. */
export async function readBatteryNote(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const batt = await run('pmset', ['-g', 'batt'], 10_000);
  return batt === undefined ? undefined : batteryNote(batt);
}

/**
 * Keeps a Mac from idle-sleeping until process `pid` exits (`caffeinate -i`), and from sleeping at all while it is
 * on AC power (`-s`). Neither stops the sleep of a closed lid on battery, or of a battery about to run out: those
 * still show in `sleepNote`. Does nothing elsewhere.
 */
export function keepAwake(pid: number = process.pid): void {
  if (process.platform !== 'darwin') return;
  const child = spawn('caffeinate', ['-i', '-s', '-w', String(pid)], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
