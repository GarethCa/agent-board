/** How long a looked-up folder is reused: many windows asking about the same session cost one `lsof`. */
const CWD_MAX_AGE_MS = 750;

export interface CwdLookup {
  /** The session's process's working directory: the last answer if it is fresh, else a lookup that others share. */
  (sessionId: string, pid: number): Promise<string | undefined>;
  /** Drops what it knows of the session. */
  forget(sessionId: string): void;
}

/** Wraps `find` (`processCwd`) so that lookups for one session arriving together, or soon after one another, share one. */
export function createCwdLookup(options: { find(pid: number): Promise<string | undefined>; maxAgeMs?: number; now?(): number }): CwdLookup {
  const { find, maxAgeMs = CWD_MAX_AGE_MS, now = Date.now } = options;
  const known = new Map<string, { cwd: string; at: number }>();
  const pending = new Map<string, Promise<string | undefined>>();
  const lookup = ((sessionId, pid) => {
    const last = known.get(sessionId);
    if (last !== undefined && now() - last.at < maxAgeMs) return Promise.resolve(last.cwd);
    let inflight = pending.get(sessionId);
    if (inflight === undefined) {
      inflight = find(pid)
        .then((cwd) => {
          if (cwd !== undefined) known.set(sessionId, { cwd, at: now() });
          return cwd;
        })
        .finally(() => pending.delete(sessionId));
      pending.set(sessionId, inflight);
    }
    return inflight;
  }) as CwdLookup;
  lookup.forget = (sessionId) => {
    known.delete(sessionId);
    pending.delete(sessionId);
  };
  return lookup;
}
