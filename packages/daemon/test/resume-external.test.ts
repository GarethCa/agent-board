import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { DaemonRpcError, type DaemonClient } from '../src/client.ts';
import { AGENT_ERROR, type DaemonEvent, type ExternalUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

/** A daemon whose global hooks, and whose agents' `~`, are a temp home: never the real ~/.claude or ~/.codex. */
async function externalDaemon() {
  const home = tempDataDir();
  const daemon = await startTestDaemon({
    externalHookFiles: { claude: join(home, '.claude', 'settings.json'), codex: join(home, '.codex', 'hooks.json') },
    externalHookFile: join(tempDataDir(), 'external-hook.json'),
    agentEnv: fakeHarnessEnv({ scenario: 'output', home }),
  });
  const client = await connectTestClient(daemon);
  await client.call('externalHooks.setEnabled', { enabled: true });
  return { daemon, client, recorder: recordEvents(client), home };
}

/** Runs the fake `command` in `cwd` as if from another terminal, with `home` as `~`, until it exits. */
function runElsewhere(command: string, args: string[], cwd: string, home: string, scenario: FakeScenario = 'output') {
  const child = spawn(command, args, { cwd, env: fakeHarnessEnv({ scenario, home }) });
  child.stdout.resume();
  child.stderr.resume();
  return new Promise<number | null>((resolve) => child.on('close', resolve));
}

/** Starts the fake claude at its prompt in `cwd`, as if in another terminal, and ends it when the test does. */
function claudeLiveElsewhere(cwd: string, home: string) {
  const child = spawn('claude', ['Pick a database'], { cwd, env: fakeHarnessEnv({ scenario: 'waiting', home }) });
  child.stdout.resume();
  child.stderr.resume();
  onTestFinished(() => void child.kill());
}

const isExternalUpdate = (event: DaemonEvent): event is ExternalUpdatedEvent => event.type === 'external.updated';
const ended = (event: DaemonEvent): event is ExternalUpdatedEvent => isExternalUpdate(event) && event.session.endedAt !== null;

// Where the board drew the tile, for one it slotted into "Unsorted".
/** Waits for the agent's terminal to show the conversation it had elsewhere: the fake shows it again on resuming. */
async function showsConversation(client: DaemonClient, recorder: ReturnType<typeof recordEvents>, sessionId: string) {
  await client.call('session.attach', { sessionId });
  await recorder.waitForText(sessionId, 'Tidy the README');
}

const TERMINAL = { cols: 80, rows: 24, position: { x: 0, y: 0 } };

describe('resuming an external session in agent-board', { timeout: 30_000 }, () => {
  it('adopts an ended claude session as a managed agent with the same session id, in its folder and zone', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], repo, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');

    const plan = await client.call('external.resumePlan', { id: external!.id });
    expect(plan).toEqual({
      cwd: repo,
      cwdExists: true,
      repo: { root: repo, worktree: repo, branch: git(repo, 'branch', '--show-current'), main: true },
      liveElsewhere: false,
    });

    const agent = await client.call('external.resume', { id: external!.id, where: 'here', ...TERMINAL });
    expect(agent).toMatchObject({
      sessionId: external!.sessionId,
      harness: 'claude',
      zoneId: zone.id,
      cwd: repo,
      worktree: repo,
      repoRoot: repo,
      ownsWorktree: false,
      endedAt: null,
      description: 'Tidy the README',
    });
    // It carries on the conversation it had: the fake claude shows it again on --resume.
    await showsConversation(client, recorder, agent.sessionId);
    // Replaced, not duplicated.
    expect(await client.call('external.list')).toEqual([]);
    expect(recorder.events).toContainEqual({ type: 'external.removed', id: external!.id });
    expect((await client.call('agent.list')).map((a) => a.sessionId)).toEqual([agent.sessionId]);

    // Removing it from the board leaves the user's own checkout alone, uncommitted work and all.
    await client.call('agent.delete', { sessionId: agent.sessionId });
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect(git(repo, 'branch', '--show-current')).toBe(plan.repo!.branch);
  });

  it('keeps the tile where it was put, and its connectors', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], repo, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');
    // In the Unsorted group, with no place yet: the board says where it is drawn.
    expect(external).toMatchObject({ zoneId: expect.any(String), position: null });
    const note = await client.call('item.create', { kind: 'sticky', zoneId: null, x: 900, y: 0, width: 200, height: 120, data: { text: 'hi', color: '#ffe680' } });
    const connector = await client.call('connector.create', {
      from: { type: 'external', id: external!.id, side: 'right' },
      to: { type: 'item', id: note.id, side: 'left' },
    });

    const agent = await client.call('external.resume', { id: external!.id, where: 'here', ...TERMINAL, position: { x: 400, y: 200 } });
    expect(agent).toMatchObject({ zoneId: external!.zoneId, position: { x: 400, y: 200 } });
    const [moved] = await client.call('connector.list');
    expect(moved).toMatchObject({ id: connector.id, from: { type: 'agent', id: agent.sessionId }, to: { type: 'item', id: note.id } });
  });

  it('warns when the session may still be running elsewhere, and only resumes it when told to', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    claudeLiveElsewhere(repo, home);
    await recorder.waitFor((e): e is ExternalUpdatedEvent => isExternalUpdate(e) && e.session.state === 'waiting');
    const [external] = await client.call('external.list');

    expect(await client.call('external.resumePlan', { id: external!.id })).toMatchObject({ liveElsewhere: true });
    const error = await client.call('external.resume', { id: external!.id, where: 'here', ...TERMINAL }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as DaemonRpcError).code).toBe(AGENT_ERROR.liveElsewhere);
    expect(await client.call('external.list')).toHaveLength(1);

    const agent = await client.call('external.resume', { id: external!.id, where: 'here', force: true, ...TERMINAL });
    expect(agent.sessionId).toBe(external!.sessionId);
    // Its hooks from the other terminal no longer make an external tile of it.
    expect(await client.call('external.list')).toEqual([]);
  });

  it("counts a transcript written after the session's end as running elsewhere, past a grace for its last writes", async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], repo, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');
    const transcript = join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), `${external!.sessionId}.jsonl`);
    const writtenAt = (ms: number) => utimesSync(transcript, new Date(ms), new Date(ms));
    const endedAt = Date.parse(external!.endedAt!);

    writtenAt(endedAt + 1_000);
    expect(await client.call('external.resumePlan', { id: external!.id })).toMatchObject({ liveElsewhere: false });
    // Resumed in another terminal with the global hooks off: only its transcript says so.
    writtenAt(endedAt + 10_000);
    expect(await client.call('external.resumePlan', { id: external!.id })).toMatchObject({ liveElsewhere: true });
  });

  it('cuts a new worktree from the commit a detached session is on', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'second');
    const detached = join(tempDataDir(), 'wt');
    git(repo, 'worktree', 'add', '--quiet', '--detach', detached, first);
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], detached, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');
    expect(await client.call('external.resumePlan', { id: external!.id })).toMatchObject({ repo: { branch: null, main: false } });

    const agent = await client.call('external.resume', { id: external!.id, where: 'new-worktree', ...TERMINAL });
    expect(agent.branch).toBe('wt-resumed');
    expect(git(agent.worktree, 'rev-parse', 'HEAD')).toBe(first);
  });

  it('says when the folder is gone, and resumes it in a new worktree cut from its branch instead', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    const branch = git(repo, 'branch', '--show-current');
    const web = join(repo, 'apps', 'web');
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], web, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');
    rmSync(web, { recursive: true });

    const plan = await client.call('external.resumePlan', { id: external!.id });
    expect(plan).toMatchObject({ cwd: web, cwdExists: false, repo: { root: repo, branch } });
    const error = await client.call('external.resume', { id: external!.id, where: 'here', ...TERMINAL }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as Error).message).toContain(web);

    const agent = await client.call('external.resume', { id: external!.id, where: 'new-worktree', ...TERMINAL });
    expect(agent).toMatchObject({ sessionId: external!.sessionId, repoRoot: repo, ownsWorktree: true, cwd: join(agent.worktree, 'apps', 'web') });
    expect(agent.worktree).not.toBe(repo);
    expect(agent.branch).not.toBe(branch);
    expect(git(agent.worktree, 'merge-base', 'HEAD', branch)).toBe(git(repo, 'rev-parse', branch));
    // Its conversation is carried over to the new folder, so --resume finds it there.
    await showsConversation(client, recorder, agent.sessionId);
  });

  it('resumes in a folder the user picks', async () => {
    const { client, recorder, home } = await externalDaemon();
    const gone = tempRepo('app');
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], gone, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');
    rmSync(gone, { recursive: true });
    const elsewhere = tempRepo('other');

    const agent = await client.call('external.resume', { id: external!.id, where: { folder: elsewhere }, ...TERMINAL });
    expect(agent).toMatchObject({ cwd: elsewhere, worktree: elsewhere, repoRoot: elsewhere, ownsWorktree: false });
    await showsConversation(client, recorder, agent.sessionId);
  });

  it('offers no new worktree outside git, and resumes there in place', async () => {
    const { client, recorder, home } = await externalDaemon();
    const folder = tempDataDir();
    expect(await runElsewhere('claude', ['-p', 'Tidy the README'], folder, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');

    expect(await client.call('external.resumePlan', { id: external!.id })).toMatchObject({ cwdExists: true, repo: null });
    const refused = await client.call('external.resume', { id: external!.id, where: 'new-worktree', ...TERMINAL }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DaemonRpcError);
    const agent = await client.call('external.resume', { id: external!.id, where: 'here', ...TERMINAL });
    expect(agent).toMatchObject({ cwd: folder, ownsWorktree: false, branch: '' });
    // With no repo or branch, it has no work to review.
    const review = await client.call('review.start', { sessionId: agent.sessionId }).catch((e: unknown) => e);
    expect(review).toBeInstanceOf(DaemonRpcError);
    expect((review as Error).message).toContain('no branch');
    await client.call('agent.delete', { sessionId: agent.sessionId });
    expect(existsSync(folder)).toBe(true);
  });

  it('adopts a codex session, carrying on its conversation with codex resume', async () => {
    const { client, recorder, home } = await externalDaemon();
    const repo = tempRepo('app');
    // The fake codex runs user hooks only once trusted; the flag stands in for the user trusting them in its review.
    expect(await runElsewhere('codex', ['exec', '--dangerously-bypass-hook-trust', 'Tidy the README'], repo, home)).toBe(0);
    await recorder.waitFor(ended);
    const [external] = await client.call('external.list');

    const agent = await client.call('external.resume', { id: external!.id, where: 'here', ...TERMINAL });
    expect(agent).toMatchObject({ sessionId: external!.sessionId, harness: 'codex' });
    await showsConversation(client, recorder, agent.sessionId);
    // Resumed, not started afresh: one rollout, the one it had.
    await recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.updated' && e.agent.state === 'idle' && e.agent.endedAt === null);
    expect((await client.call('agent.list'))[0]!.notice).toBeNull();
    const rollouts = readdirSync(join(home, '.codex', 'sessions'), { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
    expect(rollouts).toHaveLength(1);
  });
});
