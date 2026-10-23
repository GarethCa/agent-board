// An agent started in the repo's own checkout (the Orchestrator role's Checkout row): whatever the app does to it, the
// user's folder, its files and its branch stay as they are, and it never opens a pull request, pushes or merges.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { RPC_ERROR } from '../src/protocol.ts';
import { removeWorktree } from '../src/worktrees.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

async function setup(scenario: 'waiting' | 'orchestrate' = 'waiting') {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE });
  onTestFinished(github.dispose);
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: { ...fakeHarnessEnv({ scenario, home: tempDataDir() }), TMPDIR: tempDataDir() },
    gh: github.gh,
    pullRequestPollMs: 3_600_000,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  const bare = join(tempDataDir(), 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'remote', 'set-url', '--push', 'origin', bare);
  git(repo, 'branch', '-M', 'main');
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  // The user's own work, uncommitted, that nothing may touch.
  writeFileSync(join(repo, 'wip.txt'), 'unsaved work\n');
  const orchestrator = (extra: object = {}) =>
    client.call('agent.spawn', { zoneId: zone.id, role: 'orchestrator', orchestrate: 'zone', checkout: 'main', ...extra, ...SIZE });
  /** The checkout as the user left it: branches, HEAD, status and the file. */
  const state = () => ({
    branches: git(repo, 'branch', '--format=%(refname:short)'),
    head: git(repo, 'rev-parse', 'HEAD'),
    current: git(repo, 'branch', '--show-current'),
    status: git(repo, 'status', '--porcelain'),
    wip: readFileSync(join(repo, 'wip.txt'), 'utf8'),
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
  });
  return { github, daemon, client, recorder, repo, bare, zone, orchestrator, state };
}

describe('an agent in the repo’s own checkout', () => {
  it('owns no branch and no worktree, and the checkout is as the user left it', async () => {
    const { orchestrator, repo, state } = await setup();
    const before = state();

    const agent = await orchestrator();

    expect(agent).toMatchObject({ worktree: repo, branch: '', ownedBranch: '', ownsWorktree: false });
    expect(state()).toEqual(before);
  });

  it('leaves the folder, its branches and the user’s uncommitted work alone when deleted, forced or not', async () => {
    const { client, orchestrator, repo, state } = await setup();
    const before = state();

    const first = await orchestrator();
    await client.call('agent.delete', { sessionId: first.sessionId });
    expect(state()).toEqual(before);

    const second = await orchestrator();
    await client.call('agent.delete', { sessionId: second.sessionId, force: true });
    const third = await orchestrator();
    await client.call('agent.delete', { sessionId: third.sessionId, force: true, keepWorktree: false });

    expect(state()).toEqual(before);
    expect(existsSync(join(repo, 'wip.txt'))).toBe(true);
    expect(await client.call('agent.list')).toEqual([]);
  });

  it('leaves the checkout alone when stopped and restarted', async () => {
    const { client, orchestrator, state } = await setup();
    const before = state();
    const agent = await orchestrator();

    await client.call('agent.stop', { sessionId: agent.sessionId });
    await client.call('agent.resume', { sessionId: agent.sessionId });
    expect(state()).toEqual(before);

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    expect(state()).toEqual(before);
  });

  it('is never removed as a worktree, even by the fallback that deletes a folder git no longer knows', async () => {
    const { repo, state } = await setup();
    const before = state();

    await expect(removeWorktree(repo, repo, 'main')).rejects.toThrow(/own checkout/);

    expect(state()).toEqual(before);
  });

  it('opens no pull request and pushes nothing, whichever way it is asked', async () => {
    const { client, orchestrator, github, bare } = await setup();
    const agent = await orchestrator();

    await expect(client.call('gate.openPullRequest', { sessionId: agent.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('works in the repo\'s own checkout'),
    });

    expect(git(bare, 'for-each-ref')).toBe('');
    expect(github.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'create')).toEqual([]);
  });

  it('merges nothing', async () => {
    const { client, orchestrator, github } = await setup();
    const agent = await orchestrator();

    await expect(
      client.call('gate.merge', {
        sessionId: agent.sessionId,
        number: 1,
        headCommit: '0'.repeat(40),
        cleanup: { close: true, worktree: true, branch: true, comment: false },
      }),
    ).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringContaining('works in the repo\'s own checkout') });

    expect(github.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge')).toEqual([]);
  });

  it('is refused for an orchestrator’s own agents: each gets a worktree, whatever the call carries', async () => {
    const { client, daemon, recorder, orchestrator, repo, state } = await setup('orchestrate');
    const lead = await orchestrator({ prompt: 'Print your board identity', noTemplate: true });
    await client.call('session.attach', { sessionId: lead.sessionId });
    await recorder.waitForText(lead.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(lead.sessionId))![1]!;
    const side = await connectTestClient(daemon);
    await side.call('board.identify', { token });
    const before = state();

    const child = await side.call('orchestrator.spawn', { token, name: 'crew', checkout: 'main' } as never);

    expect(child).toMatchObject({ spawnedBy: lead.sessionId, ownsWorktree: true });
    expect(child.worktree).not.toBe(repo);
    expect(state().current).toBe(before.current);
    expect(state().wip).toBe(before.wip);
  });
});
