import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { createFakeGitHub, createFakeTracker, FAKE_GITHUB_STATE, type FakeGitHubPullRequest } from '@agent-board/tracker/testing';
import type { DaemonClient } from '../src/client.ts';
import type { DaemonOptions } from '../src/daemon.ts';
import {
  DEFAULT_USAGE_THRESHOLDS,
  RPC_ERROR,
  type Agent,
  type AgentState,
  type AgentUpdatedEvent,
  type DaemonEvent,
  type FlowEdge,
  type FlowEdgeRemovedEvent,
  type FlowEdgeUpdatedEvent,
  type HookEvent,
} from '../src/protocol.ts';
import { connectTestClient, git, insertFakeSession, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/**
 * A daemon whose agents run the fake claude's `output` scenario: one turn, then each line typed to it as a turn. Held
 * hand-offs are checked again every `flowRecheckMs`; `gh` is a fake one, if given, asked every 100 ms.
 */
async function flowDaemon(
  dataDir = tempDataDir(),
  stepDelayMs = 0,
  extra: { gh?: string; flowRecheckMs?: number; trackers?: DaemonOptions['trackers'] } = {},
) {
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), idleNotifyMs: 200, stepDelayMs }),
    flowRecheckMs: extra.flowRecheckMs ?? 0,
    trackers: extra.trackers,
    ...(extra.gh === undefined ? {} : { gh: extra.gh, pullRequestPollMs: 100 }),
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, recorder: recordEvents(client) };
}

type Recorder = ReturnType<typeof recordEvents>;

/** Resolves with the edge once an update of it matches. */
async function untilEdge(recorder: Recorder, id: string, match: (edge: FlowEdge) => boolean): Promise<FlowEdge> {
  const event = await recorder.waitFor(
    (e): e is FlowEdgeUpdatedEvent => e.type === 'flowEdge.updated' && e.edge.id === id && match(e.edge),
  );
  return event.edge;
}

const isAgentUpdate = (event: DaemonEvent): event is AgentUpdatedEvent => event.type === 'agent.updated';

/** Resolves with the agent once an update after the first `after` events matches. */
async function untilAgent(recorder: Recorder, sessionId: string, match: (agent: Agent) => boolean, after = 0): Promise<Agent> {
  const event = await recorder.waitFor(
    (e): e is AgentUpdatedEvent =>
      isAgentUpdate(e) && e.agent.sessionId === sessionId && match(e.agent) && recorder.events.indexOf(e) >= after,
  );
  return event.agent;
}

/** The states an agent went through, as clients heard them, without repeats, from the `after`th event on. */
function statesOf(events: DaemonEvent[], sessionId: string, after = 0): AgentState[] {
  const states: AgentState[] = [];
  for (const event of events.slice(after)) {
    if (isAgentUpdate(event) && event.agent.sessionId === sessionId && states.at(-1) !== event.agent.state) {
      states.push(event.agent.state);
    }
  }
  return states;
}

/** Two agents in one zone, each through its first turn and sitting at its prompt. */
async function twoAgents(client: DaemonClient, recorder: Recorder, repo = tempRepo()) {
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0 });
  const a = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write the code', name: 'Coder', ...SIZE });
  const b = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Review the code', name: 'Reviewer', ...SIZE });
  // Its idle prompt has come after its turn: it sits at its prompt.
  for (const agent of [a, b]) await untilAgent(recorder, agent.sessionId, (seen) => seen.state === 'waiting');
  return { zone, a, b };
}

/** Approves every command the edge's gates and scripts run, as they are now. */
async function approveAll(client: DaemonClient, id: string): Promise<void> {
  for (const { command, fingerprint } of await client.call('flowEdge.commands', { id })) {
    await client.call('flowEdge.approve', { id, command, fingerprint });
  }
}

