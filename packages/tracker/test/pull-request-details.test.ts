import { describe, expect, it, onTestFinished } from 'vitest';
import { allowedActions, approvePullRequest, isGitHubRepo, pullRequestDetails, pullRequestOfUrl } from '../src/index.ts';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest, type FakeGitHubState } from '../src/testing.ts';

const pr = (fields: Partial<FakeGitHubPullRequest> = {}): FakeGitHubPullRequest => ({
  repo: 'acme/app',
  number: 41,
  title: 'Fix the login redirect',
  headRefName: 'gh-34-fix-the-login-redirect',
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [],
  ...fields,
});

const fakeWith = (state: Partial<FakeGitHubState>) => {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, ...state });
  onTestFinished(github.dispose);
  return github;
};

describe('pullRequestOfUrl', () => {
  it("reads a pull request's repo and number from its GitHub URL", () => {
    expect(pullRequestOfUrl('https://github.com/acme/app/pull/41')).toEqual({ repo: 'acme/app', number: 41 });
    expect(pullRequestOfUrl('https://github.com/acme/app.js/pull/7/files')).toEqual({ repo: 'acme/app.js', number: 7 });
  });

  it('is undefined for anything else', () => {
    expect(pullRequestOfUrl('https://github.com/acme/app/issues/41')).toBeUndefined();
    expect(pullRequestOfUrl('http://github.com/acme/app/pull/41')).toBeUndefined();
    expect(pullRequestOfUrl('https://example.com/acme/app/pull/41')).toBeUndefined();
    expect(pullRequestOfUrl('')).toBeUndefined();
  });
});

