import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { DaemonRpcError, type DaemonClient } from '../src/client.ts';
import { claudeSettings } from '../src/agent-spawns.ts';
import { HOOK_TOKEN_ENV, HOOK_URL_ENV } from '../src/hook-forwarder.ts';
import { daemonPaths } from '../src/paths.ts';
import { isProcessAlive } from '../src/pid.ts';
import {
  AGENT_ERROR,
  MAX_NAME_LENGTH,
  RPC_ERROR,
  type Agent,
  type AgentState,
  type AgentUpdatedEvent,
  type DaemonEvent,
  type Harness,
  type HookEvent,
  type PermissionPrompt,
  type SessionExitedEvent,
} from '../src/protocol.ts';
import type { Clock } from '../src/clock.ts';
import { createFakeClock } from './fake-clock.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** A daemon whose agents run the fake claude with `scenario`, with their worktrees under a temp dir. */
async function agentDaemon(
  scenario: FakeScenario,
  options: {
    idleNotifyMs?: number;
    stepDelayMs?: number;
    dataDir?: string;
    permissionHoldMs?: number;
    clock?: Clock;
    repeat?: boolean;
    /** The fake harnesses' home, where they keep their conversations: a fresh one by default. */
    home?: string;
    /** Where the daemon's log lines go: nowhere by default. */
    log?: (message: string) => void;
  } = {},
) {
  const home = options.home ?? tempDataDir();
  const worktreesDir = tempDataDir();
  const dataDir = options.dataDir ?? tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir,
    agentEnv: fakeHarnessEnv({
      scenario,
      home,
      idleNotifyMs: options.idleNotifyMs ?? 200,
      stepDelayMs: options.stepDelayMs,
      repeat: options.repeat,
    }),
    permissionHoldMs: options.permissionHoldMs,
    clock: options.clock,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client), worktreesDir, dataDir, home };
}

const isAgentUpdate = (event: DaemonEvent): event is AgentUpdatedEvent => event.type === 'agent.updated';

/** The states an agent's tile went through, as clients heard them, without repeats. */
function statesOf(events: DaemonEvent[], sessionId: string): AgentState[] {
  const states: AgentState[] = [];
  for (const event of events) {
    if (isAgentUpdate(event) && event.agent.sessionId === sessionId && states.at(-1) !== event.agent.state) {
      states.push(event.agent.state);
    }
  }
  return states;
}

/** Waits for the agent to reach `state` in an update after the first `after` events the recorder saw. */
async function untilState(
  recorder: ReturnType<typeof recordEvents>,
  sessionId: string,
  state: AgentState,
  after = 0,
): Promise<Agent> {
  const event = await recorder.waitFor(
    (e): e is AgentUpdatedEvent =>
      isAgentUpdate(e) && e.agent.sessionId === sessionId && e.agent.state === state && recorder.events.indexOf(e) >= after,
  );
  return event.agent;
}

async function addZone(client: DaemonClient, path: string) {
  return client.call('zone.add', { path, x: 0, y: 0 });
}

/** Waits for an update after the first `after` events the recorder saw in which the agent matches `match`. */
async function untilAgent(
  recorder: ReturnType<typeof recordEvents>,
  sessionId: string,
  match: (agent: Agent) => boolean,
  after = 0,
): Promise<Agent> {
  const event = await recorder.waitFor(
    (e): e is AgentUpdatedEvent =>
      isAgentUpdate(e) && e.agent.sessionId === sessionId && match(e.agent) && recorder.events.indexOf(e) >= after,
  );
  return event.agent;
}