describe('flow edges over the socket', () => {
  it('creates an auto final-message edge between two agents, lists it, and tells every client', async () => {
    const { daemon, client, recorder } = await flowDaemon();
    const other = recordEvents(await connectTestClient(daemon));
    const { a, b } = await twoAgents(client, recorder);

    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });

    expect(edge).toMatchObject({
      id: expect.any(String),
      from: a.sessionId,
      to: b.sessionId,
      trigger: 'auto',
      payload: 'final-message',
      lastDelivery: null,
      delivering: false,
    });
    expect(await client.call('flowEdge.list')).toEqual([edge]);
    await other.waitFor((e): e is FlowEdgeUpdatedEvent => e.type === 'flowEdge.updated' && e.edge.id === edge.id);
  });

  it('refuses an edge to itself, to an unknown agent, a second one the same way, and an auto loop', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const refused = (params: Record<string, unknown>) =>
      expect(client.call('flowEdge.create', params as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    await refused({ from: a.sessionId, to: a.sessionId });
    await refused({ from: a.sessionId, to: 'nobody' });
    await refused({ from: a.sessionId, to: b.sessionId, trigger: 'sometimes' });
    await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    await refused({ from: a.sessionId, to: b.sessionId, trigger: 'manual' });
    // Two auto edges back and forth would have the agents answer each other for ever.
    await refused({ from: b.sessionId, to: a.sessionId });
    const back = await client.call('flowEdge.create', { from: b.sessionId, to: a.sessionId, trigger: 'manual' });
    await expect(client.call('flowEdge.update', { id: back.id, trigger: 'auto' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('moves an end onto another agent, its rules and shape kept, and refuses one onto itself, nobody, a pair already joined or an auto loop', async () => {
    const { client, recorder } = await flowDaemon();
    const { zone, a, b } = await twoAgents(client, recorder);
    const c = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Check the code', name: 'Checker', ...SIZE });
    await untilAgent(recorder, c.sessionId, (seen) => seen.state === 'waiting');
    const refused = (params: Record<string, unknown>) =>
      expect(client.call('flowEdge.update', params as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, payload: 'handover', style: 'elbow' });

    const moved = await client.call('flowEdge.update', { id: edge.id, to: c.sessionId, toSide: 'top' });

    expect(moved).toMatchObject({ id: edge.id, from: a.sessionId, to: c.sessionId, toSide: 'top', style: 'elbow', payload: 'handover', trigger: 'auto' });
    expect(await client.call('flowEdge.list')).toEqual([moved]);
    await refused({ id: edge.id, to: a.sessionId });
    await refused({ id: edge.id, from: c.sessionId });
    await refused({ id: edge.id, to: 'nobody' });
    const other = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual' });
    await refused({ id: other.id, to: c.sessionId });
    // C answering A by itself, with A's edge to C an auto one, would have them answer each other for ever.
    const back = await client.call('flowEdge.create', { from: c.sessionId, to: b.sessionId });
    await refused({ id: back.id, to: a.sessionId });
    // Moved and made manual at once, it closes no loop.
    expect(await client.call('flowEdge.update', { id: back.id, to: a.sessionId, trigger: 'manual' })).toMatchObject({ from: c.sessionId, to: a.sessionId });
  });

  it('switches an edge between auto and manual, and deletes it', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });

    expect(await client.call('flowEdge.update', { id: edge.id, trigger: 'manual' })).toMatchObject({ trigger: 'manual' });
    await client.call('flowEdge.delete', { id: edge.id });

    expect(await client.call('flowEdge.list')).toEqual([]);
    await recorder.waitFor((e): e is FlowEdgeRemovedEvent => e.type === 'flowEdge.removed' && e.id === edge.id);
    await expect(client.call('flowEdge.delete', { id: edge.id })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  it('keeps its edges across a daemon restart, and drops an edge with either agent', async () => {
    const dataDir = tempDataDir();
    const first = await flowDaemon(dataDir);
    const { a, b } = await twoAgents(first.client, first.recorder);
    const edge = await first.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual' });
    first.client.close();
    await first.daemon.stop();

    const second = await flowDaemon(dataDir);
    expect(await second.client.call('flowEdge.list')).toEqual([edge]);
    const other = recordEvents(await connectTestClient(second.daemon));
    await second.client.call('agent.delete', { sessionId: b.sessionId, force: true });
    expect(await second.client.call('flowEdge.list')).toEqual([]);
    // Every client hears it go, before the agent does, so none keeps an edge to an agent it no longer has.
    await other.waitFor((e): e is FlowEdgeRemovedEvent => e.type === 'flowEdge.removed' && e.id === edge.id);
    const order = other.events.map((e) => e.type).filter((type) => type === 'flowEdge.removed' || type === 'agent.removed');
    expect(order).toEqual(['flowEdge.removed', 'agent.removed']);
  });

  it("keeps an agent's last final message across a daemon restart, so a manual edge still sends it", async () => {
    const dataDir = tempDataDir();
    const first = await flowDaemon(dataDir);
    const { a, b } = await twoAgents(first.client, first.recorder);
    const edge = await first.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual' });
    first.client.close();
    await first.daemon.stop();

    const second = await flowDaemon(dataDir);
    const preview = await second.client.call('flowEdge.preview', { id: edge.id });
    expect(preview).toMatchObject({ name: 'final message', text: 'All tests pass.' });
  });

  it('edits its rules, keeps them across a restart, and refuses a path out of the worktree or an empty condition', async () => {
    const dataDir = tempDataDir();
    const first = await flowDaemon(dataDir);
    const { a, b } = await twoAgents(first.client, first.recorder);
    const edge = await first.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    expect(edge).toMatchObject({ payload: 'final-message', path: null, conditions: [], checks: [], held: null, history: [], deliveries: 0 });

    // A file payload takes its default path, until given one.
    expect(await first.client.call('flowEdge.update', { id: edge.id, payload: 'handover' })).toMatchObject({ path: 'handover.md' });
    const conditions = [{ kind: 'pr-checks' }, { kind: 'issue-label', label: 'ready-for-agent' }] as const;
    const edited = await first.client.call('flowEdge.update', { id: edge.id, path: './docs/plan.md', conditions: [...conditions], trigger: 'manual' });
    expect(edited).toMatchObject({ payload: 'handover', path: 'docs/plan.md', trigger: 'manual', conditions, checks: [null, null] });
    const refused = (params: Record<string, unknown>) =>
      expect(first.client.call('flowEdge.update', { id: edge.id, ...params } as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await refused({ path: '../elsewhere/plan.md' });
    await refused({ path: '/etc/passwd' });
    await refused({ conditions: [{ kind: 'script', command: '  ' }] });
    await refused({ conditions: [{ kind: 'issue-label' }] });
    await refused({ conditions: [{ kind: 'whenever' }] });
    await refused({ payload: 'final-message', path: 'plan.md' });
    first.client.close();
    await first.daemon.stop();

    const second = await flowDaemon(dataDir);
    expect(await second.client.call('flowEdge.list')).toEqual([expect.objectContaining({ payload: 'handover', path: 'docs/plan.md', conditions })]);
    // Back to its final message, it carries no file.
    expect(await second.client.call('flowEdge.update', { id: edge.id, payload: 'final-message' })).toMatchObject({ path: null });
  });

  it('picks its sides from where its tiles are, curved, until reshaped: its shape is kept across a restart, and leaves its rules be', async () => {
    const dataDir = tempDataDir();
    const first = await flowDaemon(dataDir);
    const { a, b } = await twoAgents(first.client, first.recorder);
    const edge = await first.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual', payload: 'handover' });
    // An edge made without sides (by the CLI or an orchestrator) has automatic ones: the board picks them as it draws.
    expect(edge).toMatchObject({ fromSide: 'auto', toSide: 'auto', style: 'curved', points: [] });
    const drawn = await first.client.call('flowEdge.create', { from: b.sessionId, to: a.sessionId, fromSide: 'top', toSide: 'bottom', style: 'elbow', trigger: 'manual' });
    expect(drawn).toMatchObject({ fromSide: 'top', toSide: 'bottom', style: 'elbow', points: [] });

    const points = [{ x: 120.5, y: -40 }, { x: 300, y: 80 }];
    const bent = await first.client.call('flowEdge.update', { id: edge.id, fromSide: 'bottom', toSide: 'top', style: 'straight', points });
    expect(bent).toMatchObject({ fromSide: 'bottom', toSide: 'top', style: 'straight', points, trigger: 'manual', payload: 'handover', path: 'handover.md' });
    const refused = (params: Record<string, unknown>) =>
      expect(first.client.call('flowEdge.update', { id: edge.id, ...params } as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await refused({ fromSide: 'middle' });
    // A side can be made automatic again, the other end left as it is.
    expect(await first.client.call('flowEdge.update', { id: drawn.id, toSide: 'auto' })).toMatchObject({ fromSide: 'top', toSide: 'auto' });
    await first.client.call('flowEdge.update', { id: drawn.id, toSide: 'bottom' });
    await refused({ style: 'zigzag' });
    await refused({ points: [{ x: 'a', y: 1 }] });
    await refused({ points: [{ x: Number.NaN, y: 1 }] });
    await refused({ points: Array.from({ length: 33 }, () => ({ x: 0, y: 0 })) });
    // A reshape with a rule refused is refused whole: its shape isn't half saved.
    const shapeOf = async (id: string) => {
      const { fromSide, toSide, style, points: bends } = (await first.client.call('flowEdge.list')).find((known) => known.id === id)!;
      return { fromSide, toSide, style, points: bends };
    };
    await refused({ points: [{ x: 1, y: 1 }], trigger: 'sometimes' });
    expect(await shapeOf(edge.id)).toEqual({ fromSide: 'bottom', toSide: 'top', style: 'straight', points });
    // Nor when the rule would make a loop of auto edges.
    await first.client.call('flowEdge.update', { id: edge.id, trigger: 'auto' });
    await expect(first.client.call('flowEdge.update', { id: drawn.id, style: 'straight', trigger: 'auto' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    expect(await shapeOf(drawn.id)).toEqual({ fromSide: 'top', toSide: 'bottom', style: 'elbow', points: [] });
    await first.client.call('flowEdge.update', { id: edge.id, trigger: 'manual' });
    first.client.close();
    await first.daemon.stop();

    const second = await flowDaemon(dataDir);
    const kept = (await second.client.call('flowEdge.list')).find((known) => known.id === edge.id);
    expect(kept).toMatchObject({ fromSide: 'bottom', toSide: 'top', style: 'straight', points });
  });
});

describe('delivering along flow edges', () => {
  it("delivers A's final message to B as its next message when A's turn ends, A handing off meanwhile", async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    const before = recorder.events.length;

    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });

    // A's turn says "Done: Ship it.", which B gets as its next message.
    const fed = await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its final message): Done: Ship it..', before);
    expect(fed.lastMessage).toBe('Done: Hand-off from Coder (its final message): Done: Ship it..');
    expect(statesOf(recorder.events, a.sessionId, before).slice(0, 4)).toEqual(['thinking', 'idle', 'handing-off', 'idle']);
    const delivered = await recorder.waitFor(
      (e): e is FlowEdgeUpdatedEvent => e.type === 'flowEdge.updated' && e.edge.id === edge.id && e.edge.lastDelivery !== null,
    );
    expect(delivered.edge.lastDelivery).toEqual({ at: expect.any(String), delivered: true, reason: null });
    // Clients heard it go out along the edge, then arrive.
    const delivering = recorder.events
      .slice(before)
      .flatMap((e) => (e.type === 'flowEdge.updated' && e.edge.id === edge.id ? [e.edge.delivering] : []));
    expect(delivering).toEqual([true, false]);
    expect(delivered.edge.delivering).toBe(false);
  });

  it('leaves a manual edge until it is sent, then sends the final message of the turn A last finished', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual' });

    const before = recorder.events.length;
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await untilAgent(recorder, a.sessionId, (agent) => agent.lastMessage === 'Done: Ship it.', before);
    expect(statesOf(recorder.events, a.sessionId, before)).not.toContain('handing-off');
    expect((await client.call('flowEdge.list'))[0]!.lastDelivery).toBeNull();

    // A sits waiting for you: sending from it doesn't take it out of the inbox, or tell you again that it waits.
    await untilAgent(recorder, a.sessionId, (agent) => agent.state === 'waiting', before);
    const sending = recorder.events.length;
    const sent = await client.call('flowEdge.send', { id: edge.id });

    expect(sent.lastDelivery).toMatchObject({ delivered: true, reason: null });
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its final message): Done: Ship it..', before);
    expect(statesOf(recorder.events, a.sessionId, sending)).toEqual(['waiting']);
  });

  it('delivers to a B whose last message asked something: the question was to you, and the hand-off is its answer', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const asked = recorder.events.length;
    await client.call('agent.answer', { sessionId: b.sessionId, text: 'Shall I add tests too?' });
    await untilAgent(recorder, b.sessionId, (agent) => agent.state === 'waiting' && agent.lastMessage === 'Done: Shall I add tests too?.', asked);
    await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });

    const before = recorder.events.length;
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });

    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its final message): Done: Ship it..', before);
  });

  it("refuses to send before A has finished a turn, and skips a B that's still working, saying why", async () => {
    // Slow steps, so B is still mid-turn when the edge is sent.
    const { client, recorder } = await flowDaemon(tempDataDir(), 300);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const a = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write the code', ...SIZE });
    const b = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Review the code', ...SIZE });
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual' });
    await expect(client.call('flowEdge.send', { id: edge.id })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });

    await untilAgent(recorder, a.sessionId, (agent) => agent.state === 'waiting');
    await untilAgent(recorder, b.sessionId, (agent) => agent.state === 'waiting');
    // B is mid-turn on a message of its own.
    const answered = recorder.events.length;
    await client.call('agent.answer', { sessionId: b.sessionId, text: 'Look again' });
    await untilAgent(recorder, b.sessionId, (agent) => agent.state === 'thinking', answered);
    const sent = await client.call('flowEdge.send', { id: edge.id });

    expect(sent.lastDelivery).toEqual({ at: expect.any(String), delivered: false, reason: 'it was still working' });
  });
});

