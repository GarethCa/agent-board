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
}

/**
 * A daemon that asks a fake gh for agents' pull requests, with one agent running the fake claude in a repo whose
 * `origin` is on GitHub.
 */
async function agentWithFakeGitHub({ pollMs = 100, origin = 'https://github.com/acme/app.git', zoneRepo }: Setup = {}) {
  const github = createFakeGitHub();
  onTestFinished(github.dispose);
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }),
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
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Fix the login redirect', ...SIZE });
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

  it("asks at once when the agent's turn ends, without waiting for the next round", async () => {
    const { github, updated, pullRequest } = await agentWithFakeGitHub({ pollMs: 60_000 });
    // Set before the fake claude, still starting, ends its first turn.
    github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest()] });
    await updated((a) => a.pullRequests.length > 0);
  });
});
