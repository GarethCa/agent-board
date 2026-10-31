import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_ERROR, RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent } from '../src/protocol.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { refOf } from '../src/crew-flags.ts';
import { markSender } from '../src/sender-marker.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A daemon whose agents play the fake harnesses' `orchestrate` scenario in one zone whose agents may orchestrate. Each
 * fake takes its first typed line as typed, then loses the `loseEnters` Enters after the next one, as a TUI still
 * redrawing does: a message sent then is left typed at its prompt (three are a send's), and the next Enter submits it.
 */
async function sendDaemon(loseEnters = 3) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, loseEnters, loseEntersAfter: 1 }),
    submitConfirmMs: 100,
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof sendDaemon>>;

async function untilAgent(recorder: Setup['recorder'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/** `text` as the lead sent it: headed with its sender mark. */
const sentBy = (lead: Agent, text: string) => markSender('send', lead.name, refOf(lead), text);

/**
 * An orchestrator connected as itself, its board token presented, and a worker of the user's in its zone that has
 * finished its first turn: the next message typed at the worker loses its Enters.
 */
async function leadAndWorker(setup: Setup, workerPrompt = 'Write the handover') {
  const { daemon, client, recorder, zone } = setup;
  const lead = await client.call('agent.spawn', { zoneId: zone.id, name: 'lead', prompt: 'Print your board identity', ...SIZE });
  await client.call('session.attach', { sessionId: lead.sessionId });
  await recorder.waitForText(lead.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(lead.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  const worker = await client.call('agent.spawn', { zoneId: zone.id, name: 'worker', prompt: workerPrompt, ...SIZE });
  await client.call('session.attach', { sessionId: worker.sessionId });
  return { lead, token, connection, worker, ref: `agent:${worker.sessionId.slice(0, 8)}` };
}

/** Runs `agent-board <command> <args>` as the agent holding `token`, and says what it printed and how it exited. */
async function board(setup: Setup, token: string, command: string, args: string[]) {
  let out = '';
  const io = { out: (text: string) => (out += text), err: (text: string) => (out += text), env: { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token } };
  const code = await runBoardCommand(command, args, io);
  return { code, out };
}

describe('a send whose Enter never starts a turn', () => {
  it('says it was typed at the prompt but not sent, never that it was sent', async () => {
    const setup = await sendDaemon();
    const { token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });

    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Also add a test' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(new RegExp(`^worker: your message was typed at its prompt but not sent \\(no turn started on it after 3 presses of Enter\\)\\. Send it with \`agent-board send ${ref} --submit\`, or clear it with \`--clear\`$`)),
    });
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === worker.sessionId)).toMatchObject({ unsent: 'A message', state: expect.stringMatching(/idle|waiting/) });
    const [line] = await setup.client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ action: 'send', outcome: 'refused', reason: expect.stringContaining('typed at its prompt but not sent') });
  });

  it('says so in the CLI, exiting 1, after an interrupt as before it', async () => {
    const setup = await sendDaemon();
    const { token, connection, worker, ref } = await leadAndWorker(setup, 'Work slowly');
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'running');
    expect(await connection.call('orchestrator.interrupt', { token, sessionId: worker.sessionId })).toMatchObject({ state: 'idle' });

    const sent = await board(setup, token, 'send', [ref, '--', 'Do it faster']);
    expect(sent).toMatchObject({ code: 1, out: expect.stringContaining('typed at its prompt but not sent') });
    expect(sent.out).not.toMatch(/Sent to/);
  });

  it('is sent with --submit, which says its turn started', async () => {
    const setup = await sendDaemon();
    const { lead, token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Also add a test' })).rejects.toThrow(/not sent/);

    const submitted = await board(setup, token, 'send', [ref, '--submit']);
    expect(submitted).toMatchObject({ code: 0, out: expect.stringMatching(/^Sent what was typed at its prompt: agent:/) });
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe(`Done: ${sentBy(lead, 'Also add a test')}.`);
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === worker.sessionId)?.unsent).toBeNull();
  });

  it('stays unsent when the Enters of --submit are lost too, so the next message is never typed onto it', async () => {
    const setup = await sendDaemon(6);
    const { lead, token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Also add a test' })).rejects.toThrow(/not sent/);

    expect(await board(setup, token, 'send', [ref, '--submit'])).toMatchObject({
      code: 1,
      out: expect.stringContaining("worker's unsent message was not sent (no turn started on it after 3 presses of Enter): it is still at its prompt. Try --submit again, or --clear"),
    });
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === worker.sessionId)?.unsent).toBe('A message');
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Rename the file' })).rejects.toThrow(/never sent: send or clear it first/);

    // The next Enter lands.
    expect(await board(setup, token, 'send', [ref, '--submit'])).toMatchObject({ code: 0, out: expect.stringMatching(/^Sent what was typed at its prompt/) });
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe(`Done: ${sentBy(lead, 'Also add a test')}.`);
  });

  it('says a send that wakes a paused agent is waking it, not sent: it is typed once the agent is up', async () => {
    const setup = await sendDaemon(0);
    const { lead, token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    await connection.call('orchestrator.pause', { token, sessionId: worker.sessionId });
    await untilAgent(setup.recorder, worker.sessionId, (seen) => seen.state === 'hibernated');

    expect(await board(setup, token, 'send', [ref, '--', 'Rename the file'])).toMatchObject({ code: 0, out: expect.stringMatching(/^Waking it with the message, typed once it's up: /) });
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe(`Done: ${sentBy(lead, 'Rename the file')}.`);
  });

  it('is cleared with --clear: its flag goes, and the next message goes up alone', async () => {
    const setup = await sendDaemon();
    const { lead, token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Also add a test' })).rejects.toThrow(/not sent/);
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === worker.sessionId)?.flag).toMatchObject({ reason: expect.stringContaining('not sent') });

    const cleared = await board(setup, token, 'send', [ref, '--clear']);
    expect(cleared).toMatchObject({ code: 0, out: expect.stringMatching(/^Pressed Ctrl-U on what was typed at its prompt: agent:/) });
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === worker.sessionId)).toMatchObject({ unsent: null, flag: null });

    // It says what the worker reads: the message headed with the lead's sender mark.
    const sent = await board(setup, token, 'send', [ref, '--', 'Rename the file']);
    expect(sent).toMatchObject({ code: 0, out: expect.stringMatching(/^Sent to /) });
    expect(sent.out).toContain(`\nIt reads: ${sentBy(lead, 'Rename the file')}`);
    expect(await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] })).toMatchObject({ timedOut: false });
    expect((await connection.call('orchestrator.read', { token, sessionId: worker.sessionId })).text).toBe(`Done: ${sentBy(lead, 'Rename the file')}.`);
  });

  it('is sent or cleared over the MCP send tool too, saying how it went', async () => {
    const setup = await sendDaemon();
    const { token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    const mcp = new McpClient(
      { command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token } },
      tempDataDir(),
    );

    expect(await mcp.callTool('send', { agent: ref, text: 'Also add a test' })).toMatchObject({ isError: true, text: expect.stringContaining('not sent') });
    expect(await mcp.callTool('send', { agent: ref, submit: true, clear: true })).toMatchObject({ isError: true, text: expect.stringContaining('one of') });
    expect(await mcp.callTool('send', { agent: ref, submit: true })).toMatchObject({ isError: false, text: expect.stringMatching(/^Sent what was typed at its prompt/) });
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });
    expect(await mcp.callTool('send', { agent: ref, clear: true })).toMatchObject({ isError: true, text: expect.stringContaining('has no unsent message at its prompt') });
  });

  it('refuses --submit and --clear with nothing unsent, with a message too, or for an agent out of reach', async () => {
    const setup = await sendDaemon();
    const { token, connection, worker, ref } = await leadAndWorker(setup);
    await connection.call('orchestrator.wait', { token, sessionIds: [worker.sessionId] });

    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, submit: true })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'worker has no unsent message at its prompt',
    });
    expect(await board(setup, token, 'send', [ref, '--submit', '--', 'Also'])).toMatchObject({ code: 2, out: expect.stringContaining('--submit and --clear take no message') });
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, text: 'Also', clear: true })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });

    // An agent that may not orchestrate reaches no draft.
    await setup.client.call('zone.configure', { id: setup.zone.id, agentsOrchestrate: false });
    await expect(connection.call('orchestrator.send', { token, sessionId: worker.sessionId, clear: true })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });
});
