import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import {
  BOARD_ERROR,
  RPC_ERROR,
  type Agent,
  type AgentUpdatedEvent,
  type DaemonEvent,
  type FlowEdge,
  type FlowEdgeUpdatedEvent,
  type OrchestratorActivityEvent,
} from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A daemon whose agents play the fake harnesses' `orchestrate` scenario for every line typed to them, in one zone
 * whose agents may not orchestrate: handing off is every agent's.
 */
async function handoffDaemon(flowRecheckMs = 0, dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, repeat: true }),
    flowRecheckMs,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  await client.call('zone.configure', { id: zone.id, agentsOrchestrate: false });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof handoffDaemon>>;

/** The first update of the agent, from the `since`th event on, that matches; with its event's index. */
async function untilAgent(
  recorder: Setup['recorder'],
  sessionId: string,
  match: (agent: Agent) => boolean,
  since = 0,
): Promise<Agent & { at: number }> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent =>
      e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent) && recorder.events.indexOf(e) >= since,
  );
  return { ...event.agent, at: recorder.events.indexOf(event) };
}

/**
 * The end of the agent's next turn from the `since`th event on: its turn starting, then its prompt again. An idle from
 * before `since` is the last turn's end, and Send while the next one still works would be skipped.
 */
async function untilTurnEnds(recorder: Setup['recorder'], sessionId: string, since: number): Promise<Agent & { at: number }> {
  const working = await untilAgent(recorder, sessionId, (seen) => seen.state === 'thinking', since);
  return untilAgent(recorder, sessionId, (seen) => seen.state === 'idle' || seen.state === 'waiting', working.at);
}

async function untilEdge(recorder: Setup['recorder'], id: string, match: (edge: FlowEdge) => boolean): Promise<FlowEdge> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is FlowEdgeUpdatedEvent => e.type === 'flowEdge.updated' && e.edge.id === id && match(e.edge),
  );
  return event.edge;
}

/**
 * An agent named `name` that prints its board token and sits at its prompt, and a connection as it: the token
 * presented, as the CLI and MCP do.
 */