describe('Claude agents', () => {
  it('spawns claude in a new worktree and branch outside the repo', async () => {
    const { client, worktreesDir } = await agentDaemon('waiting');
    const repo = tempRepo('monorepo');
    const zone = await addZone(client, repo);

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Fix the flaky tests', ...SIZE });

    expect(agent).toMatchObject({
      zoneId: zone.id,
      harness: 'claude',
      name: 'Fix the flaky tests',
      description: 'Fix the flaky tests',
      endedAt: null,
    });
    expect(agent.branch).toMatch(/^fix-the-flaky-tests-[0-9a-f]{6}$/);
    expect(dirname(dirname(agent.worktree))).toBe(worktreesDir);
    expect(basename(dirname(agent.worktree))).toMatch(/^monorepo-[0-9a-f]{8}$/);
    expect(basename(agent.worktree)).toBe(agent.branch);
    expect(agent.cwd).toBe(agent.worktree);
    expect(git(agent.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(agent.branch);
    expect(git(repo, 'worktree', 'list')).toContain(agent.worktree);
    expect(await client.call('agent.list')).toEqual([expect.objectContaining({ sessionId: agent.sessionId })]);
    expect(await client.call('session.list')).toEqual([expect.objectContaining({ id: agent.sessionId, harness: 'claude', cwd: agent.cwd })]);
  });

  it('drives the tile state from its hooks: running → waiting → running → done', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', ...SIZE });

    await untilState(recorder, agent.sessionId, 'waiting');
    const answered = recorder.events.length;
    await client.call('session.write', { sessionId: agent.sessionId, data: 'SQLite\r' });
    await untilState(recorder, agent.sessionId, 'idle', answered);
    // EOF at the prompt ends the session, as Ctrl-D does in the real TUI.
    await client.call('session.write', { sessionId: agent.sessionId, data: '\x04' });
    const done = await untilState(recorder, agent.sessionId, 'done');

    expect(statesOf(recorder.events, agent.sessionId)).toEqual([
      'starting', // spawned with its first prompt, whose turn has not begun
      'running', // SessionStart
      'thinking',
      'idle',
      'waiting',
      'thinking', // the answer
      'running', // PreToolUse
      'thinking',
      'idle',
      'done',
    ]);
    // Each running came from a hook: the update follows the hook that caused it.
    const first = recorder.events.findIndex((e) => isAgentUpdate(e) && e.agent.state === 'running');
    expect(recorder.events.slice(0, first).some((e) => e.type === 'hook' && e.event === 'SessionStart')).toBe(true);
    // The tile keeps the task it was given, not the answer to its question.
    expect(done.description).toBe('Pick a database');
    await recorder.waitFor((e): e is SessionExitedEvent => e.type === 'session.exited' && e.sessionId === agent.sessionId);
    expect(await client.call('agent.list')).toEqual([expect.objectContaining({ state: 'done', endedAt: expect.any(String) })]);
  });

  it('shows the subagents its hooks report, from SubagentStart until SubagentStop finishes them with their result', async () => {
    const { client, recorder } = await agentDaemon('subagent');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Map the code', ...SIZE });
    expect(agent.subagents).toEqual([]);

    const started = await recorder.waitFor(
      (e): e is AgentUpdatedEvent => isAgentUpdate(e) && e.agent.sessionId === agent.sessionId && e.agent.subagents.length > 0,
    );
    expect(started.agent.subagents).toEqual([
      { id: expect.any(String), type: 'Explore', state: 'running', startedAt: expect.any(String), endedAt: null, result: null },
    ]);
    const finished = await recorder.waitFor(
      (e): e is AgentUpdatedEvent =>
        isAgentUpdate(e) && e.agent.sessionId === agent.sessionId && e.agent.subagents[0]?.endedAt != null,
    );
    expect(finished.agent.subagents).toEqual([
      expect.objectContaining({ state: 'done', result: 'Sessions are created in src/daemon/sessions.ts.' }),
    ]);
    // Its parent kept the state its own hooks gave it.
    expect(finished.agent.state).toBe('running');
    expect(await client.call('agent.list')).toEqual([expect.objectContaining({ subagents: finished.agent.subagents })]);
  });

  it('authenticates its hooks with a token from its environment, never its command line', async () => {
    const { client, recorder } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Run the tests', ...SIZE });

    const start = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
    );

    expect(start.payload).toMatchObject({ session_id: agent.sessionId, cwd: agent.cwd });
    const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String((await client.call('session.list'))[0]!.pid)], {
      encoding: 'utf8',
    });
    expect(command).toContain('--settings');
    expect(command).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
  });

  it('starts a folder zone agent in that folder of its worktree', async () => {
    const { client, recorder } = await agentDaemon('output');
    const repo = tempRepo();
    const zone = await addZone(client, join(repo, 'apps', 'web'));

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Tidy the web app', ...SIZE });

    expect(agent.cwd).toBe(join(agent.worktree, 'apps', 'web'));
    const start = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
    );
    expect(start.payload.cwd).toBe(agent.cwd);
  });

  it('refuses to start an agent in an unbound zone with no default repo, unless it is given a repo', async () => {
    const { client } = await agentDaemon('output');
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', x: 0, y: 0 });

    await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'Ideas has no repo: pick one to start the agent in',
    });
    expect(await client.call('agent.list')).toEqual([]);
  });

  it('marks a rate-limited turn, and a crash as failed', async () => {
    const limited = await agentDaemon('rate-limit');
    const zone = await addZone(limited.client, tempRepo());
    const agent = await limited.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await untilState(limited.recorder, agent.sessionId, 'rate-limited');

    const crashing = await agentDaemon('crash');
    const crashZone = await addZone(crashing.client, tempRepo());
    const crashed = await crashing.client.call('agent.spawn', { zoneId: crashZone.id, prompt: 'Go', ...SIZE });
    await untilState(crashing.recorder, crashed.sessionId, 'failed');
  });

  it('takes a name, and refuses an unknown zone', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());

    const named = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Do it', name: 'Ada', ...SIZE });
    expect(named).toMatchObject({ name: 'Ada', description: 'Do it' });
    expect(named.branch).toMatch(/^ada-[0-9a-f]{6}$/);

    await expect(client.call('agent.spawn', { zoneId: 'nope', prompt: 'x', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'no zone nope',
    });
  });

  it('mutes and unmutes its notifications, kept across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await agentDaemon('output', { dataDir });
    const zone = await addZone(first.client, tempRepo());
    const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    expect(agent.muted).toBe(false);

    const muted = await first.client.call('agent.setMuted', { sessionId: agent.sessionId, muted: true });

    expect(muted.muted).toBe(true);
    await untilAgent(first.recorder, agent.sessionId, (known) => known.muted);
    await first.daemon.stop();
    const second = await agentDaemon('output', { dataDir });
    expect((await second.client.call('agent.list'))[0]?.muted).toBe(true);
    expect((await second.client.call('agent.setMuted', { sessionId: agent.sessionId, muted: false })).muted).toBe(false);
  });

  it('marks an ask seen when its session is opened, until the agent works and asks again', async () => {
    const { client, recorder } = await agentDaemon('waiting', { repeat: true });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Set up the app');
    const waiting = await untilState(recorder, agent.sessionId, 'waiting');
    expect(waiting.seen).toBe(false);

    const seen = await client.call('agent.markSeen', { sessionId: agent.sessionId });

    expect(seen).toMatchObject({ state: 'waiting', seen: true });
    await untilAgent(recorder, agent.sessionId, (known) => known.seen);
    expect((await client.call('agent.list'))[0]?.seen).toBe(true);
  });

  it('clears seen on the next working transition, so the agent needs you again when it waits', async () => {
    const { client, recorder } = await agentDaemon('waiting', { repeat: true });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Set up the app');
    await untilState(recorder, agent.sessionId, 'waiting');
    await client.call('agent.markSeen', { sessionId: agent.sessionId });

    const answered = recorder.events.length;
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' });
    const worked = await untilAgent(recorder, agent.sessionId, (known) => known.state !== 'waiting', answered);
    expect(worked.seen).toBe(false);
    const asking = await untilAgent(recorder, agent.sessionId, (known) => known.state === 'waiting', answered);
    expect(asking.seen).toBe(false);
  });

  it('clears seen when another permission prompt arrives while it still needs permission', async () => {
    const { client, recorder } = await agentDaemon('subagent-permission', { stepDelayMs: 1000 });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up');
    const first = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length >= 1);
    // The second subagent has not asked yet: this is the first ask, and it is seen.
    expect(first.permissions).toHaveLength(1);
    expect((await client.call('agent.markSeen', { sessionId: agent.sessionId })).seen).toBe(true);

    // Its sibling's prompt lands in the same needs-permission state: a new ask all the same.
    const asking = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length === 2);
    expect(asking).toMatchObject({ state: 'needs-permission', seen: false });
  });

  it('reports no seen on an agent that has ended', async () => {
    const { client, recorder } = await agentDaemon('waiting', { repeat: true });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Set up the app');
    await untilState(recorder, agent.sessionId, 'waiting');
    await client.call('agent.markSeen', { sessionId: agent.sessionId });

    await client.call('session.kill', { sessionId: agent.sessionId });

    const ended = await untilAgent(recorder, agent.sessionId, (a) => a.endedAt !== null);
    expect(ended.seen).toBe(false);
    expect((await client.call('agent.list'))[0]?.seen).toBe(false);
  });

  it('does not mark an agent that is not asking, and refuses an unknown agent', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });

    expect((await client.call('agent.markSeen', { sessionId: agent.sessionId })).seen).toBe(false);
    await expect(client.call('agent.markSeen', { sessionId: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  it('refuses to mute an unknown agent, or without a boolean', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    const refused = { code: RPC_ERROR.invalidParams };

    await expect(client.call('agent.setMuted', { sessionId: 'nope', muted: true })).rejects.toMatchObject(refused);
    await expect(
      client.call('agent.setMuted', { sessionId: agent.sessionId, muted: 'yes' as unknown as boolean }),
    ).rejects.toMatchObject(refused);
  });

  it('renames an agent, keeping its worktree, branch and session, across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await agentDaemon('output', { dataDir });
    const zone = await addZone(first.client, tempRepo());
    const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });

    const renamed = await first.client.call('agent.setName', { sessionId: agent.sessionId, name: '  Fix the login  ' });

    expect(renamed).toMatchObject({ name: 'Fix the login', sessionId: agent.sessionId, branch: agent.branch, worktree: agent.worktree });
    await untilAgent(first.recorder, agent.sessionId, (known) => known.name === 'Fix the login');
    await first.daemon.stop();
    const second = await agentDaemon('output', { dataDir });
    expect((await second.client.call('agent.list'))[0]?.name).toBe('Fix the login');
  });

  it('refuses to rename an unknown agent, to a blank or over-long name, or without a string', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    const refused = { code: RPC_ERROR.invalidParams };
    const rename = (name: unknown, sessionId = agent.sessionId) =>
      client.call('agent.setName', { sessionId, name: name as string });

    await expect(rename('New', 'nope')).rejects.toMatchObject(refused);
    await expect(rename('   ')).rejects.toMatchObject(refused);
    await expect(rename('x'.repeat(MAX_NAME_LENGTH + 1))).rejects.toMatchObject(refused);
    await expect(rename(7)).rejects.toMatchObject(refused);
    expect((await rename('x'.repeat(MAX_NAME_LENGTH))).name).toHaveLength(MAX_NAME_LENGTH);
  });

  it('places its tile where asked, and moves it within its zone and into another, kept across a restart', async () => {
    const dataDir = tempDataDir();
    const first = await agentDaemon('output', { dataDir });
    const repo = tempRepo();
    const zone = await addZone(first.client, repo);
    const other = await first.client.call('zone.add', { path: repo, x: 900, y: 0 });
    const placed = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', position: { x: 20, y: 44 }, ...SIZE });
    const slotted = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go too', ...SIZE });
    expect(placed.position).toMatchObject({ x: 20, y: 44, z: expect.any(Number) });
    expect(slotted.position).toBeNull();

    const within = await first.client.call('agent.move', { sessionId: slotted.sessionId, zoneId: zone.id, x: 300, y: 50, z: 9 });
    expect(within).toMatchObject({ zoneId: zone.id, position: { x: 300, y: 50, z: 9 } });
    await untilAgent(first.recorder, slotted.sessionId, (known) => known.position?.x === 300);
    const across = await first.client.call('agent.move', { sessionId: placed.sessionId, zoneId: other.id, x: 5, y: 6 });
    expect(across).toMatchObject({ zoneId: other.id, position: { x: 5, y: 6, z: placed.position!.z } });
    await first.daemon.stop();

    const second = await agentDaemon('output', { dataDir });
    const agents = await second.client.call('agent.list');
    expect(agents.map(({ zoneId, position }) => ({ zoneId, position }))).toEqual([
      { zoneId: other.id, position: across.position },
      { zoneId: zone.id, position: within.position },
    ]);
  });

  it('moves anywhere: into another repo\'s zone, an unbound zone or loose on the board, keeping its own repo, across a restart', async () => {
    const dataDir = tempDataDir();
    const first = await agentDaemon('output', { dataDir });
    const repo = tempRepo();
    const zone = await addZone(first.client, repo);
    const elsewhere = await addZone(first.client, tempRepo());
    const unbound = await first.client.call('zone.addUnbound', { name: 'Ideas', x: 0, y: 900 });
    const foreign = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    const loose = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go too', ...SIZE });
    const idea = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'And go', ...SIZE });
    expect(foreign.repoRoot).toBe(repo);

    const inForeign = await first.client.call('agent.move', { sessionId: foreign.sessionId, zoneId: elsewhere.id, x: 1, y: 2 });
    const onBoard = await first.client.call('agent.move', { sessionId: loose.sessionId, zoneId: null, x: -300, y: 40 });
    const inUnbound = await first.client.call('agent.move', { sessionId: idea.sessionId, zoneId: unbound.id, x: 3, y: 4 });
    expect(inForeign).toMatchObject({ zoneId: elsewhere.id, repoRoot: repo, worktree: foreign.worktree, branch: foreign.branch });
    expect(onBoard).toMatchObject({ zoneId: null, position: { x: -300, y: 40 }, repoRoot: repo });
    expect(inUnbound).toMatchObject({ zoneId: unbound.id, repoRoot: repo });
    await first.daemon.stop();

    const second = await agentDaemon('output', { dataDir });
    const agents = await second.client.call('agent.list');
    expect(agents.map(({ zoneId, position, repoRoot }) => ({ zoneId, position, repoRoot }))).toEqual([
      { zoneId: elsewhere.id, position: inForeign.position, repoRoot: repo },
      { zoneId: null, position: onBoard.position, repoRoot: repo },
      { zoneId: unbound.id, position: inUnbound.position, repoRoot: repo },
    ]);
  });

  it('refuses to move into an unknown zone, or an unknown agent', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    const refused = { code: RPC_ERROR.invalidParams };
    const move = (zoneId: unknown) => client.call('agent.move', { sessionId: agent.sessionId, zoneId: zoneId as string, x: 0, y: 0 });

    await expect(move('nope')).rejects.toMatchObject(refused);
    await expect(move(7)).rejects.toMatchObject(refused);
    await expect(client.call('agent.move', { sessionId: 'nope', zoneId: zone.id, x: 0, y: 0 })).rejects.toMatchObject(refused);
    expect((await client.call('agent.list'))[0]).toMatchObject({ zoneId: zone.id, position: null });
  });

  it('refuses to remove a zone that still has agents', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });

    await expect(client.call('zone.remove', { id: zone.id })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  describe('deleting', () => {
    it('takes the connectors on the agent with it', async () => {
      const { client, recorder } = await agentDaemon('waiting');
      const zone = await addZone(client, tempRepo());
      const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      await untilState(recorder, agent.sessionId, 'waiting');
      const note = await client.call('item.create', {
        kind: 'sticky',
        zoneId: null,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        data: { text: '', color: '#ffd43b' },
      });
      await client.call('connector.create', {
        from: { type: 'item', id: note.id, side: 'right' },
        to: { type: 'agent', id: agent.sessionId, side: 'left' },
      });

      await client.call('agent.delete', { sessionId: agent.sessionId });

      expect(await client.call('connector.list')).toEqual([]);
    });

    it('with keepWorktree ends the agent and leaves its worktree, branch and unsaved work', async () => {
      const { client, recorder } = await agentDaemon('waiting');
      const repo = tempRepo();
      const zone = await addZone(client, repo);
      const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      await untilState(recorder, agent.sessionId, 'waiting');
      writeFileSync(join(agent.worktree, 'notes.md'), 'work in progress\n');

      await client.call('agent.delete', { sessionId: agent.sessionId, keepWorktree: true });

      expect(await client.call('agent.list')).toEqual([]);
      expect(existsSync(join(agent.worktree, 'notes.md'))).toBe(true);
      expect(git(repo, 'branch', '--list', agent.branch)).toContain(agent.branch);
    });

    it('kills a clean agent and removes its worktree and branch', async () => {
      const { client, recorder } = await agentDaemon('waiting');
      const repo = tempRepo();
      const zone = await addZone(client, repo);
      const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      await untilState(recorder, agent.sessionId, 'waiting');
      const [session] = await client.call('session.list');

      await client.call('agent.delete', { sessionId: agent.sessionId });

      expect(isProcessAlive(session!.pid)).toBe(false);
      expect(existsSync(agent.worktree)).toBe(false);
      expect(git(repo, 'branch', '--list', agent.branch)).toBe('');
      expect(git(repo, 'worktree', 'list')).not.toContain(agent.worktree);
      expect(await client.call('agent.list')).toEqual([]);
      await recorder.waitFor((e): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === agent.sessionId);
      // The zone is free to go now.
      await client.call('zone.remove', { id: zone.id });
    });

    it("removes its own repo's worktree when it sits in another repo's zone or loose on the board", async () => {
      const { client } = await agentDaemon('output');
      const repo = tempRepo();
      const other = tempRepo('other');
      const zone = await addZone(client, repo);
      const elsewhere = await addZone(client, other);
      const foreign = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      const loose = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go too', ...SIZE });
      await client.call('agent.move', { sessionId: foreign.sessionId, zoneId: elsewhere.id, x: 0, y: 0 });
      await client.call('agent.move', { sessionId: loose.sessionId, zoneId: null, x: 0, y: 0 });

      await client.call('agent.delete', { sessionId: foreign.sessionId, force: true });
      await client.call('agent.delete', { sessionId: loose.sessionId, force: true });

      for (const agent of [foreign, loose]) {
        expect(existsSync(agent.worktree)).toBe(false);
        expect(git(repo, 'branch', '--list', agent.branch)).toBe('');
      }
      expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      expect(git(other, 'worktree', 'list').split('\n')).toHaveLength(1);
      await client.call('zone.remove', { id: elsewhere.id });
    });

    it('asks for confirmation when the worktree has uncommitted changes or unmerged commits', async () => {
      const { client } = await agentDaemon('waiting');
      const repo = tempRepo();
      const zone = await addZone(client, repo);
      const edited = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Edit', ...SIZE });
      const committed = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Commit', ...SIZE });
      const detached = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Detach', ...SIZE });
      const commit = (worktree: string, file: string) => {
        writeFileSync(join(worktree, file), 'finished\n');
        git(worktree, 'add', '.');
        git(worktree, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'work');
      };
      writeFileSync(join(edited.worktree, 'notes.md'), 'work in progress\n');
      commit(committed.worktree, 'done.md');
      // As after a rebase or bisect: the commit is on the worktree's HEAD but on no branch.
      git(detached.worktree, 'checkout', '--quiet', '--detach');
      commit(detached.worktree, 'detached.md');

      for (const agent of [edited, committed, detached]) {
        const refusal = await client.call('agent.delete', { sessionId: agent.sessionId }).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(DaemonRpcError);
        expect(refusal).toMatchObject({ code: AGENT_ERROR.unsavedWork });
        expect(existsSync(agent.worktree)).toBe(true);
      }

      await client.call('agent.delete', { sessionId: edited.sessionId, force: true });
      await client.call('agent.delete', { sessionId: committed.sessionId, force: true });
      await client.call('agent.delete', { sessionId: detached.sessionId, force: true });
      expect(existsSync(edited.worktree)).toBe(false);
      expect(existsSync(detached.worktree)).toBe(false);
      expect(git(repo, 'branch', '--list', committed.branch)).toBe('');
      expect(await client.call('agent.list')).toEqual([]);
    });

    it('refuses an unknown agent', async () => {
      const { client } = await agentDaemon('output');
      await expect(client.call('agent.delete', { sessionId: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    });
  });

  describe('across restarts', () => {
    it('gives a client that reconnects the agent and its current state', async () => {
      const { daemon, client, recorder } = await agentDaemon('waiting');
      const zone = await addZone(client, tempRepo());
      const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      await untilState(recorder, agent.sessionId, 'waiting');

      client.close();
      await client.closed;
      const later = await connectTestClient(daemon);

      expect(await later.call('agent.list')).toEqual([expect.objectContaining({ sessionId: agent.sessionId, state: 'waiting' })]);
      expect(await later.call('session.list')).toEqual([expect.objectContaining({ id: agent.sessionId })]);
    });

    it('keeps a finished agent after the daemon restarts, and marks one whose process the daemon ended as stopped by restart', async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const finished = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Finish', ...SIZE });
      await untilState(first.recorder, finished.sessionId, 'waiting');
      const answered = first.recorder.events.length;
      await first.client.call('session.write', { sessionId: finished.sessionId, data: 'ok\r' });
      await untilState(first.recorder, finished.sessionId, 'idle', answered);
      await first.client.call('session.write', { sessionId: finished.sessionId, data: '\x04' });
      await untilState(first.recorder, finished.sessionId, 'done');
      const running = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Keep going', ...SIZE });
      await untilState(first.recorder, running.sessionId, 'waiting');

      await first.daemon.stop();
      const second = await agentDaemon('waiting', { dataDir });

      expect(await second.client.call('agent.list')).toEqual([
        expect.objectContaining({ sessionId: finished.sessionId, state: 'done' }),
        expect.objectContaining({ sessionId: running.sessionId, state: 'stopped-by-restart', endedAt: expect.any(String) }),
      ]);
    });

    it('tells stopped by restart apart from stopped by the user and from a crash, after a shutdown and a hard kill', async () => {
      const dataDir = tempDataDir();
      // The crash first, on its own daemon over the same data: the fake runs one scenario per daemon.
      const crashing = await agentDaemon('crash', { dataDir });
      const zone = await addZone(crashing.client, tempRepo());
      const crashed = await crashing.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      await untilState(crashing.recorder, crashed.sessionId, 'failed');
      await crashing.daemon.stop();

      const first = await agentDaemon('waiting', { dataDir });
      const stopped = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Stop me', ...SIZE });
      await untilState(first.recorder, stopped.sessionId, 'waiting');
      await first.client.call('agent.stop', { sessionId: stopped.sessionId });
      const shutDown = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Shut down under me', ...SIZE });
      const lost = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Keep going', ...SIZE });
      await untilState(first.recorder, shutDown.sessionId, 'waiting');
      await untilState(first.recorder, lost.sessionId, 'waiting');
      await first.daemon.stop();
      // As a daemon killed hard leaves it: the session still live, and the agent's last state a failed turn's.
      const db = new DatabaseSync(daemonPaths(dataDir).database);
      db.prepare('UPDATE sessions SET ended_at = NULL, exit_code = NULL, stopped_by_restart = 0 WHERE id = ?').run(lost.sessionId);
      db.prepare("UPDATE agents SET state = 'failed' WHERE session_id = ?").run(lost.sessionId);
      db.close();
      const second = await agentDaemon('waiting', { dataDir });

      const states = Object.fromEntries((await second.client.call('agent.list')).map((agent) => [agent.sessionId, agent.state]));
      expect(states).toEqual({
        [crashed.sessionId]: 'failed',
        [stopped.sessionId]: 'done',
        [shutDown.sessionId]: 'stopped-by-restart',
        [lost.sessionId]: 'stopped-by-restart',
      });
      await second.daemon.stop();

      // And again across one more restart: nothing it marked changes, and nothing else is marked.
      const third = await agentDaemon('waiting', { dataDir });
      const again = Object.fromEntries((await third.client.call('agent.list')).map((agent) => [agent.sessionId, agent.state]));
      expect(again).toEqual(states);
    });

    it('resumes a Claude agent stopped by restart in its conversation, with no new prompt', async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', ...SIZE });
      await untilState(first.recorder, agent.sessionId, 'waiting');
      await first.daemon.stop();
      const second = await agentDaemon('waiting', { dataDir, home: first.home });

      const resumed = await second.client.call('agent.resume', { sessionId: agent.sessionId });

      expect(resumed).toMatchObject({ sessionId: agent.sessionId, endedAt: null, state: 'idle' });
      await second.client.call('session.attach', { sessionId: agent.sessionId });
      await second.recorder.waitForText(agent.sessionId, 'Which database should I use');
      const sessionStart = await second.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      expect(sessionStart.payload).toMatchObject({ source: 'resume', session_id: agent.sessionId });
      await second.client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' });
      await second.recorder.waitForText(agent.sessionId, 'Done: SQLite.');
      await expect(second.client.call('agent.resume', { sessionId: agent.sessionId })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringContaining('is still running'),
      });
    });

    it('starts a Claude agent that never had a turn fresh under the same id, instead of failing to resume it', async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const agent = await first.client.call('agent.spawn', { zoneId: zone.id, ...SIZE });
      await first.daemon.stop();
      const second = await agentDaemon('waiting', { dataDir, home: first.home });

      const resumed = await second.client.call('agent.resume', { sessionId: agent.sessionId });

      expect(resumed).toMatchObject({ sessionId: agent.sessionId, endedAt: null, notice: 'No earlier conversation: started fresh' });
      const sessionStart = await second.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      expect(sessionStart.payload).toMatchObject({ source: 'startup', session_id: agent.sessionId });
    });

    it('starts a Claude agent whose transcript is gone fresh on its task', async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', ...SIZE });
      await untilState(first.recorder, agent.sessionId, 'waiting');
      await first.daemon.stop();
      rmSync(join(first.home, '.claude', 'projects'), { recursive: true, force: true });
      const second = await agentDaemon('waiting', { dataDir, home: first.home });

      const resumed = await second.client.call('agent.resume', { sessionId: agent.sessionId });

      expect(resumed.notice).toBe('No earlier conversation: started fresh');
      const sessionStart = await second.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      expect(sessionStart.payload).toMatchObject({ source: 'startup', session_id: agent.sessionId });
      // Its task goes again as its first message.
      await second.client.call('session.attach', { sessionId: agent.sessionId });
      await second.recorder.waitForText(agent.sessionId, 'Which database should I use');
    });

    it('starts a Codex agent that has no session id fresh, with a notice', async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const agent = await first.client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', ...SIZE });
      await first.daemon.stop();
      const second = await agentDaemon('waiting', { dataDir, home: first.home });

      const resumed = await second.client.call('agent.resume', { sessionId: agent.sessionId });

      expect(resumed).toMatchObject({ endedAt: null, notice: 'No earlier conversation: started fresh' });
      const sessionStart = await second.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      expect(sessionStart.payload).toMatchObject({ source: 'startup' });
    });

    it('resumes a Codex agent in its own conversation, by the id Codex gave it', async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const agent = await first.client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Pick a database', ...SIZE });
      const started = await first.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      const thread = started.payload.session_id as string;
      expect(thread).not.toBe(agent.sessionId);
      await first.recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop');
      await first.daemon.stop();
      const second = await agentDaemon('waiting', { dataDir, home: first.home });

      await second.client.call('agent.resume', { sessionId: agent.sessionId });

      await second.client.call('session.attach', { sessionId: agent.sessionId });
      await second.recorder.waitForText(agent.sessionId, 'Which database should I use');
      const resumed = await second.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      expect(resumed.payload).toMatchObject({ source: 'resume', session_id: thread });
      expect(await commandLine(second.client, agent.sessionId)).toContain(`resume ${thread}`);
    });

    it("starts a Codex agent afresh when Codex can't resume its conversation, and says so", async () => {
      const dataDir = tempDataDir();
      const first = await agentDaemon('waiting', { dataDir });
      const zone = await addZone(first.client, tempRepo());
      const agent = await first.client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Pick a database', ...SIZE });
      await first.recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop');
      await first.daemon.stop();
      // Its conversation is gone: Codex pruned it, or the user deleted it.
      rmSync(join(first.home, '.codex', 'sessions'), { recursive: true, force: true });
      const second = await agentDaemon('waiting', { dataDir, home: first.home });

      await second.client.call('agent.resume', { sessionId: agent.sessionId });

      const fresh = await second.recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart',
      );
      expect(fresh.payload).toMatchObject({ source: 'startup' });
      const live = await untilAgent(second.recorder, agent.sessionId, (a) => a.endedAt === null && a.notice !== null);
      expect(live.notice).toContain('started a new conversation');
      expect(live.state).not.toBe('failed');
    });

    it('refuses to resume an agent that is still running, or is gone', async () => {
      const { client, recorder } = await agentDaemon('waiting');
      const zone = await addZone(client, tempRepo());
      const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
      await untilState(recorder, agent.sessionId, 'waiting');

      const refused = { code: RPC_ERROR.invalidParams };
      await expect(client.call('agent.resume', { sessionId: agent.sessionId })).rejects.toMatchObject(refused);
      await expect(client.call('agent.resume', { sessionId: 'nope' })).rejects.toMatchObject(refused);
    });
  });
});

