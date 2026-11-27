// Ticket tiles: a ticket's chat starts its helpers into its ticket, `ls` lists them under it, their asks go to the chat,
// an arrange and a stage board leave them to the ticket, removing a ticket asks about them, and closing one closes them.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { BUILT_IN_PREFABS, parsePrefab, prefabFile } from '../src/crew-prefabs.ts';
import { stageBoardMembers } from '../src/stage-board.ts';
import { flagLeadOf, helpersOf, isHelper } from '../src/ticket-tiles.ts';
import { AGENT_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type RemoveAsk } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

async function setUp() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function untilAgent(setup: Setup, sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/** The board token `agent` printed, its first prompt having been `Print your board identity`. */
async function tokenOf(setup: Setup, sessionId: string): Promise<string> {
  await setup.client.call('session.attach', { sessionId });
  // Its echo can come in the attach's snapshot, which draws the line break as a cursor move: the token alone is matched.
  return (await setup.recorder.waitForMatch(sessionId, /identity:([A-Za-z0-9_-]+):end/))[1]!;
}

/** A ticket tile started from the Ticket prefab, as the user's side starts it: its chat, with its board token. */
async function ticket(setup: Setup) {
  const started = await setup.client.call('orchestrator.startPrefab', { name: 'ticket', zoneId: setup.zone.id, prompt: 'Print your board identity' });
  const chat = started.started[0]!;
  return { started, chat, token: await tokenOf(setup, chat.sessionId) };
}

/** A helper the ticket's chat starts, as `agent-board new` from the chat does. */
const helper = async (setup: Setup, token: string, name: string, prompt = '') =>
  (await asAgent(setup)).call('orchestrator.spawn', { token, zoneId: setup.zone.id, name, prompt });

/** A connection of its own for a call with an agent's token, which binds the connection to that agent. */
const asAgent = (setup: Setup) => connectTestClient(setup.daemon);

const agentNamed = async (setup: Setup, name: string) => (await setup.client.call('agent.list')).find((agent) => agent.name === name)!;

describe('a ticket tile', () => {
  it('starts from the Ticket prefab as its chat, the implementer, with its reviewer for the chat to start', async () => {
    const setup = await setUp();
    const { started, chat } = await ticket(setup);
    expect(started.prefab).toBe('Ticket');
    expect(started.crew).toBeNull();
    expect(started.started.map((each) => each.member)).toEqual(['chat']);
    expect(chat).toMatchObject({ ticketChat: true, ticket: null, role: 'implementer' });
    expect(started.later).toEqual([{ member: 'review', starts: 'lead', command: expect.stringContaining("--base <chat's ref>") }]);
  });

  it('puts the agents its chat starts in its ticket, and theirs too; never an agent started elsewhere', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    const builder = await helper(setup, token, 'builder', 'Print your board identity');
    expect(builder).toMatchObject({ ticket: chat.sessionId, ticketChat: false, spawnedBy: chat.sessionId, ledBy: chat.name });
    const deeper = await helper(setup, await tokenOf(setup, builder.sessionId), 'deeper');
    expect(deeper).toMatchObject({ ticket: chat.sessionId, spawnedBy: builder.sessionId });
    const loose = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'loose', ...SIZE });
    expect(loose.ticket).toBeNull();
  });

  it('starts as a ticket chat from the app too, and puts the agents named into it', async () => {
    const setup = await setUp();
    const chat = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'chat', ticketChat: true, ...SIZE });
    expect(chat).toMatchObject({ ticketChat: true, ticket: null });
    const named = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'named', ticket: chat.sessionId, ...SIZE });
    expect(named.ticket).toBe(chat.sessionId);
    await expect(setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'bad', ticket: named.sessionId, ...SIZE })).rejects.toThrow(
      /named is not a ticket's chat/,
    );
    await expect(setup.client.call('agent.spawn', { zoneId: setup.zone.id, ticketChat: true, ticket: chat.sessionId, ...SIZE })).rejects.toThrow(
      /a ticket's chat belongs to no other ticket/,
    );
  });

  it('keeps its helpers across a restart, and the app’s Delete of its chat takes them with it', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }) });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const chat = await client.call('agent.spawn', { zoneId: zone.id, name: 'chat', ticketChat: true, ...SIZE });
    const named = await client.call('agent.spawn', { zoneId: zone.id, name: 'named', ticket: chat.sessionId, ...SIZE });
    await daemon.stop();
    const again = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }) });
    const after = await connectTestClient(again);
    const list = await after.call('agent.list');
    expect(list.find((agent) => agent.sessionId === chat.sessionId)?.ticketChat).toBe(true);
    expect(list.find((agent) => agent.sessionId === named.sessionId)?.ticket).toBe(chat.sessionId);
    await after.call('agent.delete', { sessionId: chat.sessionId });
    expect((await after.call('agent.list')).map((agent) => agent.name)).toEqual([]);
  });

  it('reads a helper whose chat is gone, as an older daemon may leave it, as in no ticket', async () => {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }) });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const chat = await client.call('agent.spawn', { zoneId: zone.id, name: 'chat', ticketChat: true, ...SIZE });
    const named = await client.call('agent.spawn', { zoneId: zone.id, name: 'named', ticket: chat.sessionId, ...SIZE });
    await daemon.stop();
    const db = new DatabaseSync(join(dataDir, 'agent-board.db'));
    db.prepare("UPDATE agents SET ticket = 'gone' WHERE session_id = ?").run(named.sessionId);
    db.close();
    const again = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }) });
    const read = (await (await connectTestClient(again)).call('agent.list')).find((agent) => agent.sessionId === named.sessionId)!;
    expect(read).toMatchObject({ ticket: null, ledBy: null });
  });
});

