import { findPushedPullRequests, listPullRequests, pullRequestKey, pullRequestOfUrl, viewPullRequest, type GhOptions, type PullRequest } from '@agent-board/tracker';
import type { AgentPullRequests, WatchedAgent } from './pull-requests.ts';
import { pushTargets } from './push-targets.ts';

/** How long a commit's search is trusted when it found no open pull request. */
const SEARCH_RETRY_MS = 10 * 60_000;
/** At most this many of an agent's recorded pull requests are asked about each round, newest first. */
const MAX_RECORDED = 10;

/**
 * Looks up an agent's pull requests: its own branch's, with one gh call; only when it has none, those of the
 * branches it pushed to (`pushTargets`, read from git), else those holding its newest pushed commit, found by GitHub's
 * search. That commit is remembered for the agent (in memory: a new daemon starts again), so its pull request is still
 * found once its branch is deleted and pruned. A search that found no open pull request is trusted for `retryMs`, and
 * one running is shared: an agent with no open pull request costs one search per commit every `retryMs` at most,
 * besides its own branch's call and one per branch it pushed to. Then each pull request it recorded that neither of
 * those found is asked about by its number, one gh call each (at most `MAX_RECORDED`), so its sidebar shows its state.
 * One last seen merged or closed is not asked about again until it is recorded again (a new `recordedAt`). One gh
 * can't read (a lapsed SAML session, no access, a rate limit) keeps what was last seen of it, logged once: it never
 * stops the agent's own pull requests being read.
 */
export function createPullRequestLookup(
  options: GhOptions & { retryMs?: number; now?: () => number; log?: (message: string) => void },
): (agent: WatchedAgent) => Promise<AgentPullRequests> {
  const retryMs = options.retryMs ?? SEARCH_RETRY_MS;
  const now = options.now ?? Date.now;
  /** Each agent's newest pushed commit, as last seen. */
  const pushedCommits = new Map<string, string>();
  /** Searches to trust, by commit: when each started, and what it finds. */
  const searches = new Map<string, { at: number; found: Promise<PullRequest[]> }>();
  const branchLookup = async (agent: WatchedAgent): Promise<AgentPullRequests> => {
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
  /** Each agent's recorded pull requests as last seen, by key and when each was recorded. */
  const recordedSeen = new Map<string, Map<string, PullRequest>>();
  /** Each recorded pull request gh last failed to read, by agent, key and when recorded, with why: logged once. */
  const recordedFailures = new Map<string, string>();
  const askRecorded = async (agent: WatchedAgent, ref: NonNullable<WatchedAgent['recorded']>[number], seen: Map<string, PullRequest>) => {
    const key = pullRequestKey(ref);
    const at = `${key}@${ref.recordedAt}`;
    const last = seen.get(at);
    if (last !== undefined && (last.state === 'merged' || last.state === 'closed')) return last;
    try {
      const pr = await viewPullRequest(ref, { gh: options.gh, env: options.env, cwd: agent.worktree });
      recordedFailures.delete(`${agent.sessionId} ${at}`);
      if (pr === undefined) seen.delete(at);
      else seen.set(at, pr);
      return pr;
    } catch (error) {
      const message = (error as Error).message;
      if (recordedFailures.get(`${agent.sessionId} ${at}`) !== message) {
        options.log?.(`could not read ${key}, recorded by agent ${agent.sessionId}: ${message}`);
        recordedFailures.set(`${agent.sessionId} ${at}`, message);
      }
      return last;
    }
  };
  return async (agent) => {
    const found = await branchLookup(agent);
    const known = new Set([...found.own, ...found.pushed].flatMap((pr) => {
      const ref = pullRequestOfUrl(pr.url);
      return ref === undefined ? [] : [pullRequestKey(ref)];
    }));
    const wanted = (agent.recorded ?? []).filter((ref) => !known.has(pullRequestKey(ref))).slice(-MAX_RECORDED);
    if (wanted.length === 0) {
      recordedSeen.delete(agent.sessionId);
      return found;
    }
    const was = recordedSeen.get(agent.sessionId) ?? new Map<string, PullRequest>();
    // Only what is still wanted is kept: one deleted, re-recorded or found on its branches is forgotten.
    const seen = new Map([...was].filter(([at]) => wanted.some((ref) => at === `${pullRequestKey(ref)}@${ref.recordedAt}`)));
    recordedSeen.set(agent.sessionId, seen);
    const recorded: PullRequest[] = [];
    for (const ref of wanted) {
      const pr = await askRecorded(agent, ref, seen);
      if (pr !== undefined) recorded.push(pr);
    }
    return { ...found, recorded };
  };
}