describe('file payloads', () => {
  it("delivers a markdown file from A's worktree when A's turn ends, named for the file, and previews it", async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, payload: 'handover', path: 'plan.md' });
    writeFileSync(join(a.worktree, 'plan.md'), '# Plan\n\n1. Add zoneId.\n');
    expect(await client.call('flowEdge.preview', { id: edge.id })).toEqual({ name: 'plan.md', text: '# Plan\n\n1. Add zoneId.\n', bytes: 23 });
    const before = recorder.events.length;

    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Write the plan' });

    const said = 'Done: Hand-off from Coder (its plan.md): # Plan 1. Add zoneId..';
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === said, before);
    const delivered = await untilEdge(recorder, edge.id, (e) => e.deliveries === 1);
    expect(delivered.history).toEqual([{ at: expect.any(String), kind: 'delivered', detail: 'plan.md (23 B)' }]);
  });

  it('delivers JSON on one line, and skips a file that is not JSON, or missing, saying why', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, payload: 'json', trigger: 'manual' });
    expect(edge.path).toBe('handoff.json');
    await expect(client.call('flowEdge.send', { id: edge.id })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'there is no handoff.json in its worktree',
    });

    writeFileSync(join(a.worktree, 'handoff.json'), '{ "verdict": "approve",\n  "findings": [] }');
    const sending = recorder.events.length;
    await client.call('flowEdge.send', { id: edge.id });
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its handoff.json): {"verdict":"approve","findings":[]}.', sending);

    // An auto hand-off of a broken file goes nowhere, and its history says why.
    writeFileSync(join(a.worktree, 'handoff.json'), '{ verdict');
    await client.call('flowEdge.update', { id: edge.id, trigger: 'auto' });
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Review again' });
    const skipped = await untilEdge(recorder, edge.id, (e) => e.history[0]?.kind === 'skipped');
    expect(skipped.history[0]?.detail).toMatch(/^handoff\.json is not JSON: /);
    expect(skipped.lastDelivery).toMatchObject({ delivered: false, reason: expect.stringMatching(/is not JSON/) });
  });
});