describe('ls', () => {
  it('lists a ticket’s helpers under its chat, and as the chat’s in --json', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    await helper(setup, token, 'builder');
    await helper(setup, token, 'designer');
    await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'loose', ...SIZE });
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token };
    let out = '';
    const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env };
    expect(await runBoardCommand('ls', [], io)).toBe(0);
    const lines = out.trimEnd().split('\n');
    const at = lines.findIndex((line) => line.includes(`  ${chat.name}  `));
    expect(lines[at]).toContain('(ticket, 2 helpers)');
    expect(lines.slice(at + 1, at + 3).map((line) => /^ {2}└ agent:[0-9a-f]+ {2}(\S+)/.exec(line)?.[1])).toEqual(['builder', 'designer']);
    expect(lines.filter((line) => line.includes('loose'))).toEqual([expect.stringMatching(/^agent:/)]);

    out = '';
    expect(await runBoardCommand('ls', ['--json'], io)).toBe(0);
    const json = JSON.parse(out) as { name: string; ticket: string | null; ticketChat: boolean }[];
    const chatRef = json.find((each) => each.name === chat.name)!;
    expect(chatRef).toMatchObject({ ticketChat: true, ticket: null });
    expect(json.find((each) => each.name === 'builder')).toMatchObject({ ticketChat: false, ticket: expect.stringMatching(/^agent:/) });
  });
});

describe("a helper's asks", () => {
  it('go to its ticket’s chat, as one message for the flags raised together; none reach the user', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    const [a, b] = await Promise.all([helper(setup, token, 'builder', 'Flag: the tests need a key'), helper(setup, token, 'designer', 'Flag: which colour?')]);
    for (const each of [a, b]) {
      expect((await untilAgent(setup, each.sessionId, (seen) => seen.flag !== null)).flag).toMatchObject({ to: 'orchestrator' });
    }
    await setup.recorder.waitForText(chat.sessionId, 'which colour?');
    const screen = setup.recorder.screenText(chat.sessionId);
    expect(screen).toContain('builder');
    expect(screen).toContain('the tests need a key');
  });

  it('go to its ticket’s chat though another agent started it, which answers, clears and passes them on as its own', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    // The user's side starts one into the ticket, as a crew loop starts a reviewer into its builder's; another agent the other.
    const asker = await setup.client.call('orchestrator.spawn', { zoneId: setup.zone.id, name: 'asker', ticket: chat.sessionId, prompt: 'Ask: which colour? | red | blue' });
    const lead = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
    const flagger = await (await asAgent(setup)).call('orchestrator.spawn', {
      token: await tokenOf(setup, lead.sessionId),
      zoneId: setup.zone.id,
      name: 'flagger',
      ticket: chat.sessionId,
      prompt: 'Flag: look here',
    });
    expect([asker.spawnedBy, flagger.spawnedBy]).toEqual([null, lead.sessionId]);
    for (const each of [asker, flagger]) {
      expect(await untilAgent(setup, each.sessionId, (seen) => seen.flag !== null)).toMatchObject({ ledBy: chat.name, flag: { to: 'orchestrator' } });
    }
    expect((await agentNamed(setup, 'asker')).flag?.reason).toContain('which colour?');
    await setup.recorder.waitForText(chat.sessionId, 'which colour?');
    await setup.recorder.waitForText(chat.sessionId, 'look here');

    // The chat passes one on to the user as its own, and answers it, which clears its flag.
    const passed = await (await asAgent(setup)).call('board.needsYou', { token, reason: 'the user should look', via: flagger.sessionId });
    expect(passed.flag).toMatchObject({ reason: 'the user should look', via: 'flagger' });
    await (await asAgent(setup)).call('orchestrator.send', { token, sessionId: flagger.sessionId, text: 'carry on' });
    expect((await agentNamed(setup, 'flagger')).flag).toBeNull();
  });
});

