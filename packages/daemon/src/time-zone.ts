import { readlinkSync } from 'node:fs';

/** How often the daemon looks for a change of the system's time zone. */
const TIME_ZONE_CHECK_MS = 60_000;

/** The system's time zone, from the `/etc/localtime` link (macOS, most Linux), or undefined if it can't tell. */
function systemTimeZone(): string | undefined {
  try {
    const target = readlinkSync('/etc/localtime');
    const at = target.indexOf('zoneinfo/');
    return at === -1 ? undefined : target.slice(at + 'zoneinfo/'.length);
  } catch {
    return undefined;
  }
}

export interface FollowTimeZoneOptions {
  intervalMs?: number;
  /** Reads the system's time zone: `systemTimeZone` by default. */
  readZone?: () => string | undefined;
  log(message: string): void;
}

/**
 * Keeps the daemon's local time on the system's time zone. Node fixes its zone when it starts, so a laptop that
 * crosses zones would fire schedules on the old zone's clock while the app previews them on the new one. When the
 * system's zone changes, this sets `process.env.TZ`, which Node applies at once. A daemon started with `TZ` set keeps
 * it. Returns a function that stops following.
 */
export function followSystemTimeZone(options: FollowTimeZoneOptions): () => void {
  if (process.env.TZ !== undefined) return () => {};
  const readZone = options.readZone ?? systemTimeZone;
  let zone = readZone();
  const timer = setInterval(() => {
    const next = readZone();
    if (next === undefined || next === zone) return;
    options.log(`the system's time zone changed from ${zone ?? 'unknown'} to ${next}`);
    zone = next;
    process.env.TZ = next;
  }, options.intervalMs ?? TIME_ZONE_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
