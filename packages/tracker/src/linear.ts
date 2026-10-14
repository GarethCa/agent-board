import {
  issueBranchName,
  TrackerError,
  type Tracker,
  type TrackerIssue,
  type TrackerProject,
  type TrackerScope,
} from './tracker.ts';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

/** Linear's own page size cap. */
const MAX_PAGE = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;

export interface LinearTrackerOptions {
  /** A personal API key (`lin_api_…`) or an OAuth access token. */
  credential: string;
  /** Where Linear's GraphQL API is: `LINEAR_API_URL` by default. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

const ISSUE_FIELDS = 'identifier title description url state { name } team { key }';

const PROJECT_FIELDS = 'id name description progress status { name }';

const QUERIES = {
  teams: 'query Teams { teams(first: 250) { nodes { key name } } }',
  projects: `query Projects($filter: ProjectFilter, $first: Int) {
    projects(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${PROJECT_FIELDS} } }
  }`,
  issues: `query Issues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
  }`,
  search: `query SearchIssues($term: String!, $filter: IssueFilter, $first: Int) {
    searchIssues(term: $term, filter: $filter, first: $first) { nodes { ${ISSUE_FIELDS} } }
  }`,
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  labels: 'query IssueLabels($id: String!) { issue(id: $id) { labels { nodes { name } } } }',
  link: `mutation LinkUrl($issueId: String!, $url: String!, $title: String) {
    attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
  }`,
  comment: `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
} as const;

interface LinearIssue {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { name: string };
  team: { key: string };
}

interface LinearProject {
  id: string;
  name: string;
  description: string | null;
  progress: number;
  status: { name: string };
}

interface GraphQlError {
  message: string;
  extensions?: { code?: string; type?: string };
}

/** Linear behind the `Tracker` interface, over its GraphQL API. Scopes are teams, keyed by team key (`ACME`). */
export function createLinearTracker(options: LinearTrackerOptions): Tracker {
  const apiUrl = options.apiUrl ?? LINEAR_API_URL;
  const fetchFn = options.fetch ?? fetch;
  // Personal API keys go bare; OAuth access tokens as a bearer token.
  const authorization = options.credential.startsWith('lin_api_') ? options.credential : `Bearer ${options.credential}`;

  const request = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetchFn(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new TrackerError('unavailable', `could not reach Linear: ${(error as Error).message}`, { cause: error });
    }
    const body = (await response.json().catch(() => undefined)) as
      { data?: T | null; errors?: GraphQlError[] } | undefined;
    const errors = body?.errors ?? [];
    if (response.status === 401 || errors.some((e) => e.extensions?.code === 'AUTHENTICATION_ERROR')) {
      throw new TrackerError('unauthorized', 'Linear refused the API key');
    }
    if (errors.length > 0) throw new LinearGraphQlError(errors);
    if (!response.ok || body?.data == null) {
      throw new TrackerError('unavailable', `Linear answered ${response.status} ${response.statusText}`.trim());
    }
    return body.data;
  };

  const page = (limit = DEFAULT_LIMIT) => Math.max(1, Math.min(limit, MAX_PAGE));
  const teamFilter = (scope: string, project?: string) => ({
    team: { key: { eq: scope } },
    ...(project === undefined ? {} : { project: { id: { eq: project } } }),
  });
  const projectsOf = async (scope: string, filter: Record<string, unknown>) => {
    const data = await request<{ projects: { nodes: LinearProject[] } }>(QUERIES.projects, {
      // accessibleTeams is a collection filter: it takes `some` (or `every`) of the teams, not a team's fields.
      filter: { accessibleTeams: { some: { key: { eq: scope } } }, ...filter },
      first: MAX_PAGE,
    });
    return data.projects.nodes.map(toProject);
  };

  return {
    provider: 'linear',
    async scopes(): Promise<TrackerScope[]> {
      const data = await request<{ teams: { nodes: TrackerScope[] } }>(QUERIES.teams);
      return data.teams.nodes.map(({ key, name }) => ({ key, name }));
    },
    async getScope(key) {
      // Teams are few: one page of them holds every team.
      return (await this.scopes()).find((team) => team.key === key);
    },
    projects: (scope) => projectsOf(scope, { status: { type: { nin: ['completed', 'canceled'] } } }),
    async getProject(scope, id) {
      // Linear answers an ID that is not a UUID with an invalid-argument error, not an empty list.
      if (!UUID.test(id)) return undefined;
      return (await projectsOf(scope, { id: { eq: id } }))[0];
    },
    async listIssues(scope, { limit, project } = {}) {
      const filter = { ...teamFilter(scope, project), state: { type: { nin: ['completed', 'canceled'] } } };
      const data = await request<{ issues: { nodes: LinearIssue[] } }>(QUERIES.issues, { filter, first: page(limit) });
      return data.issues.nodes.map(toIssue);
    },
    async searchIssues(scope, text, { limit, project } = {}) {
      const data = await request<{ searchIssues: { nodes: LinearIssue[] } }>(QUERIES.search, {
        term: text,
        filter: teamFilter(scope, project),
        first: page(limit),
      });
      return data.searchIssues.nodes.map(toIssue);
    },
    async getIssue(id) {
      try {
        return toIssue((await request<{ issue: LinearIssue }>(QUERIES.issue, { id })).issue);
      } catch (error) {
        if (error instanceof LinearGraphQlError && error.notFound) return undefined;
        throw error;
      }
    },
    async issueLabels(id) {
      try {
        const { issue } = await request<{ issue: { labels: { nodes: { name: string }[] } } }>(QUERIES.labels, { id });
        return issue.labels.nodes.map((label) => label.name);
      } catch (error) {
        if (error instanceof LinearGraphQlError && error.notFound) return undefined;
        throw error;
      }
    },
    async link(id, { url, title }) {
      await mutate(request<{ attachmentLinkURL: { success: boolean } }>(QUERIES.link, { issueId: id, url, title }));
    },
    async comment(id, body) {
      await mutate(request<{ commentCreate: { success: boolean } }>(QUERIES.comment, { input: { issueId: id, body } }));
    },
    branchName: (issue) => issueBranchName(issue),
  };
}

/** A GraphQL-level failure: the request reached Linear and was refused. */
class LinearGraphQlError extends TrackerError {
  /** Linear has no entity with the requested ID. */
  readonly notFound: boolean;

  constructor(errors: GraphQlError[]) {
    super('rejected', `Linear: ${errors.map((e) => e.message).join('; ')}`);
    this.notFound = errors.every((e) => /entity not found/i.test(e.message));
  }
}

async function mutate(result: Promise<Record<string, { success: boolean }>>): Promise<void> {
  const payload = Object.values(await result)[0];
  if (payload?.success !== true) throw new TrackerError('rejected', 'Linear did not apply the change');
}

function toProject(project: LinearProject): TrackerProject {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? '',
    state: project.status.name,
    progress: project.progress,
  };
}

function toIssue(issue: LinearIssue): TrackerIssue {
  return {
    provider: 'linear',
    id: issue.identifier,
    scope: issue.team.key,
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    state: issue.state.name,
  };
}
