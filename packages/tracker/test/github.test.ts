import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { GhError, runGh } from '../src/gh.ts';
import { createGitHubTracker, type TrackerIssue } from '../src/index.ts';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubState } from '../src/testing.ts';
import { CONTRACT_COMMENT, CONTRACT_LINK } from './contract-calls.ts';
import { trackerContract } from './contract.ts';

const LOGIN_ISSUE: TrackerIssue = {
  provider: 'github',
  id: 'acme/app#34',
  scope: 'acme/app',
  title: 'Fix the login redirect',
  description: 'Users land on a blank page after signing in with the keychain.',
  url: 'https://github.com/acme/app/issues/34',
  state: 'Open',
};

/** A GitHub tracker on a fake `gh` with `state`, and the fake. */
function fakeGitHub(state: FakeGitHubState = FAKE_GITHUB_STATE) {
  const github = createFakeGitHub(state);
  onTestFinished(github.dispose);
  return { github, tracker: createGitHubTracker({ gh: github.gh }) };
}

trackerContract('GitHub (fake gh)', () => ({
  tracker: fakeGitHub().tracker,
  scope: 'acme/app',
  knownIssue: LOGIN_ISSUE,
  searchTerm: 'keychain',
  branchPrefix: 'gh-34',
}));

describe('the GitHub tracker, projects and milestones', () => {
  const ROADMAP = { id: 'PVT_fakeRoadmap', name: 'Roadmap' };
  const MILESTONES = [
    { id: '1', name: 'v1.0' },
    { id: '2', name: 'v1.1' },
  ];

  it("lists the repo's open GitHub Projects, each with the repo's milestones under it", async () => {
    const { tracker } = fakeGitHub();
    expect(await tracker.issueFilters!('acme/app')).toEqual({
      projects: [{ ...ROADMAP, milestones: MILESTONES }],
      milestones: [],
    });
    // A repo in no project has its milestones on their own.
    expect(await tracker.issueFilters!('acme/ops')).toEqual({ projects: [], milestones: [] });
  });

  it("falls back to the repo's milestones, and says why, when gh's login may not read projects", async () => {
    const { tracker } = fakeGitHub({ ...FAKE_GITHUB_STATE, projectScope: false });
    expect(await tracker.issueFilters!('acme/app')).toEqual({
      projects: [],
      milestones: MILESTONES,
      missing: 'project-scope',
    });
    // Listing by milestone needs no project scope.
    expect((await tracker.listIssues('acme/app', { milestone: '1' })).map((issue) => issue.id)).toEqual(['acme/app#12']);
  });

  it("lists a project's open issues in this repo only, newest first, and narrows them to a milestone", async () => {
    const { tracker, github } = fakeGitHub();
    const listed = await tracker.listIssues('acme/app', { project: ROADMAP.id });
    expect(listed.map((issue) => issue.id)).toEqual(['acme/app#34', 'acme/app#12']);
    expect(listed[0]).toEqual(LOGIN_ISSUE);
    const inMilestone = await tracker.listIssues('acme/app', { project: ROADMAP.id, milestone: '1' });
    expect(inMilestone.map((issue) => issue.id)).toEqual(['acme/app#12']);
    expect(await tracker.listIssues('acme/app', { project: ROADMAP.id, milestone: '2' })).toEqual([]);
    const call = github.calls().find((c) => c.args.includes('graphql'));
    expect(call?.args.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
  });

  it("reads every page of a project's items", async () => {
    const { tracker, github } = fakeGitHub({ ...FAKE_GITHUB_STATE, projectPageSize: 1 });
    const listed = await tracker.listIssues('acme/app', { project: ROADMAP.id });
    expect(listed.map((issue) => issue.id)).toEqual(['acme/app#34', 'acme/app#12']);
    const pages = github.calls().filter((c) => c.args.includes('graphql'));
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[1]?.args).toContain('after=1');
  });

  it("searches a project's issues in this repo, closed ones too", async () => {
    const { tracker } = fakeGitHub();
    expect((await tracker.searchIssues('acme/app', 'push', { project: ROADMAP.id })).map((i) => i.id)).toEqual(['acme/app#3']);
    expect(await tracker.searchIssues('acme/app', 'deploy', { project: ROADMAP.id })).toEqual([]);
  });

  it("lists and searches a repo's issues by milestone, outside any project", async () => {
    const { tracker } = fakeGitHub();
    expect((await tracker.listIssues('acme/app', { milestone: '1' })).map((issue) => issue.id)).toEqual(['acme/app#12']);
    expect(await tracker.searchIssues('acme/app', 'login', { milestone: '1' })).toEqual([]);
  });
});

