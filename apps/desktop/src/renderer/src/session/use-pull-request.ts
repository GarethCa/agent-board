import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestActed, PullRequestDetails, PullRequestRef } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';

/** Why a PR tab would read its pull request again. */
type RefreshReason = 'shown' | 'focus' | 'manual';

/** The least time between two reads its tab showing or the app being focused asks for: GitHub's rate limit is shared. */
export const REFRESH_GAP_MS = 15_000;

/**
 * A PR tab's calls to the daemon (BI1), each numbered as it starts: how many are under way, the newest approve
 * or merge, the newest whose answer is shown, and when the last one ended, whether it worked or not.
 */
export interface Runs {
  next: number;
  running: number;
  newestAction: number;
  shown: number;
  lastAt: number | undefined;
}

export const NO_RUNS: Runs = { next: 1, running: 0, newestAction: 0, shown: 0, lastAt: undefined };

/** Starts a read or an action (an approve or merge), numbering it. */
export function startRun(runs: Runs, kind: 'read' | 'action'): { runs: Runs; id: number } {
  const id = runs.next;
  return { id, runs: { ...runs, next: id + 1, running: runs.running + 1, newestAction: kind === 'action' ? id : runs.newestAction } };
}

/**
 * Ends run `id` at `now`. Its answer is taken unless one started later was already, or an action started after it: a
 * read under way as a merge starts would otherwise put back the pull request as it was before.
 */
export function settleRun(runs: Runs, id: number, now: number): { runs: Runs; take: boolean } {
  const take = id >= runs.newestAction && id > runs.shown;
  return { take, runs: { ...runs, running: runs.running - 1, shown: take ? id : runs.shown, lastAt: now } };
}

/**
 * Whether a PR tab reads its pull request now: never while a call is under way; at once when asked by hand or first
 * shown; else, as it shows again or the app is focused, once `REFRESH_GAP_MS` has passed since the last call ended,
 * even one that failed (a rate limit most of all). Never on a timer.
 */
export function refreshDue(reason: RefreshReason, runs: Runs, now: number): boolean {
  if (runs.running > 0) return false;
  if (reason === 'manual' || runs.lastAt === undefined) return true;
  return now - runs.lastAt >= REFRESH_GAP_MS;
}

/**
 * The pull request as shown once an approve or merge is done, and what to say: as it is now, or, when it couldn't be
 * read again, as it was with nothing more to do until it is read (the action happened, so it may no longer be allowed).
 */
export function afterAction(before: PullRequestDetails, acted: PullRequestActed, done: string): { details: PullRequestDetails; error?: string } {
  if ('details' in acted) return { details: acted.details };
  const stale = { allowed: false as const, why: 'Refresh to see it as it is now.' };
  return { details: { ...before, merge: stale, approve: stale }, error: `${done}, but could not read it again: ${acted.readError}` };
}

export interface PullRequestRead {
  details: PullRequestDetails | undefined;
  /** Why the last read or action failed, until the next succeeds. */
  error: string | undefined;
  /** A read or action is under way. */
  busy: boolean;
  /** When it was last read. */
  readAt: number | undefined;
  refresh(): void;
  /** Approves or merges it at the commit shown. */
  act(action: 'approve' | 'merge'): void;
}

/**
 * A pull request for its PR tab, read through the daemon: as the tab shows and as the app is focused while it shows,
 * and by hand. A tab that never shows never reads it.
 */
export function usePullRequest(ref: PullRequestRef, visible: boolean): PullRequestRead {
  const [details, setDetails] = useState<PullRequestDetails>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState<number>();
  const runs = useRef(NO_RUNS);
  const shown = useRef<PullRequestDetails>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { repo, number } = ref;

  /** Runs a call, showing what it answers unless a later one has meanwhile, or an action started after it. */
  const run = useCallback(async (kind: 'read' | 'action', call: () => Promise<{ details: PullRequestDetails; error?: string }>) => {
    const started = startRun(runs.current, kind);
    runs.current = started.runs;
    setBusy(true);
    let outcome: { details?: PullRequestDetails; error?: string };
    try {
      outcome = await call();
    } catch (failure) {
      outcome = { error: errorMessage(failure) };
    }
    const settled = settleRun(runs.current, started.id, Date.now());
    runs.current = settled.runs;
    if (!alive.current) return;
    setBusy(settled.runs.running > 0);
    if (!settled.take) return;
    if (outcome.details !== undefined) {
      shown.current = outcome.details;
      setDetails(outcome.details);
      setReadAt(settled.runs.lastAt);
    }
    setError(outcome.error);
  }, []);
  const read = useCallback(
    (reason: RefreshReason) => {
      if (refreshDue(reason, runs.current, Date.now())) void run('read', async () => ({ details: await window.agentBoard.pullRequests.details({ repo, number }) }));
    },
    [run, repo, number],
  );

  useEffect(() => {
    if (!visible) return;
    read('shown');
    const onFocus = () => read('focus');
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visible, read]);

  const act = (action: 'approve' | 'merge') => {
    const before = shown.current;
    if (before === undefined) return;
    const ref = { repo, number };
    // A merge past the gate was confirmed in the dialog, which said so for the pull request as shown.
    const call = () =>
      action === 'approve'
        ? window.agentBoard.pullRequests.approve(ref, before.headCommit)
        : window.agentBoard.pullRequests.merge(ref, before.headCommit, before.gateBlocked !== undefined);
    void run('action', async () => afterAction(before, await call(), action === 'approve' ? 'Approved' : 'Merged'));
  };

  return { details, error, busy, readAt, refresh: () => read('manual'), act };
}