describe('allowedActions', () => {
  const open = { state: 'OPEN', isDraft: false, author: 'hubot', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', squashMergeAllowed: true } as const;

  it('allows merging an open, mergeable pull request to someone who can write to the repo', () => {
    expect(allowedActions({ ...open, viewer: 'octocat', permission: 'WRITE' }).merge).toEqual({ allowed: true });
    expect(allowedActions({ ...open, mergeStateStatus: 'UNSTABLE', viewer: 'octocat', permission: 'ADMIN' }).merge).toEqual({ allowed: true });
  });

  it("says why it can't be merged", () => {
    const reason = (fields: Partial<Parameters<typeof allowedActions>[0]>) => allowedActions({ ...open, viewer: 'octocat', permission: 'WRITE', ...fields }).merge;
    expect(reason({ state: 'MERGED' })).toEqual({ allowed: false, why: 'It is merged.' });
    expect(reason({ isDraft: true })).toEqual({ allowed: false, why: 'It is a draft.' });
    expect(reason({ permission: 'READ' })).toEqual({ allowed: false, why: "You can't merge in this repo." });
    expect(reason({ squashMergeAllowed: false })).toEqual({ allowed: false, why: "This repo doesn't allow squash merges." });
    expect(reason({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toEqual({ allowed: false, why: 'It has conflicts with its base.' });
    expect(reason({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).toEqual({ allowed: false, why: 'GitHub is still checking whether it can be merged.' });
    expect(reason({ mergeStateStatus: 'BLOCKED' })).toEqual({ allowed: false, why: 'GitHub blocks merging it until its required reviews and checks pass.' });
    expect(reason({ mergeStateStatus: 'BEHIND' })).toEqual({ allowed: false, why: 'Its branch is behind its base.' });
  });

  it("allows approving an open pull request that isn't the viewer's own", () => {
    expect(allowedActions({ ...open, viewer: 'octocat', permission: 'READ' }).approve).toEqual({ allowed: true });
    expect(allowedActions({ ...open, author: 'octocat', viewer: 'octocat', permission: 'ADMIN' }).approve).toEqual({ allowed: false, why: "You can't approve your own pull request." });
    expect(allowedActions({ ...open, isDraft: true, viewer: 'octocat', permission: 'ADMIN' }).approve).toEqual({ allowed: false, why: 'It is a draft.' });
    expect(allowedActions({ ...open, state: 'CLOSED', viewer: 'octocat', permission: 'ADMIN' }).approve).toEqual({ allowed: false, why: 'It is closed.' });
  });
});

describe('pullRequestDetails', () => {
  it('reads the description, checks, files with their diffs, reviews and comments, and what the viewer may do', async () => {
    const github = fakeWith({
      pullRequests: [
        pr({
          body: 'Sends users **home** after login.',
          author: 'hubot',
          headRefOid: 'b'.repeat(40),
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/runs/1' },
            { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
            { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', targetUrl: 'https://ci.example.com/2' },
          ],
          files: [
            { filename: 'src/login.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same' },
            { filename: 'src/new-name.ts', previous_filename: 'src/old-name.ts', status: 'renamed', additions: 0, deletions: 0 },
          ],
          reviews: [{ author: 'monalisa', state: 'CHANGES_REQUESTED', body: 'Needs a test.', submittedAt: '2026-10-01T10:00:00Z' }],
          comments: [{ author: 'monalisa', body: 'Looks close.', createdAt: '2026-10-01T09:00:00Z' }],
          reviewComments: [{ id: 9, author: 'monalisa', path: 'src/login.ts', line: 2, body: 'Why here?', createdAt: '2026-10-01T10:00:00Z' }],
        }),
      ],
    });

    const details = await pullRequestDetails({ repo: 'acme/app', number: 41 }, { gh: github.gh });

    expect(details).toMatchObject({
      repo: 'acme/app',
      number: 41,
      title: 'Fix the login redirect',
      body: 'Sends users **home** after login.',
      url: 'https://github.com/acme/app/pull/41',
      state: 'open',
      author: 'hubot',
      headRefName: 'gh-34-fix-the-login-redirect',
      baseRefName: 'main',
      headCommit: 'b'.repeat(40),
      checksState: 'failing',
      checks: [
        { name: 'test', state: 'passing', url: 'https://github.com/acme/app/actions/runs/1' },
        { name: 'lint', state: 'pending' },
        { name: 'ci/legacy', state: 'failing', url: 'https://ci.example.com/2' },
      ],
      files: [
        { path: 'src/login.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same' },
        { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 0, deletions: 0 },
      ],
      filesShown: 2,
      changedFiles: 2,
      reviews: [{ author: 'monalisa', state: 'CHANGES_REQUESTED', body: 'Needs a test.', at: '2026-10-01T10:00:00Z' }],
      comments: [
        { author: 'monalisa', body: 'Looks close.', at: '2026-10-01T09:00:00Z' },
        { author: 'monalisa', body: 'Why here?', at: '2026-10-01T10:00:00Z', path: 'src/login.ts', line: 2 },
      ],
      merge: { allowed: true },
      approve: { allowed: true },
    });
    expect(details.files[1]).not.toHaveProperty('patch');
    // Every call about it names its repo, so none depends on where it runs.
    for (const call of github.calls()) if (call.args.join(' ') !== 'api user') expect(call.args.join(' ')).toContain('acme/app');
  });

  it("leaves out a file's diff when it is too large to show", async () => {
    const huge = `@@ -1 +1 @@\n${'+x\n'.repeat(200_000)}`;
    const github = fakeWith({ pullRequests: [pr({ files: [{ filename: 'big.txt', status: 'modified', additions: 200_000, deletions: 0, patch: huge }] })] });

    const [file] = (await pullRequestDetails({ repo: 'acme/app', number: 41 }, { gh: github.gh })).files;

    expect(file).toMatchObject({ path: 'big.txt', patchTooLarge: true });
    expect(file).not.toHaveProperty('patch');
  });

  it('fails as GitHub does for a pull request that does not exist', async () => {
    const github = fakeWith({ pullRequests: [] });
    await expect(pullRequestDetails({ repo: 'acme/app', number: 41 }, { gh: github.gh })).rejects.toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('Could not resolve'),
    });
  });

  it("says GitHub's rate limit was reached, and when to try again", async () => {
    const github = fakeWith({ pullRequests: [pr()], rateLimited: true });
    await expect(pullRequestDetails({ repo: 'acme/app', number: 41 }, { gh: github.gh })).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringMatching(/rate limit/i),
    });
  });
});

describe('approvePullRequest', () => {
  const head = 'b'.repeat(40);

  it('approves the pull request as the gh user, at the commit shown', async () => {
    const github = fakeWith({ pullRequests: [pr({ author: 'hubot', headRefOid: head })] });

    await approvePullRequest({ repo: 'acme/app', number: 41 }, head, { gh: github.gh });

    expect(github.calls().at(-1)?.args).toEqual(['api', 'repos/acme/app/pulls/41/reviews', '-X', 'POST', '-f', 'event=APPROVE', '-f', `commit_id=${head}`]);
    const details = await pullRequestDetails({ repo: 'acme/app', number: 41 }, { gh: github.gh });
    expect(details.reviews).toMatchObject([{ author: 'octocat', state: 'APPROVED' }]);
  });

  it('refuses once its head has moved on from the commit shown, approving nothing', async () => {
    const github = fakeWith({ pullRequests: [pr({ author: 'hubot', headRefOid: 'c'.repeat(40) })] });

    await expect(approvePullRequest({ repo: 'acme/app', number: 41 }, head, { gh: github.gh })).rejects.toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('has moved on to ccccccc since bbbbbbb'),
    });
    expect(github.calls().some((call) => call.args.includes('POST'))).toBe(false);
  });

  it("fails as GitHub does for the viewer's own pull request", async () => {
    const github = fakeWith({ pullRequests: [pr({ author: 'octocat', headRefOid: head })] });
    await expect(approvePullRequest({ repo: 'acme/app', number: 41 }, head, { gh: github.gh })).rejects.toMatchObject({
      message: expect.stringContaining('Can not approve your own pull request'),
    });
  });
});

describe('isGitHubRepo', () => {
  it('is an owner/repo, never a step up or a flag', () => {
    expect(['acme/app', 'acme/app.js', 'acme/.github', 'a-b/c_d'].map(isGitHubRepo)).toEqual([true, true, true, true]);
    expect(['../..', 'a/..', './.', 'a/.', '-x/y', 'a_b/c', 'acme', 'acme/app --web', 'a/b/c'].map(isGitHubRepo)).toEqual(Array(9).fill(false));
  });
});
