import type { PullRequest } from '@agent-board/tracker';

/** What the watcher needs to know of an agent. */
export interface WatchedAgent {
  sessionId: string;
  branch: string;
  worktree: string;
  /** The GitHub repo to look in (`owner/repo`), when its zone has one; else gh infers it from the worktree. */
  repo?: string;
  /** Its session has ended. */
  ended: boolean;
}

export interface PullRequestWatcherOptions {
  /** Every agent to watch. */
  agents(): WatchedAgent[];
  /** The pull requests made from the agent's branch. */
  pullRequests(agent: WatchedAgent): Promise<PullRequest[]>;
  /** How long it waits after one round of asking before the next; 0 never asks, not even on `refresh`. */
  intervalMs: number;
  /** The agent's pull requests changed. */
  onChange(sessionId: string): void;
  log(message: string): void;
}

export interface PullRequestWatcher {
  /** The agent's pull requests as last seen; empty until first seen. */
  get(sessionId: string): PullRequest[];
  /** Whether the agent's pull requests have been read since the watcher started, so `get`'s empty means none. */
  read(sessionId: string): boolean;
  /** Asks for the agent's pull requests now, as when its turn has ended and it may just have opened one. */
  refresh(sessionId: string): Promise<void>;
  /** Stops asking. Asking in flight finishes without reporting changes. */
  stop(): void;
}

/**
 * Keeps every agent's pull requests, asking for them one agent at a time, one round every `intervalMs`, the first
 * at once. An ended agent is asked until none of its pull requests is open (none at all counts): from then on it
 * is settled, so a board's history doesn't cost a gh call per agent per round. Only memory holds them: a new daemon
 * asks again, once for a settled agent. When asking fails it keeps what it last saw, and logs the failure once until
 * it changes.
 */
export function watchPullRequests(options: PullRequestWatcherOptions): PullRequestWatcher {
  const seen = new Map<string, { pullRequests: PullRequest[]; json: string }>();
  const failures = new Map<string, string>();
  /** The agents whose pull requests have been read at least once. */
  const read = new Set<string>();
  const settled = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const ask = async (agent: WatchedAgent) => {
    let pullRequests: PullRequest[];
    try {
      pullRequests = await options.pullRequests(agent);
      failures.delete(agent.sessionId);
      read.add(agent.sessionId);
    } catch (error) {
      const message = (error as Error).message;
      if (failures.get(agent.sessionId) !== message) {
        options.log(`could not list the pull requests of ${agent.branch}: ${message}`);
        failures.set(agent.sessionId, message);
      }
      return;
    }
    if (agent.ended && pullRequests.every((pr) => pr.state === 'merged' || pr.state === 'closed')) {
      settled.add(agent.sessionId);
    }
    const json = JSON.stringify(pullRequests);
    if (stopped || (seen.get(agent.sessionId)?.json ?? '[]') === json) return;
    seen.set(agent.sessionId, { pullRequests, json });
    options.onChange(agent.sessionId);
  };

  const round = async () => {
    const agents = options.agents();
    const known = new Set(agents.map((agent) => agent.sessionId));
    for (const sessionId of seen.keys()) if (!known.has(sessionId)) seen.delete(sessionId);
    for (const sessionId of settled) if (!known.has(sessionId)) settled.delete(sessionId);
    for (const sessionId of read) if (!known.has(sessionId)) read.delete(sessionId);
    for (const agent of agents) {
      if (stopped) return;
      if (!settled.has(agent.sessionId)) await ask(agent);
    }
  };

  const schedule = (delayMs: number) => {
    timer = setTimeout(() => {
      void round().finally(() => {
        if (!stopped) schedule(options.intervalMs);
      });
    }, delayMs);
    timer.unref();
  };
  if (options.intervalMs > 0) schedule(0);

  return {
    get: (sessionId) => seen.get(sessionId)?.pullRequests ?? [],
    read: (sessionId) => read.has(sessionId),
    async refresh(sessionId) {
      const agent = options.agents().find((a) => a.sessionId === sessionId);
      if (agent !== undefined && !stopped && options.intervalMs > 0) await ask(agent);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
