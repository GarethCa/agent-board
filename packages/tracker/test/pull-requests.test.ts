import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { checksState, listPullRequests, mergePullRequest } from '../src/index.ts';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '../src/testing.ts';

const checkRun = (status: string, conclusion = '') => ({ __typename: 'CheckRun', name: 'check', status, conclusion });
const statusContext = (state: string) => ({ __typename: 'StatusContext', context: 'ci/legacy', state });

const pr = (fields: Partial<FakeGitHubPullRequest> & Pick<FakeGitHubPullRequest, 'number'>): FakeGitHubPullRequest => ({
  repo: 'acme/app',
  title: `PR ${fields.number}`,
  headRefName: 'gh-34-fix-the-login-redirect',
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [],
  ...fields,
});

describe('checksState', () => {
  it('is none without checks, and passing when every check passed or was skipped', () => {
    expect(checksState([])).toBe('none');
    expect(checksState([checkRun('COMPLETED', 'SUCCESS'), checkRun('COMPLETED', 'SKIPPED'), statusContext('SUCCESS')])).toBe(
      'passing',
    );
  });

  it('is pending while a check runs or a status is expected', () => {
    expect(checksState([checkRun('COMPLETED', 'SUCCESS'), checkRun('IN_PROGRESS')])).toBe('pending');
    expect(checksState([checkRun('QUEUED')])).toBe('pending');
    expect(checksState([statusContext('PENDING')])).toBe('pending');
  });

  it('is failing once any check failed, even with others still running', () => {
    expect(checksState([checkRun('COMPLETED', 'FAILURE'), checkRun('IN_PROGRESS')])).toBe('failing');
    expect(checksState([checkRun('COMPLETED', 'TIMED_OUT')])).toBe('failing');
    expect(checksState([checkRun('COMPLETED', 'CANCELLED')])).toBe('failing');
    expect(checksState([statusContext('ERROR')])).toBe('failing');
  });
});

/** A git repo whose remotes are `remotes` (name → URL), removed when the test ends. */
function repoWithRemotes(remotes: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-pr-repo-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-C', dir, 'init', '--quiet']);
  for (const [name, url] of Object.entries(remotes)) execFileSync('git', ['-C', dir, 'remote', 'add', name, url]);
  return dir;
}

describe('listPullRequests', () => {
  const branch = 'gh-34-fix-the-login-redirect';
  const fakeWith = (pullRequests: FakeGitHubPullRequest[]) => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests });
    onTestFinished(github.dispose);
    return github;
  };

  it("lists the branch's pull requests in the given repo, with their state and checks", async () => {
    const github = fakeWith([
      pr({ number: 41, isDraft: true, statusCheckRollup: [checkRun('IN_PROGRESS')] }),
      pr({ number: 40, state: 'CLOSED', statusCheckRollup: [checkRun('COMPLETED', 'FAILURE')] }),
      pr({ number: 39, state: 'MERGED', statusCheckRollup: [checkRun('COMPLETED', 'SUCCESS')] }),
      pr({ number: 38, headRefName: 'someone-else' }),
      pr({ number: 7, repo: 'acme/ops' }),
    ]);

    const found = await listPullRequests(branch, { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' });

    expect(found).toEqual([
      { number: 41, title: 'PR 41', url: 'https://github.com/acme/app/pull/41', state: 'draft', checks: 'pending' },
      { number: 40, title: 'PR 40', url: 'https://github.com/acme/app/pull/40', state: 'closed', checks: 'failing' },
      { number: 39, title: 'PR 39', url: 'https://github.com/acme/app/pull/39', state: 'merged', checks: 'passing' },
    ]);
    const [call] = github.calls();
    expect(call?.args.slice(0, 8)).toEqual(['pr', 'list', '--repo', 'acme/app', '--head', branch, '--state', 'all']);
  });

  it("without a repo, asks in the repo gh infers from the directory's GitHub remotes, upstream first", async () => {
    const github = fakeWith([pr({ number: 41 }), pr({ number: 7, repo: 'acme/ops' })]);
    const fork = repoWithRemotes({
      origin: 'https://github.com/me/ops.git',
      upstream: 'git@github.com:acme/ops.git',
    });
    expect((await listPullRequests(branch, { gh: github.gh, cwd: fork })).map((p) => p.number)).toEqual([7]);
    const plain = repoWithRemotes({ origin: 'https://github.com/acme/app' });
    expect((await listPullRequests(branch, { gh: github.gh, cwd: plain })).map((p) => p.number)).toEqual([41]);
  });

  it('finds none in a repo with no GitHub remote', async () => {
    const github = fakeWith([pr({ number: 41 })]);
    expect(await listPullRequests(branch, { gh: github.gh, cwd: repoWithRemotes({}) })).toEqual([]);
    const gitlab = repoWithRemotes({ origin: 'https://gitlab.com/acme/app.git' });
    expect(await listPullRequests(branch, { gh: github.gh, cwd: gitlab })).toEqual([]);
  });

  it('says so when the directory is gone, rather than blaming gh', async () => {
    const github = fakeWith([]);
    await expect(
      listPullRequests(branch, { gh: github.gh, cwd: '/nonexistent/worktree', repo: 'acme/app' }),
    ).rejects.toMatchObject({ kind: 'rejected', message: '/nonexistent/worktree does not exist' });
  });

  it('fails as unauthorized when gh is not logged in', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, loggedIn: false });
    onTestFinished(github.dispose);
    await expect(listPullRequests('main', { gh: github.gh, cwd: '/tmp', repo: 'acme/app' })).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });
});

describe('mergePullRequest', () => {
  it('squash-merges the pull request in the given repo', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [pr({ number: 41 })] });
    onTestFinished(github.dispose);
    const cwd = repoWithRemotes({});

    await mergePullRequest(41, { gh: github.gh, cwd, repo: 'acme/app' });

    expect(github.calls().at(-1)?.args).toEqual(['pr', 'merge', '41', '--repo', 'acme/app', '--squash']);
    const [merged] = await listPullRequests('gh-34-fix-the-login-redirect', { gh: github.gh, cwd, repo: 'acme/app' });
    expect(merged?.state).toBe('merged');
  });

  it('only merges while the head is the given commit', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [pr({ number: 41, headRefOid: 'b'.repeat(40) })] });
    onTestFinished(github.dispose);
    const cwd = repoWithRemotes({});

    await expect(mergePullRequest(41, { gh: github.gh, cwd, repo: 'acme/app', headCommit: 'a'.repeat(40) })).rejects.toMatchObject({
      message: expect.stringContaining('Head branch was modified'),
    });
    expect((await listPullRequests('gh-34-fix-the-login-redirect', { gh: github.gh, cwd, repo: 'acme/app' }))[0]?.state).toBe('open');

    await mergePullRequest(41, { gh: github.gh, cwd, repo: 'acme/app', headCommit: 'b'.repeat(40) });

    expect(github.calls().at(-1)?.args).toEqual(['pr', 'merge', '41', '--repo', 'acme/app', '--squash', '--match-head-commit', 'b'.repeat(40)]);
  });

  it("fails as gh does for a pull request that isn't open", async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [pr({ number: 41, state: 'MERGED' })] });
    onTestFinished(github.dispose);

    await expect(mergePullRequest(41, { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' })).rejects.toMatchObject({
      message: expect.stringContaining('was already merged'),
    });
  });
});