describe('an agent that exited', () => {
  /** Spawns an agent, waits for its turn to end on a question, and quits it as the user would (EOF at its prompt). */
  async function exitedAgent(harness: Harness = 'claude') {
    const daemon = await agentDaemon('waiting');
    const zone = await addZone(daemon.client, tempRepo());
    const agent = await daemon.client.call('agent.spawn', { zoneId: zone.id, harness, prompt: 'Pick a database', ...SIZE });
    await daemon.recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop');
    await daemon.client.call('session.write', { sessionId: agent.sessionId, data: '\x04' });
    const ended = await untilAgent(daemon.recorder, agent.sessionId, (a) => a.shellSessionId !== null);
    return { ...daemon, agent: ended };
  }

  it('drops its pane into a shell in its folder, under its last output', async () => {
    const { client, recorder, agent } = await exitedAgent();

    expect(agent).toMatchObject({ exitCode: 0, endedAt: expect.any(String) });
    const shellId = agent.shellSessionId!;
    expect((await client.call('session.list')).find((session) => session.id === shellId)).toMatchObject({ harness: null, cwd: agent.cwd });
    await client.call('session.attach', { sessionId: shellId });
    await recorder.waitForText(shellId, 'Which database should I use');
    await client.call('session.write', { sessionId: shellId, data: 'pwd\r' });
    await recorder.waitForText(shellId, agent.cwd);
    // It is no shell tile of its own.
    expect(await client.call('shell.list')).toEqual([]);
  });

  it('restarts in its own conversation, ending its shell', async () => {
    const { client, recorder, agent } = await exitedAgent();
    const shellId = agent.shellSessionId!;

    const restarted = await client.call('agent.resume', { sessionId: agent.sessionId });

    expect(restarted).toMatchObject({ sessionId: agent.sessionId, endedAt: null, shellSessionId: null });
    const sessionStart = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart' && e.payload.source === 'resume',
    );
    expect(sessionStart.payload).toMatchObject({ session_id: agent.sessionId });
    expect((await client.call('session.list')).map((session) => session.id)).not.toContain(shellId);
  });

  it('restarts one that never had a turn fresh under the same id', async () => {
    const daemon = await agentDaemon('waiting');
    const zone = await addZone(daemon.client, tempRepo());
    const agent = await daemon.client.call('agent.spawn', { zoneId: zone.id, ...SIZE });
    await daemon.client.call('session.write', { sessionId: agent.sessionId, data: '\x04' });
    await untilAgent(daemon.recorder, agent.sessionId, (a) => a.shellSessionId !== null);

    const restarted = await daemon.client.call('agent.resume', { sessionId: agent.sessionId });

    expect(restarted).toMatchObject({ sessionId: agent.sessionId, endedAt: null, notice: 'No earlier conversation: started fresh' });
    const sessionStart = await daemon.recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart' && e.payload.source === 'startup',
    );
    expect(sessionStart.payload).toMatchObject({ session_id: agent.sessionId });
  });

  it('starts a Codex agent afresh when Codex can\'t resume its conversation', async () => {
    const { client, recorder, agent, home } = await exitedAgent('codex');
    rmSync(join(home, '.codex', 'sessions'), { recursive: true, force: true });

    await client.call('agent.resume', { sessionId: agent.sessionId });

    const live = await untilAgent(recorder, agent.sessionId, (a) => a.endedAt === null && a.notice !== null);
    expect(live.notice).toContain('started a new conversation');
  });

  it('asks before ending a shell that is running something', async () => {
    const { client, recorder, agent } = await exitedAgent();
    const shellId = agent.shellSessionId!;
    await client.call('session.attach', { sessionId: shellId });
    // A subshell: it is in the foreground before it says so. Typed, the word is split, so only its output matches.
    await client.call('session.write', { sessionId: shellId, data: '(echo bu""sy; sleep 30)\r' });
    await recorder.waitForText(shellId, 'busy');

    await expect(client.call('agent.resume', { sessionId: agent.sessionId })).rejects.toMatchObject({ code: AGENT_ERROR.shellBusy });
    await expect(client.call('agent.resume', { sessionId: agent.sessionId, force: true })).resolves.toMatchObject({ endedAt: null });
  });

  it('shows its own ended session again once its shell exits, keeping no screen of that shell', async () => {
    const { client, recorder, agent, dataDir } = await exitedAgent();
    const shellId = agent.shellSessionId!;
    const screen = join(dataDir, 'scrollback', `${shellId}.json`);
    await client.call('session.attach', { sessionId: shellId });
    await recorder.waitForText(shellId, 'Which database should I use');

    await client.call('session.write', { sessionId: shellId, data: 'exit\r' });

    await untilAgent(recorder, agent.sessionId, (a) => a.shellSessionId === null);
    await expect.poll(() => existsSync(screen)).toBe(false);
    // Nor is it written back once the exit has finished.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(screen)).toBe(false);
    expect((await client.call('session.list')).map((session) => session.id)).not.toContain(shellId);
  });

  it('ends its shell with it when it is deleted', async () => {
    const { client, agent } = await exitedAgent();

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });

    expect((await client.call('session.list')).map((session) => session.id)).not.toContain(agent.shellSessionId);
  });

  it("doesn't count its shell as a live session: the daemon stops without asking, ending the shell", async () => {
    const { daemon, client, agent } = await exitedAgent();
    const shell = (await client.call('session.list')).find((session) => session.id === agent.shellSessionId)!;

    expect(await client.call('daemon.health')).toMatchObject({ liveSessions: 0 });
    expect(await client.call('daemon.stop', {})).toEqual({ stopped: true, liveSessions: 0 });

    await daemon.closed;
    await expect.poll(() => isProcessAlive(shell.pid)).toBe(false);
  });
});

