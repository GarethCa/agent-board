import { GhError, runGh, type GhOptions } from './gh.ts';
import type { PullRequestRef } from './pull-request-ref.ts';

/** A pull request's state, as a tile shows it. */
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/** What a pull request's checks (CI) add up to: `none` when it has none. */
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none';

/** A GitHub pull request made from an agent's branch. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  checks: ChecksState;
}

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  statusCheckRollup: Record<string, unknown>[] | null;
}

/** At most this many pull requests per `gh pr list`. */
const MAX_PULL_REQUESTS = 20;

/** What gh says when there is no such repo or pull request; not a network failure's "could not resolve host". */
const NO_SUCH_PULL_REQUEST = /GraphQL: Could not resolve to (a Repository|a PullRequest|an issue or pull request)/;

/** What gh says in a repo none of whose remotes is on GitHub. */
const NOT_ON_GITHUB = /no git remotes found|none of the git remotes configured/i;

/** Where gh is asked about pull requests: in `repo` (`owner/repo`), or else the GitHub repo of the git repo at `cwd`. */
type PullRequestOptions = GhOptions & { cwd: string; repo?: string };

/**
 * The pull requests, open or not, whose head is `branch`, newest first, through the user's own `gh` login: in `repo`
 * (`owner/repo`), or else in the GitHub repo gh infers from the remotes of the git repo at `cwd`. None in a repo with
 * no GitHub remote. Failures are `TrackerError`s.
 */
export function listPullRequests(branch: string, options: PullRequestOptions): Promise<PullRequest[]> {
  return pullRequestList(['--head', branch], options);
}

/**
 * Pull request `ref` as gh sees it now, through the user's own `gh` login; undefined for one GitHub doesn't have (or
 * won't show). Other failures are `TrackerError`s.
 */
export async function viewPullRequest(ref: PullRequestRef, options: GhOptions & { cwd?: string }): Promise<PullRequest | undefined> {
  let found: GhPullRequest;
  try {
    found = JSON.parse(
      await runGh(['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'number,title,url,state,isDraft,statusCheckRollup'], options),
    ) as GhPullRequest;
  } catch (error) {
    if (error instanceof GhError && NO_SUCH_PULL_REQUEST.test(error.stderr)) return undefined;
    throw error;
  }
  return { number: found.number, title: found.title, url: found.url, state: pullRequestState(found), checks: checksState(found.statusCheckRollup ?? []) };
}

/** At most this many branches an agent pushed to are asked about. */
const MAX_PUSHED_TO = 5;

/** A commit id as git writes it: SHA-1, or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The pull requests an agent's work went into on branches other than its own: those of the branches it
 * pushed to (`pushedTo`, its upstream first, the first `MAX_PUSHED_TO`, each asked about once); failing any, those
 * holding `commit`, found by GitHub's search (which still finds them once their branch is deleted). At most
 * `MAX_PUSHED_TO + 1` gh calls; none with neither. A `commit` that isn't a full commit id is never searched for.
 * Otherwise as `listPullRequests`.
 */
export async function findPushedPullRequests(
  where: { pushedTo: readonly string[]; commit?: string },
  options: PullRequestOptions,
): Promise<PullRequest[]> {
  const found = new Map<number, PullRequest>();
  for (const head of [...new Set(where.pushedTo)].slice(0, MAX_PUSHED_TO)) {
    for (const pr of await listPullRequests(head, options)) found.set(pr.number, pr);
  }
  if (found.size > 0 || where.commit === undefined || !COMMIT_ID.test(where.commit)) return [...found.values()];
  return pullRequestList(['--search', where.commit], options);
}

/** `gh pr list` of every state, narrowed by `filter`, newest first. */
async function pullRequestList(filter: string[], options: PullRequestOptions): Promise<PullRequest[]> {
  let found: GhPullRequest[];
  try {
    const args = [
      ...['pr', 'list', ...(options.repo === undefined ? [] : ['--repo', options.repo]), ...filter],
      ...['--state', 'all', '--limit', String(MAX_PULL_REQUESTS)],
    ];
    found = JSON.parse(
      await runGh([...args, '--json', 'number,title,url,state,isDraft,statusCheckRollup'], options),
    ) as GhPullRequest[];
  } catch (error) {
    if (error instanceof GhError && NOT_ON_GITHUB.test(error.stderr)) return [];
    throw error;
  }
  return found.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pullRequestState(pr),
    checks: checksState(pr.statusCheckRollup ?? []),
  }));
}

/** A pull request's state as gh gives it, with a draft told apart. */
export function pullRequestState(pr: { state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean }): PullRequestState {
  return pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : pr.state === 'MERGED' ? 'merged' : 'closed';
}

/**
 * Squash-merges pull request `number` through the user's own `gh` login, in `repo` or else the one gh infers from the
 * remotes at `cwd`, deleting nothing. With `headCommit`, only while the pull request's head is that commit, so nothing
 * pushed since is merged. Failures, such as one that isn't open, can't be merged yet or has moved on, are
 * `TrackerError`s.
 */
export async function mergePullRequest(number: number, options: GhOptions & { cwd: string; repo?: string; headCommit?: string }): Promise<void> {
  await runGh(
    [
      'pr',
      'merge',
      String(number),
      ...(options.repo === undefined ? [] : ['--repo', options.repo]),
      '--squash',
      ...(options.headCommit === undefined ? [] : ['--match-head-commit', options.headCommit]),
    ],
    options,
  );
}

/**
 * Opens a pull request of `head`, a branch already pushed, into the repo's default branch through the user's own `gh`
 * login, in `repo` or else the one gh infers from the remotes at `cwd`; resolves with its URL. The description goes on
 * stdin, never on the command line; with `draft`, it opens as a draft. Failures, such as one already open for the branch, are
 * `TrackerError`s.
 */
export async function createPullRequest(
  options: GhOptions & { cwd: string; repo?: string; head: string; title: string; body: string; draft?: boolean },
): Promise<string> {
  const out = await runGh(
    [
      'pr',
      'create',
      ...(options.repo === undefined ? [] : ['--repo', options.repo]),
      '--head',
      options.head,
      '--title',
      options.title,
      '--body-file',
      '-',
      ...(options.draft === true ? ['--draft'] : []),
    ],
    { ...options, input: options.body },
  );
  return out.trim().split('\n').at(-1) ?? '';
}

/** Deletes the branch from the GitHub repo (`owner/repo`) through the user's own `gh` login. Failures are `TrackerError`s. */
export async function deleteRemoteBranch(repo: string, branch: string, options: GhOptions & { cwd?: string } = {}): Promise<void> {
  await runGh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`], options);
}

/** Conclusions of a finished check run that fail it, as GitHub's own rollup counts them. */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * Adds up a pull request's `statusCheckRollup` (check runs and commit statuses): failing once any failed, else
 * pending while any is unfinished, else passing.
 */
export function checksState(rollup: readonly Record<string, unknown>[]): ChecksState {
  if (rollup.length === 0) return 'none';
  let pending = false;
  for (const check of rollup) {
    if (check.__typename === 'StatusContext') {
      if (check.state === 'FAILURE' || check.state === 'ERROR') return 'failing';
      if (check.state === 'PENDING' || check.state === 'EXPECTED') pending = true;
    } else if (check.status !== 'COMPLETED') {
      pending = true;
    } else if (FAILED_CONCLUSIONS.has(String(check.conclusion))) {
      return 'failing';
    }
  }
  return pending ? 'pending' : 'passing';
}
