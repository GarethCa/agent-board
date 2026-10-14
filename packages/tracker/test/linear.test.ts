import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLinearTracker, LINEAR_API_URL, TrackerError, type TrackerIssue } from '../src/index.ts';
import { RECORDED_LINEAR_FIXTURES, replayFetch, serveFixtures, type HttpInteraction } from '../src/testing.ts';
import { CONTRACT_COMMENT, CONTRACT_LINK, MISSING_ISSUE_SUFFIX, MISSING_PROJECT_ID } from './contract-calls.ts';
import { trackerContract } from './contract.ts';

/**
 * Written by scripts/record-linear.ts against the real Linear API. `source` says so; a recording from a stub would
 * prove only that the provider agrees with that stub, so the suite refuses one.
 */
const fixtures = JSON.parse(readFileSync(RECORDED_LINEAR_FIXTURES, 'utf8')) as {
  source: string;
  subject: { scope: string; knownIssue: TrackerIssue; searchTerm: string; project?: string };
  interactions: HttpInteraction[];
};
const { scope, knownIssue, searchTerm, project } = fixtures.subject;

/** A Linear tracker answered from the fixtures, and the headers of every request it sent. */
function replayed(credential = 'lin_api_test') {
  const replay = replayFetch(fixtures.interactions);
  const headers: Headers[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    headers.push(new Headers(init?.headers));
    return replay.fetch(input, init);
  };
  return { tracker: createLinearTracker({ credential, fetch: fetchFn }), headers, replay };
}

/** A tracker whose every request is answered with `body`, as a hand-written Linear response. */
function answering(body: unknown, status = 200) {
  return createLinearTracker({ credential: 'lin_api_x', fetch: async () => Response.json(body, { status }) });
}

trackerContract(`Linear (${fixtures.source})`, () => ({ ...fixtures.subject, tracker: replayed().tracker }));

/** A tracker that answers every request with `body`, and the bodies it was sent. */
function recording(body: unknown) {
  const sent: { query: string; variables: { filter: Record<string, unknown> } }[] = [];
  const tracker = createLinearTracker({
    credential: 'lin_api_x',
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(body);
    },
  });
  return { tracker, sent };
}