/** Spawns an agent and attaches to its session, so the recorder sees its screen. */
async function spawnAttached(client: DaemonClient, zoneId: string, prompt: string, harness: Harness = 'claude'): Promise<Agent> {
  const agent = await client.call('agent.spawn', { zoneId, prompt, harness, ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  return agent;
}

describe("the daemon's log of how an agent's session ended", () => {
  /** A daemon whose log is kept, with a fake claude agent sitting at its prompt after its first turn. */
  async function idleAgent() {
    const logs: string[] = [];
    const daemon = await agentDaemon('waiting', { log: (message) => void logs.push(message) });
    const zone = await addZone(daemon.client, tempRepo());
    const agent = await daemon.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Pick a database', ...SIZE });
    await daemon.recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop');
    const pid = (await daemon.client.call('session.list')).find((session) => session.id === agent.sessionId)!.pid;
    return { ...daemon, agent, pid, logs };
  }

  /** The line the daemon logged when the session `sessionId` ended. */
  async function exitLine(logs: string[], sessionId: string): Promise<string> {
    let line: string | undefined;
    await vi.waitFor(() => {
      line = logs.find((message) => message.startsWith(`claude session ${sessionId} `) && message.includes(' exited '));
      expect(line).toBeDefined();
    }, { timeout: 5_000 });
    return line!;
  }

  it('names the signal, and that the daemon did not send it, when something outside the daemon ends the agent', async () => {
    // As a `pkill -f <word>` run anywhere on the machine does to every process whose argv, prompt included, names the word.
    const { agent, pid, logs } = await idleAgent();

    process.kill(pid, 'SIGTERM');

    expect(await exitLine(logs, agent.sessionId)).toBe(
      `claude session ${agent.sessionId} (pid ${pid}) exited on SIGTERM, not ended by the daemon`,
    );
  });

  it('names the exit code when the agent quits by itself', async () => {
    const { client, agent, pid, logs } = await idleAgent();

    await client.call('session.write', { sessionId: agent.sessionId, data: '\x04' });

    expect(await exitLine(logs, agent.sessionId)).toBe(
      `claude session ${agent.sessionId} (pid ${pid}) exited with code 0, not ended by the daemon`,
    );
  });

  it('names who had the daemon end it', async () => {
    const { client, agent, pid, logs } = await idleAgent();

    await client.call('agent.stop', { sessionId: agent.sessionId });

    expect(await exitLine(logs, agent.sessionId)).toMatch(
      new RegExp(`^claude session ${agent.sessionId} \\(pid ${pid}\\) exited .*, ended by the daemon for the app's agent\\.stop$`),
    );
  });

  it('names its shutdown when the daemon stops', async () => {
    const { daemon, agent, pid, logs } = await idleAgent();

    await daemon.stop();

    expect(await exitLine(logs, agent.sessionId)).toMatch(
      new RegExp(`^claude session ${agent.sessionId} \\(pid ${pid}\\) exited .*, ended by the daemon for its shutdown$`),
    );
  });

  it("names the app's delete, for the session and for the agent", async () => {
    const { client, agent, pid, logs } = await idleAgent();

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });

    expect(await exitLine(logs, agent.sessionId)).toMatch(
      new RegExp(`^claude session ${agent.sessionId} \\(pid ${pid}\\) exited .*, ended by the daemon for its delete for the app's agent\\.delete$`),
    );
    expect(logs.find((message) => message.startsWith(`deleted agent ${agent.sessionId} `))).toMatch(/ for the app's agent\.delete$/);
  });

  it("names the app's restart, and ends the shell its pane dropped into for it", async () => {
    const { client, recorder, agent, logs } = await idleAgent();
    await client.call('session.write', { sessionId: agent.sessionId, data: '\x04' });
    const ended = await untilAgent(recorder, agent.sessionId, (a) => a.shellSessionId !== null);

    await client.call('agent.resume', { sessionId: agent.sessionId });

    await vi.waitFor(() => expect(logs).toContain(`relaunched claude agent ${agent.sessionId} to restart it, for the app's agent.resume`), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(logs.find((message) => message.startsWith(`shell session ${ended.shellSessionId} `))).toMatch(
      /, ended by the daemon for its agent's restart for the app's agent\.resume$/,
    ), { timeout: 5_000 });
  });
});

describe('the needs-you inbox', () => {
  it("answers a waiting agent: its last message is the context, and the answer resumes it", async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Pick a database');
    expect(agent).toMatchObject({ lastMessage: null, permissions: [] });

    const waiting = await untilState(recorder, agent.sessionId, 'waiting');
    expect(waiting.lastMessage).toBe('Which database should I use, Postgres or SQLite?');
    const answered = recorder.events.length;
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' });

    await recorder.waitForText(agent.sessionId, 'Going with SQLite.');
    const resumed = await untilState(recorder, agent.sessionId, 'idle', answered);
    expect(statesOf(recorder.events.slice(answered), agent.sessionId)).toEqual(['thinking', 'running', 'thinking', 'idle']);
    expect(resumed.lastMessage).toBe('Going with SQLite.');
    // While it worked on the answer, the old question was not its last word.
    const working = recorder.events.slice(answered).filter(isAgentUpdate).find((e) => e.agent.state === 'running')!;
    expect(working.agent.lastMessage).toBeNull();
  });

  it('says when its own turn last ended, each time it ends, and keeps it through its next turn', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Pick a database');
    expect(agent.finishedAt).toBeNull();

    const first = await untilAgent(recorder, agent.sessionId, (a) => a.finishedAt !== null);
    const answered = recorder.events.length;
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' });
    const working = await untilAgent(recorder, agent.sessionId, (a) => a.state === 'running', answered);
    expect(working.finishedAt).toBe(first.finishedAt);
    const second = await untilAgent(recorder, agent.sessionId, (a) => a.finishedAt !== first.finishedAt, answered);
    expect(second.finishedAt! > first.finishedAt!).toBe(true);
  });

  it('types answers sent at once one after the other, never run together', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Pick a database');
    await untilState(recorder, agent.sessionId, 'waiting');

    await Promise.all([
      client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' }),
      client.call('agent.answer', { sessionId: agent.sessionId, text: 'Ship it' }),
    ]);

    await recorder.waitForText(agent.sessionId, 'Going with SQLite.');
    await recorder.waitForText(agent.sessionId, 'Done: Ship it.');
  });

  it('sends a multi-line answer as one message, its lines kept, pasted as a terminal pastes it', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Pick a database');
    await untilState(recorder, agent.sessionId, 'waiting');
    const answered = recorder.events.length;

    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite,\r\nfor now\n' });

    await untilState(recorder, agent.sessionId, 'idle', answered);
    const { entries } = await client.call('agent.transcript', { sessionId: agent.sessionId });
    expect(entries.filter((entry) => entry.kind === 'user')).toEqual([
      { kind: 'user', text: 'Pick a database' },
      { kind: 'user', text: 'SQLite,\nfor now' },
    ]);
  });

  it('pastes a one-line answer when asked to, as a dropped file is pasted', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Pick a database');
    await untilState(recorder, agent.sessionId, 'waiting');

    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'See /tmp/shot.png', paste: true });

    await recorder.waitForText(agent.sessionId, 'Going with See /tmp/shot.png.');
  });

  it('refuses an empty answer, an unknown or ended agent, and an agent that needs permission', async () => {
    const { client, recorder } = await agentDaemon('permission');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up');
    await untilState(recorder, agent.sessionId, 'needs-permission');

    const refused = { code: RPC_ERROR.invalidParams };
    await expect(client.call('agent.answer', { sessionId: agent.sessionId, text: 'yes' })).rejects.toMatchObject(refused);
    await expect(client.call('agent.answer', { sessionId: agent.sessionId, text: ' \n ' })).rejects.toMatchObject(refused);
    await expect(client.call('agent.answer', { sessionId: 'nope', text: 'hi' })).rejects.toMatchObject(refused);
    await client.call('session.kill', { sessionId: agent.sessionId });
    await expect(client.call('agent.answer', { sessionId: agent.sessionId, text: 'hi' })).rejects.toMatchObject(refused);
  });

  it('holds its PermissionRequest open and allows the tool call through it', async () => {
    const { client, recorder } = await agentDaemon('permission');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up');

    const asking = await untilState(recorder, agent.sessionId, 'needs-permission');
    expect(asking.permissions).toEqual([
      {
        id: expect.any(String),
        toolName: 'Bash',
        toolInput: { command: 'rm -rf dist', description: 'Remove build output' },
        subagent: null,
        requestedAt: expect.any(String),
        heldUntil: expect.any(String),
      },
    ]);
    const decided = recorder.events.length;
    const requestId = asking.permissions[0]!.id;
    await client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId, behavior: 'allow' });

    await recorder.waitForText(agent.sessionId, 'Removed dist.');
    await untilState(recorder, agent.sessionId, 'idle', decided);
    // Settled by the hook: the terminal never asked.
    expect(recorder.screenText(agent.sessionId)).not.toContain('(y/n)');
    expect(recorder.events.some((e) => e.type === 'hook' && e.payload.notification_type === 'permission_prompt')).toBe(false);
    const after = recorder.events.slice(decided).filter(isAgentUpdate);
    expect(after[0]!.agent).toMatchObject({ state: 'running', permissions: [] });
    expect(after.every((e) => e.agent.permissions.length === 0)).toBe(true);
  });

  it('denies the tool call through its PermissionRequest, and refuses a second decision', async () => {
    const { client, recorder } = await agentDaemon('permission');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up');
    const { permissions } = await untilState(recorder, agent.sessionId, 'needs-permission');

    const decision = { sessionId: agent.sessionId, requestId: permissions[0]!.id };
    await client.call('agent.decidePermission', { ...decision, behavior: 'deny', message: 'Keep dist' });

    await recorder.waitForText(agent.sessionId, 'Okay, I left dist alone.');
    expect(recorder.screenText(agent.sessionId)).not.toContain('(y/n)');
    await expect(client.call('agent.decidePermission', { ...decision, behavior: 'allow' })).rejects.toMatchObject({
      code: AGENT_ERROR.permissionGone,
    });
    await expect(
      client.call('agent.decidePermission', { ...decision, behavior: 'maybe' as 'allow' }),
    ).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  it('leaves the prompt to the terminal once the hold lapses, and clears it when answered there', async () => {
    const { client, recorder } = await agentDaemon('permission', { permissionHoldMs: 300 });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up');
    const [prompt] = (await untilState(recorder, agent.sessionId, 'needs-permission')).permissions;

    await recorder.waitForText(agent.sessionId, '(y/n)');
    const lapsed = await untilAgent(recorder, agent.sessionId, (a) => a.permissions[0]?.heldUntil === null);
    expect(lapsed).toMatchObject({ state: 'needs-permission', permissions: [{ id: prompt!.id, toolName: 'Bash' }] });
    await expect(
      client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: prompt!.id, behavior: 'allow' }),
    ).rejects.toMatchObject({ code: AGENT_ERROR.permissionGone });

    const typed = recorder.events.length;
    await client.call('session.write', { sessionId: agent.sessionId, data: 'y\r' });
    await recorder.waitForText(agent.sessionId, 'Removed dist.');
    const moved = await untilAgent(recorder, agent.sessionId, (a) => a.state !== 'needs-permission', typed);
    expect(moved.permissions).toEqual([]);
  });

  describe('with two subagents asking at once', () => {
    const commandOf = (prompt: PermissionPrompt) => (prompt.toolInput as { command: string }).command;

    it('holds both, each answered from the inbox on its own', async () => {
      const { client, recorder } = await agentDaemon('subagent-permission');
      const zone = await addZone(client, tempRepo());
      const agent = await spawnAttached(client, zone.id, 'Clean up');

      const asking = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length === 2);
      expect(asking.state).toBe('needs-permission');
      const [dist, build] = ['rm -rf dist', 'rm -rf build'].map((command) => asking.permissions.find((p) => commandOf(p) === command)!);
      expect(dist!.subagent).toEqual({ id: expect.any(String), type: 'general-purpose' });
      expect(build!.subagent!.id).not.toBe(dist!.subagent!.id);

      const first = recorder.events.length;
      await client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: build!.id, behavior: 'deny' });
      await recorder.waitForText(agent.sessionId, 'Left build alone.');
      // The other is still held, and still needs the user, whatever its sibling's hooks did meanwhile.
      const afterFirst = recorder.events.slice(first).filter(isAgentUpdate).filter((e) => e.agent.sessionId === agent.sessionId);
      expect(afterFirst.every((e) => e.agent.state === 'needs-permission')).toBe(true);
      expect(afterFirst.at(-1)!.agent.permissions).toEqual([expect.objectContaining({ id: dist!.id, heldUntil: expect.any(String) })]);

      await client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: dist!.id, behavior: 'allow' });
      await recorder.waitForText(agent.sessionId, 'Both workers are done.');
      expect(recorder.screenText(agent.sessionId)).toContain('Removed dist.');
      expect(recorder.screenText(agent.sessionId)).not.toContain('(y/n)');
      const done = await untilAgent(recorder, agent.sessionId, (a) => a.state === 'waiting' || a.state === 'idle');
      expect(done.permissions).toEqual([]);
    });

    it('keeps both listed after their holds lapse, until each is answered in the terminal', async () => {
      const { client, recorder } = await agentDaemon('subagent-permission', { permissionHoldMs: 300 });
      const zone = await addZone(client, tempRepo());
      const agent = await spawnAttached(client, zone.id, 'Clean up');

      const lapsed = await untilAgent(
        recorder,
        agent.sessionId,
        (a) => a.permissions.length === 2 && a.permissions.every((p) => p.heldUntil === null),
      );
      expect(lapsed.state).toBe('needs-permission');

      // The fake asks for both in its terminal; each typed line answers one.
      const typed = recorder.events.length;
      await client.call('session.write', { sessionId: agent.sessionId, data: 'y\r' });
      const one = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length === 1, typed);
      expect(one.state).toBe('needs-permission');
      await client.call('session.write', { sessionId: agent.sessionId, data: 'n\r' });
      await recorder.waitForText(agent.sessionId, 'Both workers are done.');
      const settled = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length === 0, typed);
      expect(settled.state).not.toBe('needs-permission');
    });
  });

  it('asks claude to wait on its PermissionRequest hook a little longer than the daemon holds it', () => {
    const settings = claudeSettings('http://127.0.0.1:1/hooks', 110_000);
    const timeoutOf = (event: string) => settings.hooks[event]![0]!.hooks[0]!.timeout;
    expect(timeoutOf('PermissionRequest')).toBe(120);
    expect(timeoutOf('PreToolUse')).toBe(5);
  });
});