describe('conditions', () => {
  /** A daemon with a fake gh, and two agents in a repo on GitHub, with a pull request of A's whose checks run. */
  async function withPullRequest(flowRecheckMs = 0) {
    const github = createFakeGitHub();
    onTestFinished(github.dispose);
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { gh: github.gh, flowRecheckMs });
    const repo = tempRepo();
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const { a, b } = await twoAgents(client, recorder, repo);
    const pullRequest = (conclusion: string): FakeGitHubPullRequest => ({
      repo: 'acme/app',
      number: 214,
      title: 'Movable sessions',
      headRefName: a.branch,
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'check', status: conclusion === '' ? 'IN_PROGRESS' : 'COMPLETED', conclusion }],
    });
    const checks = (conclusion: string) => github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pullRequest(conclusion)] });
    checks('');
    await untilAgent(recorder, a.sessionId, (agent) => agent.pullRequests[0]?.checks === 'pending');
    return { client, recorder, a, b, checks };
  }

  it("holds an auto hand-off until A's PR checks pass, then delivers it", async () => {
    const { client, recorder, a, b, checks } = await withPullRequest();
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'pr-checks' }] });
    const before = recorder.events.length;

    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });

    const held = await untilEdge(recorder, edge.id, (e) => e.held !== null);
    expect(held.held).toEqual({ since: expect.any(String), reason: 'PR #214 checks pending', name: 'final message', copy: true });
    expect(held.checks).toEqual([{ passed: false, at: expect.any(String), detail: 'PR #214 checks pending' }]);
    expect(held.history.map((event) => event.kind)).toEqual(['held']);
    expect(held.lastDelivery).toBeNull();

    // Failing checks hold it still: A may yet push a fix.
    checks('FAILURE');
    await untilEdge(recorder, edge.id, (e) => e.held?.reason === 'PR #214 checks failing');
    checks('SUCCESS');
    const said = 'Done: Hand-off from Coder (its final message): Done: Ship it..';
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === said, before);
    const released = await untilEdge(recorder, edge.id, (e) => e.deliveries === 1);
    expect(released.held).toBeNull();
    expect(released.history.map((event) => [event.kind, event.detail])).toEqual([
      ['delivered', 'final message (14 B)'],
      ['released', 'every condition passed'],
      ['held', 'PR #214 checks failing'],
      ['held', 'PR #214 checks pending'],
    ]);
  });

  it('sends now whatever its conditions say, dropping the hand-off it held', async () => {
    const { client, recorder, a, b } = await withPullRequest();
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'pr-checks' }] });
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await untilEdge(recorder, edge.id, (e) => e.held !== null);

    const sent = await client.call('flowEdge.send', { id: edge.id });

    expect(sent).toMatchObject({ held: null, deliveries: 1, lastDelivery: { delivered: true } });
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its final message): Done: Ship it..');
  });

  it("checks a held hand-off again by itself, releasing it once a custom script passes in A's worktree", async () => {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', {
      from: a.sessionId,
      to: b.sessionId,
      conditions: [{ kind: 'script', command: 'test -f ready' }],
    });
    await approveAll(client, edge.id);
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    expect((await untilEdge(recorder, edge.id, (e) => e.held !== null)).held?.reason).toBe('exited 1');

    writeFileSync(join(a.worktree, 'ready'), '');

    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1 && e.held === null);
  });

  it("holds a hand-off until A's linked issue has the label", async () => {
    const labels: Record<string, string[]> = { 'ACME-16': [] };
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, {
      flowRecheckMs: 100,
      trackers: { linear: () => createFakeTracker({ labels }) },
    });
    const { zone, a, b } = await twoAgents(client, recorder);
    await client.call('tracker.connect', { provider: 'linear', credential: 'lin_api_key' });
    await client.call('zone.setTracker', { id: zone.id, tracker: { provider: 'linear', scope: 'ACME' } });
    const edge = await client.call('flowEdge.create', {
      from: a.sessionId,
      to: b.sessionId,
      conditions: [{ kind: 'issue-label', label: 'ready-for-agent' }],
    });
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    expect((await untilEdge(recorder, edge.id, (e) => e.held !== null)).held?.reason).toBe('it has no linked issue');

    await client.call('agent.link', { sessionId: a.sessionId, issueId: 'ACME-16' });
    await untilEdge(recorder, edge.id, (e) => e.held?.reason === 'no ready-for-agent label');
    labels['ACME-16'] = ['Ready-for-agent'];

    const released = await untilEdge(recorder, edge.id, (e) => e.deliveries === 1);
    expect(released.checks).toEqual([{ passed: true, at: expect.any(String), detail: 'has ready-for-agent' }]);
  });

  it('releases a held hand-off once its conditions are taken away', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command: 'false' }] });
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await untilEdge(recorder, edge.id, (e) => e.held !== null);

    await client.call('flowEdge.update', { id: edge.id, conditions: [] });

    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1 && e.held === null);
  });
});

