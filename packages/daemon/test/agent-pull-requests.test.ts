import { describe, expect, it, onTestFinished } from 'vitest';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import { createPullRequestLookup } from '../src/agent-pull-requests.ts';
import type { WatchedAgent } from '../src/pull-requests.ts';
import { git, tempRepo } from './helpers.ts';

const AT = '2026-10-23T10:12:00.000Z';

const pullRequest = (fields: Partial<FakeGitHubPullRequest>): FakeGitHubPullRequest => ({
  repo: 'acme/app',
  number: 41,
  title: 'Fix the login redirect',
  headRefName: 'fix-login',
  state: 'OPEN',
  isDraft: false,
  statusCheckRollup: [],
  ...fields,
});

/** A lookup asking a fake gh, an agent on branch `fix-login` in a repo of acme/app, and what the lookup logged. */
function setup(state: Partial<typeof FAKE_GITHUB_STATE>) {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, ...state });
  onTestFinished(github.dispose);
  const repo = tempRepo();
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'checkout', '-q', '-b', 'fix-login');
  const logged: string[] = [];
  const lookup = createPullRequestLookup({ gh: github.gh, log: (message) => logged.push(message) });
  const agent = (recorded: WatchedAgent['recorded']): WatchedAgent => ({ sessionId: 'a', branch: 'fix-login', worktree: repo, ended: false, recorded });
  const views = () => github.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'view').map((call) => `${call.args[4]}#${call.args[2]}`);
  return { github, lookup, agent, logged, views };
}

describe("an agent's recorded pull requests", () => {
  it('reads its own pull requests, and the other recorded ones, when gh can’t read one of them', async () => {
    const { lookup, agent, logged } = setup({
      repos: [...FAKE_GITHUB_STATE.repos, { nameWithOwner: 'saml/locked', description: null }],
      unreadableRepos: ['saml/locked'],
      pullRequests: [pullRequest({}), pullRequest({ repo: 'acme/ops', number: 7, headRefName: 'release' }), pullRequest({ repo: 'saml/locked', number: 3, headRefName: 'x' })],
    });
    const recorded = [
      { repo: 'saml/locked', number: 3, recordedAt: AT },
      { repo: 'acme/ops', number: 7, recordedAt: AT },
    ];
    const found = await lookup(agent(recorded));
    expect(found.own.map((pr) => pr.number)).toEqual([41]);
    expect(found.recorded?.map((pr) => pr.url)).toEqual(['https://github.com/acme/ops/pull/7']);
    expect(logged).toEqual([expect.stringMatching(/^could not read saml\/locked#3, recorded by agent a: .*SAML/)]);

    // Logged once until it changes.
    await lookup(agent(recorded));
    expect(logged).toHaveLength(1);
  });

  it('stops asking about one last seen merged or closed, until it is recorded again', async () => {
    const { github, lookup, agent, views } = setup({ pullRequests: [pullRequest({ repo: 'acme/ops', number: 7, headRefName: 'release', state: 'MERGED' })] });
    const recorded = [{ repo: 'acme/ops', number: 7, recordedAt: AT }];
    expect((await lookup(agent(recorded))).recorded).toEqual([expect.objectContaining({ number: 7, state: 'merged' })]);
    expect((await lookup(agent(recorded))).recorded).toEqual([expect.objectContaining({ number: 7, state: 'merged' })]);
    expect(views()).toEqual(['acme/ops#7']);

    // An open one is asked about every round.
    github.setState({ ...github.state(), pullRequests: [pullRequest({ repo: 'acme/ops', number: 8, headRefName: 'next' })] });
    const open = [{ repo: 'acme/ops', number: 8, recordedAt: AT }];
    await lookup(agent(open));
    await lookup(agent(open));
    expect(views()).toEqual(['acme/ops#7', 'acme/ops#8', 'acme/ops#8']);

    // Recorded again, the merged one is asked about once more.
    await lookup(agent([{ repo: 'acme/ops', number: 7, recordedAt: '2026-10-24T09:00:00.000Z' }]));
    expect(views()).toEqual(['acme/ops#7', 'acme/ops#8', 'acme/ops#8', 'acme/ops#7']);
  });

  it('takes a pull request gh says there is no such one of as gone, not as a failure', async () => {
    const { lookup, agent, logged } = setup({ pullRequests: [] });
    expect((await lookup(agent([{ repo: 'acme/ops', number: 99, recordedAt: AT }]))).recorded).toEqual([]);
    expect(logged).toEqual([]);
  });
});