/** The command line of the agent's process, as `ps` shows it to any local user. */
async function commandLine(client: DaemonClient, sessionId: string): Promise<string> {
  const session = (await client.call('session.list')).find((s) => s.id === sessionId)!;
  return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(session.pid)], { encoding: 'utf8' });
}

describe('long-lived agents', () => {
  /** A Saturday morning, local time. */
  const start = new Date(2026, 9, 10, 7, 30, 15);
  const nineOClock = new Date(2026, 9, 10, 9, 0);
  const isRunPrompt = (prompt: string) => (e: DaemonEvent): e is HookEvent =>
    e.type === 'hook' && e.event === 'UserPromptSubmit' && e.payload.prompt === prompt;
  /** Waits for the agent's first turn to end. */
  const untilFirstStop = (recorder: ReturnType<typeof recordEvents>, sessionId: string) =>
    recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'Stop');

  it('runs on its cron schedule: the prompt goes to the agent at each fire time, and it waits for the next one', async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('output', { clock });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Fix the tests');
    await untilFirstStop(recorder, agent.sessionId);

    const scheduled = await client.call('agent.setSchedule', {
      sessionId: agent.sessionId,
      schedule: { cron: '0 9 * * *', prompt: 'Check the nightly build' },
    });
    expect(scheduled).toMatchObject({
      state: 'scheduled',
      schedule: { cron: '0 9 * * *', prompt: 'Check the nightly build', enabled: true, nextRunAt: nineOClock.toISOString(), lastRun: null },
    });
    expect((await client.call('agent.list'))[0]).toMatchObject({ state: 'scheduled' });

    clock.advanceTo(new Date(nineOClock.getTime() - 1_000));
    // Long enough for a prompt typed early to have reached the agent.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(recorder.events.some(isRunPrompt('Check the nightly build'))).toBe(false);
    const fired = recorder.events.length;
    clock.advance(1_000);
    await recorder.waitFor(isRunPrompt('Check the nightly build'));
    await recorder.waitForText(agent.sessionId, 'Done: Check the nightly build.');
    const after = await untilState(recorder, agent.sessionId, 'scheduled', fired + 1);
    expect(statesOf(recorder.events.slice(fired), agent.sessionId)).toEqual(['scheduled', 'thinking', 'scheduled']);
    expect(after.schedule).toMatchObject({
      nextRunAt: new Date(2026, 9, 11, 9, 0).toISOString(),
      lastRun: { dueAt: nineOClock.toISOString(), firedAt: nineOClock.toISOString(), outcome: 'started', reason: null },
    });
  });

  it("stays scheduled, not waiting for you, when Claude says it's idle at its prompt", async () => {
    const { client, recorder } = await agentDaemon('output', { idleNotifyMs: 100 });
    const zone = await addZone(client, tempRepo());
    const plain = await spawnAttached(client, zone.id, 'Plain');
    const scheduled = await spawnAttached(client, zone.id, 'Scheduled');
    await client.call('agent.setSchedule', { sessionId: scheduled.sessionId, schedule: { cron: '@daily', prompt: 'Sweep' } });

    await untilState(recorder, plain.sessionId, 'waiting');
    const idlePrompts = (sessionId: string) =>
      recorder.events.filter((e) => e.type === 'hook' && e.sessionId === sessionId && e.payload.notification_type === 'idle_prompt');
    await recorder.waitFor((e): e is HookEvent => idlePrompts(scheduled.sessionId).includes(e));
    const [agent] = (await client.call('agent.list')).filter((a) => a.sessionId === scheduled.sessionId);
    expect(agent).toMatchObject({ state: 'scheduled' });
  });

  it('skips a fire time while the agent waits for you, and puts a run that needs permission in the inbox', async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('permission', { clock, repeat: true, permissionHoldMs: 60_000 });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up');
    const asking = await untilState(recorder, agent.sessionId, 'needs-permission');
    await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 * * * *', prompt: 'Clean up again' } });

    // 08:00: still waiting on its first permission prompt.
    clock.advanceTo(new Date(2026, 9, 10, 8, 0));
    const skipped = await untilAgent(recorder, agent.sessionId, (a) => (a.schedule?.lastRun ?? null) !== null);
    expect(skipped).toMatchObject({ state: 'needs-permission', schedule: { lastRun: { outcome: 'skipped', reason: 'it was waiting for you' } } });
    expect(recorder.events.some(isRunPrompt('Clean up again'))).toBe(false);

    const decided = recorder.events.length;
    await client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: asking.permissions[0]!.id, behavior: 'allow' });
    await untilState(recorder, agent.sessionId, 'scheduled', decided);

    // 09:00: the run asks for permission, so it waits for you in the inbox.
    clock.advanceTo(nineOClock);
    await recorder.waitFor(isRunPrompt('Clean up again'));
    const waiting = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length > 0, decided);
    expect(waiting).toMatchObject({
      state: 'needs-permission',
      permissions: [{ toolName: 'Bash' }],
      schedule: { lastRun: { outcome: 'started' } },
    });

    const allowed = recorder.events.length;
    await client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: waiting.permissions[0]!.id, behavior: 'allow' });
    await untilState(recorder, agent.sessionId, 'scheduled', allowed);
  });

  it('can be disabled, keeping its settings, or have its schedule taken away', async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('output', { clock });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Fix the tests');
    await untilFirstStop(recorder, agent.sessionId);
    const schedule = { cron: '0 9 * * *', prompt: 'Sweep' };
    await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule });

    const disabled = await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { ...schedule, enabled: false } });
    expect(disabled).toMatchObject({ state: 'idle', schedule: { ...schedule, enabled: false, nextRunAt: null } });
    clock.advanceTo(new Date(2026, 9, 11));
    const removed = await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: null });
    expect(removed).toMatchObject({ state: 'idle', schedule: null });
    expect(recorder.events.some(isRunPrompt('Sweep'))).toBe(false);
  });

  it('refuses a bad cron expression, an empty prompt or an unknown agent', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    const set = (sessionId: string, schedule: unknown) => client.call('agent.setSchedule', { sessionId, schedule } as never);

    await expect(set(agent.sessionId, { cron: '0 25 * * *', prompt: 'Sweep' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('hour'),
    });
    await expect(set(agent.sessionId, { cron: '@daily', prompt: '' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(set(agent.sessionId, { cron: 5, prompt: 'Sweep' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(set(agent.sessionId, 'daily')).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(set('nope', { cron: '@daily', prompt: 'Sweep' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect((await client.call('agent.list'))[0]!.schedule).toBeNull();
  });

  it('waits for you in the inbox when a run ends on a question, skipping fire times until you answer', async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('waiting', { clock, repeat: true });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Set up the app');
    await untilFirstStop(recorder, agent.sessionId);
    const set = await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 * * * *', prompt: 'Set it up again' } });
    expect(set).toMatchObject({ state: 'waiting', lastMessage: 'Which database should I use, Postgres or SQLite?' });

    // 08:00: its question is still unanswered.
    clock.advanceTo(new Date(2026, 9, 10, 8, 0));
    const skipped = await untilAgent(recorder, agent.sessionId, (a) => (a.schedule?.lastRun ?? null) !== null);
    expect(skipped).toMatchObject({ state: 'waiting', schedule: { lastRun: { outcome: 'skipped', reason: 'it was waiting for you' } } });

    const answered = recorder.events.length;
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'SQLite' });
    await recorder.waitForText(agent.sessionId, 'Going with SQLite.');
    await untilState(recorder, agent.sessionId, 'scheduled', answered);

    // 09:00: the run asks the same question, and waits for you in the inbox.
    const ran = recorder.events.length;
    clock.advanceTo(nineOClock);
    await recorder.waitFor(isRunPrompt('Set it up again'));
    const waiting = await untilAgent(recorder, agent.sessionId, (a) => a.lastMessage?.endsWith('?') === true, ran);
    expect(waiting).toMatchObject({ state: 'waiting', schedule: { lastRun: { outcome: 'started' } } });
    clock.advanceTo(new Date(2026, 9, 10, 10, 0));
    await untilAgent(recorder, agent.sessionId, (a) => a.schedule?.lastRun?.outcome === 'skipped', ran);
  });

  it('skips a fire time while the agent is rate-limited', async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('rate-limit', { clock });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Go');
    await untilState(recorder, agent.sessionId, 'rate-limited');
    await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 8 * * *', prompt: 'Sweep' } });

    clock.advanceTo(new Date(2026, 9, 10, 8, 0));
    const skipped = await untilAgent(recorder, agent.sessionId, (a) => (a.schedule?.lastRun ?? null) !== null);
    expect(skipped.schedule!.lastRun).toMatchObject({ outcome: 'skipped', reason: 'it was rate-limited' });
  });

  it("skips a fire time while you are typing in its terminal, so it never adds to your draft", async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('output', { clock });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Go');
    await untilFirstStop(recorder, agent.sessionId);
    await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 * * * *', prompt: 'Sweep' } });

    await client.call('session.write', { sessionId: agent.sessionId, data: 'half a tho' });
    clock.advanceTo(new Date(2026, 9, 10, 8, 0));
    const skipped = await untilAgent(recorder, agent.sessionId, (a) => (a.schedule?.lastRun ?? null) !== null);
    expect(skipped.schedule!.lastRun).toMatchObject({ outcome: 'skipped', reason: 'you were typing in its terminal' });

    const submitted = recorder.events.length;
    await client.call('session.write', { sessionId: agent.sessionId, data: 'ught\r' });
    await untilAgent(recorder, agent.sessionId, (a) => a.lastMessage === 'Done: half a thought.' && a.state === 'scheduled', submitted);
    clock.advanceTo(nineOClock);
    await recorder.waitFor(isRunPrompt('Sweep'));
  });

  it.each<Harness>(['claude', 'codex'])('relaunches an ended %s agent in its worktree at its next fire time', async (harness) => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('output', { clock });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Fix the tests', harness);
    await untilFirstStop(recorder, agent.sessionId);
    await client.call('agent.stop', { sessionId: agent.sessionId });

    const ended = await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 9 * * *', prompt: 'Check the nightly build' } });
    expect(ended).toMatchObject({ state: 'done', schedule: { nextRunAt: nineOClock.toISOString() } });

    const fired = recorder.events.length;
    clock.advanceTo(nineOClock);
    const relaunched = await untilAgent(recorder, agent.sessionId, (a) => a.endedAt === null && a.schedule?.lastRun != null, fired);
    expect(relaunched).toMatchObject({ cwd: agent.cwd, schedule: { lastRun: { outcome: 'started', reason: null } } });
    const sessionStart = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'SessionStart' && recorder.events.indexOf(e) >= fired,
    );
    // Claude carries on the same conversation; Codex starts a new one in the same worktree.
    expect(sessionStart.payload.source).toBe(harness === 'claude' ? 'resume' : 'startup');
    await recorder.waitFor(isRunPrompt('Check the nightly build'));
    await untilState(recorder, agent.sessionId, 'scheduled', fired);
    // The shell its pane dropped into when it was stopped goes as it relaunches.
    await expect.poll(() => client.call('session.list')).toEqual([expect.objectContaining({ id: agent.sessionId })]);
  });

  it("keeps the Codex setting it last started with when its repo's last zone has gone", async () => {
    const clock = createFakeClock(start);
    const { client, recorder } = await agentDaemon('output', { clock });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Fix the tests', 'codex');
    await untilFirstStop(recorder, agent.sessionId);
    await client.call('agent.stop', { sessionId: agent.sessionId });
    await client.call('agent.move', { sessionId: agent.sessionId, zoneId: null, x: -400, y: 0 });
    await client.call('zone.remove', { id: zone.id });
    await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 9 * * *', prompt: 'Check the nightly build' } });

    const fired = recorder.events.length;
    clock.advanceTo(nineOClock);
    await untilAgent(recorder, agent.sessionId, (a) => a.endedAt === null && a.schedule?.lastRun != null, fired);
    await client.call('session.attach', { sessionId: agent.sessionId });
    // Started unattended, it never stops at Codex's hook review.
    expect(await commandLine(client, agent.sessionId)).toContain('--dangerously-bypass-hook-trust');
  });

  it('relaunches its agent after a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await agentDaemon('output', { dataDir });
    const zone = await addZone(first.client, tempRepo());
    const agent = await first.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await first.client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '0 9 * * *', prompt: 'Sweep' } });
    await first.daemon.stop();

    const clock = createFakeClock(start);
    const second = await agentDaemon('output', { dataDir, clock });
    expect(await second.client.call('agent.list')).toEqual([
      expect.objectContaining({ state: 'failed', schedule: expect.objectContaining({ nextRunAt: nineOClock.toISOString() }) }),
    ]);
    clock.advanceTo(nineOClock);
    await second.recorder.waitFor(isRunPrompt('Sweep'));
    await untilState(second.recorder, agent.sessionId, 'scheduled');
  });

  it('loses its schedule when deleted', async () => {
    const { client, dataDir } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE });
    await client.call('agent.setSchedule', { sessionId: agent.sessionId, schedule: { cron: '@hourly', prompt: 'Sweep' } });

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });

    const db = new DatabaseSync(daemonPaths(dataDir).database, { readOnly: true });
    expect(db.prepare('SELECT count(*) AS n FROM schedules').get()).toEqual({ n: 0 });
    db.close();
  });
});

