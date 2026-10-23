import { GhError, runGh, type GhOptions } from './gh.ts';
import { listOf, objectOf, parseJson, stringOf } from './shape.ts';
import { shortIssueId } from './providers.ts';
import { issueBranchName, TrackerError, type Tracker, type TrackerIssue, type TrackerScope } from './tracker.ts';

export type GitHubTrackerOptions = GhOptions;

const ISSUE_FIELDS = 'number,title,body,url,state';
/** Repos `scopes()` lists; `getScope` finds any other. */
const REPOS_PATH = 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const REPO = /^[\w.-]+\/[\w.-]+$/;
/** An issue's ID: `owner/repo#34`, GitHub's own way to name an issue in any repo. */
const ISSUE_ID = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
/** What gh says when there is no such repo, issue or pull request. */
const NOT_FOUND = /Could not resolve to (a Repository|a PullRequest|an issue or pull request)/;

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
}

interface GhPullRequest {
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
}

/**
 * GitHub Issues behind the `Tracker` interface, through the user's own `gh` login: agent-board stores no GitHub
 * token. Scopes are repos, keyed `owner/repo`; issue IDs are `owner/repo#34`.
 */
export function createGitHubTracker(options: GitHubTrackerOptions = {}): Tracker {
  const gh = async <T>(args: string[], input?: string): Promise<T> =>
    parseJson(await runGh(args, { ...options, input }), 'GitHub') as T;
  const limit = (wanted = DEFAULT_LIMIT) => String(Math.max(1, Math.min(wanted, MAX_LIMIT)));
  /** A repo's issues: open ones most recently updated first, or all of them matching `search`, best match first. */
  const issueList = async (scope: string, state: 'open' | 'all', search: string, wanted?: number) => {
    const issues = await gh<GhIssue[]>([
      ...['issue', 'list', '--repo', scope, '--state', state, '--limit', limit(wanted)],
      ...['--search', search, '--json', ISSUE_FIELDS],
    ]);
    return issues.map(toIssue);
  };
  /** Undefined when gh says the repo or issue does not exist. */
  const unlessMissing = <T>(error: unknown): T | undefined => {
    if (error instanceof GhError && NOT_FOUND.test(error.stderr)) return undefined;
    throw error;
  };

  const tracker: Tracker = {
    provider: 'github',
    async loggedIn() {
      try {
        await runGh(['api', 'user', '--jq', '.login'], options);
        return true;
      } catch (error) {
        if (error instanceof GhError && error.kind === 'unauthorized') return false;
        throw error;
      }
    },
    async scopes(): Promise<TrackerScope[]> {
      const repos = await gh<{ full_name: string; name: string; description: string | null }[]>(['api', REPOS_PATH]);
      return repos.map((repo) => ({
        key: repo.full_name,
        name: repo.name,
        ...(repo.description ? { description: repo.description } : {}),
      }));
    },
    async getScope(key) {
      if (!REPO.test(key)) return undefined;
      return gh<{ nameWithOwner: string; name: string; description: string | null }>([
        'repo',
        'view',
        key,
        '--json',
        'nameWithOwner,name,description',
      ]).then(
        (repo) => ({ key: repo.nameWithOwner, name: repo.name, ...(repo.description ? { description: repo.description } : {}) }),
        unlessMissing<TrackerScope>,
      );
    },
    listIssues: (scope, { limit } = {}) => issueList(scope, 'open', 'sort:updated-desc', limit),
    searchIssues: (scope, text, { limit } = {}) => issueList(scope, 'all', text, limit),
    async getIssue(id) {
      const ref = parseIssueId(id);
      if (ref === undefined) return undefined;
      const issue = await gh<GhIssue>(['issue', 'view', ref.number, '--repo', ref.repo, '--json', ISSUE_FIELDS]).then(
        toIssue,
        unlessMissing<TrackerIssue>,
      );
      // Pull requests share issues' numbers, and `gh issue view` shows them too.
      return issue?.url.includes('/pull/') ? undefined : issue;
    },
    async issueLabels(id) {
      const ref = parseIssueId(id);
      if (ref === undefined) return undefined;
      const issue = await gh<{ labels: unknown }>(['issue', 'view', ref.number, '--repo', ref.repo, '--json', 'labels']).then(
        (found) => found,
        unlessMissing<{ labels: unknown }>,
      );
      if (issue === undefined) return undefined;
      return listOf(objectOf(issue, 'the issue', 'GitHub').labels, 'labels', 'GitHub').map((label) =>
        stringOf(objectOf(label, 'a label', 'GitHub'), 'name', 'a label name', 'GitHub'),
      );
    },
    async getPullRequest(id) {
      const ref = parseIssueId(id);
      if (ref === undefined) return undefined;
      const pr = await gh<GhPullRequest>(['pr', 'view', ref.number, '--repo', ref.repo, '--json', 'title,url,state,isDraft']).then(
        (found) => found,
        unlessMissing<GhPullRequest>,
      );
      if (pr === undefined) return undefined;
      const fields = objectOf(pr, 'the pull request', 'GitHub');
      for (const key of ['title', 'url', 'state']) stringOf(fields, key, `the pull request ${key}`, 'GitHub');
      const state = pr.state === 'OPEN' ? (pr.isDraft ? 'Draft' : 'Open') : pr.state.charAt(0) + pr.state.slice(1).toLowerCase();
      return { title: pr.title, url: pr.url, state };
    },
    // GitHub issues have no attachments: a link is a comment, which GitHub also shows as a cross-reference.
    link: (id, { url, title }) => tracker.comment(id, `Linked: [${title}](${url})`),
    async comment(id, body) {
      const ref = parseIssueId(id);
      if (ref === undefined) throw new TrackerError('rejected', `${id} is not a GitHub issue ID (owner/repo#number)`);
      await runGh(['issue', 'comment', ref.number, '--repo', ref.repo, '--body-file', '-'], { ...options, input: body });
    },
    // `#34` with the `gh` prefix: `gh-34-short-title`.
    branchName: (issue) => issueBranchName({ ...issue, id: shortIssueId(issue) }, 'gh'),
  };
  return tracker;
}

/** The repo and number of an issue ID (`owner/repo#34`), or undefined if it isn't one. */
function parseIssueId(id: string): { repo: string; number: string } | undefined {
  const ref = ISSUE_ID.exec(id);
  return ref === null ? undefined : { repo: ref[1]!, number: ref[2]! };
}

function toIssue(issue: GhIssue): TrackerIssue {
  // The URL spells the repo as GitHub does (`https://github.com/owner/repo/issues/34`), whatever case it was asked in.
  const [owner, repo] = new URL(issue.url).pathname.split('/').slice(1, 3);
  const scope = `${owner}/${repo}`;
  return {
    provider: 'github',
    id: `${scope}#${issue.number}`,
    scope,
    title: issue.title,
    description: issue.body ?? '',
    url: issue.url,
    state: issue.state.charAt(0) + issue.state.slice(1).toLowerCase(),
  };
}
