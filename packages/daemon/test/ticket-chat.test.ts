// Who builds a ticket: its chat as the implementer, or a builder the chat leads in the chat's own worktree. A switch
// happens at a hand-off, never mid-edit, and hands the branch over: the work in the worktree stays.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { Agent, AgentUpdatedEvent, DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function setUp() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, repeat: true }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function untilAgent(setup: Setup, sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const now = (await setup.client.call('agent.list')).find((agent) => agent.sessionId === sessionId);
  if (now !== undefined && match(now)) return now;
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

const listed = async (setup: Setup) => setup.client.call('agent.list');

/** A ticket's chat of `kind`, at its prompt, its first turn ended. */
async function chatAtRest(setup: Setup, chatKind?: 'implementer' | 'lead') {
  const chat = await setup.client.call('agent.spawn', {
    zoneId: setup.zone.id,
    name: 'chat',
    ticketChat: true,
    ...(chatKind === undefined ? {} : { chatKind }),
    prompt: 'Print your board identity',
    ...SIZE,
  });
  await setup.client.call('session.attach', { sessionId: chat.sessionId });
  return untilAgent(setup, chat.sessionId, (seen) => seen.state === 'waiting');
}

/** The chat's builder, once the switch has started it. */
const builderOf = async (setup: Setup, chat: Agent) => (await listed(setup)).find((agent) => agent.ticket === chat.sessionId && agent.role === 'implementer');

/** Gives `agent` a turn: a plain prompt writes a handover in its worktree and ends `STATUS: done`, a hand-off. */
async function turn(setup: Setup, agent: Agent, text: string) {
  await setup.client.call('session.attach', { sessionId: agent.sessionId });
  await untilAgent(setup, agent.sessionId, (seen) => seen.state === 'waiting');
  await setup.client.call('agent.answer', { sessionId: agent.sessionId, text });
}