describe('an arrange', () => {
  it('lays out a ticket’s chat but never its helpers, which the ticket holds', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    const builder = await helper(setup, token, 'builder');
    await setup.client.call('agent.move', { sessionId: builder.sessionId, zoneId: setup.zone.id, x: 900, y: 600 });
    await setup.client.call('agent.move', { sessionId: chat.sessionId, zoneId: setup.zone.id, x: 40, y: 900 });
    const result = await setup.client.call('orchestrator.arrange', { zoneId: setup.zone.id });
    expect(result.moved.map((each) => each.target.id)).toContain(chat.sessionId);
    expect(result.moved.map((each) => each.target.id)).not.toContain(builder.sessionId);
    expect((await agentNamed(setup, 'builder')).position).toMatchObject({ x: 900, y: 600 });
  });
});

describe('removing a ticket', () => {
  it('asks about its helpers, as about a reviewer: one left out holds it back, and allowed, it goes with its helpers', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    const builder = await helper(setup, token, 'builder');
    for (const each of [builder, chat]) {
      await setup.client.call('agent.stop', { sessionId: each.sessionId });
      await untilAgent(setup, each.sessionId, (seen) => seen.endedAt !== null);
    }
    const asker = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'tidier', prompt: 'Print your board identity', ...SIZE });
    const askerToken = await tokenOf(setup, asker.sessionId);
    const answer = (await asAgent(setup)).call('orchestrator.askRemove', { token: askerToken, sessionIds: [chat.sessionId] });
    const ask: RemoveAsk = (await untilAgent(setup, asker.sessionId, (seen) => seen.removeAsk !== null)).removeAsk!;
    expect(ask.tiles).toEqual([{ sessionId: chat.sessionId, name: chat.name, held: 'its helper builder would go with it' }]);
    await setup.client.call('removeAsk.decide', { sessionId: asker.sessionId, askId: ask.id, allow: true, include: [chat.sessionId] });
    expect(await answer).toEqual({
      outcome: 'allowed',
      removed: [
        { sessionId: chat.sessionId, name: chat.name },
        { sessionId: builder.sessionId, name: 'builder' },
      ],
      kept: [],
    });
    expect((await setup.client.call('agent.list')).map((agent) => agent.name)).toEqual(['tidier']);
  });

  it('refuses an agent’s close --remove of a chat it started, with a helper it did not start itself', async () => {
    const setup = await setUp();
    const lead = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
    const leadToken = await tokenOf(setup, lead.sessionId);
    const chat = await (await asAgent(setup)).call('orchestrator.spawn', {
      token: leadToken,
      zoneId: setup.zone.id,
      name: 'chat',
      ticketChat: true,
      prompt: 'Print your board identity',
    });
    await helper(setup, await tokenOf(setup, chat.sessionId), 'builder');
    await expect((await asAgent(setup)).call('orchestrator.close', { token: leadToken, sessionId: chat.sessionId, remove: true })).rejects.toThrow(
      /a ticket's chat with a helper you did not start \(builder\)/,
    );
    expect((await setup.client.call('agent.list')).map((agent) => agent.name).sort()).toEqual(['builder', 'chat', 'lead']);
  });

  it('removes nothing when the app deletes a chat whose helper has unsaved work', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    const builder = await helper(setup, token, 'builder');
    writeFileSync(join(builder.worktree!, 'draft.txt'), 'unsaved');
    await expect(setup.client.call('agent.delete', { sessionId: chat.sessionId })).rejects.toMatchObject({
      code: AGENT_ERROR.unsavedWork,
      message: expect.stringMatching(/^builder: /),
    });
    expect((await setup.client.call('agent.list')).map((agent) => agent.name).sort()).toEqual(['builder', chat.name].sort());
  });
});

