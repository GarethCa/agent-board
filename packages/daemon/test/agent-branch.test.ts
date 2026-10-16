import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { DaemonClient } from '../src/client.ts';
import { AGENT_ERROR, type Agent, type AgentUpdatedEvent } from '../src/protocol.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

async function agentOnBranch(): Promise<{ client: DaemonClient; agent: Agent }> {
  const daemon = await startTestDaemon({
    dataDir: tempDataDir(),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const zone = await client.call('zone.add', { path: tempRepo('monorepo'), x: 0, y: 0 });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Work on it', ...SIZE });
  return { client, agent };
}

const listed = async (client: DaemonClient, agent: Agent) => {
  await client.call('agent.refreshBranches');
  return (await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!;
};

describe('an agent that changes its branch', () => {
  it('shows the branch it renamed to, not the one it started on', async () => {
    const { client, agent } = await agentOnBranch();
    git(agent.worktree, 'branch', '-m', 'renamed-one');

    expect(await listed(client, agent)).toMatchObject({ branch: 'renamed-one', detached: false });
  });

  it('keeps the last branch name, marked detached, on a detached HEAD, and follows a branch checked out after', async () => {
    const { client, agent } = await agentOnBranch();
    git(agent.worktree, 'checkout', '--detach');
    expect(await listed(client, agent)).toMatchObject({ branch: agent.branch, ownedBranch: agent.branch, detached: true });

    git(agent.worktree, 'checkout', '-b', 'second-branch');
    expect(await listed(client, agent)).toMatchObject({ branch: 'second-branch', ownedBranch: agent.branch, detached: false });
  });

  it('adopts a rename as its own branch, and closing it then removes that branch', async () => {
    const { client, agent } = await agentOnBranch();
    const repo = agent.repoRoot;
    git(agent.worktree, 'branch', '-m', 'renamed-one');
    // No hook or listing in between: closing reads the branch first, or the renamed branch would leak.
    await client.call('agent.delete', { sessionId: agent.sessionId });

    expect(git(repo, 'branch', '--list', 'renamed-one')).toBe('');
    expect(git(repo, 'branch', '--list', agent.branch)).toBe('');
  });

  it('keeps ownership of its own branch when it checks another out: closing leaves the other alone and still checks its own', async () => {
    const { client, agent } = await agentOnBranch();
    const repo = agent.repoRoot;
    git(repo, 'branch', 'develop');
    writeFileSync(join(agent.worktree, 'work.ts'), 'export {};\n');
    git(agent.worktree, 'add', '.');
    git(agent.worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'Work');
    git(agent.worktree, 'checkout', 'develop');
    expect(await listed(client, agent)).toMatchObject({ branch: 'develop', ownedBranch: agent.branch, detached: false });

    // Its own branch holds a commit no other has, so closing is refused, as it was before the checkout.
    await expect(client.call('agent.delete', { sessionId: agent.sessionId })).rejects.toMatchObject({ code: AGENT_ERROR.unsavedWork });
    expect(git(repo, 'branch', '--list', 'develop')).toContain('develop');

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    expect(git(repo, 'branch', '--list', 'develop')).toContain('develop');
    expect(git(repo, 'branch', '--list', agent.branch)).toBe('');
  });

  it('follows the rename on the agent\'s next hook, without anyone listing the board', async () => {
    const { client, agent } = await agentOnBranch();
    const events = recordEvents(client);
    git(agent.worktree, 'branch', '-m', 'renamed-hooked');
    // The fake claude is still reporting (its idle notification comes after the rename): each hook re-reads the branch.
    await events.waitFor(
      (e): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.branch === 'renamed-hooked',
    );
  });

  it('does not adopt a branch it is on when its own is renamed away or deleted, so closing deletes only its own', async () => {
    for (const lose of [(a: Agent) => git(a.worktree, 'branch', '-m', a.branch, 'renamed-elsewhere'), (a: Agent) => git(a.worktree, 'branch', '-D', a.branch)]) {
      const { client, agent } = await agentOnBranch();
      const repo = agent.repoRoot;
      git(repo, 'branch', 'develop');
      git(agent.worktree, 'checkout', 'develop');
      lose(agent);

      expect(await listed(client, agent)).toMatchObject({ branch: 'develop', ownedBranch: agent.branch });
      await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
      expect(git(repo, 'branch', '--list', 'develop')).toContain('develop');
    }
  });

  it('follows a rename done while another branch is out, once the renamed branch is checked out', async () => {
    const { client, agent } = await agentOnBranch();
    git(agent.repoRoot, 'branch', 'develop');
    git(agent.worktree, 'checkout', 'develop');
    git(agent.worktree, 'branch', '-m', agent.branch, 'renamed-one');
    git(agent.worktree, 'checkout', 'renamed-one');

    expect(await listed(client, agent)).toMatchObject({ branch: 'renamed-one', ownedBranch: 'renamed-one' });
  });
});
