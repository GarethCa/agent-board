import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import {
  createFakeGitHub,
  FAKE_GITHUB_STATE,
  type FakeGitHubPullRequest,
} from '@agent-board/tracker/testing';
import type { Agent, AgentUpdatedEvent, DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

interface Setup {
  /** How often the daemon asks gh: every 100 ms by default. */
  pollMs?: number;
  /** The repo's `origin`: acme/app on GitHub by default. */
  origin?: string;
  /** The GitHub repo the zone takes its issues from; none by default. */
  zoneRepo?: string;
  /** The fake claude's scenario and the agent's prompt: `waiting`, fixing the login redirect, by default. */
  scenario?: 'waiting' | 'orchestrate';
  prompt?: string;
}

/**
 * A daemon that asks a fake gh for agents' pull requests, with one agent running the fake claude in a repo whose
 * `origin` is on GitHub.
 */
async function agentWithFakeGitHub({
  pollMs = 100,
  origin = 'https://github.com/acme/app.git',
  zoneRepo,
  scenario = 'waiting',
  prompt = 'Fix the login redirect',
}: Setup = {}) {
  const github = createFakeGitHub();
  onTestFinished(github.dispose);
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home: tempDataDir(), idleNotifyMs: 200 }),
    gh: github.gh,
    pullRequestPollMs: pollMs,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  git(repo, 'remote', 'add', 'origin', origin);
  let zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  if (zoneRepo !== undefined) {
    zone = await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'github', scope: zoneRepo } });
  }
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt, ...SIZE });
  /** Resolves with the agent's next update whose pull requests match. */
  const updated = (match: (agent: Agent) => boolean) =>
    recorder.waitFor(
      (event: DaemonEvent): event is AgentUpdatedEvent =>
        event.type === 'agent.updated' && event.agent.sessionId === agent.sessionId && match(event.agent),
    );
  const pullRequest = (fields: Partial<FakeGitHubPullRequest> = {}): FakeGitHubPullRequest => ({
    repo: 'acme/app',
    number: 41,
    title: 'Fix the login redirect',
    headRefName: agent.branch,
    state: 'OPEN',
    isDraft: false,
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'check', status: 'IN_PROGRESS', conclusion: '' }],
    ...fields,
  });
  /** How many times gh was asked for the agent's pull requests. */
  const asked = () => github.calls().filter((call) => call.args[0] === 'pr' && call.args.includes(agent.branch)).length;
  return { client, github, agent, updated, pullRequest, asked };
}

