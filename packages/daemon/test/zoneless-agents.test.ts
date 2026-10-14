// Zone-less agents and group zones: an agent can start loose on the board, from a repo it is given, and a
// zone can be a group with no repo, an optional default repo, bound later and unbound again.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeTracker, createMemoryCredentialStore } from '@agent-board/tracker/testing';
import { RPC_ERROR, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };
const LINEAR_KEY = 'lin_api_good';
const at = { x: 40, y: 80 };

async function agentDaemon() {
  const scratchDir = join(tempDataDir(), 'scratch');
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    scratchDir,
    agentEnv: fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), idleNotifyMs: 200 }),
    credentials: createMemoryCredentialStore(),
    trackers: { linear: () => createFakeTracker() },
  });
  const client = await connectTestClient(daemon);
  return { client, recorder: recordEvents(client), scratchDir };
}

/** The command line the session with `pid` runs. */
function commandOf(pid: number): string {
  return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
}

/** Adds a commit on a new branch `name`, leaving the repo on its first branch. */
function branchWithCommit(repo: string, name: string): string {
  const head = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(repo, 'checkout', '--quiet', '-b', name);
  writeFileSync(join(repo, `${name}.md`), name);
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', name);
  const commit = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '--quiet', head);
  return commit;
}

describe('zone-less agents', () => {
  it('start loose on the board, in a worktree of the repo they are given, which becomes a recent folder', async () => {
    const { client, recorder } = await agentDaemon();
    const repo = tempRepo('loose');

    const agent = await client.call('agent.spawn', {
      zoneId: null,
      repo: { path: repo },
      prompt: 'Tidy up',
      position: { x: 500, y: 600 },
      ...SIZE,
    });

    expect(agent).toMatchObject({ zoneId: null, repoRoot: repo, position: { x: 500, y: 600 }, name: 'Tidy up' });
    expect(agent.worktree).not.toContain(repo);
    expect(git(agent.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(agent.branch);
    await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
    );
    expect((await client.call('zone.recentFolders')).map((folder) => folder.path)).toContain(repo);
  });

  it('start in a folder of their repo when given one', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();

    const agent = await client.call('agent.spawn', { zoneId: null, repo: { path: join(repo, 'apps', 'web') }, prompt: 'Go', position: at, ...SIZE });

    expect(agent.repoRoot).toBe(repo);
    expect(agent.cwd).toBe(join(agent.worktree, 'apps', 'web'));
  });

  it('cut their worktree from the base branch asked for, on the branch asked for', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();
    const develop = branchWithCommit(repo, 'develop');

    const agent = await client.call('agent.spawn', {
      zoneId: null,
      repo: { path: repo },
      baseBranch: 'develop',
      branch: 'agent/new-work',
      prompt: 'Go',
      position: at,
      ...SIZE,
    });

    expect(agent.branch).toBe('agent/new-work');
    expect(git(agent.worktree, 'rev-parse', 'HEAD')).toBe(develop);
  });

  it('refuse a base branch the repo lacks, a branch it has already, or a name git refuses, starting nothing', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();
    const head = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    const spawn = (extra: object) => client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: 'Go', position: at, ...SIZE, ...extra });

    await expect(spawn({ baseBranch: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(/no branch nope/) });
    await expect(spawn({ branch: head })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(/already has a branch/) });
    await expect(spawn({ branch: 'bad..name' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(/not a valid branch name/) });
    expect(await client.call('agent.list')).toEqual([]);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('start with no task at their prompt, named new-agent-N', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();

    const first = await client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '', position: at, ...SIZE });
    const second = await client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '', position: at, ...SIZE });

    expect(first).toMatchObject({ name: 'new-agent-1', description: '' });
    expect(second.name).toBe('new-agent-2');
    expect(second.branch).toMatch(/^new-agent-2-[0-9a-f]{6}$/);
  });

  it('launch the harness with no message when the task is empty or missing', async () => {
    const { client, recorder } = await agentDaemon();
    const repo = tempRepo();

    const empty = await client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '  ', position: at, ...SIZE });
    const missing = await client.call('agent.spawn', { zoneId: null, repo: { path: repo }, position: at, ...SIZE });

    for (const agent of [empty, missing]) {
      expect(agent).toMatchObject({ description: '', state: 'idle' });
      // Its session has started (its hook arrived) but it has nothing to run.
      await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart');
      expect((await client.call('agent.list')).find((a) => a.sessionId === agent.sessionId)?.state).toBe('idle');
      const session = (await client.call('session.list')).find((s) => s.id === agent.sessionId);
      expect(commandOf(session!.pid)).not.toContain(' -- ');
    }
  });

  it('start in a new scratch repo when asked for one', async () => {
    const { client, scratchDir } = await agentDaemon();

    const agent = await client.call('agent.spawn', { zoneId: null, repo: { scratch: true }, prompt: '', position: at, ...SIZE });

    expect(agent.repoRoot).toBe(join(realpathSync(scratchDir), 'new-agent-1'));
    expect(git(agent.repoRoot, 'log', '--format=%s')).toBe('Initial commit');
    expect(existsSync(agent.worktree)).toBe(true);
  });

  it('run the model asked for, and keep it', async () => {
    const { client } = await agentDaemon();

    const agent = await client.call('agent.spawn', { zoneId: null, repo: { path: tempRepo() }, prompt: 'Go', model: 'haiku', position: at, ...SIZE });

    expect(agent.model).toBe('haiku');
    const [session] = await client.call('session.list');
    expect(commandOf(session!.pid)).toContain('--model haiku');
  });

  it('leave nothing behind when they fail to start: no scratch repo, no worktree, no recent folder', async () => {
    const { client, scratchDir } = await agentDaemon();
    const repo = tempRepo();
    const spawn = (extra: object) => client.call('agent.spawn', { zoneId: null, prompt: '', position: at, ...SIZE, ...extra });

    for (let n = 0; n < 3; n++) {
      await expect(spawn({ repo: { scratch: true }, branch: 'foo..bar' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    }
    await expect(spawn({ repo: { scratch: true }, baseBranch: 'nope' })).rejects.toMatchObject({ message: expect.stringMatching(/no branch nope/) });
    await expect(spawn({ repo: { path: repo }, baseBranch: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    expect(existsSync(scratchDir) ? readdirSync(scratchDir) : []).toEqual([]);
    expect(await client.call('zone.recentFolders')).toEqual([]);
    expect(await client.call('agent.list')).toEqual([]);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuse a model that is not a name, which would reach the harness as an option', async () => {
    const { client } = await agentDaemon();
    const spawn = (model: string) =>
      client.call('agent.spawn', { zoneId: null, repo: { path: tempRepo() }, prompt: 'Go', model, position: at, ...SIZE });

    for (const model of ['--dangerously-skip-permissions', '-m', 'opus sonnet']) {
      await expect(spawn(model)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams, message: `${model} is not a model name` });
    }
    expect((await spawn('claude-opus-5-5[1m]')).model).toBe('claude-opus-5-5[1m]');
  });

  it('keep the role they were started in, and refuse one that is not a role', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();

    const agent = await client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '', role: 'reviewer', position: at, ...SIZE });

    expect(agent.role).toBe('reviewer');
    await expect(
      client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '', role: 'boss' as never, position: at, ...SIZE }),
    ).rejects.toMatchObject({ message: 'unknown role boss' });
  });

  it('started at once with no task get names of their own, and the next name is offered beforehand', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();
    expect(await client.call('agent.nextName')).toEqual({ name: 'new-agent-1' });

    const both = await Promise.all(
      [1, 2].map(() => client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '', position: at, ...SIZE })),
    );

    expect(both.map((agent) => agent.name).sort()).toEqual(['new-agent-1', 'new-agent-2']);
    expect(await client.call('agent.nextName')).toEqual({ name: 'new-agent-3' });
  });

  it('start from an issue in a tracker group, on the board or in it, in a repo picked for them', async () => {
    const { client } = await agentDaemon();
    await client.call('tracker.connect', { provider: 'linear', credential: LINEAR_KEY });
    const group = await client.call('zone.addUnbound', { name: 'Planning', tracker: { provider: 'linear', scope: 'ACME' }, ...at });
    const repo = tempRepo();

    const inGroup = await client.call('agent.spawn', { zoneId: group.id, repo: { path: repo }, prompt: '', issueId: 'ACME-12', ...SIZE });
    const loose = await client.call('agent.spawn', {
      zoneId: null,
      repo: { path: repo },
      prompt: '',
      issueId: 'ACME-12',
      issueZoneId: group.id,
      position: at,
      ...SIZE,
    });

    expect(inGroup).toMatchObject({ zoneId: group.id, repoRoot: repo, branch: 'acme-12-spawn-agents-in-a-pty', issue: { id: 'ACME-12' } });
    expect(loose).toMatchObject({ zoneId: null, repoRoot: repo, branch: 'acme-12-spawn-agents-in-a-pty-2', issue: { id: 'ACME-12' } });
    // An agent in the group takes its issues from it, its repo having no zone of its own.
    const linked = await client.call('agent.link', { sessionId: inGroup.sessionId, issueId: 'ACME-16' });
    expect(linked.issue?.id).toBe('ACME-16');
    await expect(
      client.call('agent.spawn', { zoneId: null, repo: { path: repo }, prompt: '', issueId: 'ACME-12', position: at, ...SIZE }),
    ).rejects.toMatchObject({ message: 'only a zone with a tracker starts agents from issues' });
  });

  it('refuse to start with no repo to cut a worktree from', async () => {
    const { client } = await agentDaemon();

    await expect(client.call('agent.spawn', { zoneId: null, prompt: 'Go', position: at, ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'pick a repo to start the agent in',
    });
  });
});