describe('closing a ticket', () => {
  it('takes its helpers with it, as removing it does: none is left on the board without a ticket', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    await helper(setup, token, 'builder');
    await helper(setup, token, 'designer');
    await expect(setup.client.call('orchestrator.close', { sessionId: chat.sessionId })).resolves.toBeNull();
    expect((await setup.client.call('agent.list')).map((agent) => agent.name)).toEqual([]);
  });

  it('refuses an agent’s close of a chat with a helper it did not start, and closes one whose helpers it started', async () => {
    const setup = await setUp();
    const lead = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
    const leadToken = await tokenOf(setup, lead.sessionId);
    const asLead = await asAgent(setup);
    const chat = await asLead.call('orchestrator.spawn', { token: leadToken, zoneId: setup.zone.id, name: 'chat', ticketChat: true, prompt: 'Print your board identity' });
    await helper(setup, await tokenOf(setup, chat.sessionId), 'builder');
    await expect(asLead.call('orchestrator.close', { token: leadToken, sessionId: chat.sessionId })).rejects.toThrow(
      /chat is a ticket's chat with a helper you did not start \(builder\).*--remove --ask/,
    );
    expect((await setup.client.call('agent.list')).map((agent) => agent.name).sort()).toEqual(['builder', 'chat', 'lead']);

    const other = await asLead.call('orchestrator.spawn', { token: leadToken, zoneId: setup.zone.id, name: 'other', ticketChat: true });
    await asLead.call('orchestrator.spawn', { token: leadToken, zoneId: setup.zone.id, name: 'mine', ticket: other.sessionId });
    await expect(asLead.call('orchestrator.close', { token: leadToken, sessionId: other.sessionId })).resolves.toBeNull();
    expect((await setup.client.call('agent.list')).map((agent) => agent.name).sort()).toEqual(['builder', 'chat', 'lead']);
  });

  it('closes nothing when a helper has unsaved work', async () => {
    const setup = await setUp();
    const { chat, token } = await ticket(setup);
    const builder = await helper(setup, token, 'builder');
    writeFileSync(join(builder.worktree!, 'draft.txt'), 'unsaved');
    await expect(setup.client.call('orchestrator.close', { sessionId: chat.sessionId })).rejects.toMatchObject({
      code: AGENT_ERROR.unsavedWork,
      message: expect.stringMatching(/^builder: /),
    });
    const left = await setup.client.call('agent.list');
    expect(left.map((agent) => agent.name).sort()).toEqual(['builder', chat.name].sort());
    expect(left.find((agent) => agent.name === 'builder')).toMatchObject({ ticket: chat.sessionId, endedAt: null });
  });

  it('closes its helpers with its chat when a crew the chat builds for is merged, and none while a helper holds unsaved work', async () => {
    /** A crew whose builder is a ticket's chat with a helper; its pull request merged on the fake GitHub. */
    const mergedCrew = async (unsaved: boolean) => {
      const github = createFakeGitHub();
      onTestFinished(github.dispose);
      const dataDir = tempDataDir();
      const start = () =>
        startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }), gh: github.gh, pullRequestPollMs: 100 });
      const first = await start();
      const repo = tempRepo();
      git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
      const firstClient = await connectTestClient(first);
      const zone = await firstClient.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
      const started = await firstClient.call('orchestrator.startPrefab', { name: 'Implementer + reviewer', zoneId: zone.id, prompt: 'Fix the login redirect' });
      expect(started.crew).not.toBeNull();
      const chat = started.started[0]!;
      await first.stop();
      // No prefab yet builds a crew around a ticket's chat: one is made so here, as a later step may.
      const db = new DatabaseSync(join(dataDir, 'agent-board.db'));
      db.prepare('UPDATE agents SET ticket_chat = 1 WHERE session_id = ?').run(chat.sessionId);
      db.close();
      const daemon = await start();
      const client = await connectTestClient(daemon);
      // Live again, so the crew can flag it.
      await client.call('agent.resume', { sessionId: chat.sessionId });
      const builder = await client.call('agent.spawn', { zoneId: zone.id, name: 'builder', ticket: chat.sessionId, ...SIZE });
      if (unsaved) writeFileSync(join(builder.worktree, 'draft.txt'), 'unsaved');
      const pr = { repo: 'acme/app', number: 41, title: 'Fix the login redirect', headRefName: chat.branch, state: 'MERGED' as const, isDraft: false, statusCheckRollup: [] };
      github.setState({ ...FAKE_GITHUB_STATE, pullRequests: [pr] });
      return { client, chat, builder };
    };

    /** The board's agents once the crew loop is done with the merge: none, or the flagged chat with its helper. */
    const settled = async ({ client }: Awaited<ReturnType<typeof mergedCrew>>) => {
      for (let tries = 0; ; tries++) {
        const left = await client.call('agent.list');
        if (left.length === 0 || left.some((agent) => agent.flag !== null) || tries === 100) return left;
        await new Promise((done) => setTimeout(done, 100));
      }
    };

    expect(await settled(await mergedCrew(false))).toEqual([]);

    const held = await mergedCrew(true);
    const left = await settled(held);
    expect(left.map((agent) => agent.name).sort()).toEqual(['builder', held.chat.name].sort());
    expect(left.find((agent) => agent.sessionId === held.chat.sessionId)?.flag?.reason).toMatch(/couldn't close .*\(builder: .*\) after the merge/);
  });
});