describe("an agent's pull requests", () => {
  it('shows the pull requests made from its branch, with their state and checks, as they change', async () => {
    const { client, github, agent, updated, pullRequest } = await agentWithFakeGitHub();
    expect(agent.pullRequests).toEqual([]);

    const otherBranch = pullRequest({ number: 40, headRefName: 'someone-else' });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(), otherBranch] });
    await updated((a) => a.pullRequests.length > 0);
    expect((await client.call('agent.list'))[0]?.pullRequests).toEqual([
      {
        number: 41,
        title: 'Fix the login redirect',
        url: 'https://github.com/acme/app/pull/41',
        state: 'open',
        checks: 'pending',
      },
    ]);

    const success = [{ __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ state: 'MERGED', statusCheckRollup: success })] });
    const merged = await updated((a) => a.pullRequests[0]?.state === 'merged');
    expect(merged.agent.pullRequests[0]).toMatchObject({ state: 'merged', checks: 'passing' });

    // gh was asked in the agent's worktree, for its branch, and found the repo from its remote.
    const call = github.calls().find((c) => c.args[0] === 'pr')!;
    expect(call.cwd).toBe(agent.worktree);
    expect(call.args.slice(0, 4)).toEqual(['pr', 'list', '--head', agent.branch]);
  });

  it('tells its crew of a pull request opened after a first read that found none, once', async () => {
    const { client, github, agent, pullRequest, asked } = await agentWithFakeGitHub();
    // Its first read finds nothing, so changes nothing and tells no client. Its reads overlap as it starts (one as it
    // starts, a round's, one as its turn ends), and the first answered is its first read: under load, one whose gh call
    // isn't logged yet. Rounds run one at a time, so by the fourth ask a round's read has been answered, with nothing.
    await expect.poll(asked, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
    const { cursor } = await client.call('orchestrator.wait', { crew: true, since: 'now', timeoutMs: 0 });

    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    const heard = await client.call('orchestrator.wait', { crew: true, since: cursor, kinds: ['pr-opened'], timeoutMs: 10_000 });
    expect(heard.events).toEqual([expect.objectContaining({ sessionId: agent.sessionId, kind: 'pr-opened', detail: '#41 https://github.com/acme/app/pull/41' })]);
    // Read again and again: no news.
    const before = asked();
    await expect.poll(asked, { timeout: 10_000 }).toBeGreaterThan(before + 1);
    expect((await client.call('orchestrator.wait', { crew: true, since: heard.cursor, kinds: ['pr-opened'], timeoutMs: 0 })).events).toEqual([]);
  });

  it('reads an agent started after the daemon as it starts, so a pull request of its first turn is news', async () => {
    // No round before the next minute: the daemon's first ran before the agent was there.
    const { client, github, agent, pullRequest, asked } = await agentWithFakeGitHub({ pollMs: 60_000, scenario: 'orchestrate', prompt: 'Work slowly' });
    // Read as it started, with no pull request yet, while its first turn works.
    await expect.poll(asked, { timeout: 10_000 }).toBe(1);
    expect((await client.call('agent.list'))[0]?.state).not.toBe('idle');
    const { cursor } = await client.call('orchestrator.wait', { crew: true, since: 'now', timeoutMs: 0 });

    // It opens one in that turn; the read as its turn ends finds it.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    const heard = await client.call('orchestrator.wait', { crew: true, since: cursor, kinds: ['pr-opened'], timeoutMs: 15_000 });
    expect(heard.events).toEqual([expect.objectContaining({ sessionId: agent.sessionId, kind: 'pr-opened', detail: '#41 https://github.com/acme/app/pull/41' })]);
  });

  it('asks for the pull requests of the new branch once the agent renames it', async () => {
    const { github, agent, updated, pullRequest } = await agentWithFakeGitHub();
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ headRefName: 'renamed-one' })] });
    git(agent.worktree, 'branch', '-m', 'renamed-one');

    const found = await updated((a) => a.branch === 'renamed-one' && a.pullRequests.length > 0);
    expect(found.agent.pullRequests[0]).toMatchObject({ number: 41 });
  });

  it('keeps the pull requests it last saw while gh fails', async () => {
    const { client, github, updated, pullRequest } = await agentWithFakeGitHub();
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    await updated((a) => a.pullRequests.length > 0);

    github.setState({ ...FAKE_GITHUB_STATE, loggedIn: false, pullRequests: [] });
    const failedCalls = () => github.calls().filter((call) => call.args[0] === 'pr').length;
    const before = failedCalls();
    await expect.poll(failedCalls, { timeout: 10_000 }).toBeGreaterThan(before + 1);

    expect((await client.call('agent.list'))[0]?.pullRequests).toHaveLength(1);
  });

  it("asks in a GitHub zone's own repo, whatever the worktree's remotes say", async () => {
    const { github, updated, pullRequest } = await agentWithFakeGitHub({
      origin: 'https://github.com/me/app-fork.git',
      zoneRepo: 'acme/app',
    });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    const found = await updated((a) => a.pullRequests.length > 0);
    expect(found.agent.pullRequests.map((pr) => pr.url)).toEqual(['https://github.com/acme/app/pull/41']);
    expect(github.calls().find((c) => c.args[0] === 'pr')?.args.slice(0, 4)).toEqual([
      'pr',
      'list',
      '--repo',
      'acme/app',
    ]);
  });

  it("asks in its own zone's repo when it sits loose on the board or in another repo's zone", async () => {
    const { client, github, agent, updated, pullRequest } = await agentWithFakeGitHub({
      origin: 'https://github.com/me/app-fork.git',
      zoneRepo: 'acme/app',
    });
    const elsewhere = await client.call('zone.add', { path: tempRepo('other'), x: 900, y: 0 });
    const prCalls = () => github.calls().filter((c) => c.args[0] === 'pr' && c.args.includes(agent.branch));

    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: null, x: -400, y: 0 });
    const before = prCalls().length;
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    const found = await updated((a) => a.zoneId === null && a.pullRequests.length > 0);
    expect(found.agent.pullRequests.map((pr) => pr.url)).toEqual(['https://github.com/acme/app/pull/41']);

    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: elsewhere.id, x: 0, y: 0 });
    const moved = prCalls().length;
    await expect.poll(() => prCalls().length, { timeout: 10_000 }).toBeGreaterThan(moved);
    expect(prCalls().slice(before).every((call) => call.args.slice(2, 4).join(' ') === '--repo acme/app')).toBe(true);
  });

  it("still asks, from its worktree, once its repo has no zone left on the board", async () => {
    const { client, github, agent, updated, pullRequest } = await agentWithFakeGitHub({ zoneRepo: 'acme/app' });
    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: null, x: -400, y: 0 });
    await client.call('zone.remove', { id: agent.zoneId! });

    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    const found = await updated((a) => a.pullRequests.length > 0);
    expect(found.agent.pullRequests.map((pr) => pr.url)).toEqual(['https://github.com/acme/app/pull/41']);
  });

  it('stops asking about an ended agent once none of its pull requests is open', async () => {
    const { client, github, agent, updated, pullRequest, asked } = await agentWithFakeGitHub();
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    await updated((a) => a.pullRequests.length > 0);
    await client.call('session.kill', { sessionId: agent.sessionId });

    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ state: 'MERGED' })] });
    await updated((a) => a.pullRequests[0]?.state === 'merged');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = asked();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asked()).toBe(settled);
  });

  it('shows the pull request of a branch it pushed its own commit to, open and once merged, for its tile alone', async () => {
    const { client, github, agent, updated, pullRequest } = await agentWithFakeGitHub({ zoneRepo: 'acme/app' });
    const mirror = join(tempDataDir(), 'mirror.git');
    git(agent.worktree, 'init', '--quiet', '--bare', mirror);
    git(agent.worktree, 'remote', 'add', 'mirror', mirror);
    git(agent.worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'fix');
    git(agent.worktree, 'push', '--quiet', 'mirror', 'HEAD:fix-the-login');
    const head = git(agent.worktree, 'rev-parse', 'HEAD');

    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ number: 174, headRefName: 'fix-the-login', headRefOid: head })] });
    const found = await updated((a) => a.pushedPullRequests[0]?.number === 174);
    // Not its own: nothing merges it from this agent.
    expect(found.agent.pullRequests).toEqual([]);
    await expect(
      client.call('gate.merge', {
        sessionId: agent.sessionId,
        number: 174,
        headCommit: head,
        cleanup: { close: false, worktree: false, branch: false, comment: false },
      }),
    ).rejects.toThrow(/#174 is not one of/);
    expect(github.calls().some((call) => call.args[1] === 'merge')).toBe(false);

    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest({ number: 174, headRefName: 'fix-the-login', state: 'MERGED' })] });
    await updated((a) => a.pushedPullRequests[0]?.state === 'merged');
  });

  it('still shows the pull request it pushed to once that branch is deleted and pruned, by its pushed commit, searched for once', async () => {
    const { github, agent, updated, pullRequest } = await agentWithFakeGitHub({ zoneRepo: 'acme/app' });
    const commit = (message: string) => {
      git(agent.worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', message);
      return git(agent.worktree, 'rev-parse', 'HEAD');
    };
    const mirror = join(tempDataDir(), 'mirror.git');
    git(agent.worktree, 'init', '--quiet', '--bare', mirror);
    git(agent.worktree, 'remote', 'add', 'mirror', mirror);
    const pushed = commit('fix');
    git(agent.worktree, 'push', '--quiet', 'mirror', 'HEAD:fix-the-login');
    const open = pullRequest({ number: 174, headRefName: 'fix-the-login', commits: [pushed] });
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [open] });
    await updated((a) => a.pushedPullRequests[0]?.number === 174);

    // It goes on, its PR merges and its branch goes: the commit searched for is the one it pushed, not the newer one.
    const notes = commit('notes');
    git(agent.worktree, 'push', '--quiet', 'mirror', '--delete', 'fix-the-login');
    git(agent.worktree, 'fetch', '--quiet', '--prune', 'mirror');
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [{ ...open, state: 'MERGED' }] });
    await updated((a) => a.pushedPullRequests[0]?.state === 'merged');
    const searches = (sha: string) => github.calls().filter((call) => call.args.includes('--search') && call.args.includes(sha)).length;
    expect(searches(notes)).toBe(0);

    // Found merged, it is trusted for a while, though its own branch is asked about every round.
    const searched = searches(pushed);
    const own = () => github.calls().filter((call) => call.args.includes(agent.branch)).length;
    const before = own();
    await expect.poll(own, { timeout: 10_000 }).toBeGreaterThan(before + 2);
    expect(searches(pushed)).toBe(searched);
  });

  it("asks at once when the agent's turn ends, without waiting for the next round", async () => {
    const { github, updated, pullRequest } = await agentWithFakeGitHub({ pollMs: 60_000 });
    // Set before the fake claude, still starting, ends its first turn.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    await updated((a) => a.pullRequests.length > 0);
  });
});
