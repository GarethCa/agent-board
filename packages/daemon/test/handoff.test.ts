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
async function handoffDaemon(flowRecheckMs = 0) {
  const daemon = await startTestDaemon({
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

async function untilAgent(recorder: Setup['recorder'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
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

    // Not to an agent it has no edge to: it never makes one, nor reaches past its edges.
    await expect(connection.call('board.handoff', { token, to: a.sessionId, message: 'hi' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/no edge from you/),
    });
    const lone = await agentSide(setup, 'lone');
    await expect(lone.connection.call('board.handoff', { token: lone.token, message: 'hi' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/no edge leaves your tile/),
    });
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
});
