import {
  issueBranchName,
  TrackerError,
  type Tracker,
  type TrackerIssue,
  type TrackerProject,
  type TrackerScope,
} from './tracker.ts';
import { nodesOf, objectOf, stringOf } from './shape.ts';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

/** Linear's own page size cap. */
const MAX_PAGE = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const SOURCE = 'Linear';

export interface LinearTrackerOptions {
  /** A personal API key (`lin_api_…`) or an OAuth access token. */
  credential: string;
  /** Where Linear's GraphQL API is: `LINEAR_API_URL` by default. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

const ISSUE_FIELDS = 'identifier title description url state { name } team { key } project { id }';

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
    const data = await request<unknown>(QUERIES.projects, {
      // accessibleTeams is a collection filter: it takes `some` (or `every`) of the teams, not a team's fields.
      filter: { accessibleTeams: { some: { key: { eq: scope } } }, ...filter },
      first: MAX_PAGE,
    });
    return nodesOf(data, 'projects', SOURCE).map(toProject);
  };

  return {
    provider: 'linear',
    async scopes(): Promise<TrackerScope[]> {
      const data = await request<unknown>(QUERIES.teams);
      return nodesOf(data, 'teams', SOURCE).map((team) => {
        const fields = objectOf(team, 'a team', SOURCE);
        return { key: stringOf(fields, 'key', 'a team key', SOURCE), name: stringOf(fields, 'name', 'a team name', SOURCE) };
      });
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
      const data = await request<unknown>(QUERIES.issues, { filter, first: page(limit) });
      return nodesOf(data, 'issues', SOURCE).map(toIssue);
    },
    async searchIssues(scope, text, { limit, project } = {}) {
      const data = await request<unknown>(QUERIES.search, {
        term: text,
        filter: teamFilter(scope, project),
        first: page(limit),
      });
      return nodesOf(data, 'searchIssues', SOURCE).map(toIssue);
    },
    async getIssue(id) {
      try {
        return toIssue(objectOf(await request<unknown>(QUERIES.issue, { id }), 'the issue', SOURCE).issue);
      } catch (error) {
        if (error instanceof LinearGraphQlError && error.notFound) return undefined;
        throw error;
      }
    },
    async issueLabels(id) {
      try {
        const data = objectOf(await request<unknown>(QUERIES.labels, { id }), 'the issue', SOURCE);
        const labels = nodesOf(objectOf(data.issue, 'the issue', SOURCE), 'labels', SOURCE);
        return labels.map((label) => stringOf(objectOf(label, 'a label', SOURCE), 'name', 'a label name', SOURCE));
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

function toProject(node: unknown): TrackerProject {
  const project = objectOf(node, 'a project', SOURCE);
  return {
    id: stringOf(project, 'id', 'a project id', SOURCE),
    name: stringOf(project, 'name', 'a project name', SOURCE),
    description: typeof project.description === 'string' ? project.description : '',
    state: stringOf(objectOf(project.status, 'a project status', SOURCE), 'name', 'a project status', SOURCE),
    progress: typeof project.progress === 'number' ? project.progress : 0,
  };
}

function toIssue(node: unknown): TrackerIssue {
  const issue = objectOf(node, 'an issue', SOURCE);
  const project = issue.project == null ? undefined : objectOf(issue.project, 'an issue project', SOURCE);
  return {
    provider: 'linear',
    id: stringOf(issue, 'identifier', 'an issue identifier', SOURCE),
    scope: stringOf(objectOf(issue.team, 'an issue team', SOURCE), 'key', 'an issue team', SOURCE),
    title: stringOf(issue, 'title', 'an issue title', SOURCE),
    description: typeof issue.description === 'string' ? issue.description : '',
    url: stringOf(issue, 'url', 'an issue url', SOURCE),
    state: stringOf(objectOf(issue.state, 'an issue state', SOURCE), 'name', 'an issue state', SOURCE),
    ...(project === undefined ? {} : { project: stringOf(project, 'id', 'an issue project', SOURCE) }),
  };
}
