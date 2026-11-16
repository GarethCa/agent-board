import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest, type FakeGitHubState } from '@agent-board/tracker/testing';
import { BOARD_CALLER_METHODS, TRACKER_ERROR } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempRepo } from './helpers.ts';

const pr = (fields: Partial<FakeGitHubPullRequest> = {}): FakeGitHubPullRequest => ({
  repo: 'acme/app',
  number: 41,
  title: 'Fix the login redirect',
  headRefName: 'gh-34-fix-the-login-redirect',
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [],
  headRefOid: 'b'.repeat(40),
  ...fields,
});

async function daemonWith(state: Partial<FakeGitHubState>) {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, ...state });
  onTestFinished(github.dispose);
  const client = await connectTestClient(await startTestDaemon({ gh: github.gh }));
  return { github, client };
}

describe('PR tabs', () => {
  it('reads a pull request whole with gh', async () => {
    const { client } = await daemonWith({ pullRequests: [pr({ body: 'Sends users home.' })] });

    const details = await client.call('pullRequest.details', { repo: 'acme/app', number: 41 });

    expect(details).toMatchObject({ repo: 'acme/app', number: 41, body: 'Sends users home.', state: 'open', merge: { allowed: true }, approve: { allowed: true } });
  });

  it('approves it at the commit the user saw, and answers with it as it is now', async () => {
    const { client, github } = await daemonWith({ pullRequests: [pr()] });

    const acted = await client.call('pullRequest.approve', { repo: 'acme/app', number: 41, headCommit: 'b'.repeat(40) });

    expect(github.calls().some((call) => call.args.join(' ') === `api repos/acme/app/pulls/41/reviews -X POST -f event=APPROVE -f commit_id=${'b'.repeat(40)}`)).toBe(true);
    expect('details' in acted && acted.details.reviews).toMatchObject([{ author: 'octocat', state: 'APPROVED' }]);
  });

  it('refuses to approve once something was pushed since the commit the user saw', async () => {
    const { client, github } = await daemonWith({ pullRequests: [pr({ headRefOid: 'c'.repeat(40) })] });

    await expect(client.call('pullRequest.approve', { repo: 'acme/app', number: 41, headCommit: 'b'.repeat(40) })).rejects.toMatchObject({
      message: expect.stringContaining('has moved on'),
    });
    expect(github.calls().some((call) => call.args.includes('POST'))).toBe(false);
  });

  it('squash-merges it only at the commit the user saw', async () => {
    const { client, github } = await daemonWith({ pullRequests: [pr()] });

    await expect(client.call('pullRequest.merge', { repo: 'acme/app', number: 41, headCommit: 'a'.repeat(40) })).rejects.toMatchObject({
      message: expect.stringContaining('Head branch was modified'),
    });
    const acted = await client.call('pullRequest.merge', { repo: 'acme/app', number: 41, headCommit: 'b'.repeat(40) });

    expect('details' in acted && acted.details.state).toBe('merged');
    expect(github.calls().filter((call) => call.args[1] === 'merge').at(-1)?.args).toEqual([
      ...['pr', 'merge', '41', '--repo', 'acme/app', '--squash'],
      ...['--match-head-commit', 'b'.repeat(40)],
    ]);
  });

  it('says a merge that happened happened, though reading the pull request again failed', async () => {
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, pullRequests: [pr()] });
    onTestFinished(github.dispose);
    // A gh that merges, but fails to read the pull request whole, as when the rate limit is reached between the two.
    const dir = mkdtempSync(join(tmpdir(), 'ab-flaky-gh-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/bin/sh\ncase "$*" in *statusCheckRollup*) echo 'GraphQL: API rate limit exceeded for user ID 1.' >&2; exit 1;; esac\nexec '${github.gh}' "$@"\n`);
    chmodSync(gh, 0o755);
    const client = await connectTestClient(await startTestDaemon({ gh }));

    const acted = await client.call('pullRequest.merge', { repo: 'acme/app', number: 41, headCommit: 'b'.repeat(40) });

    expect(acted).toEqual({ readError: expect.stringMatching(/rate limit/i) });
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(true);
  });

  it("says when GitHub's rate limit is reached", async () => {
    const { client } = await daemonWith({ pullRequests: [pr()], rateLimited: true });

    await expect(client.call('pullRequest.details', { repo: 'acme/app', number: 41 })).rejects.toMatchObject({
      code: TRACKER_ERROR.unavailable,
      message: expect.stringMatching(/rate limit/i),
    });
  });

  it('refuses a repo or number that names no pull request', async () => {
    const { client, github } = await daemonWith({ pullRequests: [pr()] });

    for (const params of [{ repo: 'acme', number: 41 }, { repo: 'acme/app --web', number: 41 }, { repo: '../..', number: 41 }, { repo: 'acme/app', number: 0 }, { repo: 'acme/app', number: 1.5 }]) {
      await expect(client.call('pullRequest.details', params)).rejects.toMatchObject({ message: expect.stringMatching(/repo|number/) });
    }
    expect(github.calls()).toEqual([]);
  });

  it('is never open to agents: only the user merges or approves', () => {
    for (const method of ['pullRequest.details', 'pullRequest.merge', 'pullRequest.approve'] as const) expect(BOARD_CALLER_METHODS.has(method)).toBe(false);
  });
});