describe('pausing, manual edges and queueing', () => {
  it('drops a held hand-off when its edge is made manual: only Send delivers along a manual edge', async () => {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command: 'test -f ready' }] });
    await approveAll(client, edge.id);
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await untilEdge(recorder, edge.id, (e) => e.held !== null);

    const manual = await client.call('flowEdge.update', { id: edge.id, trigger: 'manual' });
    writeFileSync(join(a.worktree, 'ready'), '');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(manual.held).toBeNull();
    expect(manual.history[0]).toMatchObject({ kind: 'skipped', detail: 'it was made manual while it was held' });
    expect((await client.call('flowEdge.list'))[0]).toMatchObject({ deliveries: 0, held: null });
  });

  it("drops every approval when its sender moves to another agent: a command approved in one agent's worktree never runs in another's", async () => {
    const { client, recorder } = await flowDaemon();
    const { zone, a, b } = await twoAgents(client, recorder);
    const c = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Check the code', name: 'Checker', ...SIZE });
    await untilAgent(recorder, c.sessionId, (seen) => seen.state === 'waiting');
    const gate = { conditions: [{ kind: 'script' as const, command: 'test -f ready' }] };
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, ...gate });
    const approvals = async (id: string) => (await client.call('flowEdge.commands', { id })).map((command) => command.approval);
    await approveAll(client, edge.id);
    expect(await approvals(edge.id)).toEqual(['approved']);

    // Moving only its receiver keeps them: the commands still run in the same worktree.
    await client.call('flowEdge.update', { id: edge.id, to: c.sessionId });
    expect(await approvals(edge.id)).toEqual(['approved']);
    // Moving its sender, alone or with a change of rules, drops them.
    await client.call('flowEdge.update', { id: edge.id, from: b.sessionId });
    expect(await approvals(edge.id)).toEqual(['unapproved']);
    await approveAll(client, edge.id);
    await client.call('flowEdge.update', { id: edge.id, from: a.sessionId, paused: true });
    expect(await approvals(edge.id)).toEqual(['unapproved']);
  });

  it("never keeps an approval sent for one sender once the edge has moved to another while it was being checked", async () => {
    const { client, recorder } = await flowDaemon();
    const { zone, a, b } = await twoAgents(client, recorder);
    const c = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Check the code', name: 'Checker', ...SIZE });
    await untilAgent(recorder, c.sessionId, (seen) => seen.state === 'waiting');
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command: 'test -f ready' }] });
    const [plan] = await client.call('flowEdge.commands', { id: edge.id });
    const { command, fingerprint } = plan!;

    // The approval, read for A, is sent; the edge moves to C while the daemon reads what it runs in A's worktree.
    const approving = client.call('flowEdge.approve', { id: edge.id, command, fingerprint, from: a.sessionId });
    const moving = client.call('flowEdge.update', { id: edge.id, from: c.sessionId });
    const [approved, moved] = await Promise.allSettled([approving, moving]);

    expect(moved.status).toBe('fulfilled');
    expect(approved).toMatchObject({ status: 'rejected', reason: { code: RPC_ERROR.invalidParams } });
    expect((await client.call('flowEdge.commands', { id: edge.id })).map((each) => each.approval)).toEqual(['unapproved']);
    // An approval named for a sender the edge no longer has is refused outright.
    await expect(client.call('flowEdge.approve', { id: edge.id, command, fingerprint, from: a.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('drops a held hand-off when its edge is moved onto another agent: it was meant for the one it left', async () => {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { zone, a, b } = await twoAgents(client, recorder);
    const c = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Check the code', name: 'Checker', ...SIZE });
    await untilAgent(recorder, c.sessionId, (seen) => seen.state === 'waiting');
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command: 'test -f ready' }] });
    await approveAll(client, edge.id);
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await untilEdge(recorder, edge.id, (e) => e.held !== null);

    const moved = await client.call('flowEdge.update', { id: edge.id, to: c.sessionId });

    expect(moved.held).toBeNull();
    expect(moved.history[0]).toMatchObject({ kind: 'skipped', detail: 'it was moved to another agent while it was held' });
  });

  it('skips hand-offs while paused, keeps a held one waiting, and releases it once resumed', async () => {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, paused: true });
    expect(edge.paused).toBe(true);
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    const skipped = await untilEdge(recorder, edge.id, (e) => e.history[0]?.kind === 'skipped');
    expect(skipped.history[0]?.detail).toBe('the edge was paused');

    await client.call('flowEdge.update', { id: edge.id, paused: false, conditions: [{ kind: 'script', command: 'test -f ready' }] });
    await approveAll(client, edge.id);
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it again' });
    await untilEdge(recorder, edge.id, (e) => e.held !== null);
    await client.call('flowEdge.update', { id: edge.id, paused: true });
    writeFileSync(join(a.worktree, 'ready'), '');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await client.call('flowEdge.list'))[0]).toMatchObject({ deliveries: 0, held: { reason: 'exited 1' } });

    await client.call('flowEdge.update', { id: edge.id, paused: false });
    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1 && e.held === null);
  });

  /**
   * Two agents and an edge out of A whose script marks `started` (outside the worktree) and then takes a second: long
   * enough to change the edge while it is being checked. It passes once `ready` is in A's worktree.
   */
  async function slowCheck() {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { a, b } = await twoAgents(client, recorder);
    const started = join(tempDataDir(), 'started');
    const command = `touch '${started}'; sleep 1; test -f ready`;
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command }] });
    await approveAll(client, edge.id);
    /** Resolves once a check of the script has started. */
    const checkStarted = async () => {
      rmSync(started, { force: true });
      await expect.poll(() => existsSync(started), { timeout: 5_000 }).toBe(true);
    };
    return { client, recorder, a, b, edge, checkStarted };
  }

  it('holds, not delivers, a hand-off whose check passes after the edge was paused mid-check', async () => {
    const { client, recorder, a, edge, checkStarted } = await slowCheck();
    writeFileSync(join(a.worktree, 'ready'), '');
    const checking = checkStarted();
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await checking;

    await client.call('flowEdge.update', { id: edge.id, paused: true });

    const held = await untilEdge(recorder, edge.id, (e) => e.held !== null);
    expect(held).toMatchObject({ deliveries: 0, held: { reason: 'the edge was paused while it was checked' } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await client.call('flowEdge.list'))[0]).toMatchObject({ deliveries: 0 });
    await client.call('flowEdge.update', { id: edge.id, paused: false });
    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1 && e.held === null);
  });

  it('skips a hand-off whose check passes after the edge was made manual mid-check', async () => {
    const { client, recorder, a, edge, checkStarted } = await slowCheck();
    writeFileSync(join(a.worktree, 'ready'), '');
    const checking = checkStarted();
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await checking;

    await client.call('flowEdge.update', { id: edge.id, trigger: 'manual' });

    const skipped = await untilEdge(recorder, edge.id, (e) => e.history[0]?.kind === 'skipped');
    expect(skipped).toMatchObject({ deliveries: 0, held: null });
    expect(skipped.history[0]?.detail).toBe('it was made manual while it was checked');
  });

  it('keeps holding a hand-off whose recheck passes after the edge was paused mid-check', async () => {
    const { client, recorder, a, edge, checkStarted } = await slowCheck();
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    await untilEdge(recorder, edge.id, (e) => e.held?.reason === 'exited 1');
    writeFileSync(join(a.worktree, 'ready'), '');
    await checkStarted();

    await client.call('flowEdge.update', { id: edge.id, paused: true });

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await client.call('flowEdge.list'))[0]).toMatchObject({ deliveries: 0, paused: true, held: { name: 'final message' } });
    await client.call('flowEdge.update', { id: edge.id, paused: false });
    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1 && e.held === null);
  });

  it("queues a delivery B can't take now, and delivers it once B's turn ends", async () => {
    // Slow steps, so B is still mid-turn when the edge is sent.
    const { client, recorder } = await flowDaemon(tempDataDir(), 300);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const a = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write the code', name: 'Coder', ...SIZE });
    const b = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Review the code', ...SIZE });
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, trigger: 'manual', deliverAs: 'queue' });
    await untilAgent(recorder, a.sessionId, (agent) => agent.state === 'waiting');
    await untilAgent(recorder, b.sessionId, (agent) => agent.state === 'waiting');
    const answered = recorder.events.length;
    await client.call('agent.answer', { sessionId: b.sessionId, text: 'Look again' });
    await untilAgent(recorder, b.sessionId, (agent) => agent.state === 'thinking', answered);

    const sent = await client.call('flowEdge.send', { id: edge.id });

    expect(sent.queued).toEqual({ since: expect.any(String), name: 'final message', copy: true });
    expect(sent.history[0]).toEqual({ at: expect.any(String), kind: 'queued', detail: 'it was still working' });
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its final message): All tests pass..', answered);
    const delivered = await untilEdge(recorder, edge.id, (e) => e.deliveries === 1);
    expect(delivered.queued).toBeNull();
  }, 20_000);
});