/** Commits `files` to the repo, so every new worktree of it has them. */
function commit(repo: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'add files');
}

describe.each<Harness>(['claude', 'codex'])('the session window controls, for a %s agent', (harness) => {
  it('interrupts its turn: it goes idle at its prompt, and takes the next message', async () => {
    const { client, recorder } = await agentDaemon('output', { stepDelayMs: 300 });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Run the tests', harness);
    await untilState(recorder, agent.sessionId, 'thinking');

    const interrupted = await client.call('agent.interrupt', { sessionId: agent.sessionId });

    expect(interrupted).toMatchObject({ state: 'idle', endedAt: null });
    await recorder.waitForText(agent.sessionId, 'Interrupted');
    const after = recorder.events.length;
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'carry on' });
    await recorder.waitForText(agent.sessionId, 'Done: carry on.');
    await untilState(recorder, agent.sessionId, 'idle', after);
    expect(recorder.events.some((e) => e.type === 'hook' && e.event === 'Stop' && e.payload.last_assistant_message === 'All tests pass.')).toBe(false);
  });

  it('stays idle when a hook from the interrupted turn lands after the interrupt, until the next prompt', async () => {
    const { client, recorder, home } = await agentDaemon('output', { stepDelayMs: 300 });
    // A copy of each PostToolUse that reaches the daemon 2 s late, through its hook ingress, as a hook still in
    // flight when the turn is interrupted would.
    const late = `body=$(cat); sleep 2; curl -s -o /dev/null -X POST -H "Authorization: Bearer $${HOOK_TOKEN_ENV}" -H 'Content-Type: application/json' --data "$body" "$${HOOK_URL_ENV}"`;
    const configDir = harness === 'claude' ? join(home, '.claude') : join(home, '.codex');
    mkdirSync(configDir, { recursive: true });
    const hooks = { PostToolUse: [{ hooks: [{ type: 'command', command: late }] }] };
    writeFileSync(join(configDir, harness === 'claude' ? 'settings.json' : 'hooks.json'), JSON.stringify({ hooks }));
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Run the tests', harness);
    const posts = () => recorder.events.filter((e) => e.type === 'hook' && e.event === 'PostToolUse').length;
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.event === 'PostToolUse');

    await client.call('agent.interrupt', { sessionId: agent.sessionId });
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.event === 'PostToolUse' && posts() === 2);

    // At its prompt: idle, or waiting once Claude's idle_prompt has fired. Not back mid-turn.
    expect(['idle', 'waiting']).toContain((await client.call('agent.list'))[0]!.state);
    const after = recorder.events.length;
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'carry on' });
    await untilState(recorder, agent.sessionId, 'thinking', after);
  }, 15_000);

  it('interrupts a turn waiting on a permission prompt, releasing its held hook', async () => {
    const { client, recorder } = await agentDaemon('permission');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up', harness);
    await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length === 1);

    const interrupted = await client.call('agent.interrupt', { sessionId: agent.sessionId });

    expect(interrupted).toMatchObject({ state: 'idle', permissions: [] });
    await recorder.waitForText(agent.sessionId, 'Interrupted');
  });

  it('refuses to interrupt an agent with no turn under way, or one that has ended', async () => {
    const { client, recorder } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Run the tests', harness);
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.event === 'Stop');
    await untilState(recorder, agent.sessionId, 'idle');

    const refused = { code: RPC_ERROR.invalidParams };
    await expect(client.call('agent.interrupt', { sessionId: agent.sessionId })).rejects.toMatchObject(refused);
    await expect(client.call('agent.interrupt', { sessionId: 'nope' })).rejects.toMatchObject(refused);
    await client.call('agent.stop', { sessionId: agent.sessionId });
    await expect(client.call('agent.interrupt', { sessionId: agent.sessionId })).rejects.toMatchObject(refused);
  });

  it('stops it mid-turn: its session ends as done, not failed, and its worktree stays', async () => {
    const { client, recorder } = await agentDaemon('output', { stepDelayMs: 300 });
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Run the tests', harness);
    await untilState(recorder, agent.sessionId, 'thinking');

    const stopped = await client.call('agent.stop', { sessionId: agent.sessionId });

    expect(stopped).toMatchObject({ state: 'done', endedAt: expect.any(String) });
    // Its pane may have dropped into a shell already: no harness is left running.
    expect((await client.call('session.list')).filter((session) => session.harness !== null)).toEqual([]);
    expect(existsSync(agent.worktree)).toBe(true);
    await expect(client.call('agent.stop', { sessionId: agent.sessionId })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });
});