describe('the Linear tracker, projects', () => {
  const PROJECT_ID = '7c1d2e3f-0000-4000-8000-00000000000a';
  const node = {
    id: PROJECT_ID,
    name: 'agent-board v1',
    description: null,
    progress: 0.58,
    status: { name: 'In Progress' },
  };

  it('lists the open projects of a team, most recently updated first', async () => {
    const { tracker, sent } = recording({ data: { projects: { nodes: [node] } } });
    expect(await tracker.projects!('ACME')).toEqual([
      { id: PROJECT_ID, name: 'agent-board v1', description: '', state: 'In Progress', progress: 0.58 },
    ]);
    expect(sent[0]?.query).toContain('orderBy: updatedAt');
    expect(sent[0]?.variables.filter).toEqual({
      accessibleTeams: { some: { key: { eq: 'ACME' } } },
      status: { type: { nin: ['completed', 'canceled'] } },
    });
  });

  it('gets a project of the team by ID, finished or not, and nothing for another', async () => {
    const found = recording({ data: { projects: { nodes: [node] } } });
    expect(await found.tracker.getProject!('ACME', PROJECT_ID)).toMatchObject({ id: PROJECT_ID });
    expect(found.sent[0]?.variables.filter).toEqual({
      accessibleTeams: { some: { key: { eq: 'ACME' } } },
      id: { eq: PROJECT_ID },
    });
    const none = recording({ data: { projects: { nodes: [] } } });
    expect(await none.tracker.getProject!('ACME', '7c1d2e3f-0000-4000-8000-00000000000b')).toBeUndefined();
  });

  it('has no project for an ID that is not a UUID, which Linear would reject, without asking', async () => {
    const { tracker, sent } = recording({ data: { projects: { nodes: [node] } } });
    expect(await tracker.getProject!('ACME', 'nope')).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("limits a team's issues to a project, when asked", async () => {
    const list = recording({ data: { issues: { nodes: [] } } });
    await list.tracker.listIssues('ACME', { project: PROJECT_ID });
    expect(list.sent[0]?.variables.filter).toEqual({
      team: { key: { eq: 'ACME' } },
      project: { id: { eq: PROJECT_ID } },
      state: { type: { nin: ['completed', 'canceled'] } },
    });
    const search = recording({ data: { searchIssues: { nodes: [] } } });
    await search.tracker.searchIssues('ACME', 'zone', { project: PROJECT_ID });
    expect(search.sent[0]?.variables.filter).toEqual({ team: { key: { eq: 'ACME' } }, project: { id: { eq: PROJECT_ID } } });
  });

  it("matches a project's teams with `some`, as Linear's TeamCollectionFilter has no fields of its own", async () => {
    const { tracker, sent } = recording({ data: { projects: { nodes: [] } } });
    await tracker.projects!('ACME');
    await tracker.getProject!('ACME', PROJECT_ID);
    for (const { variables } of sent) {
      expect(variables.filter.accessibleTeams).toEqual({ some: { key: { eq: 'ACME' } } });
      expect(variables.filter.accessibleTeams).not.toHaveProperty('key');
    }
  });

  it('asks for no project unless it is given one', async () => {
    const list = recording({ data: { issues: { nodes: [] } } });
    await list.tracker.listIssues('ACME');
    expect(list.sent[0]?.variables.filter).not.toHaveProperty('project');
  });
});

// The recorded calls only cover projects once the recorder has been run against real Linear.
describe.skipIf(project === undefined)('the recorded project calls', () => {
  it('list the open projects and the issues of one, as the provider asks for them', () => {
    const asked = (text: string) => fixtures.interactions.find((i) => JSON.stringify(i.request.body).includes(text));
    expect(asked('projects(filter')).toBeDefined();
    expect(asked('"project":{"id":{"eq":"' + project + '"}}')).toBeDefined();
  });
});

describe('the Linear tracker', () => {
  it('is tested against fixtures recorded from the real Linear API', () => {
    expect(fixtures.source).toMatch(/^recorded from api\.linear\.app on \d{4}-\d{2}-\d{2}$/);
    // A detail only real Linear adds to its refusal, which a hand-written stub is unlikely to imitate.
    const refusal = fixtures.interactions.find((i) => i.response.status === 401);
    expect(refusal?.response.body).toMatchObject({
      errors: [{ extensions: { code: 'AUTHENTICATION_ERROR', userPresentableMessage: expect.any(String) } }],
    });
  });

  it("asks for the team's issues, leaving out closed ones", () => {
    const list = fixtures.interactions.find(
      (i) =>
        JSON.stringify(i.request.body).includes('issues(filter') &&
        !JSON.stringify(i.request.body).includes('"project"'),
    );
    expect(list?.request.body).toMatchObject({
      variables: { filter: { team: { key: { eq: scope } }, state: { type: { nin: ['completed', 'canceled'] } } } },
    });
  });

  it('reads a missing description as empty', async () => {
    const issue = {
      identifier: 'ACME-8',
      title: 'Spawn a Codex agent',
      description: null,
      url: 'https://linear.app/acme/issue/ACME-8',
      state: { name: 'Todo' },
      team: { key: 'ACME' },
    };
    expect(await answering({ data: { issue } }).getIssue('ACME-8')).toMatchObject({ description: '', scope: 'ACME' });
  });

  it("reads an issue's labels, and has none for an issue it can't find", async () => {
    const labels = { nodes: [{ name: 'ready-for-agent' }, { name: 'Bug' }] };
    expect(await answering({ data: { issue: { labels } } }).issueLabels!('ACME-8')).toEqual(['ready-for-agent', 'Bug']);
    const missing = answering({ errors: [{ message: 'Entity not found: Issue' }], data: null });
    expect(await missing.issueLabels!('ACME-404')).toBeUndefined();
  });

  it('sends a personal API key as is, and an OAuth token as a bearer token', async () => {
    const apiKey = replayed('lin_api_abc');
    await apiKey.tracker.scopes();
    expect(apiKey.headers[0]?.get('authorization')).toBe('lin_api_abc');
    const oauth = replayed('oauth-token');
    await oauth.tracker.scopes();
    expect(oauth.headers[0]?.get('authorization')).toBe('Bearer oauth-token');
  });

  it('fails as unauthorized when Linear refuses the credential', async () => {
    // Fixtures match requests without their headers, so the refusal has the same request as `scopes()`: replay it alone.
    const refusal = fixtures.interactions.find((i) => i.response.status !== 200)!;
    const refused = createLinearTracker({ credential: 'lin_api_revoked', fetch: replayFetch([refusal]).fetch });
    await expect(refused.scopes()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('fails as unavailable when Linear cannot be reached or answers garbage', async () => {
    const offline = createLinearTracker({
      credential: 'lin_api_x',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(offline.scopes()).rejects.toEqual(expect.objectContaining({ kind: 'unavailable' }));
    const broken = createLinearTracker({
      credential: 'lin_api_x',
      fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });
    const failure = await broken.scopes().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrackerError);
    expect(failure).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('502') });
  });

  it('fails as rejected on any other GraphQL error', async () => {
    const invalid = answering({ errors: [{ message: 'Argument Validation Error' }], data: null });
    await expect(invalid.scopes()).rejects.toMatchObject({
      kind: 'rejected',
      message: 'Linear: Argument Validation Error',
    });
  });

  it('uses every fixture, and the fixtures keep no request headers', async () => {
    const { tracker, replay } = replayed();
    await tracker.scopes();
    await tracker.listIssues(scope);
    await tracker.searchIssues(scope, searchTerm);
    await tracker.getIssue(knownIssue.id);
    await tracker.getIssue(`${knownIssue.id}${MISSING_ISSUE_SUFFIX}`);
    await tracker.link(knownIssue.id, CONTRACT_LINK);
    await tracker.comment(knownIssue.id, CONTRACT_COMMENT);
    if (project !== undefined) {
      await tracker.projects!(scope);
      await tracker.getProject!(scope, project);
      await tracker.getProject!(scope, MISSING_PROJECT_ID);
      await tracker.listIssues(scope, { project });
      await tracker.searchIssues(scope, searchTerm, { project });
    }
    // Only the refusal is left: the first match for the `scopes()` request always wins.
    expect(replay.unused().map((i) => i.response.status)).not.toContain(200);
    // No headers, so no credential (the recorder also checks the file for the key it used).
    for (const { request } of fixtures.interactions)
      expect(Object.keys(request).sort()).toEqual(['body', 'method', 'url']);
  });
});

it('tests cannot reach the real Linear API', async () => {
  await expect(createLinearTracker({ credential: 'lin_api_x' }).scopes()).rejects.toMatchObject({
    kind: 'unavailable',
    message: expect.stringContaining('recorded HTTP fixtures'),
  });
});

it('serves fixtures over HTTP for processes that only take a URL', async () => {
  const server = await serveFixtures(fixtures.interactions, LINEAR_API_URL);
  try {
    const tracker = createLinearTracker({ credential: 'lin_api_test', apiUrl: server.url });
    expect(await tracker.getIssue(knownIssue.id)).toEqual(knownIssue);
    const unmatched = await fetch(server.url, { method: 'POST', body: '{"query":"nope"}' });
    expect(unmatched.status).toBe(500);
    expect(await unmatched.text()).toContain('no recorded HTTP fixture');
  } finally {
    await server.close();
  }
});