describe('the gate green condition, in the daemon', () => {
  it("holds a hand-off while A's gate is red, and runs it again only once A commits", async () => {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { a, b } = await twoAgents(client, recorder);
    // The gate counts its runs in a file outside the worktree, and passes once `green` is committed.
    const runs = join(tempDataDir(), 'runs');
    const command = `echo run >> '${runs}'; git ls-files --error-unmatch green`;
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'gate-green', command }] });
    await approveAll(client, edge.id);
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });
    expect((await untilEdge(recorder, edge.id, (e) => e.held !== null)).held?.reason).toMatch(/^red at [0-9a-f]{7}: exited 1/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readFileSync(runs, 'utf8')).toBe('run\n');

    writeFileSync(join(a.worktree, 'green'), '');
    git(a.worktree, 'add', 'green');
    git(a.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'Fix');

    const released = await untilEdge(recorder, edge.id, (e) => e.deliveries === 1);
    expect(released.checks[0]).toMatchObject({ passed: true, detail: expect.stringMatching(/^green at /) });
    expect(readFileSync(runs, 'utf8')).toBe('run\nrun\n');
  });
});

describe('approving what gates and scripts run', () => {
  it("never runs a command until you approve it, and asks again once what it runs changes", async () => {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    const { a, b } = await twoAgents(client, recorder);
    // The script marks each run outside the worktree, and fails until `ready` is there.
    const runs = join(tempDataDir(), 'runs');
    writeFileSync(join(a.worktree, 'gate.sh'), `echo run >> '${runs}'\ntest -f ready\n`);
    const command = 'sh gate.sh';
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command }] });
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });

    const held = await untilEdge(recorder, edge.id, (e) => e.held !== null);
    expect(held.held?.reason).toBe('waiting for your approval');
    expect(held.checks[0]).toMatchObject({ passed: false, needsApproval: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(runs)).toBe(false);

    const [plan] = await client.call('flowEdge.commands', { id: edge.id });
    expect(plan).toEqual({
      command,
      shown: expect.stringMatching(/^sh gate\.sh\ngate\.sh: sha256 [0-9a-f]{12}$/),
      fingerprint: expect.any(String),
      approval: 'unapproved',
      from: a.sessionId,
    });
    await expect(client.call('flowEdge.approve', { id: edge.id, command, fingerprint: 'stale' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('has changed since you looked at it'),
    });
    await expect(client.call('flowEdge.approve', { id: edge.id, command: 'rm -rf ~', fingerprint: plan!.fingerprint })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });

    const approved = await client.call('flowEdge.approve', { id: edge.id, command, fingerprint: plan!.fingerprint });
    expect(approved.history[0]).toMatchObject({ kind: 'approved', detail: command });
    await untilEdge(recorder, edge.id, (e) => e.held?.reason === 'exited 1');
    expect(readFileSync(runs, 'utf8')).toMatch(/^run\n/);

    // A changes what the command runs: it runs no more until approved again.
    writeFileSync(join(a.worktree, 'gate.sh'), `echo changed >> '${runs}'\ntrue\n`);
    await untilEdge(recorder, edge.id, (e) => e.held?.reason === 'changed since you approved it: waiting for your approval');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(runs, 'utf8')).not.toContain('changed');
    expect((await client.call('flowEdge.commands', { id: edge.id }))[0]?.approval).toBe('changed');

    await approveAll(client, edge.id);
    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1 && e.held === null);
    expect(readFileSync(runs, 'utf8')).toContain('changed');
  });

  it('drops the approval of a command taken off the edge, so putting it back asks again', async () => {
    const { client, recorder } = await flowDaemon();
    const { a, b } = await twoAgents(client, recorder);
    const conditions = [{ kind: 'script', command: 'true' }] as const;
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [...conditions] });
    await approveAll(client, edge.id);
    expect((await client.call('flowEdge.commands', { id: edge.id }))[0]?.approval).toBe('approved');

    await client.call('flowEdge.update', { id: edge.id, conditions: [] });
    await client.call('flowEdge.update', { id: edge.id, conditions: [...conditions] });

    expect((await client.call('flowEdge.commands', { id: edge.id }))[0]?.approval).toBe('unapproved');
  });
});

