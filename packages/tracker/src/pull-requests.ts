import { GhError, runGh, type GhOptions } from './gh.ts';

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

/** At most this many pull requests per branch. */
const MAX_PULL_REQUESTS = 20;

/** What gh says in a repo none of whose remotes is on GitHub. */
const NOT_ON_GITHUB = /no git remotes found|none of the git remotes configured/i;

/**
 * The pull requests, open or not, whose head is `branch`, newest first, through the user's own `gh` login: in `repo`
 * (`owner/repo`), or else in the GitHub repo gh infers from the remotes of the git repo at `cwd`. None in a repo with
 * no GitHub remote. Failures are `TrackerError`s.
 */
export async function listPullRequests(
  branch: string,
  options: GhOptions & { cwd: string; repo?: string },
): Promise<PullRequest[]> {
  let found: GhPullRequest[];
  try {
    const args = [
      ...['pr', 'list', ...(options.repo === undefined ? [] : ['--repo', options.repo]), '--head', branch],
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