describe('group zones', () => {
  it('start agents in their default repo, and ask for one when they have none', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();
    const group = await client.call('zone.addUnbound', { name: 'Onboarding', ...at });

    await expect(client.call('agent.spawn', { zoneId: group.id, prompt: 'Go', ...SIZE })).rejects.toMatchObject({
      message: 'Onboarding has no repo: pick one to start the agent in',
    });
    const withDefault = await client.call('zone.setDefaultRepo', { id: group.id, path: repo });
    expect(withDefault).toMatchObject({ kind: 'unbound', repoRoot: null, defaultRepo: repo });

    const agent = await client.call('agent.spawn', { zoneId: group.id, prompt: 'Go', ...SIZE });

    expect(agent).toMatchObject({ zoneId: group.id, repoRoot: repo });
    expect((await client.call('zone.setDefaultRepo', { id: group.id, path: null })).defaultRepo).toBeNull();
  });

  it('start an agent from the repo it is given over their default', async () => {
    const { client } = await agentDaemon();
    const group = await client.call('zone.addUnbound', { name: 'Mixed', ...at });
    await client.call('zone.setDefaultRepo', { id: group.id, path: tempRepo('one') });
    const other = tempRepo('two');

    const agent = await client.call('agent.spawn', { zoneId: group.id, repo: { path: other }, prompt: 'Go', ...SIZE });

    expect(agent).toMatchObject({ zoneId: group.id, repoRoot: other });
  });

  it('refuse a default repo outside git, or on a bound zone', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();
    const group = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    const bound = await client.call('zone.add', { path: repo, ...at });

    await expect(client.call('zone.setDefaultRepo', { id: group.id, path: tempDataDir() })).rejects.toMatchObject({
      message: expect.stringMatching(/not inside a git repository/),
    });
    await expect(client.call('zone.setDefaultRepo', { id: bound.id, path: repo })).rejects.toMatchObject({
      message: expect.stringMatching(/is bound to a repo already/),
    });
  });

  it('start shells in their default repo', async () => {
    const { client } = await agentDaemon();
    const repo = tempRepo();
    const group = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    await client.call('zone.setDefaultRepo', { id: group.id, path: join(repo, 'apps', 'web') });

    const shell = await client.call('shell.create', { zoneId: group.id });

    expect(shell.cwd).toBe(join(repo, 'apps', 'web'));
  });

  it('unbind back into a group, keeping its tracker and issue cards, and the agents in it on their own repo', async () => {
    const { client } = await agentDaemon();
    await client.call('tracker.connect', { provider: 'linear', credential: LINEAR_KEY });
    const repo = tempRepo();
    const zone = await client.call('zone.add', { path: repo, tracker: { provider: 'linear', scope: 'ACME' }, ...at });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    const [issue] = await client.call('tracker.issues', { zoneId: zone.id });
    const card = await client.call('item.create', { kind: 'issue', zoneId: zone.id, x: 0, y: 0, width: 280, height: 120, data: { ...issue! } });

    const group = await client.call('zone.unbind', { id: zone.id });

    expect(group).toMatchObject({ kind: 'unbound', repoRoot: null, folder: '', tracker: { provider: 'linear', scope: 'ACME' }, defaultRepo: null });
    expect(await client.call('item.list')).toEqual([card]);
    // Its issues still start agents, in a repo picked for each.
    const fromIssue = await client.call('agent.spawn', { zoneId: zone.id, repo: { path: repo }, prompt: '', issueId: issue!.id, ...SIZE });
    expect(fromIssue.issue?.id).toBe(issue!.id);
    expect((await client.call('agent.list'))[0]).toMatchObject({ sessionId: agent.sessionId, zoneId: zone.id, repoRoot: repo });
    const rebound = await client.call('zone.bind', { id: zone.id, as: 'repo', path: repo });
    expect(rebound).toMatchObject({ kind: 'repo', repoRoot: repo });
  });

  it('refuse to unbind an unknown zone', async () => {
    const { client } = await agentDaemon();

    await expect(client.call('zone.unbind', { id: 'nope' })).rejects.toMatchObject({ message: 'no zone nope' });
  });

  it('keep their default repo across a restart', async () => {
    const dataDir = tempDataDir();
    const repo = tempRepo();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    const group = await before.call('zone.addUnbound', { name: 'Ideas', ...at });
    await before.call('zone.setDefaultRepo', { id: group.id, path: repo });
    before.close();
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir }));

    expect((await after.call('zone.list'))[0]).toMatchObject({ id: group.id, defaultRepo: repo });
  });
});