describe("a ticket's chat", () => {
  it('is the implementer unless it starts as its own lead; only a chat has a kind', async () => {
    const setup = await setUp();
    const implementer = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'one', ticketChat: true, ...SIZE });
    expect(implementer).toMatchObject({ chatKind: 'implementer' });
    expect(implementer.chatSwitch).toBeUndefined();
    const lead = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'two', ticketChat: true, chatKind: 'lead', ...SIZE });
    expect(lead).toMatchObject({ chatKind: 'lead' });
    await expect(setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'three', chatKind: 'lead', ...SIZE })).rejects.toThrow(/only a ticket's chat has a kind/);
    await expect(setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'four', ticketChat: true, chatKind: 'boss' as never, ...SIZE })).rejects.toThrow(
      /unknown ticket chat kind boss/,
    );
    const loose = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'loose', ...SIZE });
    expect(loose.chatKind).toBeUndefined();
    await expect(setup.client.call('ticket.setChat', { sessionId: loose.sessionId, kind: 'lead' })).rejects.toThrow(/loose is not a ticket's chat/);
  });

  it("becomes its own lead at rest: a builder starts in the chat's worktree, which it does not own", async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup);
    const { agent } = await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' });
    expect(agent).toMatchObject({ chatKind: 'lead' });
    expect(agent.chatSwitch).toBeUndefined();
    const builder = (await builderOf(setup, chat))!;
    expect(builder).toMatchObject({ ticket: chat.sessionId, spawnedBy: chat.sessionId, worktree: chat.worktree, ownsWorktree: false, ticketChat: false });
    // The chat is told as the board's notice, not as a message the user typed.
    await expect
      .poll(async () => (await setup.client.call('agent.transcript', { sessionId: chat.sessionId })).entries.find((entry) => entry.kind === 'user' && entry.text.startsWith("You are now this ticket's lead")), { timeout: 10_000 })
      .toMatchObject({ from: { kind: 'board', name: 'agent-board', ref: 'board' } });
  });

  it('becomes the implementer again once its builder hands off: the builder closes and its work stays on the branch', async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup);
    await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' });
    const builder = (await builderOf(setup, chat))!;
    await turn(setup, builder, 'Hand off: The work is done.');
    await untilAgent(setup, builder.sessionId, (seen) => seen.workFinishedAt !== null && seen.state === 'waiting');

    const { agent } = await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'implementer' });
    expect(agent).toMatchObject({ chatKind: 'implementer' });
    expect((await listed(setup)).some((each) => each.sessionId === builder.sessionId)).toBe(false);
    // The builder's handover, written in the shared worktree, is the chat's now.
    expect(readFileSync(join(chat.worktree, '.agent-board/handover.md'), 'utf8')).toContain('The work is done.');
    expect(existsSync(chat.worktree)).toBe(true);
  });

  it('becomes the implementer again at once while its builder is at its prompt, before it has had a turn', async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup);
    await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' });
    const builder = (await builderOf(setup, chat))!;
    await setup.client.call('session.attach', { sessionId: builder.sessionId });
    await untilAgent(setup, builder.sessionId, (seen) => seen.state === 'waiting' && seen.workFinishedAt === null);

    const { agent } = await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'implementer' });
    expect(agent).toMatchObject({ chatKind: 'implementer' });
    expect(agent.chatSwitch).toBeUndefined();
    expect((await listed(setup)).some((each) => each.sessionId === builder.sessionId)).toBe(false);
  });

  it('refuses a second pick while a switch is being made, and says why', async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup);
    const first = setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' });
    await expect(setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'implementer' })).rejects.toThrow(/under way/);
    expect((await first).agent).toMatchObject({ chatKind: 'lead' });
    expect(await builderOf(setup, chat)).toBeDefined();
  });

  it('waits for a builder mid-turn to hand off, then takes the branch over', async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup);
    await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' });
    const builder = (await builderOf(setup, chat))!;
    await turn(setup, builder, 'Work slowly');
    await untilAgent(setup, builder.sessionId, (seen) => seen.state === 'running' || seen.state === 'thinking');

    const { agent } = await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'implementer' });
    expect(agent).toMatchObject({ chatKind: 'lead', chatSwitch: 'implementer' });
    expect(await builderOf(setup, chat)).toBeDefined();

    const after = await untilAgent(setup, chat.sessionId, (seen) => seen.chatKind === 'implementer');
    expect(after.chatSwitch).toBeUndefined();
    await expect.poll(async () => (await listed(setup)).some((each) => each.sessionId === builder.sessionId), { timeout: 10_000 }).toBe(false);
    expect(existsSync(chat.worktree)).toBe(true);
  });

  it('as the implementer mid-turn, becomes its own lead at its hand-off; asking for its kind again drops the switch', async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup);
    await turn(setup, chat, 'Work slowly');
    await untilAgent(setup, chat.sessionId, (seen) => seen.state === 'running' || seen.state === 'thinking');
    expect((await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' })).agent).toMatchObject({ chatKind: 'implementer', chatSwitch: 'lead' });
    expect((await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'implementer' })).agent.chatSwitch).toBeUndefined();
    expect((await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'lead' })).agent.chatSwitch).toBe('lead');
    expect(await builderOf(setup, chat)).toBeUndefined();

    await untilAgent(setup, chat.sessionId, (seen) => seen.chatKind === 'lead');
    const builder = (await builderOf(setup, chat))!;
    expect(builder).toMatchObject({ worktree: chat.worktree, ownsWorktree: false });
  });

  it('as its own lead before a builder starts, puts its first builder in its own worktree, and becomes the implementer at once', async () => {
    const setup = await setUp();
    const chat = await chatAtRest(setup, 'lead');
    expect(await builderOf(setup, chat)).toBeUndefined();
    const builder = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'builder', role: 'implementer', ticket: chat.sessionId, ...SIZE });
    expect(builder).toMatchObject({ worktree: chat.worktree, ownsWorktree: false });
    const second = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'second', role: 'implementer', ticket: chat.sessionId, ...SIZE });
    expect(second.ownsWorktree).toBe(true);
    await setup.client.call('agent.delete', { sessionId: builder.sessionId });
    expect((await setup.client.call('ticket.setChat', { sessionId: chat.sessionId, kind: 'implementer' })).agent).toMatchObject({ chatKind: 'implementer' });
  });

  it('keeps its kind across a restart', async () => {
    const dataDir = tempDataDir();
    const env = () => fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() });
    const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: env() });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const chat = await client.call('agent.spawn', { zoneId: zone.id, name: 'chat', ticketChat: true, chatKind: 'lead', ...SIZE });
    await daemon.stop();
    const again = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: env() });
    const after = await connectTestClient(again);
    expect((await after.call('agent.list')).find((agent) => agent.sessionId === chat.sessionId)).toMatchObject({ chatKind: 'lead' });
  });

  it('starts from a ticket prefab as the kind the prefab says, or the kind asked for this ticket alone', async () => {
    const setup = await setUp();
    const start = (name: string, ticketChat?: 'implementer' | 'lead') =>
      setup.client.call('orchestrator.startPrefab', { name, zoneId: setup.zone.id, ...(ticketChat === undefined ? {} : { ticketChat }) });
    const plain = await start('ticket');
    expect(plain.started[0]).toMatchObject({ ticketChat: true, chatKind: 'implementer', role: 'implementer' });
    expect(plain.later.map((each) => each.member)).toEqual(['review']);

    const led = await start('ticket', 'lead');
    expect(led.started[0]).toMatchObject({ chatKind: 'lead', role: 'custom', roleName: 'orchestrator' });
    expect(led.later.map((each) => each.member)).toEqual(['build', 'review']);
    expect(led.later[1]!.command).toContain("--base <build's ref>");

    const designed = await start('design, build, review');
    expect(designed.started[0]).toMatchObject({ chatKind: 'lead' });
    const built = await start('design, build, review', 'implementer');
    expect(built.started[0]).toMatchObject({ chatKind: 'implementer', role: 'implementer' });
    expect(built.later.map((each) => each.member)).toEqual(['design', 'review']);

    await expect(start('lead and crew', 'lead')).rejects.toThrow(/Lead and crew starts no ticket tile/);
    await expect(setup.client.call('orchestrator.startPrefab', { name: 'ticket', zoneId: setup.zone.id, ticketChat: 'boss' as never })).rejects.toThrow(
      /a ticket's chat is implementer or lead/,
    );
  });
});