describe('Codex agents', () => {
  it('spawns codex in its own worktree, with its state live from hooks forwarded to the daemon', async () => {
    const { client, recorder } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());

    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Run the tests', ...SIZE });

    expect(agent).toMatchObject({ harness: 'codex', name: 'Run the tests', state: 'starting' });
    expect(agent.notice).toBeNull();
    expect(git(agent.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(agent.branch);
    expect(await client.call('session.list')).toEqual([expect.objectContaining({ id: agent.sessionId, harness: 'codex' })]);
    const command = await commandLine(client, agent.sessionId);
    expect(command).toContain('--dangerously-bypass-hook-trust');
    expect(command).toContain('shell_environment_policy.exclude=["AGENT_BOARD_HOOK_*"]');
    expect(command).not.toMatch(/AGENT_BOARD_HOOK_TOKEN|Bearer/);

    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.event === 'Stop');
    await client.call('session.write', { sessionId: agent.sessionId, data: '\x04' });
    await untilState(recorder, agent.sessionId, 'done');

    expect(statesOf(recorder.events, agent.sessionId)).toEqual([
      'starting', // spawned, its first prompt queued
      'running', // SessionStart
      'thinking', // UserPromptSubmit
      'running', // PreToolUse
      'thinking', // PostToolUse
      'idle', // Stop
      'done', // SessionEnd
    ]);
    const start = recorder.events.find((e): e is HookEvent => e.type === 'hook' && e.event === 'SessionStart')!;
    expect(start).toMatchObject({ sessionId: agent.sessionId, payload: { cwd: agent.cwd, model: expect.any(String) } });
  });

  it('holds its PermissionRequest for the inbox, and its forwarder carries the decision back to Codex', async () => {
    const { client, recorder } = await agentDaemon('permission');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Clean up', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });

    const asking = await untilAgent(recorder, agent.sessionId, (a) => a.permissions.length === 1);
    expect(asking).toMatchObject({ state: 'needs-permission', permissions: [{ toolName: 'Bash', heldUntil: expect.any(String) }] });
    const decided = recorder.events.length;
    await client.call('agent.decidePermission', { sessionId: agent.sessionId, requestId: asking.permissions[0]!.id, behavior: 'allow' });

    await recorder.waitForText(agent.sessionId, 'Removed dist.');
    const idle = await untilState(recorder, agent.sessionId, 'idle', decided);
    expect(idle).toMatchObject({ permissions: [], lastMessage: 'Removed dist.' });
    expect(recorder.screenText(agent.sessionId)).not.toContain('(y/n)');
  });

  it('shows needs-permission until the user answers in the terminal once the hold lapses', async () => {
    const { client, recorder } = await agentDaemon('permission', { permissionHoldMs: 300 });
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Clean up', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });

    await untilState(recorder, agent.sessionId, 'needs-permission');
    // The hold lapsed with no decision, so Codex asks in its terminal.
    await recorder.waitForText(agent.sessionId, '(y/n)');
    const answered = recorder.events.length;
    await client.call('session.write', { sessionId: agent.sessionId, data: 'y\r' });
    await untilState(recorder, agent.sessionId, 'idle', answered);
    await recorder.waitForText(agent.sessionId, 'Removed dist.');
  });

  it('ignores a permission_prompt notification that lands after its prompt was answered in the terminal', async () => {
    const { client, recorder, home } = await agentDaemon('permission', { permissionHoldMs: 300, stepDelayMs: 1500 });
    // A permission_prompt Notification that reaches the daemon 1 s after each PostToolUse, as one still in flight when
    // the prompt was answered would.
    const notification = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
    const late = `cat > /dev/null; sleep 1; curl -s -o /dev/null -X POST -H "Authorization: Bearer $${HOOK_TOKEN_ENV}" -H 'Content-Type: application/json' --data '${notification}' "$${HOOK_URL_ENV}"`;
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: late }] }] } }));
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up', 'claude');
    await untilState(recorder, agent.sessionId, 'needs-permission');
    await recorder.waitForText(agent.sessionId, '(y/n)');
    const answered = recorder.events.length;
    await client.call('session.write', { sessionId: agent.sessionId, data: 'y\r' });
    await untilState(recorder, agent.sessionId, 'thinking', answered);

    const notifications = () => recorder.events.filter((e) => e.type === 'hook' && e.event === 'Notification' && e.payload.notification_type === 'permission_prompt').length;
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.event === 'Notification' && notifications() >= 2);
    // The fake's own notification came with the prompt; the second is the late copy. Let the daemon handle it, then check it didn't put the agent back to needs-permission.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The turn is still going on: the answered prompt left it thinking, and the late notification must not change that.
    const states = statesOf(recorder.events.slice(answered), agent.sessionId);
    expect(states.slice(states.indexOf('thinking'))).not.toContain('needs-permission');
    expect((await client.call('agent.list'))[0]!.state).not.toBe('needs-permission');
  }, 20_000);

  it('still shows a genuine second permission prompt after a late notification of the first was ignored', async () => {
    const { client, recorder, home } = await agentDaemon('two-permissions', { permissionHoldMs: 300, stepDelayMs: 1500 });
    const notification = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
    const late = `cat > /dev/null; sleep 1; curl -s -o /dev/null -X POST -H "Authorization: Bearer $${HOOK_TOKEN_ENV}" -H 'Content-Type: application/json' --data '${notification}' "$${HOOK_URL_ENV}"`;
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: late }] }] } }));
    const zone = await addZone(client, tempRepo());
    const agent = await spawnAttached(client, zone.id, 'Clean up', 'claude');
    const asks = (command: string) => (a: Agent) => a.state === 'needs-permission' && a.permissions.some((p) => (p.toolInput as { command?: string }).command === command);
    await untilAgent(recorder, agent.sessionId, asks('rm -rf dist'));
    await recorder.waitForText(agent.sessionId, '(y/n)');
    await client.call('session.write', { sessionId: agent.sessionId, data: 'y\r' });

    // The first prompt's late notification is ignored (dropped), then the second prompt is a new one and must show.
    const second = await untilAgent(recorder, agent.sessionId, asks('rm -rf build'));
    expect(second.permissions).toHaveLength(1);
    await recorder.waitForText(agent.sessionId, '(y/n)');
    await client.call('session.write', { sessionId: agent.sessionId, data: 'y\r' });
    await recorder.waitForText(agent.sessionId, 'Removed build.');
  }, 30_000);

  it('drops the bypass flag when the zone turns it off', async () => {
    const { client, recorder } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    await client.call('zone.configure', { id: zone.id, codexBypassHookTrust: false });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Go', ...SIZE });

    await client.call('session.attach', { sessionId: agent.sessionId });
    expect(await commandLine(client, agent.sessionId)).not.toContain('--dangerously-bypass-hook-trust');
    expect(agent.notice).toBeNull();
    // The fake codex has no review screen: untrusted hooks never run.
    await recorder.waitForText(agent.sessionId, 'untrusted hook group(s)');
  });

  it.each([
    ['a repo zone', '', '.codex/hooks.json'],
    ['a repo zone', '', '.codex/config.toml'],
    ['a folder zone', 'apps/web', 'apps/web/.codex/config.toml'],
    ['a folder zone', 'apps/web', '.codex/hooks.json'],
  ])('in %s, asks first and then launches without the bypass flag when the worktree brings Codex config (%s, %s)', async (_, folder, file) => {
    const { client } = await agentDaemon('output');
    const repo = tempRepo();
    commit(repo, { [file]: '{}\n' });
    const zone = await addZone(client, join(repo, folder));
    const params = { zoneId: zone.id, harness: 'codex' as const, prompt: 'Go', ...SIZE };

    const refused = await client.call('agent.spawn', params).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: AGENT_ERROR.projectCodexConfig, message: expect.stringContaining(dirname(file)) });
    expect((refused as Error).message).toMatch(/trusting all of them trusts both/);
    // Nothing was left behind: no agent, no worktree, no branch.
    expect(await client.call('agent.list')).toEqual([]);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);

    const agent = await client.call('agent.spawn', { ...params, allowProjectCodexConfig: true });
    expect(await commandLine(client, agent.sessionId)).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('counts a committed .codex symlink whose target is missing', async () => {
    const { client } = await agentDaemon('output');
    const repo = tempRepo();
    symlinkSync('.cache/cx', join(repo, '.codex'));
    git(repo, 'add', '.codex');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'link');
    const zone = await addZone(client, repo);

    await expect(client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Go', ...SIZE })).rejects.toMatchObject({
      code: AGENT_ERROR.projectCodexConfig,
    });
  });

  it('ignores Codex config deeper than the agent starts, which Codex would not load', async () => {
    const { client } = await agentDaemon('output');
    const repo = tempRepo();
    commit(repo, { 'apps/web/.codex/hooks.json': '{}\n' });
    const zone = await addZone(client, repo);

    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Go', ...SIZE });

    expect(await commandLine(client, agent.sessionId)).toContain('--dangerously-bypass-hook-trust');
  });

  it('stops a flagged agent once Codex config appears in its worktree, and says why on the agent', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Pick a database', ...SIZE });
    await recorder.waitFor((e): e is HookEvent => e.type === 'hook' && e.sessionId === agent.sessionId && e.event === 'Stop');

    // What the agent could do with a shell command; a /new in its TUI would then load it with the flag still on.
    mkdirSync(join(agent.cwd, '.codex'));
    writeFileSync(join(agent.cwd, '.codex', 'hooks.json'), '{}');

    const stopped = await untilState(recorder, agent.sessionId, 'failed');
    expect(stopped.notice).toContain(join(agent.cwd, '.codex'));
    expect(stopped.notice).toMatch(/stopped this agent/);
    await recorder.waitFor((e): e is SessionExitedEvent => e.type === 'session.exited' && e.sessionId === agent.sessionId);
    expect((await client.call('agent.list'))[0]!.notice).toBe(stopped.notice);
  });

  it('leaves an agent started without the flag alone when Codex config appears', async () => {
    const { client, recorder } = await agentDaemon('waiting');
    const zone = await addZone(client, tempRepo());
    await client.call('zone.configure', { id: zone.id, codexBypassHookTrust: false });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Go', ...SIZE });

    mkdirSync(join(agent.cwd, '.codex'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await client.call('session.list')).toEqual([expect.objectContaining({ id: agent.sessionId })]);
    expect((await client.call('agent.list'))[0]!.notice).toBeNull();
    expect(recorder.events.some((e) => e.type === 'session.exited')).toBe(false);
  });

  it("refuses a Codex agent when its hook launcher can't be written, while Claude agents still start", async () => {
    const blocked = join(tempDataDir(), 'file');
    writeFileSync(blocked, 'not a folder');
    const home = tempDataDir();
    const daemon = await startTestDaemon({
      worktreesDir: tempDataDir(),
      hookShimPath: join(blocked, 'bin', 'agent-board-hook'),
      agentEnv: fakeHarnessEnv({ scenario: 'output', home }),
    });
    const client = await connectTestClient(daemon);
    const zone = await addZone(client, tempRepo());

    await expect(client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Go', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining("can't write the Codex hook launcher"),
    });
    await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...SIZE })).resolves.toMatchObject({ harness: 'claude' });
  });

  it('refuses a harness it does not know', async () => {
    const { client } = await agentDaemon('output');
    const zone = await addZone(client, tempRepo());
    await expect(
      client.call('agent.spawn', { zoneId: zone.id, harness: 'gemini' as never, prompt: 'Go', ...SIZE }),
    ).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect(await client.call('agent.list')).toEqual([]);
  });
});

