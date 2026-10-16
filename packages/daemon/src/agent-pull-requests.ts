import { findPushedPullRequests, listPullRequests, type GhOptions, type PullRequest } from '@agent-board/tracker';
import type { AgentPullRequests, WatchedAgent } from './pull-requests.ts';
import { pushTargets } from './push-targets.ts';

/** How long a commit's search is trusted when it found no open pull request. */
const SEARCH_RETRY_MS = 10 * 60_000;

/**
 * Looks up an agent's pull requests: its own branch's, with one gh call; only when it has none, those of the
 * branches it pushed to (`pushTargets`, read from git), else those holding its newest pushed commit, found by GitHub's
 * search. That commit is remembered for the agent (in memory: a new daemon starts again), so its pull request is still
 * found once its branch is deleted and pruned. A search that found no open pull request is trusted for `retryMs`, and
 * one running is shared: an agent with no open pull request costs one search per commit every `retryMs` at most,
 * besides its own branch's call and one per branch it pushed to.
 */
export function createPullRequestLookup(
  options: GhOptions & { retryMs?: number; now?: () => number },
): (agent: WatchedAgent) => Promise<AgentPullRequests> {
  const retryMs = options.retryMs ?? SEARCH_RETRY_MS;
  const now = options.now ?? Date.now;
  /** Each agent's newest pushed commit, as last seen. */
  const pushedCommits = new Map<string, string>();
  /** Searches to trust, by commit: when each started, and what it finds. */
  const searches = new Map<string, { at: number; found: Promise<PullRequest[]> }>();
  return async (agent) => {
    const where = { gh: options.gh, env: options.env, cwd: agent.worktree, repo: agent.repo };
    const own = await listPullRequests(agent.branch, where);
    if (own.length > 0) return { own, pushed: [] };
    const targets = await pushTargets(agent.worktree, agent.branch);
    if (targets.commit !== undefined) pushedCommits.set(agent.sessionId, targets.commit);
    const viaBranches = await findPushedPullRequests({ pushedTo: targets.pushedTo.filter((head) => head !== agent.branch) }, where);
    const commit = pushedCommits.get(agent.sessionId);
    if (viaBranches.length > 0 || commit === undefined) return { own, pushed: viaBranches };
    for (const [sha, { at }] of searches) if (now() - at >= retryMs) searches.delete(sha);
    let search = searches.get(commit);
    if (search === undefined) {
      search = { at: now(), found: findPushedPullRequests({ pushedTo: [], commit }, where) };
      searches.set(commit, search);
    }
    const ran = search;
    const forget = () => {
      if (searches.get(commit) === ran) searches.delete(commit);
    };
    try {
      const pushed = await ran.found;
      // An open one may yet change: asked about again next round.
      if (pushed.some((pr) => pr.state === 'open' || pr.state === 'draft')) forget();
      return { own, pushed };
    } catch (error) {
      forget();
      throw error;
    }
  };
}
