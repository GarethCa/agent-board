// Agents in a group with no repo: they run in the group's own folder, outside git, with no worktree or branch, and
// nothing the app does to them runs git there or deletes a folder it didn't make for them.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import * as gitModule from '../src/git.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { newAgent, openBoardSession } from '../src/board-ops.ts';
import { RPC_ERROR, type HookEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

vi.mock('../src/git.ts', async (importOriginal) => {
  const original = await importOriginal<typeof gitModule>();
  return { ...original, runGit: vi.fn(original.runGit) };
});

const SIZE = { cols: 120, rows: 40 };
const at = { x: 40, y: 80 };

/** The folders git was run in since the test started. */
const gitDirs = () => vi.mocked(gitModule.runGit).mock.calls.map(([dir]) => dir);
/** Whether `dir` is `folder` or inside it. */
const within = (dir: string, folder: string) => !relative(folder, dir).startsWith('..');

async function setup(dataDir = tempDataDir()) {
  vi.mocked(gitModule.runGit).mockClear();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  return { daemon, client, recorder, dataDir };
}

describe('an agent in a group with no repo', () => {
  it('starts in the group’s own folder, outside git, with no worktree or branch', async () => {
    const { client, recorder, dataDir } = await setup();
    const group = await client.call('zone.addUnbound', { name: 'Local Banking', ...at });

    const agent = await client.call('agent.spawn', { zoneId: group.id, role: 'orchestrator', orchestrate: 'zone', prompt: 'Plan it', ...SIZE });
    // What its hooks set off (branch reads, pull request lookups) has had its turn too.
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop');

    expect(agent.worktree.startsWith(dataDir)).toBe(true);
    expect(agent).toMatchObject({ zoneId: group.id, plainFolder: true, ownsWorktree: false, branch: '', ownedBranch: '', repoRoot: agent.worktree, cwd: agent.worktree });
    expect(existsSync(agent.worktree)).toBe(true);
    expect(existsSync(join(agent.worktree, '.git'))).toBe(false);
    expect(gitDirs().filter((dir) => within(dir, agent.worktree))).toEqual([]);
  });

  it('shares the group’s folder with the group’s other no-repo agents, as a checkout to read', async () => {
    const { client } = await setup();
    const group = await client.call('zone.addUnbound', { name: 'Local Banking', ...at });

    const first = await client.call('agent.spawn', { zoneId: group.id, prompt: 'One', ...SIZE });
    const second = await client.call('agent.spawn', { zoneId: group.id, prompt: 'Two', ...SIZE });

    expect(second.worktree).toBe(first.worktree);
    expect((await client.call('zone.list')).find((zone) => zone.id === group.id)).toMatchObject({ groupFolder: first.worktree });
  });

  it('takes no branch, base branch, main checkout or reviewer role: there is no repo', async () => {
    const { client } = await setup();
    const group = await client.call('zone.addUnbound', { name: 'Local Banking', ...at });

    for (const asked of [{ branch: 'mine' }, { baseBranch: 'main' }, { role: 'reviewer' }]) {
      await expect(client.call('agent.spawn', { zoneId: group.id, prompt: 'Go', ...asked, ...SIZE })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringContaining('Local Banking has no repo'),
      });
    }
    // The checkout it would work in is its folder: a main checkout asks nothing more of it.
    const orchestrator = await client.call('agent.spawn', { zoneId: group.id, role: 'orchestrator', orchestrate: 'zone', checkout: 'main', ...SIZE });
    expect(orchestrator).toMatchObject({ plainFolder: true, branch: '' });
  });

  it('leaves its folder and what is in it when deleted, forced or not, and finds it again after a restart', async () => {
    const dataDir = tempDataDir();
    const before = await setup(dataDir);
    const group = await before.client.call('zone.addUnbound', { name: 'Local Banking', ...at });
    const first = await before.client.call('agent.spawn', { zoneId: group.id, prompt: 'One', ...SIZE });
    writeFileSync(join(first.worktree, 'notes.md'), 'kept\n');

    await before.client.call('agent.delete', { sessionId: first.sessionId });
    const second = await before.client.call('agent.spawn', { zoneId: group.id, prompt: 'Two', ...SIZE });
    await before.client.call('agent.delete', { sessionId: second.sessionId, force: true });
    expect(readdirSync(first.worktree)).toContain('notes.md');
    await before.daemon.stop();

    const after = await setup(dataDir);
    const third = await after.client.call('agent.spawn', { zoneId: group.id, prompt: 'Three', ...SIZE });
    expect(third.worktree).toBe(first.worktree);
    expect(readdirSync(third.worktree)).toContain('notes.md');
    expect(gitDirs().filter((dir) => within(dir, first.worktree))).toEqual([]);
  });

  it('has no gate to run, and no reviewer of its work', async () => {
    const { client } = await setup();
    const group = await client.call('zone.addUnbound', { name: 'Local Banking', ...at });
    await client.call('zone.configure', { id: group.id, gateCommand: 'true' });
    const agent = await client.call('agent.spawn', { zoneId: group.id, prompt: 'One', ...SIZE });

    await expect(client.call('gate.run', { sessionId: agent.sessionId })).rejects.toMatchObject({ message: expect.stringContaining('no repo') });
    await expect(client.call('review.start', { sessionId: agent.sessionId, ...SIZE })).rejects.toMatchObject({ message: expect.stringContaining('outside git') });
    expect(gitDirs().filter((dir) => within(dir, agent.worktree))).toEqual([]);
  });
});

