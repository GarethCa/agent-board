import { useSyncExternalStore } from 'react';

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** The clock to the minute, as a number so a read is stable between ticks. */
const minute = () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

/** One timer for every subscriber, running only while there is one. */
function subscribe(onTick: () => void): () => void {
  listeners.add(onTick);
  timer ??= setInterval(() => listeners.forEach((listener) => listener()), 15_000);
  return () => {
    listeners.delete(onTick);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The time now, to the minute, drawn again as it moves on (unlike `useNow`, which ticks each second for countdowns): a stamp of "Today" turns to "Yesterday" at midnight without a redraw from anything else. */
export function useMinute(): Date {
  return new Date(useSyncExternalStore(subscribe, minute));
}
