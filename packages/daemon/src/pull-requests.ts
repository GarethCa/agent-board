import type { PullRequest, PullRequestRef } from '@agent-board/tracker';

/** What the watcher needs to know of an agent. */
export interface WatchedAgent {
  sessionId: string;
  branch: string;
  worktree: string;
  /** The GitHub repo to look in (`owner/repo`), when its zone has one; else gh infers it from the worktree. */
  repo?: string;
  /** Its session has ended. */
  ended: boolean;
  /** The pull requests it recorded on its sidebar (and the user hasn't deleted), on any branch, with when each was recorded. */
  recorded?: (PullRequestRef & { recordedAt: string })[];
}

/**
 * An agent's pull requests: its own branch's, and, for its tile alone, those of the branches it pushed to;
 * and, for its sidebar, those it recorded that are neither.
 */
export interface AgentPullRequests {
  own: PullRequest[];
  pushed: PullRequest[];
  recorded?: PullRequest[];
}

export interface PullRequestWatcherOptions {
  /** Every agent to watch. */
  agents(): WatchedAgent[];
  /** The agent's pull requests. */
  pullRequests(agent: WatchedAgent): Promise<AgentPullRequests>;
  /** How long it waits after one round of asking before the next; 0 never asks, not even on `refresh`. */
  intervalMs: number;
  /** Whether its first round waits for `start`, so whoever hears `onRead` is there for it; else it starts at once. */
  startLater?: boolean;
  /** The agent's pull requests changed. */
  onChange(sessionId: string): void;
  /**
   * The agent's pull requests were read, changed or not: its own branch's, and whether it was their first read since the
   * watcher started: what is there at the first is no news.
   */
  onRead?(sessionId: string, own: readonly PullRequest[], first: boolean): void;
  log(message: string): void;
}

export interface PullRequestWatcher {
  /** The pull requests made from the agent's branch, as last seen; empty until first seen. */
  get(sessionId: string): PullRequest[];
  /** The pull requests of the branches it pushed to, as last seen: for its tile alone. Empty until first seen. */
  pushed(sessionId: string): PullRequest[];
  /** The pull requests it recorded that are neither its own nor pushed ones, as last seen: for its sidebar. */
  recorded(sessionId: string): PullRequest[];
  /** Whether the agent's pull requests have been read since the watcher started, so `get`'s empty means none. */
  read(sessionId: string): boolean;
  /** Asks for the agent's pull requests now, as when its turn has ended and it may just have opened one. */
  refresh(sessionId: string): Promise<void>;
  /** Starts its rounds, when made with `startLater`; once only. */
  start(): void;
  /** Stops asking. Asking in flight finishes without reporting changes. */
  stop(): void;
}

/** What an agent has before its pull requests are first seen. */
const NONE = JSON.stringify({ own: [], pushed: [] } satisfies AgentPullRequests);

/**
 * Keeps every agent's pull requests, asking for them one agent at a time, one round every `intervalMs`, the first
 * at once. An ended agent is asked until none of its pull requests is open (none at all counts): from then on it
 * is settled, so a board's history doesn't cost a gh call per agent per round. Only memory holds them: a new daemon
 * asks again, once for a settled agent. When asking fails it keeps what it last saw, and logs the failure once until
 * it changes.
 */
export function watchPullRequests(options: PullRequestWatcherOptions): PullRequestWatcher {
  const seen = new Map<string, { pullRequests: AgentPullRequests; json: string }>();
  const failures = new Map<string, string>();
  /** The agents whose pull requests have been read at least once. */
  const read = new Set<string>();
  const settled = new Set<string>();
  /** Each agent's newest ask whose answer was taken: an older one answering later is stale (a round's, across a refresh). */
  const answered = new Map<string, number>();
  let asks = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const ask = async (agent: WatchedAgent) => {
    const ticket = ++asks;
    let pullRequests: AgentPullRequests;
    try {
      pullRequests = await options.pullRequests(agent);
      if ((answered.get(agent.sessionId) ?? 0) > ticket) return;
      answered.set(agent.sessionId, ticket);
      failures.delete(agent.sessionId);
      const first = !read.has(agent.sessionId);
      read.add(agent.sessionId);
      if (!stopped) options.onRead?.(agent.sessionId, pullRequests.own, first);
    } catch (error) {
      const message = (error as Error).message;
      if (failures.get(agent.sessionId) !== message) {
        options.log(`could not list the pull requests of ${agent.branch}: ${message}`);
        failures.set(agent.sessionId, message);
      }
      return;
    }
    const all = [...pullRequests.own, ...pullRequests.pushed, ...(pullRequests.recorded ?? [])];
    if (agent.ended && all.every((pr) => pr.state === 'merged' || pr.state === 'closed')) {
      settled.add(agent.sessionId);
    }
    const json = JSON.stringify(pullRequests);
    if (stopped || (seen.get(agent.sessionId)?.json ?? NONE) === json) return;
    seen.set(agent.sessionId, { pullRequests, json });
    options.onChange(agent.sessionId);
  };

  const round = async () => {
    const agents = options.agents();
    const known = new Set(agents.map((agent) => agent.sessionId));
    for (const sessionId of seen.keys()) if (!known.has(sessionId)) seen.delete(sessionId);
    for (const sessionId of settled) if (!known.has(sessionId)) settled.delete(sessionId);
    for (const sessionId of read) if (!known.has(sessionId)) read.delete(sessionId);
    for (const sessionId of answered.keys()) if (!known.has(sessionId)) answered.delete(sessionId);
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
  let started = false;
  const start = () => {
    if (started || stopped) return;
    started = true;
    if (options.intervalMs > 0) schedule(0);
  };
  if (options.startLater !== true) start();

  return {
    get: (sessionId) => seen.get(sessionId)?.pullRequests.own ?? [],
    pushed: (sessionId) => seen.get(sessionId)?.pullRequests.pushed ?? [],
    recorded: (sessionId) => seen.get(sessionId)?.pullRequests.recorded ?? [],
    read: (sessionId) => read.has(sessionId),
    start,
    async refresh(sessionId) {
      const agent = options.agents().find((a) => a.sessionId === sessionId);
      if (agent !== undefined && started && !stopped && options.intervalMs > 0) await ask(agent);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