/** An agent as these rules read it. */
const agent = (sessionId: string, fields: Partial<Agent> = {}): Agent =>
  ({ sessionId, zoneId: 'z', spawnedBy: null, orphanedFrom: null, ticket: null, ticketChat: false, roleName: null, master: false, ...fields }) as Agent;

describe('the ticket rules', () => {
  it('reads a helper by its ticket, and sends its flags to that ticket’s chat before the agent that started it', () => {
    const chat = agent('chat', { ticketChat: true, spawnedBy: 'master' });
    const builder = agent('builder', { ticket: 'chat', spawnedBy: 'chat' });
    const reviewer = agent('reviewer', { ticket: 'chat', spawnedBy: 'master' });
    expect([chat, builder, reviewer].map(isHelper)).toEqual([false, true, true]);
    expect(helpersOf([chat, builder, reviewer], 'chat').map((each) => each.sessionId)).toEqual(['builder', 'reviewer']);
    expect([chat, builder, reviewer].map(flagLeadOf)).toEqual(['master', 'chat', 'chat']);
  });

  it('keeps helpers off a stage board, which holds their ticket’s chat', () => {
    const chat = agent('chat', { ticketChat: true, spawnedBy: 'master' });
    const builder = agent('builder', { ticket: 'chat', spawnedBy: 'chat' });
    expect(stageBoardMembers([chat, builder], 'z', { joined: ['builder'], left: [] })).toEqual(['chat']);
  });

  it('lays out a helper moved to another zone than its chat’s as any agent there', () => {
    const chat = agent('chat', { ticketChat: true, spawnedBy: 'master' });
    const builder = agent('builder', { ticket: 'chat', spawnedBy: 'chat', zoneId: 'y' });
    expect(stageBoardMembers([chat, builder], 'y', { joined: ['builder'], left: [] })).toEqual(['builder']);
  });

  it('reads and writes a ticket prefab', () => {
    const prefab = BUILT_IN_PREFABS.find((each) => each.name === 'Ticket')!;
    expect(prefab.onBoard).toBe('ticket');
    expect(parsePrefab(prefabFile(prefab))).toEqual(prefab);
  });
});
