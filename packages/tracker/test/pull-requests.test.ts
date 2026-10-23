import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { checksState, findPushedPullRequests, listPullRequests, mergePullRequest, viewPullRequest } from '../src/index.ts';
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

describe('findPushedPullRequests', () => {
  const sha = 'c'.repeat(40);
  const fakeWith = (pullRequests: FakeGitHubPullRequest[]) => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests });
    onTestFinished(github.dispose);
    return github;
  };
  const numbers = (found: { number: number }[]) => found.map((p) => p.number);
  const asked = (github: ReturnType<typeof fakeWith>) => github.calls().map((call) => call.args.slice(4, 6).join(' '));

  it('finds the pull request of a branch the agent pushed to, open and after it merged, with no search', async () => {
    const github = fakeWith([pr({ number: 174, headRefName: 'fix-the-login' }), pr({ number: 9, headRefName: 'other' })]);
    const options = { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' };

    expect(await findPushedPullRequests({ pushedTo: ['fix-the-login'], commit: sha }, options)).toEqual([
      { number: 174, title: 'PR 174', url: 'https://github.com/acme/app/pull/174', state: 'open', checks: 'none' },
    ]);
    github.setState({ ...github.state(), pullRequests: [pr({ number: 174, headRefName: 'fix-the-login', state: 'MERGED' })] });
    expect((await findPushedPullRequests({ pushedTo: ['fix-the-login'], commit: sha }, options))[0]?.state).toBe('merged');
    expect(asked(github)).toEqual(['--head fix-the-login', '--head fix-the-login']);
  });

  it('lists the pull requests of every branch it pushed to, each once, asking about each branch once', async () => {
    const github = fakeWith([pr({ number: 51, headRefName: 'b' }), pr({ number: 50, headRefName: 'a' })]);

    const found = await findPushedPullRequests({ pushedTo: ['a', 'b', 'a'] }, { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' });

    expect(numbers(found)).toEqual([50, 51]);
    expect(asked(github)).toEqual(['--head a', '--head b']);
  });

  it('asks about the first five branches it pushed to, then searches', async () => {
    const github = fakeWith([]);
    const pushedTo = Array.from({ length: 12 }, (_, i) => `pushed-${i}`);

    await findPushedPullRequests({ pushedTo, commit: sha }, { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' });

    expect(asked(github)).toEqual([...[0, 1, 2, 3, 4].map((i) => `--head pushed-${i}`), `--search ${sha}`]);
  });

  it("falls back to the pull requests holding the agent's commit when no branch it pushed to has one", async () => {
    const github = fakeWith([pr({ number: 174, headRefName: 'gone', state: 'MERGED', commits: ['a'.repeat(40), sha] }), pr({ number: 9, headRefName: 'other' })]);

    const found = await findPushedPullRequests({ pushedTo: ['pruned'], commit: sha }, { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' });

    expect(numbers(found)).toEqual([174]);
    expect(github.calls().at(-1)?.args.slice(0, 8)).toEqual(['pr', 'list', '--repo', 'acme/app', '--search', sha, '--state', 'all']);
  });

  it('asks nothing with nowhere pushed to and no commit, nor searches for what is not a commit id', async () => {
    const github = fakeWith([pr({ number: 9, headRefName: 'other' })]);
    const options = { gh: github.gh, cwd: repoWithRemotes({}), repo: 'acme/app' };

    expect(await findPushedPullRequests({ pushedTo: [] }, options)).toEqual([]);
    expect(await findPushedPullRequests({ pushedTo: [], commit: '' }, options)).toEqual([]);
    expect(await findPushedPullRequests({ pushedTo: [], commit: 'c0ffee' }, options)).toEqual([]);
    expect(github.calls()).toEqual([]);
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

describe('viewPullRequest', () => {
  it('reads one pull request by its repo and number, and takes one GitHub has no such of as none', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [pr({ number: 12, state: 'MERGED' })] });
    onTestFinished(github.dispose);
    expect(await viewPullRequest({ repo: 'Acme/App', number: 12 }, { gh: github.gh })).toMatchObject({ number: 12, state: 'merged', url: 'https://github.com/acme/app/pull/12' });
    expect(await viewPullRequest({ repo: 'acme/app', number: 13 }, { gh: github.gh })).toBeUndefined();
    expect(await viewPullRequest({ repo: 'acme/nothing', number: 1 }, { gh: github.gh })).toBeUndefined();
  });

  it('fails, rather than calling it gone, when gh can’t read it', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, unreadableRepos: ['acme/app'], pullRequests: [pr({ number: 12 })] });
    onTestFinished(github.dispose);
    await expect(viewPullRequest({ repo: 'acme/app', number: 12 }, { gh: github.gh })).rejects.toThrow(/SAML/);
  });
});