describe('finding pull requests to open', () => {
  /** A zone bound to a repo whose GitHub remote is `remote`. */
  async function boundTo(client: Awaited<ReturnType<typeof daemonWith>>['client'], name: string, remote: string) {
    const repo = tempRepo(name);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://github.com/${remote}.git`]);
    const zone = await client.call('zone.addUnbound', { name, x: 0, y: 0 });
    await client.call('zone.bind', { id: zone.id, as: 'repo', path: repo });
  }

  it("lists the open pull requests of the board's repos, by anyone, each once, marking those whose review is asked of the user", async () => {
    const { client, github } = await daemonWith({
      pullRequests: [
        pr({ number: 44, title: 'Fix the docs', author: 'hubot', reviewRequests: [{ login: 'octocat' }] }),
        pr({ number: 43, state: 'MERGED' }),
        pr({ number: 7, repo: 'acme/ops', title: 'Rotate the keys', headRefName: 'rotate' }),
        pr({ number: 9, repo: 'acme/elsewhere' }),
      ],
    });
    await boundTo(client, 'app', 'acme/app');
    await boundTo(client, 'app-again', 'acme/app');
    await boundTo(client, 'ops', 'acme/ops');

    const found = await client.call('pullRequest.search');

    expect(found.map(({ repo, number, reviewRequested }) => [repo, number, reviewRequested])).toEqual([
      ['acme/app', 44, true],
      ['acme/ops', 7, false],
    ]);
    expect(found[1]).toEqual({ repo: 'acme/ops', number: 7, title: 'Rotate the keys', url: 'https://github.com/acme/ops/pull/7', author: 'hubot', branch: 'rotate', draft: false, reviewRequested: false });

    // Two folders that push to the same GitHub repo ask GitHub about it once.
    expect(github.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'list')).toHaveLength(2);
  });

  it('answers a search again soon after from what it found, asking GitHub nothing more', async () => {
    const { client, github } = await daemonWith({ pullRequests: [pr()] });
    await boundTo(client, 'app', 'acme/app');
    const first = await client.call('pullRequest.search');
    const asked = github.calls().length;

    expect(await client.call('pullRequest.search')).toEqual(first);
    expect(github.calls()).toHaveLength(asked);
  });

  it('finds none on a board with no repo, asking GitHub nothing', async () => {
    const { client, github } = await daemonWith({ pullRequests: [pr()] });
    expect(await client.call('pullRequest.search')).toEqual([]);
    expect(github.calls()).toEqual([]);
  });

  it("isn't for agents", () => {
    expect(BOARD_CALLER_METHODS).not.toContain('pullRequest.search');
  });
});