describe('the GitHub tracker', () => {
  it("lists a repo's open issues, newest first, and names repos by owner/repo", async () => {
    const { tracker } = fakeGitHub();
    expect((await tracker.listIssues('acme/app')).map((issue) => issue.id)).toEqual(['acme/app#34', 'acme/app#12']);
    expect(await tracker.listIssues('acme/app', { limit: 1 })).toEqual([LOGIN_ISSUE]);
    expect(await tracker.scopes()).toEqual([
      { key: 'acme/app', name: 'app', description: 'The app' },
      { key: 'acme/ops', name: 'ops' },
    ]);
  });

  it('searches closed issues too, and reads an empty body as an empty description', async () => {
    const { tracker } = fakeGitHub();
    expect(await tracker.searchIssues('acme/app', 'CI')).toEqual([
      expect.objectContaining({ id: 'acme/app#3', state: 'Closed' }),
    ]);
    expect(await tracker.getIssue('acme/app#12')).toMatchObject({ description: '' });
  });

  it('spells a repo as GitHub does, whatever case it was asked in', async () => {
    const { tracker } = fakeGitHub();
    expect(await tracker.getScope('Acme/App')).toEqual({ key: 'acme/app', name: 'app', description: 'The app' });
    expect(await tracker.getIssue('ACME/app#34')).toEqual(LOGIN_ISSUE);
  });

  it("reads an issue's labels, and has none for an unknown issue", async () => {
    const { tracker } = fakeGitHub({
      ...FAKE_GITHUB_STATE,
      issues: FAKE_GITHUB_STATE.issues.map((issue) => (issue.number === 34 ? { ...issue, labels: ['bug', 'ready'] } : issue)),
    });
    expect(await tracker.issueLabels!('acme/app#34')).toEqual(['bug', 'ready']);
    expect(await tracker.issueLabels!('acme/app#12')).toEqual([]);
    expect(await tracker.issueLabels!('acme/app#99')).toBeUndefined();
    expect(await tracker.issueLabels!('ACME-12')).toBeUndefined();
  });

  it('has no issue for a pull request, a malformed ID or an unknown repo', async () => {
    const { tracker } = fakeGitHub({
      ...FAKE_GITHUB_STATE,
      pullRequests: [
        {
          repo: 'acme/app',
          number: 35,
          title: 'Fix the redirect',
          headRefName: 'gh-34-fix',
          state: 'OPEN',
          isDraft: false,
          statusCheckRollup: [],
        },
      ],
    });
    expect(await tracker.getIssue('acme/app#35')).toBeUndefined();
    expect(await tracker.getIssue('ACME-12')).toBeUndefined();
    expect(await tracker.getIssue('acme/nope#1')).toBeUndefined();
  });

  it('names branches gh-<number>-<title>', () => {
    const { tracker } = fakeGitHub();
    expect(tracker.branchName(LOGIN_ISSUE)).toBe('gh-34-fix-the-login-redirect');
  });

  it('comments through gh with the body on stdin, and links by commenting', async () => {
    const { tracker, github } = fakeGitHub();
    await tracker.comment(LOGIN_ISSUE.id, CONTRACT_COMMENT);
    await tracker.link(LOGIN_ISSUE.id, CONTRACT_LINK);
    const writes = github.calls().filter((call) => call.args[1] === 'comment');
    expect(writes.map((call) => [call.args.slice(0, 5), call.stdin])).toEqual([
      [['issue', 'comment', '34', '--repo', 'acme/app'], CONTRACT_COMMENT],
      [['issue', 'comment', '34', '--repo', 'acme/app'], `Linked: [${CONTRACT_LINK.title}](${CONTRACT_LINK.url})`],
    ]);
  });

  it('refuses to comment on an issue that does not exist', async () => {
    const { tracker } = fakeGitHub();
    await expect(tracker.comment('acme/app#999', 'hi')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(tracker.listIssues('acme/nope')).rejects.toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining("Could not resolve to a Repository with the name 'acme/nope'"),
    });
  });

  it("knows whether gh is logged in from gh's own user, without listing repos", async () => {
    const { tracker, github } = fakeGitHub();
    expect(await tracker.loggedIn?.()).toBe(true);
    expect(github.calls().map((call) => call.args.join(' '))).toEqual(['api user --jq .login']);
    github.setState({ ...FAKE_GITHUB_STATE, loggedIn: false });
    expect(await tracker.loggedIn?.()).toBe(false);
    await expect(createGitHubTracker({ gh: '/nonexistent/gh' }).loggedIn?.()).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('fails as unauthorized when gh is not logged in', async () => {
    const { tracker } = fakeGitHub({ ...FAKE_GITHUB_STATE, loggedIn: false });
    await expect(tracker.scopes()).rejects.toMatchObject({
      kind: 'unauthorized',
      message: expect.stringContaining('gh auth login'),
    });
  });

  it('fails as unavailable when gh is not installed', async () => {
    const tracker = createGitHubTracker({ gh: '/nonexistent/gh' });
    await expect(tracker.scopes()).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('GitHub CLI'),
    });
  });
});

it('tests cannot run the real gh', async () => {
  await expect(createGitHubTracker().scopes()).rejects.toMatchObject({
    message: expect.stringContaining('refused to run the real gh'),
  });
  // Tripped on purpose: clear the hit, or the guard fails this file.
  const hits = process.env.AGENT_BOARD_GH_GUARD_HITS!;
  expect(readFileSync(hits, 'utf8')).toBe('gh api user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member\n');
  writeFileSync(hits, '');
});

// The assertion holds with or without the fix: what fails without it is Vitest's check for unhandled errors, which
// fails the run on the EPIPE.
it('settles when gh exits without reading its input, rather than failing on the broken pipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-exits-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\necho "unknown command" >&2\nexit 1\n', { mode: 0o755 });
  // Far more than a pipe holds, so writing it outlives gh and hits the closed pipe.
  const input = 'x'.repeat(4 * 1024 * 1024);

  await expect(runGh(['api', 'graphql', '--input', '-'], { gh, input })).rejects.toBeInstanceOf(GhError);
});
