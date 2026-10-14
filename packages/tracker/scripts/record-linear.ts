// Records the Linear provider's HTTP fixtures (fixtures/linear/recorded.json) from a real Linear workspace. Run by
// hand, never in CI:
//
//   env LINEAR_API_KEY=lin_api_… pnpm --filter @agent-board/tracker record:linear
//
// It creates a scratch issue in team $LINEAR_TEAM (ACME by default; in its most recently updated open project), runs
// every call the tests replay against it, deletes it, writes the fixtures, prints their diff and runs the tracker tests
// on them. The key is never written: fixtures keep no request headers. The lists a workspace answers are cut to the
// scratch issue, the team and the project, and its slug is redacted from URLs (sanitise-linear.ts): still read the diff
// before committing. $LINEAR_API_URL points it at another endpoint, such as a stub, for testing the script itself.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recordingFetch, type HttpInteraction } from '../src/http-fixtures.ts';
import { createLinearTracker, LINEAR_API_URL } from '../src/linear.ts';
import { sanitiseRecording } from './sanitise-linear.ts';
import { CONTRACT_COMMENT, CONTRACT_LINK, MISSING_ISSUE_SUFFIX, MISSING_PROJECT_ID } from '../test/contract-calls.ts';

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error('Set LINEAR_API_KEY to a Linear personal API key (Settings → Security & access).');
  process.exit(1);
}
const scope = process.env.LINEAR_TEAM || 'ACME';
const apiUrl = process.env.LINEAR_API_URL || LINEAR_API_URL;
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const out = fileURLToPath(new URL('../fixtures/linear/recorded.json', import.meta.url));

/** A GraphQL call that is not recorded: setting up and cleaning up the scratch issue. */
async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey! },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length || body.data === undefined) {
    throw new Error(`Linear: ${body.errors?.map((e) => e.message).join('; ') ?? response.status}`);
  }
  return body.data;
}

const teams = await graphql<{ teams: { nodes: { id: string }[] } }>(
  'query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }',
  { key: scope },
);
const teamId = teams.teams.nodes[0]?.id;
if (teamId === undefined) throw new Error(`the key cannot see a team ${scope}`);

// The scratch issue goes in the team's most recently updated open project, so the project calls have something to find.
const projects = await createLinearTracker({ credential: apiKey, apiUrl }).projects!(scope);
const project = projects[0];
if (project === undefined) throw new Error(`team ${scope} has no open project: make one for the recording to use`);

// A word only the scratch issue has, so the recorded search finds exactly it.
const searchTerm = `abfixture${randomBytes(4).toString('hex')}`;
const created = await graphql<{ issueCreate: { issue: { id: string; identifier: string } } }>(
  `
    mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue {
          id
          identifier
        }
      }
    }
  `,
  {
    input: {
      teamId,
      title: `agent-board fixture recording ${searchTerm}`,
      projectId: project.id,
      description: `Scratch issue made by packages/tracker/scripts/record-linear.ts (${searchTerm}). It deletes it when done; delete it by hand if it is still here.`,
    },
  },
);
const scratch = created.issueCreate.issue;
console.log(`created scratch issue ${scratch.identifier}`);

try {
  // Search is indexed asynchronously: wait until it finds the new issue, unrecorded, before recording it.
  const probe = createLinearTracker({ credential: apiKey, apiUrl });
  for (let waited = 0; !(await probe.searchIssues(scope, searchTerm)).some((i) => i.id === scratch.identifier);) {
    if (waited >= 60_000) throw new Error(`search did not find ${scratch.identifier} within a minute`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    waited += 2_000;
  }

  const interactions: HttpInteraction[] = [];
  const fetchFn = recordingFetch(fetch, (interaction) => interactions.push(interaction));
  const tracker = createLinearTracker({ credential: apiKey, apiUrl, fetch: fetchFn });

  await tracker.scopes();
  const open = await tracker.listIssues(scope);
  if (!open.some((issue) => issue.id === scratch.identifier)) throw new Error(`${scratch.identifier} is not listed`);
  await tracker.searchIssues(scope, searchTerm);
  await tracker.projects!(scope);
  if ((await tracker.getProject!(scope, project.id))?.id !== project.id)
    throw new Error(`${project.name} is not found`);
  if ((await tracker.getProject!(scope, MISSING_PROJECT_ID)) !== undefined)
    throw new Error('a missing project was found');
  const inProject = await tracker.listIssues(scope, { project: project.id });
  if (!inProject.some((issue) => issue.id === scratch.identifier))
    throw new Error(`${scratch.identifier} is not in ${project.name}`);
  await tracker.searchIssues(scope, searchTerm, { project: project.id });
  const knownIssue = await tracker.getIssue(scratch.identifier);
  if (knownIssue === undefined) throw new Error(`${scratch.identifier} is not found`);
  await tracker.getIssue(`${scratch.identifier}${MISSING_ISSUE_SUFFIX}`);
  await tracker.link(scratch.identifier, CONTRACT_LINK);
  await tracker.comment(scratch.identifier, CONTRACT_COMMENT);
  await createLinearTracker({ credential: 'lin_api_revoked', apiUrl, fetch: fetchFn })
    .scopes()
    .catch(() => {});

  // Fixtures always name the real API, whatever endpoint was recorded.
  for (const { request } of interactions) request.url = LINEAR_API_URL;
  const source =
    apiUrl === LINEAR_API_URL
      ? `recorded from api.linear.app on ${new Date().toISOString().slice(0, 10)}`
      : `synthetic: recorded from ${apiUrl}, not Linear; re-record with LINEAR_API_KEY set`;
  // Only the scratch issue, team and project stay of what the workspace answered; nothing else of it is committed.
  const fixture = sanitiseRecording({
    source,
    subject: { scope, knownIssue, searchTerm, project: project.id },
    interactions,
  });
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  if (json.includes(apiKey)) throw new Error('the fixtures would hold the API key: not writing them');
  writeFileSync(out, json);
  console.log(`wrote ${interactions.length} interactions to ${out} (${source})`);
} finally {
  await graphql('mutation Delete($id: String!) { issueDelete(id: $id) { success } }', { id: scratch.id }).then(
    () => console.log(`deleted scratch issue ${scratch.identifier}`),
    (error: Error) => console.error(`could not delete ${scratch.identifier}, delete it by hand: ${error.message}`),
  );
}

execFileSync('git', ['--no-pager', 'diff', '--stat', '--', out], { cwd: repoRoot, stdio: 'inherit' });
execFileSync('git', ['--no-pager', 'diff', '--', out], { cwd: repoRoot, stdio: 'inherit' });
console.log('\nreplaying the new fixtures through the tracker tests:');
execFileSync('pnpm', ['vitest', 'run', 'packages/tracker'], { cwd: repoRoot, stdio: 'inherit' });
