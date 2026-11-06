import { useEffect, useState } from 'react';
import { startSinceClock } from '../../../shared/needs-you';

/** The time now, re-rendering every second while `ticking`, for countdowns. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * The time now, for a line that says how long ago `at` was (`sinceText`): it moves only when that line would read
 * differently, at each whole minute since `at`, so a tile showing one re-renders once a minute, not every second.
 * Not `useMinute`, whose shared clock turns over on the wall clock's minute: "1 min ago" would then show up to a minute
 * late or early, as `at` falls anywhere within a minute.
 */
export function useNowForSince(at: string): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => startSinceClock(at, setNow), [at]);
  return now;
}