async function agentSide(setup: Setup, name: string) {
  const { daemon, client, recorder, zone } = setup;
  const agent = await client.call('agent.spawn', { zoneId: zone.id, name, prompt: 'Print your board identity', ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  await untilAgent(recorder, agent.sessionId, (seen) => seen.state === 'waiting');
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

/** An agent the user started, at its prompt, attached so what it is typed can be read. */
async function receiver(setup: Setup, name: string): Promise<Agent> {
  const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name, ...SIZE });
  await setup.client.call('session.attach', { sessionId: agent.sessionId });
  return agent;
}

const handover = (worktree: string, text: string, path = 'handover.md') => {
  mkdirSync(join(worktree, path, '..'), { recursive: true });
  writeFileSync(join(worktree, path), text);
};

/** The kinds of the edge's events, oldest first. */
const historyOf = async (setup: Setup, id: string) =>
  (await setup.client.call('flowEdge.list')).find((edge) => edge.id === id)!.history.map(({ kind }) => kind).reverse();

/**
 * A witness edge from `from` to a third agent, carrying the same file as the edge under test but never handed off
 * explicitly: its turn's end hands off along it, so once it has delivered, that hand-off has run along every edge it
 * was going to. Resolves with a wait for that, plus a margin for a slower edge's work (a script) to land.
 */
async function witness(setup: Setup, from: string) {
  const c = await receiver(setup, 'witness');
  const edge = await setup.client.call('flowEdge.create', { from, to: c.sessionId, payload: 'handover', path: '.agent-board/handover.md' });
  return async () => {
    await untilEdge(setup.recorder, edge.id, (seen) => seen.deliveries === 1 && !seen.delivering);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  };
}

describe('handing off explicitly', () => {
  it("hands a fake agent's handover.md to a fake reviewer through the MCP tool, logs it, and its turn's end doesn't send it again", async () => {
    const setup = await handoffDaemon();
    const { agent: a } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const edge = await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, payload: 'handover', path: '.agent-board/handover.md' });
    const turnEnded = await witness(setup, a.sessionId);

    // It writes .agent-board/handover.md, calls the handoff tool (to the reviewer alone), then ends its turn.
    await setup.client.call('agent.answer', { sessionId: a.sessionId, text: 'Hand off to review: The login test is fixed.' });

    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its handover.md): # Handover The login test is fixed.');
    await setup.recorder.waitForText(a.sessionId, 'review: delivered handover.md');
    const logged = await setup.recorder.waitFor(
      (e: DaemonEvent): e is OrchestratorActivityEvent => e.type === 'orchestrator.activity' && e.entry.action === 'handoff',
    );
    expect(logged.entry).toMatchObject({ orchestratorId: a.sessionId, targetId: b.sessionId, outcome: 'done', detail: 'handover.md: delivered' });
    // Its turn's end hands off along the witness alone: the reviewer's edge delivered once, and was never tried again.
    await turnEnded();
    expect(await historyOf(setup, edge.id)).toEqual(['delivered']);
    expect(edge.madeBy).toBeNull();
  });

  it("holds a fake agent's hand-off through the tool while its edge's condition fails, and its turn's end doesn't send it either", async () => {
    const setup = await handoffDaemon();
    const { agent: a } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const edge = await setup.client.call('flowEdge.create', {
      from: a.sessionId,
      to: b.sessionId,
      payload: 'handover',
      path: '.agent-board/handover.md',
      conditions: [{ kind: 'script', command: 'test -f ready' }],
    });
    for (const { command, fingerprint } of await setup.client.call('flowEdge.commands', { id: edge.id })) {
      await setup.client.call('flowEdge.approve', { id: edge.id, command, fingerprint });
    }
    const turnEnded = await witness(setup, a.sessionId);

    await setup.client.call('agent.answer', { sessionId: a.sessionId, text: 'Hand off to review: Not ready yet.' });

    await setup.recorder.waitForText(a.sessionId, 'review: held handover.md: exited 1');
    // Its turn's end doesn't hand off along it again: one hold, not two.
    await turnEnded();
    expect(await historyOf(setup, edge.id)).toEqual(['approved', 'held']);
    const now = (await setup.client.call('flowEdge.list')).find((each) => each.id === edge.id);
    expect(now).toMatchObject({ deliveries: 0, held: { name: 'handover.md', reason: 'exited 1', copy: true } });
    expect(setup.recorder.screenText(b.sessionId)).not.toContain('Hand-off from');
  });

  it('hands off again at the end of a later turn: a hand-off belongs to the turn it was made in, even one interrupted or never begun', async () => {
    const setup = await handoffDaemon();
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const edge = await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });

    // Handed off between turns: no Stop of its turn follows.
    expect(await connection.call('board.handoff', { token, message: 'first' })).toMatchObject([{ outcome: 'delivered' }]);
    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its message): first');
    await untilAgent(setup.recorder, b.sessionId, (seen) => seen.state === 'waiting' && seen.lastMessage !== null);

    // Its next turn ends with a final message, which goes along the edge as ever.
    await setup.client.call('agent.answer', { sessionId: a.sessionId, text: 'Write the docs' });

    await untilEdge(setup.recorder, edge.id, (seen) => seen.deliveries === 2);
    expect(await historyOf(setup, edge.id)).toEqual(['delivered', 'delivered']);
    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its final message): Handover written. STATUS: done');
  });

  it('hands off through `agent-board handoff` in its shell too', async () => {
    const setup = await handoffDaemon();
    const { agent: a } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, payload: 'handover', path: '.agent-board/handover.md' });

    await setup.client.call('agent.answer', { sessionId: a.sessionId, text: 'Hand off by CLI: Docs updated.' });

    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its handover.md): # Handover Docs updated.');
    await setup.recorder.waitForText(a.sessionId, 'review: delivered handover.md');
  });

  it('hands off only along its own outgoing edges, and with `to` along its edge to that agent alone', async () => {
    const setup = await handoffDaemon();
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const c = await receiver(setup, 'docs');
    const toB = await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    const toC = await setup.client.call('flowEdge.create', { from: a.sessionId, to: c.sessionId });
    const intoA = await setup.client.call('flowEdge.create', { from: b.sessionId, to: a.sessionId, trigger: 'manual' });
    const bToC = await setup.client.call('flowEdge.create', { from: b.sessionId, to: c.sessionId, trigger: 'manual' });

    const outcomes = await connection.call('board.handoff', { token, to: c.sessionId, message: 'Docs need a line on login' });

    expect(outcomes).toEqual([{ edgeId: toC.id, to: c.sessionId, outcome: 'delivered', name: 'message', reason: null }]);
    await setup.recorder.waitForText(c.sessionId, 'Hand-off from impl (its message): Docs need a line on login');
    const byId = new Map((await setup.client.call('flowEdge.list')).map((edge) => [edge.id, edge]));
    for (const id of [toB.id, intoA.id, bToC.id]) expect(byId.get(id)!.deliveries).toBe(0);

    // Never to itself.
    await expect(connection.call('board.handoff', { token, to: a.sessionId, message: 'hi' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/that is you/),
    });
    // One with no edge out hands nothing on, but says it is finished.
    const lone = await agentSide(setup, 'lone');
    // What it hands over is checked as an edge would: a handover that isn't there finishes nothing.
    await expect(lone.connection.call('board.handoff', { token: lone.token, handoverPath: '.agent-board/handovr.md' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/there is no .agent-board\/handovr.md in its worktree/),
    });
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === lone.agent.sessionId)?.workFinishedAt).toBeNull();
    expect(await lone.connection.call('board.handoff', { token: lone.token, message: 'hi' })).toEqual([]);
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === lone.agent.sessionId)?.workFinishedAt).toEqual(expect.any(String));
    expect((await setup.client.call('agent.list')).find((agent) => agent.sessionId === a.sessionId)?.workFinishedAt).toEqual(expect.any(String));
  });

  it('says an agent is finished once it sets its status done, until its next prompt', async () => {
    const setup = await handoffDaemon();
    const { agent, token, connection } = await agentSide(setup, 'impl');
    expect(await connection.call('board.setStatus', { token, summary: 'Gate running' })).toMatchObject({ workFinishedAt: null });
    const done = await connection.call('board.setStatus', { token, summary: 'PR open', done: true });
    expect(done.workFinishedAt).toEqual(expect.any(String));
    // Done again keeps when it first said so.
    expect((await connection.call('board.setStatus', { token, summary: 'PR open, gate green', done: true })).workFinishedAt).toBe(done.workFinishedAt);

    const since = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Also add a test' });
    expect(await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'thinking', since)).toMatchObject({ workFinishedAt: null });
  });

  it('hands off to an agent it names with no edge, as a one-off edge drawn afterwards, and again along it', async () => {
    const setup = await handoffDaemon();
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');

    const handedFirst = setup.recorder.events.length;
    const [first] = await connection.call('board.handoff', { token, to: b.sessionId, message: 'Please review the login fix' });
    expect(first).toMatchObject({ to: b.sessionId, outcome: 'delivered', name: 'message' });
    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its message): Please review the login fix');
    const edge = (await setup.client.call('flowEdge.list')).find((each) => each.id === first!.edgeId)!;
    expect(edge).toMatchObject({ from: a.sessionId, to: b.sessionId, trigger: 'manual', oneOff: true, madeBy: a.sessionId, deliveries: 1 });
    expect(await setup.client.call('flowEdge.lastPayload', { id: edge.id })).toMatchObject({ text: 'Please review the login fix' });

    // Named again, it goes along the same edge, though it is manual; the user's Send replays what it last carried.
    await untilTurnEnds(setup.recorder, b.sessionId, handedFirst);
    const handed = setup.recorder.events.length;
    const [again] = await connection.call('board.handoff', { token, to: b.sessionId, message: 'And the signup test' });
    expect(again).toMatchObject({ edgeId: edge.id, outcome: 'delivered' });
    expect(await historyOf(setup, edge.id)).toEqual(['delivered', 'delivered']);
    expect((await setup.client.call('flowEdge.list')).filter((each) => each.from === a.sessionId)).toHaveLength(1);
    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its message): And the signup test');
    await untilTurnEnds(setup.recorder, b.sessionId, handed);
    await setup.client.call('flowEdge.send', { id: edge.id });
    expect(await historyOf(setup, edge.id)).toEqual(['delivered', 'delivered', 'delivered']);
    expect(await setup.client.call('flowEdge.lastPayload', { id: edge.id })).toMatchObject({ text: 'And the signup test' });
  });

  it("keeps what a named hand-off carried, so Send replays it after a restart: JSON handed inline is no file", async () => {
    const dataDir = tempDataDir();
    const setup = await handoffDaemon(0, dataDir);
    const { token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const [handed] = await connection.call('board.handoff', { token, to: b.sessionId, json: { pr: 12 } });
    expect(handed).toMatchObject({ outcome: 'delivered' });
    connection.close();
    setup.client.close();
    await setup.daemon.stop();

    const again = await connectTestClient(await startTestDaemon({ dataDir }));
    expect(await again.call('flowEdge.preview', { id: handed!.edgeId })).toMatchObject({ text: '{"pr":12}' });
  });

  it('hands back and forth by name, implementer and reviewer, and leaves the user free to draw the reply', async () => {
    const setup = await handoffDaemon();
    const impl = await agentSide(setup, 'impl');
    const review = await agentSide(setup, 'review');
    // Each turn on a hand-off writes a handover and ends on STATUS: done.
    const turnEnded = async (agent: Agent) => {
      await setup.recorder.waitForText(agent.sessionId, 'STATUS: done');
      await expect
        .poll(async () => (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.state, { timeout: 10_000 })
        .toMatch(/^(idle|waiting)$/);
    };

    const [there] = await impl.connection.call('board.handoff', { token: impl.token, to: review.agent.sessionId, message: 'Review this' });
    expect(there).toMatchObject({ outcome: 'delivered' });
    // A one-off edge is no auto edge: the user may draw the reply, and a named one back is never refused.
    const drawn = await setup.client.call('flowEdge.create', { from: review.agent.sessionId, to: impl.agent.sessionId });
    await setup.client.call('flowEdge.delete', { id: drawn.id });
    const [back] = await review.connection.call('board.handoff', { token: review.token, to: impl.agent.sessionId, message: 'Fix the null check' });
    expect(back).toMatchObject({ outcome: 'delivered' });
    await setup.recorder.waitForText(impl.agent.sessionId, 'Hand-off from review (its message): Fix the null check');
    await turnEnded(review.agent);
    const [again] = await impl.connection.call('board.handoff', { token: impl.token, to: review.agent.sessionId, message: 'Fixed' });
    expect(again).toMatchObject({ edgeId: there!.edgeId, outcome: 'delivered' });
    const edges = await setup.client.call('flowEdge.list');
    expect(edges.map((edge) => [edge.from, edge.oneOff])).toEqual([
      [impl.agent.sessionId, true],
      [review.agent.sessionId, true],
    ]);
  });

  it('never starts an ended agent again by a named hand-off, so two agents can never relaunch each other', async () => {
    const setup = await handoffDaemon();
    const impl = await agentSide(setup, 'impl');
    const review = await agentSide(setup, 'review');
    const ended = async (agent: Agent) => {
      await setup.client.call('agent.stop', { sessionId: agent.sessionId });
      await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.endedAt !== null);
    };
    const [there] = await impl.connection.call('board.handoff', { token: impl.token, to: review.agent.sessionId, message: 'Review this' });

    // The reviewer ends; the implementer names it again: skipped, and it stays ended.
    await ended(review.agent);
    const [skipped] = await impl.connection.call('board.handoff', { token: impl.token, to: review.agent.sessionId, message: 'Wake up' });
    expect(skipped).toMatchObject({
      edgeId: there!.edgeId,
      outcome: 'skipped',
      reason: "review has ended: a named hand-off never starts it again, the user's Send or an edge the user drew does",
    });
    // Both ended, nothing a named hand-off made starts either: only the user's Send along it does.
    await ended(impl.agent);
    const isEnded = async (agent: Agent) => (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.endedAt !== null;
    expect([await isEnded(impl.agent), await isEnded(review.agent)]).toEqual([true, true]);
    await setup.client.call('flowEdge.send', { id: there!.edgeId });
    await untilAgent(setup.recorder, review.agent.sessionId, (seen) => seen.endedAt === null);
    expect(await isEnded(impl.agent)).toBe(true);
  });

  it('names a target only in its scope: its zone, unless the user let it orchestrate wider', async () => {
    const setup = await handoffDaemon();
    const { token, connection } = await agentSide(setup, 'impl');
    const elsewhere = await setup.client.call('zone.add', { path: tempRepo('elsewhere'), x: 4000, y: 0, name: 'elsewhere' });
    const far = await setup.client.call('agent.spawn', { zoneId: elsewhere.id, name: 'far', ...SIZE });
    await expect(connection.call('board.handoff', { token, to: far.sessionId, message: 'hi' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/far is outside your scope/),
    });
    expect(await setup.client.call('flowEdge.list')).toEqual([]);
  });

  it("skips a final-message edge it gives no message, since its last final message is from an earlier turn; a manual or paused one too", async () => {
    const setup = await handoffDaemon();
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const c = await receiver(setup, 'docs');
    const d = await receiver(setup, 'qa');
    const finalMessage = await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    const manual = await setup.client.call('flowEdge.create', { from: a.sessionId, to: c.sessionId, trigger: 'manual', payload: 'handover' });
    const paused = await setup.client.call('flowEdge.create', { from: a.sessionId, to: d.sessionId, payload: 'handover', paused: true });
    handover(a.worktree, 'notes');

    const outcomes = await connection.call('board.handoff', { token });

    expect(outcomes).toEqual([
      { edgeId: finalMessage.id, to: b.sessionId, outcome: 'skipped', name: 'final message', reason: expect.stringMatching(/give a message/) },
      { edgeId: manual.id, to: c.sessionId, outcome: 'skipped', name: 'handover.md', reason: expect.stringMatching(/manual: the user sends it/) },
      { edgeId: paused.id, to: d.sessionId, outcome: 'skipped', name: 'handover.md', reason: 'the edge was paused' },
    ]);
    expect((await setup.client.call('flowEdge.list')).map((edge) => edge.deliveries)).toEqual([0, 0, 0]);
  });

  it('takes a handover file of its own, and inline JSON, in place of the files its edges name; and refuses one outside its worktree', async () => {
    const setup = await handoffDaemon();
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const c = await receiver(setup, 'ci');
    await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, payload: 'handover' });
    await setup.client.call('flowEdge.create', { from: a.sessionId, to: c.sessionId, payload: 'json' });
    handover(a.worktree, 'The plan is done.', '.agent-board/handover.md');

    const outcomes = await connection.call('board.handoff', { token, handoverPath: '.agent-board/handover.md', json: { ready: true, tests: 3 } });

    expect(outcomes.map(({ outcome, name }) => [outcome, name])).toEqual([
      ['delivered', 'handover.md'],
      ['delivered', 'handoff.json'],
    ]);
    await setup.recorder.waitForText(b.sessionId, '(its handover.md): The plan is done.');
    await setup.recorder.waitForText(c.sessionId, '(its handoff.json): {"ready":true,"tests":3}');
    const [first] = await setup.client.call('flowEdge.list');
    expect(await setup.client.call('flowEdge.lastPayload', { id: first!.id })).toEqual({ name: 'handover.md', text: 'The plan is done.', at: expect.any(String) });

    await expect(connection.call('board.handoff', { token, handoverPath: '../elsewhere.md' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });

  it('holds a hand-off whose condition fails, keeping what it was given even with only paths kept, and delivers it once it passes', async () => {
    const setup = await handoffDaemon(100);
    await setup.client.call('settings.set', { heldPayloads: 'path' });
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const edge = await setup.client.call('flowEdge.create', {
      from: a.sessionId,
      to: b.sessionId,
      conditions: [{ kind: 'script', command: 'test -f ready' }],
    });
    for (const { command, fingerprint } of await setup.client.call('flowEdge.commands', { id: edge.id })) {
      await setup.client.call('flowEdge.approve', { id: edge.id, command, fingerprint });
    }

    const outcomes = await connection.call('board.handoff', { token, message: 'Ready for review' });

    expect(outcomes).toEqual([{ edgeId: edge.id, to: b.sessionId, outcome: 'held', name: 'message', reason: 'exited 1' }]);
    expect((await setup.client.call('flowEdge.list'))[0]!.held).toMatchObject({ name: 'message', copy: true });
    writeFileSync(join(a.worktree, 'ready'), '');
    await untilEdge(setup.recorder, edge.id, (seen) => seen.deliveries === 1);
    await setup.recorder.waitForText(b.sessionId, 'Hand-off from impl (its message): Ready for review');
  });

  it('answers `checking` for a hand-off whose conditions take a while, and logs how it ended once it has', async () => {
    const setup = await handoffDaemon();
    const { agent: a, token, connection } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    const edge = await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId, conditions: [{ kind: 'script', command: 'sleep 6' }] });
    for (const { command, fingerprint } of await setup.client.call('flowEdge.commands', { id: edge.id })) {
      await setup.client.call('flowEdge.approve', { id: edge.id, command, fingerprint });
    }

    expect(await connection.call('board.handoff', { token, message: 'Slow gate' })).toMatchObject([{ outcome: 'checking' }]);

    await untilEdge(setup.recorder, edge.id, (seen) => seen.deliveries === 1);
    const delivered = await setup.recorder.waitFor(
      (e: DaemonEvent): e is OrchestratorActivityEvent => e.type === 'orchestrator.activity' && e.entry.detail === 'message: delivered',
    );
    expect(delivered.entry).toMatchObject({ action: 'handoff', orchestratorId: a.sessionId, targetId: b.sessionId, outcome: 'done' });
  }, 30_000);

  it("refuses a shell's token: an ended agent's shell never hands off for it", async () => {
    const setup = await handoffDaemon();
    const { agent: a } = await agentSide(setup, 'impl');
    const b = await receiver(setup, 'review');
    await setup.client.call('flowEdge.create', { from: a.sessionId, to: b.sessionId });
    await setup.client.call('agent.stop', { sessionId: a.sessionId });
    const ended = await untilAgent(setup.recorder, a.sessionId, (seen) => seen.shellSessionId !== null);
    const shell = ended.shellSessionId!;
    await setup.client.call('session.attach', { sessionId: shell });
    await setup.client.call('session.write', { sessionId: shell, data: 'echo "identity:$AGENT_BOARD_IDENTITY:end"\r' });
    await setup.recorder.waitForText(shell, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(shell))![1]!;

    const connection = await connectTestClient(setup.daemon);
    await expect(connection.call('board.handoff', { token, message: 'hi' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/only a live agent hands off/),
    });
    // And it stays a read-only connection: approving or sending an edge is the user's.
    const [edge] = await setup.client.call('flowEdge.list');
    await expect(connection.call('flowEdge.send', { id: edge!.id })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it('drops the percentage of an agent whose turn has ended, and of one that has ended, keeping its own summary', async () => {
    const setup = await handoffDaemon();
    const { agent, token, connection } = await agentSide(setup, 'impl');
    // It sits at its prompt: a percentage of a turn that is over says nothing.
    const set = await connection.call('board.setStatus', { token, summary: 'Look around', progress: 20 });
    expect(set.status).toMatchObject({ summary: 'Look around', progress: null });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)?.status).toMatchObject({ summary: 'Look around', progress: null });

    // Mid-turn it shows.
    const since = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Work slowly' });
    await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.state === 'running', since);
    expect((await connection.call('board.setStatus', { token, summary: 'Map the board', progress: 20 })).status).toMatchObject({ progress: 20 });
    expect((await untilTurnEnds(setup.recorder, agent.sessionId, since)).status).toMatchObject({ summary: 'Map the board', progress: null });

    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    const ended = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.endedAt !== null);
    expect(ended.status).toMatchObject({ summary: 'Map the board', progress: null });
  });

  it('shows the last message of a finished turn on a tile whose agent set no status', async () => {
    const setup = await handoffDaemon();
    const worker = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'worker', prompt: 'Write the thing', ...SIZE });
    const done = await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.status !== null);
    expect(done.status).toMatchObject({ summary: 'Handover written.', progress: null });
    expect(done.state).not.toBe('running');
    // The update that says its turn ended already carries the message: no tile shows the turn before's, or none, first.
    const started = setup.recorder.events.findIndex((e) => e.type === 'agent.updated' && e.agent.sessionId === worker.sessionId && e.agent.state === 'thinking');
    const ending = setup.recorder.events.filter(
      (e, index): e is AgentUpdatedEvent =>
        index > started && e.type === 'agent.updated' && e.agent.sessionId === worker.sessionId && (e.agent.state === 'idle' || e.agent.state === 'waiting'),
    );
    expect(ending.length).toBeGreaterThan(0);
    expect(ending.every(({ agent }) => agent.status?.summary === 'Handover written.')).toBe(true);

    // An interrupted turn ended on no message: the last one, of the turn before, isn't shown as its.
    const since = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: worker.sessionId, text: 'Work slowly' });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'running', since);
    const interrupted = await setup.client.call('agent.interrupt', { sessionId: worker.sessionId });
    expect(interrupted.state).toBe('idle');
    expect(interrupted.status).toBeNull();
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)?.status).toBeNull();

    // What it last said is still kept for its hand-offs: a final-message edge carries it on.
    const review = await receiver(setup, 'review');
    const edge = await setup.client.call('flowEdge.create', { from: worker.sessionId, to: review.sessionId });
    expect(await setup.client.call('flowEdge.preview', { id: edge.id })).toMatchObject({ text: expect.stringContaining('Handover written.') });
    await setup.client.call('flowEdge.send', { id: edge.id });
    await setup.recorder.waitForText(review.sessionId, 'Handover written.');
  });

  it('keeps the percentage of an agent waiting on a question mid-turn, and drops it once the turn is over', async () => {
    const setup = await handoffDaemon();
    const { agent, token, connection } = await agentSide(setup, 'impl');
    const since = setup.recorder.events.length;
    await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Ask: Which cache? | Redis | CDN only' });
    const asking = await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.ask !== null, since);
    expect(asking.state).toBe('waiting');
    expect((await connection.call('board.setStatus', { token, summary: 'Choosing a cache', progress: 30 })).status).toMatchObject({ progress: 30 });
    await setup.client.call('ask.answer', { sessionId: agent.sessionId, askId: asking.ask!.id, answer: { option: 0 } });
    expect((await untilAgent(setup.recorder, agent.sessionId, (seen) => seen.ask === null && (seen.state === 'idle' || seen.state === 'waiting'), asking.at)).status).toMatchObject({
      summary: 'Choosing a cache',
      progress: null,
    });
  });
});
