// Test doubles: never import these from production code.
export {
  createFakeTracker,
  FAKE_ISSUE_PROJECTS,
  FAKE_ISSUES,
  FAKE_PROJECTS,
  FAKE_SCOPES,
  type FakeTracker,
} from './fake.ts';
export {
  createFakeGitHub,
  FAKE_GH,
  FAKE_GITHUB_STATE,
  type FakeGhCall,
  type FakeGitHub,
  type FakeGitHubIssue,
  type FakeGitHubPullRequest,
  type FakeGitHubState,
} from './fake-github.ts';
export { createMemoryCredentialStore } from './credentials.ts';
export { createTempKeychain } from './keychain-testing.ts';
export { serveFixtures } from './fixture-server.ts';
export { recordingFetch, replayFetch, type HttpInteraction, type ReplayFetch } from './http-fixtures.ts';

/** The Linear fixtures written by scripts/record-linear.ts. Check their `source` for where they came from. */
export const RECORDED_LINEAR_FIXTURES = new URL('../fixtures/linear/recorded.json', import.meta.url);
