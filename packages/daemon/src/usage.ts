// Plan usage: the newest reading, which Claude agents' status lines post (never asked of anyone, so no tokens are spent
// reading it).
import type { DatabaseSync } from 'node:sqlite';
import type { BoardConnection } from './board.ts';
import { USAGE_STALE_MS, type DaemonEvent, type DaemonMethods, type UsageReading, type UsageWindow } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type UsageMethods = Pick<DaemonMethods, 'usage.get'>;

/** How often a reading whose percentages haven't changed is written and told again: it is still the newest. */
const SAME_READING_MS = 60_000;

interface ReadingRow {
  five_hour_used: number | null;
  five_hour_resets_at: number | null;
  seven_day_used: number | null;
  seven_day_resets_at: number | null;
  read_at: string;
}

export interface UsageHostOptions {
  db: DatabaseSync;
  broadcast(event: DaemonEvent): void;
  now?: () => number;
}

export interface UsageHost {
  /**
   * Takes what Claude Code passed an agent's status line (its JSON): its `rate_limits` become the newest reading. One
   * without them (an API-key session, an older Claude Code) changes nothing.
   */
  record(statusLine: unknown): void;
  reading(): UsageReading;
  handlers<Context extends BoardConnection>(): RpcHandlers<UsageMethods, Context>;
  /** Stops telling clients when the reading goes stale. */
  close(): void;
}

export function createUsageHost(options: UsageHostOptions): UsageHost {
  const { db } = options;
  const now = options.now ?? Date.now;
  const select = db.prepare('SELECT * FROM usage_reading WHERE id = 1');
  const upsert = db.prepare(
    `INSERT INTO usage_reading (id, five_hour_used, five_hour_resets_at, seven_day_used, seven_day_resets_at, read_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET five_hour_used = excluded.five_hour_used, five_hour_resets_at = excluded.five_hour_resets_at,
       seven_day_used = excluded.seven_day_used, seven_day_resets_at = excluded.seven_day_resets_at, read_at = excluded.read_at`,
  );

  const reading = (): UsageReading => {
    const row = select.get() as ReadingRow | undefined;
    if (row === undefined) return { fiveHour: null, sevenDay: null, readAt: null, stale: true };
    const at = now();
    const fiveHour = usageWindow(row.five_hour_used, row.five_hour_resets_at);
    const sevenDay = usageWindow(row.seven_day_used, row.seven_day_resets_at);
    // A window that has reset since is back near 0, whatever the reading said.
    const reset = [row.five_hour_resets_at, row.seven_day_resets_at].some((resets) => resets !== null && resets * 1000 <= at);
    return { fiveHour, sevenDay, readAt: row.read_at, stale: reset || at - Date.parse(row.read_at) > USAGE_STALE_MS };
  };

  /** Tells clients once the reading goes stale, as no newer one will. */
  let staleTimer: NodeJS.Timeout | undefined;
  const announce = () => {
    options.broadcast({ type: 'usage.updated', usage: reading() });
    armStale();
  };
  /** Sets the timer that tells clients once the reading goes stale: on each reading, and on a start with one kept. */
  const armStale = () => {
    const usage = reading();
    clearTimeout(staleTimer);
    if (usage.stale || usage.readAt === null) return;
    const row = select.get() as unknown as ReadingRow;
    const resets = [row.five_hour_resets_at, row.seven_day_resets_at].filter((each): each is number => each !== null).map((each) => each * 1000);
    const staleAt = Math.min(Date.parse(usage.readAt) + USAGE_STALE_MS + 1, ...resets);
    staleTimer = setTimeout(announce, Math.max(0, staleAt - now()));
    staleTimer.unref();
  };

  const record = (statusLine: unknown) => {
    const limits = isObject(statusLine) ? statusLine.rate_limits : undefined;
    if (!isObject(limits)) return;
    const five = windowOf(limits.five_hour);
    const seven = windowOf(limits.seven_day);
    if (five === undefined && seven === undefined) return;
    const was = select.get() as ReadingRow | undefined;
    const values = [five?.used ?? null, five?.resetsAt ?? null, seven?.used ?? null, seven?.resetsAt ?? null] as const;
    const same =
      was !== undefined &&
      [was.five_hour_used, was.five_hour_resets_at, was.seven_day_used, was.seven_day_resets_at].every((value, index) => value === values[index]);
    // Status lines run every few seconds: the same reading again is written, and told, at most once a minute.
    if (same && now() - Date.parse(was.read_at) < SAME_READING_MS) return;
    upsert.run(...values, new Date(now()).toISOString());
    announce();
  };

  // A reading kept from before a restart still goes stale in its clients' eyes.
  armStale();

  return {
    record,
    reading,
    handlers: <Context extends BoardConnection>(): RpcHandlers<UsageMethods, Context> => ({ 'usage.get': () => reading() }),
    close: () => clearTimeout(staleTimer),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A status line's `rate_limits` window: its used percentage and when it resets, in epoch seconds. */
function windowOf(value: unknown): { used: number; resetsAt: number | null } | undefined {
  if (!isObject(value)) return undefined;
  const used = value.used_percentage;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined;
  const resetsAt = typeof value.resets_at === 'number' && Number.isFinite(value.resets_at) ? Math.round(value.resets_at) : null;
  return { used: Math.min(used, 100), resetsAt };
}

function usageWindow(used: number | null, resetsAt: number | null): UsageWindow | null {
  if (used === null) return null;
  return { usedPercent: used, remainingPercent: Math.max(0, 100 - used), resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString() };
}
