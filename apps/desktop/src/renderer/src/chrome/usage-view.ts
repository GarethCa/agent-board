// The toolbar's usage pill: what it shows of the newest plan usage reading. Pure, so the wording is unit-tested.
import { USAGE_STALE_MS, type UsageReading, type UsageWindow } from '@agent-board/daemon/protocol';
import { shortWhen } from '../when';

/** At this much of either window the pill draws attention to itself. */
const HOT_PERCENT = 80;

export interface UsageMeterWindow {
  /** `5h`, `7d`. */
  short: string;
  /** `5-hour window`. */
  label: string;
  used: number;
  left: number;
  /** `resets 14:00`, or empty when the reading didn't say. */
  resets: string;
}

export interface UsageMeter {
  windows: UsageMeterWindow[];
  stale: boolean;
  hot: boolean;
  /** How old the reading is, as the hover detail's last line says it. */
  fresh: string;
}

/** Minutes, or hours and minutes, in words: `1 min`, `2 h 5 min`. */
function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What the pill shows of `reading` at `now`; nothing before any reading, as there is nothing to show. */
export function usageMeter(reading: UsageReading, now: number, when: (iso: string) => string = shortWhen): UsageMeter | undefined {
  if (reading.readAt === null) return undefined;
  const windows: UsageMeterWindow[] = [];
  const add = (short: string, label: string, window: UsageWindow | null) => {
    if (window === null) return;
    windows.push({
      short,
      label,
      used: Math.round(window.usedPercent),
      left: Math.round(window.remainingPercent),
      resets: window.resetsAt === null ? '' : `resets ${when(window.resetsAt)}`,
    });
  };
  add('5h', '5-hour window', reading.fiveHour);
  add('7d', '7-day window', reading.sevenDay);
  const old = now - Date.parse(reading.readAt);
  const ago = age(old);
  // Stale by the daemon's word, or by the clock, should no word come.
  const stale = reading.stale || old > USAGE_STALE_MS;
  return {
    windows,
    stale,
    hot: !stale && windows.some((window) => window.used >= HOT_PERCENT),
    fresh: stale ? `Stale: last read ${ago} ago. Updates when an agent runs.` : `Read ${ago} ago`,
  };
}
