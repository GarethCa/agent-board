import { useEffect, useState } from 'react';
import type { CheckoutState } from '@agent-board/daemon/protocol';

/** How often a tile re-reads its checkout, so the warning goes away once the checkout is clean and back on the default branch. */
const REFRESH_MS = 5_000;

/** What is off about the repo's own checkout for an agent working in it, or undefined when it is clean on the default branch. */
export function checkoutWarning({ branch, defaultBranch, dirty }: CheckoutState): string | undefined {
  const off = branch === null ? 'a detached HEAD' : defaultBranch !== null && branch !== defaultBranch ? branch : undefined;
  const parts = [dirty ? 'has uncommitted changes' : undefined, off === undefined ? undefined : `is on ${off}`];
  const found = parts.filter((part) => part !== undefined);
  return found.length === 0 ? undefined : `main checkout ${found.join(' and ')}`;
}

type Listener = (warning: string | undefined) => void;

/** One watch per repo path, shared by every tile and dialog that asks about it: N orchestrators in a repo cost one read. */
interface Watch {
  listeners: Set<Listener>;
  /** How many listeners want it kept up to date, not just read once. */
  refreshers: number;
  warning: string | undefined;
  /** The one pending re-read, if any: never more than one chain per path. */
  timer: ReturnType<typeof setTimeout> | undefined;
  reading: boolean;
  stopped: boolean;
}

/**
 * Watches repo checkouts through `readState`. `watch(path, refresh, listener)` tells the listener the warning as it
 * changes, reading at once (a read already running is joined) and, while any listener of the path passes `refresh`,
 * again `refreshMs` after each read settles, so reads never overlap. Every listener of a path shares those reads. The
 * returned function stops listening; the last one to go stops the reads.
 */
export function createCheckoutWatcher(readState: (path: string) => Promise<CheckoutState>, refreshMs = REFRESH_MS) {
  const watches = new Map<string, Watch>();

  const schedule = (path: string, watch: Watch) => {
    if (watch.stopped || watch.reading || watch.timer !== undefined || watch.refreshers === 0) return;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      read(path, watch);
    }, refreshMs);
  };

  const read = (path: string, watch: Watch) => {
    if (watch.reading || watch.stopped) return;
    watch.reading = true;
    readState(path)
      .then(checkoutWarning, () => undefined)
      .then((warning) => {
        watch.warning = warning;
        watch.listeners.forEach((listener) => listener(warning));
      })
      .finally(() => {
        watch.reading = false;
        schedule(path, watch);
      });
  };

  return (path: string, refresh: boolean, listener: Listener): (() => void) => {
    let watch = watches.get(path);
    if (watch === undefined) {
      watch = { listeners: new Set(), refreshers: 0, warning: undefined, timer: undefined, reading: false, stopped: false };
      watches.set(path, watch);
    }
    const mine = watch;
    mine.listeners.add(listener);
    if (refresh) mine.refreshers += 1;
    if (mine.warning !== undefined) listener(mine.warning);
    // A pending re-read is soon enough for a listener that keeps watching; one that only looks once wants it afresh.
    if (!refresh || mine.timer === undefined) read(path, mine);
    return () => {
      mine.listeners.delete(listener);
      if (refresh) mine.refreshers -= 1;
      if (mine.refreshers === 0) {
        clearTimeout(mine.timer);
        mine.timer = undefined;
      }
      if (mine.listeners.size === 0) {
        mine.stopped = true;
        watches.delete(path);
      }
    };
  };
}

const watchCheckout = createCheckoutWatcher((path) => window.agentBoard.zones.checkoutState(path));

/**
 * The warning for the checkout of the repo at `path`, or undefined while there is none, it is unknown, or `path` is
 * undefined. Reads once, and keeps reading when `refresh` is set. Only reads: the checkout is never touched.
 */
export function useCheckoutWarning(path: string | undefined, refresh = false): string | undefined {
  const [warning, setWarning] = useState<string>();
  useEffect(() => {
    setWarning(undefined);
    if (path === undefined) return;
    return watchCheckout(path, refresh, setWarning);
  }, [path, refresh]);
  return warning;
}
