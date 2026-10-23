import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, type FakeHarnessEnvOptions } from '@agent-board/fake-harness';
import { createFakeTracker } from '@agent-board/tracker/testing';
import type { DaemonClient } from '../src/client.ts';
import {
  type AgentStart,
  type AgentStartingEvent,
  type AgentUpdatedEvent,
  type DaemonEvent,
} from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A daemon whose agents run the fake harnesses, starting as `fake` says, with a fake Linear. */
async function startDaemon(fake: Pick<FakeHarnessEnvOptions, 'startDelayMs' | 'startFailure'> = {}, startStepTimeoutMs?: number) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), ...fake }),
    trackers: { linear: () => createFakeTracker() },
    ...(startStepTimeoutMs === undefined ? {} : { startStepTimeoutMs }),
  });
  const client = await connectTestClient(daemon);
  return { client, recorder: recordEvents(client) };
}

async function addZone(client: DaemonClient, path: string) {
  return client.call('zone.add', { path, x: 0, y: 0 });
}

function commit(repo: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'add files');
}

/** A repo whose `git worktree add` takes `ms` longer, as on a slow disk: its checkout hook sleeps. */
function slowRepo(ms: number): string {
  const repo = tempRepo();
  const hook = join(repo, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\nsleep ${ms / 1000}\n`);
  chmodSync(hook, 0o755);
  return repo;
}

const isStarting = (sessionId: string) => (event: DaemonEvent): event is AgentStartingEvent =>
  event.type === 'agent.starting' && event.start.sessionId === sessionId;

/** The steps the start's tile showed, in order, as `kind:state`. */
function stepsShown(events: readonly DaemonEvent[], sessionId: string): string[] {
  const shown: string[] = [];
  for (const event of events) {
    if (!isStarting(sessionId)(event)) continue;
    for (const step of event.start.steps) {
      const line = `${step.kind}:${step.state}`;
      if (!shown.includes(line)) shown.push(line);
    }
  }
  return shown;
}

async function untilFailed(recorder: ReturnType<typeof recordEvents>, sessionId: string): Promise<AgentStart> {
  const event = await recorder.waitFor((event): event is AgentStartingEvent => isStarting(sessionId)(event) && event.start.error !== null);
  return event.start;
}

const isUpdate = (sessionId: string) => (event: DaemonEvent): event is AgentUpdatedEvent =>
  event.type === 'agent.updated' && event.agent.sessionId === sessionId;

describe('starting an agent', () => {
  it('tells every client of its tile well under a second after it is asked for, before any git runs for it', async () => {
    const { client } = await startDaemon();
    const zone = await addZone(client, slowRepo(1500));
    let heard: number | undefined;
    client.onEvent((event) => {
      if (event.type === 'agent.starting') heard ??= Date.now();
    });

    const asked = Date.now();
    // A typed branch and a base, each checked by git, and a slow checkout: none is waited on before the tile.
    await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', branch: 'agent/go', baseBranch: 'main', ...SIZE });
    await expect.poll(() => heard).toBeDefined();
    expect(heard! - asked).toBeLessThan(500);
  });

  it('puts its tile on the board before its worktree exists, shows each step, then turns it into the agent', async () => {
    const { client, recorder } = await startDaemon();
    const zone = await addZone(client, slowRepo(1500));

    const asked = Date.now();
    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Pick a cache for the job queue', ...SIZE });
    // Answered at once, while git is still making its worktree.
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(await client.call('agent.list')).toEqual([]);
    expect(await client.call('agent.starts')).toEqual([
      expect.objectContaining({ sessionId, zoneId: zone.id, name: 'Pick a cache for the job queue', harness: 'claude', error: null }),
    ]);
    const first = recorder.events.find(isStarting(sessionId))!;
    expect(first.start.steps).toEqual([]);

    const agent = await recorder.waitFor((event): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === sessionId);
    expect(stepsShown(recorder.events, sessionId)).toEqual(['worktree:now', 'worktree:done', 'launch:now']);
    const done = recorder.events.filter(isStarting(sessionId)).at(-1)!.start.steps.find((step) => step.kind === 'worktree');
    expect(done).toEqual({ kind: 'worktree', state: 'done', detail: agent.agent.branch });
    // The agent is told first, then the start is over: the board never shows neither.
    const ended = recorder.events.findIndex((event) => event.type === 'agent.startEnded' && event.sessionId === sessionId);
    expect(ended).toBeGreaterThan(recorder.events.indexOf(agent));
    expect(await client.call('agent.starts')).toEqual([]);
  });

  it('shows the last line its harness printed while it starts, until its first hook', async () => {
    const { client, recorder } = await startDaemon({ startDelayMs: 1500 });
    const zone = await addZone(client, tempRepo());

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });

    const starting = await recorder.waitFor(
      (event): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === sessionId && event.agent.startup?.output != null,
    );
    expect(starting.agent).toMatchObject({ state: 'starting', startup: { output: 'claude is starting', failed: false } });
    const up = await recorder.waitFor(
      (event): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === sessionId && event.agent.state !== 'starting',
    );
    expect(up.agent.startup).toBeNull();
  });

  it('keeps a harness that exits before its first hook as a failed start, with what it printed', async () => {
    const { client, recorder } = await startDaemon({ startFailure: 'ANTHROPIC_API_KEY not set' });
    const zone = await addZone(client, tempRepo());

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });

    const failed = await recorder.waitFor(
      (event): event is AgentUpdatedEvent =>
        event.type === 'agent.updated' && event.agent.sessionId === sessionId && event.agent.startup?.output === 'ANTHROPIC_API_KEY not set',
    );
    expect(failed.agent).toMatchObject({ exitCode: 1, startup: { failed: true } });
    expect(failed.agent.endedAt).not.toBeNull();
  });

  it('keeps a start that fails with its error, undoing what it made, and starts it again on retry', async () => {
    const { client, recorder } = await startDaemon();
    const repo = tempRepo();
    const zone = await addZone(client, repo);

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', baseBranch: 'no-such-branch', ...SIZE });

    const failed = await untilFailed(recorder, sessionId);
    expect(failed.error).toMatch(/no-such-branch/);
    expect(failed.confirm).toBe(false);
    expect(failed.steps).toEqual([{ kind: 'worktree', state: 'failed', detail: null }]);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(await client.call('agent.starts')).toEqual([failed]);

    // It fails the same way again: its tile shows the new try, then the error.
    const before = recorder.events.length;
    await client.call('agent.retryStart', { sessionId });
    const retried = recorder.events.slice(before).find(isStarting(sessionId))!;
    expect(retried.start).toMatchObject({ error: null, steps: [] });
    await recorder.waitFor((event): event is AgentStartingEvent => isStarting(sessionId)(event) && event.start.error !== null && recorder.events.indexOf(event) > before);

    await client.call('agent.dismissStart', { sessionId });
    expect(recorder.events.at(-1)).toEqual({ type: 'agent.startEnded', sessionId });
    expect(await client.call('agent.starts')).toEqual([]);
  });

  it('refuses a retry of a start still going, and what fails its checks before the tile', async () => {
    const { client } = await startDaemon();
    const zone = await addZone(client, slowRepo(1000));

    await expect(client.call('agent.start', { zoneId: zone.id, model: '--bad', prompt: 'Go', ...SIZE })).rejects.toThrow(/not a model name/);
    expect(await client.call('agent.starts')).toEqual([]);

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await expect(client.call('agent.retryStart', { sessionId })).rejects.toThrow(/still starting/);
    await expect(client.call('agent.retryStart', { sessionId: 'nope' })).rejects.toThrow(/no agent being started/);
  });

  it('stops a start dismissed while it runs before its session would start, leaving no worktree', async () => {
    const { client, recorder } = await startDaemon();
    const repo = slowRepo(1000);
    const zone = await addZone(client, repo);

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await client.call('agent.dismissStart', { sessionId });
    expect(await client.call('agent.starts')).toEqual([]);

    // Once git is done, the worktree it made is undone, and no agent is started.
    await expect.poll(() => git(repo, 'worktree', 'list').split('\n').length, { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await client.call('agent.list')).toEqual([]);
    expect(recorder.events.some((event) => event.type === 'agent.updated')).toBe(false);
  });

  it('asks to confirm Codex config of the worktree on its failed tile, and starts once confirmed', async () => {
    const { client, recorder } = await startDaemon();
    const repo = tempRepo();
    commit(repo, { '.codex/hooks.json': '{}\n' });
    const zone = await addZone(client, repo);

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, harness: 'codex', prompt: 'Go', ...SIZE });

    const failed = await untilFailed(recorder, sessionId);
    expect(failed).toMatchObject({ confirm: true, error: expect.stringMatching(/trusting all of them trusts both/) });
    expect(failed.steps.map((step) => `${step.kind}:${step.state}`)).toEqual(['worktree:done', 'launch:failed']);

    await client.call('agent.retryStart', { sessionId, allowProjectCodexConfig: true });
    const agent = await recorder.waitFor((event): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === sessionId);
    expect(agent.agent.harness).toBe('codex');
  });

  it('dismisses the starts of a zone removed while they run: no harness runs on, and nothing is left behind', async () => {
    const { client, recorder } = await startDaemon();
    const repo = slowRepo(1500);
    const zone = await addZone(client, repo);

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await client.call('zone.remove', { id: zone.id });
    expect(recorder.events.some((event) => event.type === 'agent.startEnded' && event.sessionId === sessionId)).toBe(true);
    expect(await client.call('agent.starts')).toEqual([]);

    await expect.poll(() => git(repo, 'worktree', 'list').split('\n').length, { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await client.call('session.list')).some((session) => session.id === sessionId)).toBe(false);
    expect(await client.call('agent.list')).toEqual([]);
  });

  it('tells a start the daemon does not know as over, so no client keeps its tile after a restart', async () => {
    const { client, recorder } = await startDaemon();

    await client.call('agent.dismissStart', { sessionId: 'gone-with-the-last-daemon' });
    expect(recorder.events.at(-1)).toEqual({ type: 'agent.startEnded', sessionId: 'gone-with-the-last-daemon' });
  });

  it('fails a step that takes too long, with Retry, and undoes what it made once it is done', async () => {
    const { client, recorder } = await startDaemon({}, 300);
    const repo = slowRepo(1500);
    const zone = await addZone(client, repo);

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });

    const failed = await untilFailed(recorder, sessionId);
    expect(failed.error).toBe('creating the worktree took longer than 0.3 s');
    expect(failed.steps).toEqual([{ kind: 'worktree', state: 'failed', detail: null }]);
    await expect.poll(() => git(repo, 'worktree', 'list').split('\n').length, { timeout: 10_000 }).toBe(1);
  });

  it('gives the agent the name and place its tile was given while it started', async () => {
    const { client, recorder } = await startDaemon();
    const zone = await addZone(client, slowRepo(1000));

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await client.call('agent.updateStart', { sessionId, name: 'Renamed', move: { zoneId: zone.id, x: 300, y: 40 } });
    expect((await client.call('agent.starts'))[0]).toMatchObject({ name: 'Renamed', position: { x: 300, y: 40 } });

    const agent = await recorder.waitFor(isUpdate(sessionId));
    expect(agent.agent).toMatchObject({ name: 'Renamed', zoneId: zone.id, position: { x: 300, y: 40 } });
    // Its branch was named before: renaming an agent never renames its branch.
    expect(agent.agent.branch).toMatch(/^go-/);
  });

  it('retries a harness that exited as it started with the same first message, and shows a second failure the same way', async () => {
    const { client, recorder } = await startDaemon({ startFailure: 'ANTHROPIC_API_KEY not set' });
    const zone = await addZone(client, tempRepo());

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', role: 'implementer', ...SIZE });
    const failed = (event: DaemonEvent): event is AgentUpdatedEvent =>
      isUpdate(sessionId)(event) && event.agent.startup?.failed === true && event.agent.startup.output === 'ANTHROPIC_API_KEY not set';
    await recorder.waitFor(failed);

    const before = recorder.events.length;
    await client.call('agent.retryStart', { sessionId });
    // Starting again: its tile shows the start, not a plain ended agent, and then fails again.
    await recorder.waitFor((event): event is AgentUpdatedEvent => isUpdate(sessionId)(event) && event.agent.state === 'starting' && recorder.events.indexOf(event) >= before);
    await recorder.waitFor((event): event is AgentUpdatedEvent => failed(event) && recorder.events.indexOf(event) >= before);
    // Its first message again, the implementer's template first, as the fake shows from its saved screen.
    await client.call('session.attach', { sessionId });
    await recorder.waitForText(sessionId, 'task: You are the implementer');
  });

  it('puts up a start tile for agent.spawn, as orchestrators and Ask Claude use, and shows an issue step', async () => {
    const { client, recorder } = await startDaemon();
    await client.call('tracker.connect', { provider: 'linear', credential: 'lin_api_good' });
    const zone = await client.call('zone.add', { path: tempRepo(), tracker: { provider: 'linear', scope: 'OPS' }, x: 0, y: 0 });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: '', issueId: 'OPS-3', ...SIZE });

    const first = recorder.events.findIndex(isStarting(agent.sessionId));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(recorder.events.findIndex(isUpdate(agent.sessionId)));
    expect(stepsShown(recorder.events, agent.sessionId)).toEqual(['issue:now', 'issue:done', 'worktree:now', 'worktree:done', 'launch:now']);
    // Shown by its issue's id first, then named after the issue once it is read.
    expect(recorder.events.find(isStarting(agent.sessionId))!.start.name).toBe('OPS-3');
    expect(agent.name).toMatch(/^OPS-3: /);
  });

  it('carries on loose on the board when its zone is deleted from the board (dissolved) while it starts', async () => {
    const { client, recorder } = await startDaemon();
    const zone = await addZone(client, slowRepo(1500));

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await client.call('zone.dissolve', { id: zone.id });
    expect((await client.call('agent.starts'))[0]).toMatchObject({ sessionId, zoneId: null, error: null });

    const agent = await recorder.waitFor(isUpdate(sessionId));
    expect(agent.agent.zoneId).toBeNull();
    expect(agent.agent.position).not.toBeNull();
    expect(await client.call('agent.starts')).toEqual([]);
  });

  it('refuses to move a start into a zone that does not exist', async () => {
    const { client } = await startDaemon();
    const zone = await addZone(client, slowRepo(1000));

    const { sessionId } = await client.call('agent.start', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await expect(client.call('agent.updateStart', { sessionId, move: { zoneId: 'no-such-zone', x: 0, y: 0 } })).rejects.toThrow(/no zone no-such-zone/);
    expect((await client.call('agent.starts'))[0]).toMatchObject({ zoneId: zone.id });
  });
});