describe('held payloads', () => {
  /** Two agents, and a handover.md edge out of A held until `ready` is in A's worktree. */
  async function heldPlan(heldPayloads?: 'copy' | 'path') {
    const { client, recorder } = await flowDaemon(tempDataDir(), 0, { flowRecheckMs: 100 });
    if (heldPayloads !== undefined) expect(await client.call('settings.set', { heldPayloads })).toMatchObject({ heldPayloads });
    const { a, b } = await twoAgents(client, recorder);
    const edge = await client.call('flowEdge.create', {
      from: a.sessionId,
      to: b.sessionId,
      payload: 'handover',
      path: 'plan.md',
      conditions: [{ kind: 'script', command: 'test -f ready' }],
    });
    await approveAll(client, edge.id);
    writeFileSync(join(a.worktree, 'plan.md'), 'First plan\n');
    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Write the plan' });
    const held = await untilEdge(recorder, edge.id, (e) => e.held?.reason === 'exited 1');
    return { client, recorder, a, b, edge, held };
  }

  it('keeps a copy by default, and delivers the plan as it was when A handed off', async () => {
    const { client, recorder, a, b, edge, held } = await heldPlan();
    expect(await client.call('settings.get')).toEqual({ heldPayloads: 'copy', claudePath: '', codexPath: '', compactWindow: 0, clickableLinks: true, needsYouShows: 'explicit', notifications: true, notifyInFront: false, arrangeSpacing: 'roomy', usagePacing: false, usageThresholds: DEFAULT_USAGE_THRESHOLDS });
    expect(held.held).toMatchObject({ name: 'plan.md', copy: true });
    const before = recorder.events.length;
    writeFileSync(join(a.worktree, 'plan.md'), 'Second plan\n');
    writeFileSync(join(a.worktree, 'ready'), '');
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its plan.md): First plan.', before);
    expect((await untilEdge(recorder, edge.id, (e) => e.deliveries === 1)).held).toBeNull();
  });

  it("holds a hand-off to an agent in a zone held for usage, saying why, and delivers it once the hold is lifted", async () => {
    const dataDir = tempDataDir();
    const { daemon, client, recorder } = await flowDaemon(dataDir);
    const { zone, a, b } = await twoAgents(client, recorder);
    await client.call('settings.set', { usagePacing: true });
    await client.call('zone.configure', { id: zone.id, priority: 'low' });
    insertFakeSession(dataDir, { id: 'reader', hookToken: 'reader-token' });
    await fetch(`http://127.0.0.1:${daemon.hookPort}/usage`, {
      method: 'POST',
      headers: { authorization: 'Bearer reader-token' },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 90, resets_at: Date.now() / 1000 + 3600 } } }),
    });
    await client.call('orchestrator.hold', { zoneId: zone.id });
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });

    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Write the code' });

    expect((await untilEdge(recorder, edge.id, (e) => e.held !== null)).held).toMatchObject({ reason: 'held: 5h at 90%, zone low priority' });
    const before = recorder.events.length;
    await client.call('orchestrator.release', { zoneId: zone.id });
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage?.startsWith('Done: Hand-off from Coder') === true, before);
    expect((await untilEdge(recorder, edge.id, (e) => e.deliveries === 1)).held).toBeNull();
  });

  it('holds a hand-off to an agent paused for usage, saying why, and delivers it once the user wakes it', async () => {
    const dataDir = tempDataDir();
    const { daemon, client, recorder } = await flowDaemon(dataDir);
    const { zone, a, b } = await twoAgents(client, recorder);
    await client.call('settings.set', { usagePacing: true });
    await client.call('zone.configure', { id: zone.id, priority: 'low' });
    insertFakeSession(dataDir, { id: 'reader', hookToken: 'reader-token' });
    await fetch(`http://127.0.0.1:${daemon.hookPort}/usage`, {
      method: 'POST',
      headers: { authorization: 'Bearer reader-token' },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 96, resets_at: Date.now() / 1000 + 3600 } } }),
    });
    await client.call('orchestrator.usagePause', { sessionId: b.sessionId });
    await untilAgent(recorder, b.sessionId, (agent) => agent.state === 'hibernated');
    const edge = await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });

    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Write the code' });

    expect((await untilEdge(recorder, edge.id, (e) => e.held !== null)).held).toMatchObject({ reason: 'held: paused for usage, 5h at 96%, zone low priority' });
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === b.sessionId)?.state).toBe('hibernated');

    // The user's Override wakes it, and what was held for its pause goes at once: this daemon has no periodic recheck.
    const before = recorder.events.length;
    await client.call('agent.resume', { sessionId: b.sessionId });
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage?.startsWith('Done: Hand-off from Coder') === true, before);
    expect((await untilEdge(recorder, edge.id, (e) => e.deliveries === 1)).held).toBeNull();
  });

  it('keeps only the path when told to, and reads the file again when it delivers', async () => {
    const { recorder, a, b, edge, held } = await heldPlan('path');
    expect(held.held).toMatchObject({ name: 'plan.md', copy: false });
    const before = recorder.events.length;
    writeFileSync(join(a.worktree, 'plan.md'), 'Second plan\n');
    writeFileSync(join(a.worktree, 'ready'), '');
    await untilAgent(recorder, b.sessionId, (agent) => agent.lastMessage === 'Done: Hand-off from Coder (its plan.md): Second plan.', before);
    await untilEdge(recorder, edge.id, (e) => e.deliveries === 1);
  });

  it('skips a held hand-off whose file has gone by the time it is delivered, with only its path kept', async () => {
    const { a, recorder, edge } = await heldPlan('path');
    rmSync(join(a.worktree, 'plan.md'));
    writeFileSync(join(a.worktree, 'ready'), '');
    const skipped = await untilEdge(recorder, edge.id, (e) => e.history[0]?.kind === 'skipped');
    expect(skipped.history[0]?.detail).toBe('there is no plan.md in its worktree');
    expect(skipped).toMatchObject({ held: null, deliveries: 0 });
  });

  it('drops the copies held now when told to keep only paths', async () => {
    const { client, recorder, edge } = await heldPlan();
    await expect(client.call('settings.set', { heldPayloads: 'nowhere' as 'path' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await client.call('settings.set', { heldPayloads: 'path' });
    expect((await untilEdge(recorder, edge.id, (e) => e.held?.copy === false)).held?.name).toBe('plan.md');
  });

  it('drops a held hand-off, and its copy, when you drop it', async () => {
    const { client, a, edge } = await heldPlan();
    const dropped = await client.call('flowEdge.drop', { id: edge.id });
    expect(dropped.held).toBeNull();
    expect(dropped.history[0]).toMatchObject({ kind: 'skipped', detail: 'plan.md was dropped by you' });
    writeFileSync(join(a.worktree, 'ready'), '');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await client.call('flowEdge.list'))[0]).toMatchObject({ held: null, deliveries: 0 });
  });
});

describe('handing off to an ended agent', () => {
  it("resumes an ended Codex B's conversation with the hand-off, as Claude does", async () => {
    const { client, recorder } = await flowDaemon();
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const a = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write the code', name: 'Coder', ...SIZE });
    const b = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Review the code', name: 'Reviewer', ...SIZE });
    await untilAgent(recorder, a.sessionId, (seen) => seen.state === 'waiting');
    await untilAgent(recorder, b.sessionId, (seen) => seen.lastMessage !== null);
    const thread = (await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === b.sessionId && e.event === 'SessionStart',
    )).payload.session_id;
    await client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    await client.call('agent.stop', { sessionId: b.sessionId });
    await untilAgent(recorder, b.sessionId, (agent) => agent.endedAt !== null);
    const before = recorder.events.length;

    await client.call('agent.answer', { sessionId: a.sessionId, text: 'Ship it' });

    const resumed = await recorder.waitFor(
      (e): e is HookEvent => e.type === 'hook' && e.sessionId === b.sessionId && e.event === 'SessionStart' && recorder.events.indexOf(e) >= before,
    );
    expect(resumed.payload).toMatchObject({ source: 'resume', session_id: thread });
  }, 20_000);
});
