import { GhError, runGh, type GhOptions } from './gh.ts';
import { listOf, nodesOf, objectOf, parseJson, stringOf } from './shape.ts';
import { shortIssueId } from './providers.ts';
import {
  issueBranchName,
  TrackerError,
  type IssueFilters,
  type IssueListOptions,
  type Tracker,
  type TrackerIssue,
  type TrackerMilestone,
  type TrackerScope,
} from './tracker.ts';

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

/** What gh says when its login lacks the `read:project` scope that GitHub Projects need. */
const NO_PROJECT_SCOPE = /required scopes[\s\S]*read:project/;

/** The most pages of a project's items read for one list: 1,000 items. */
const PROJECT_ITEM_PAGES = 10;

const MILESTONES = 'milestones(first: 100, states: OPEN, orderBy: { field: DUE_DATE, direction: ASC }) { nodes { number title } }';
const QUERIES = {
  /** A repo's open projects (GitHub Projects, which belong to a user or an org) and its open milestones. */
  filters: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { id title closed } }
    ${MILESTONES}
  } }`,
  /** Without projects, for a login that may not read them. */
  milestones: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${MILESTONES} } }`,
  /** A page of a project's items, in board order: its issues from any repo, and its pull requests and drafts. */
  items: `query($project: ID!, $after: String) { node(id: $project) { ... on ProjectV2 {
    items(first: 100, after: $after, orderBy: { field: POSITION, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { content { __typename ... on Issue {
        number title body url state updatedAt milestone { number } repository { nameWithOwner }
      } } }
    }
  } } }`,
} as const;

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
}

/** What a project's item says of an issue, beyond `GhIssue`. */
interface ProjectIssueFields {
  __typename: string;
  updatedAt: string;
  milestone: { number: number } | null;
  repository: { nameWithOwner: string };
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
  const issueList = async (scope: string, state: 'open' | 'all', search: string, wanted?: number, milestone?: string) => {
    const issues = await gh<GhIssue[]>([
      ...['issue', 'list', '--repo', scope, '--state', state, '--limit', limit(wanted)],
      ...(milestone === undefined ? [] : [`--milestone=${milestone}`]),
      ...['--search', search, '--json', ISSUE_FIELDS],
    ]);
    return issues.map(toIssue);
  };
  const graphql = async (query: string, fields: Record<string, string>): Promise<Record<string, unknown>> => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
    return objectOf(objectOf(await gh<unknown>(args), 'the answer', 'GitHub').data, 'the answer', 'GitHub');
  };
  const repoFields = (scope: string) => {
    const [owner, name] = scope.split('/');
    return { owner: owner!, name: name! };
  };
  const milestonesOf = (repository: unknown): TrackerMilestone[] =>
    nodesOf<{ number: number; title: string }>(objectOf(repository, 'the repo', 'GitHub'), 'milestones', 'GitHub').map(
      (milestone) => ({ id: String(milestone.number), name: milestone.title }),
    );
  /** A project's issues in the repo, newest first: open ones, or all those matching every word of `search`. */
  const projectIssues = async (scope: string, only: IssueListOptions, search?: string): Promise<TrackerIssue[]> => {
    const items: { content: (GhIssue & ProjectIssueFields) | null }[] = [];
    // Every page, up to a few: a project shared by many repos, or keeping closed items, has more than one.
    for (let page = 0, after: string | undefined; page < PROJECT_ITEM_PAGES; page++) {
      const data = await graphql(QUERIES.items, { project: only.project!, ...(after === undefined ? {} : { after }) });
      const project = objectOf(data.node, 'the project', 'GitHub');
      items.push(...nodesOf<{ content: (GhIssue & ProjectIssueFields) | null }>(project, 'items', 'GitHub'));
      const { pageInfo } = objectOf(project.items, 'the items', 'GitHub') as { pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
      if (pageInfo?.hasNextPage !== true || typeof pageInfo.endCursor !== 'string') break;
      after = pageInfo.endCursor;
    }
    const words = search?.toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .flatMap(({ content }) => (content?.__typename === 'Issue' ? [content] : []))
      .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === scope.toLowerCase())
      .filter((issue) => only.milestone === undefined || String(issue.milestone?.number) === only.milestone)
      .filter((issue) =>
        words === undefined
          ? issue.state === 'OPEN'
          : words.every((word) => `${issue.title} ${issue.body ?? ''}`.toLowerCase().includes(word)),
      )
      .sort((a, b) => (words === undefined ? b.updatedAt.localeCompare(a.updatedAt) : 0))
      .slice(0, Number(limit(only.limit)))
      .map(toIssue);
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
    async issueFilters(scope): Promise<IssueFilters> {
      let data: Record<string, unknown>;
      try {
        data = await graphql(QUERIES.filters, repoFields(scope));
      } catch (error) {
        if (!(error instanceof GhError && NO_PROJECT_SCOPE.test(error.stderr))) throw error;
        const repository = (await graphql(QUERIES.milestones, repoFields(scope))).repository;
        return { projects: [], milestones: milestonesOf(repository), missing: 'project-scope' };
      }
      // A milestone is the repo's: each project's are the repo's, and narrow its items.
      const milestones = milestonesOf(data.repository);
      const projects = nodesOf<{ id: string; title: string; closed: boolean }>(objectOf(data.repository, 'the repo', 'GitHub'), 'projectsV2', 'GitHub')
        .filter((project) => !project.closed)
        .map((project) => ({ id: project.id, name: project.title, milestones }));
      return { projects, milestones: projects.length === 0 ? milestones : [] };
    },
    listIssues: (scope, options = {}) =>
      options.project === undefined
        ? issueList(scope, 'open', 'sort:updated-desc', options.limit, options.milestone)
        : projectIssues(scope, options),
    searchIssues: (scope, text, options = {}) =>
      options.project === undefined
        ? issueList(scope, 'all', text, options.limit, options.milestone)
        : projectIssues(scope, options, text),
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