describe('an orchestrator in a group with no repo', () => {
  /** An orchestrator in a no-repo group that prints its board token, and a connection as it. */
  async function lead() {
    const ctx = await setup();
    const group = await ctx.client.call('zone.addUnbound', { name: 'Local Banking', ...at });
    await ctx.client.call('zone.configure', { id: group.id, agentsOrchestrate: true });
    const agent = await ctx.client.call('agent.spawn', { zoneId: group.id, role: 'orchestrator', orchestrate: 'zone', noTemplate: true, prompt: 'Print your board identity', ...SIZE });
    await ctx.client.call('session.attach', { sessionId: agent.sessionId });
    await ctx.recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(ctx.recorder.screenText(agent.sessionId))![1]!;
    const connection = await connectTestClient(ctx.daemon);
    await connection.call('board.identify', { token });
    return { ...ctx, group, agent, token, connection };
  }

  it('starts a crew member in a worktree of the repo it names', async () => {
    const { connection, token, group, agent } = await lead();
    const repo = tempRepo('bank');

    const crew = await connection.call('orchestrator.spawn', { token, name: 'ledger', repo, prompt: 'Fix it' });

    expect(crew).toMatchObject({ zoneId: group.id, repoRoot: repo, ownsWorktree: true, plainFolder: false, spawnedBy: agent.sessionId });
    expect(crew.branch).not.toBe('');
    // Git runs where there is a repo: what the other tests find absent is absent from the folder alone.
    expect(gitDirs().some((dir) => within(dir, repo))).toBe(true);
  });

  it('starts a crew member with no repo named in the group’s folder too', async () => {
    const { connection, token, agent } = await lead();

    const crew = await connection.call('orchestrator.spawn', { token, name: 'notes', prompt: 'Write it up' });

    expect(crew).toMatchObject({ plainFolder: true, worktree: agent.worktree, branch: '', ownsWorktree: false });
  });

  it('refuses a repo for a crew member in a zone bound to its own', async () => {
    const { client, connection, token } = await lead();
    const bound = await client.call('zone.add', { path: tempRepo('bound'), name: 'bound', ...at });
    await client.call('agent.setOrchestrate', { sessionId: (await client.call('agent.list'))[0]!.sessionId, scope: 'board' });

    await expect(connection.call('orchestrator.spawn', { token, zoneId: bound.id, repo: tempRepo('elsewhere'), prompt: 'Go' })).rejects.toMatchObject({
      message: expect.stringContaining('is bound to its own repo'),
    });
  });

  it('refuses a repo that is not an absolute path, before running git anywhere', async () => {
    const { connection, token } = await lead();
    const before = gitDirs().length;

    await expect(connection.call('orchestrator.spawn', { token, repo: 'relative/x', baseBranch: 'main', prompt: 'Go' })).rejects.toMatchObject({
      message: 'repo path must be absolute, got relative/x',
    });
    expect(gitDirs().slice(before)).toEqual([]);
  });

  /** A crew member the lead starts in `repo`, then a reviewer it starts from that member's branch, as `agent-board new` does. */
  async function reviewOfCrew(ctx: Awaited<ReturnType<typeof lead>>, repo: string) {
    const crew = await ctx.connection.call('orchestrator.spawn', { token: ctx.token, name: 'ledger', repo, prompt: 'Fix it' });
    const session = await openBoardSession({ [BOARD_SOCKET_ENV]: ctx.daemon.socketPath, [BOARD_TOKEN_ENV]: ctx.token });
    try {
      const started = await newAgent(session, { prompt: 'Review it', name: 'review', role: 'reviewer', base: 'agent:ledger' });
      return { crew, reviewer: started.json as { repoRoot: string; reviews: { branch: string } | null } };
    } finally {
      session.close();
    }
  }

  it('starts a reviewer of a crew member in that member’s repo', async () => {
    const ctx = await lead();
    const repo = tempRepo('bank');

    const { crew, reviewer } = await reviewOfCrew(ctx, repo);

    expect(reviewer).toMatchObject({ repoRoot: repo, reviews: { branch: crew.branch } });
  });

  it('starts a reviewer of a crew member in that member’s repo, not the group’s default', async () => {
    const ctx = await lead();
    await ctx.client.call('zone.setDefaultRepo', { id: ctx.group.id, path: tempRepo('default') });
    const repo = tempRepo('bank');

    const { crew, reviewer } = await reviewOfCrew(ctx, repo);

    expect(crew.repoRoot).toBe(repo);
    expect(reviewer).toMatchObject({ repoRoot: repo, reviews: { branch: crew.branch } });
  });
});
