import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { ALERT_INTERVAL_MS, MAX_ALERT_LENGTH, needsYouKind, type Agent, type AgentUpdatedEvent, type DaemonEvent } from '../src/protocol.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';
import { createFakeClock } from './fake-clock.ts';
import type { Clock } from '../src/clock.ts';

const SIZE = { cols: 120, rows: 40 };

async function alertDaemon(clock?: Clock) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
    ...(clock === undefined ? {} : { clock }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof alertDaemon>>;

/** Starts an agent that prints its board token, and connects as it. */
async function agentOf(setup: Setup, harness: 'claude' | 'codex' = 'claude') {
  const { daemon, client, recorder, zone } = setup;
  const agent = await client.call('agent.spawn', { zoneId: zone.id, harness, prompt: 'Print your board identity', ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

const untilAgent = async (setup: Setup, sessionId: string, match: (agent: Agent) => boolean) =>
  (await setup.recorder.waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent))).agent;

describe('an agent alerting the user', () => {
  it('tells the user with a line and a link, asking nothing of them', async () => {
    const setup = await alertDaemon();
    const { agent, token, connection } = await agentOf(setup);
    expect(agent.alert).toBeUndefined();

    const alerted = await connection.call('board.alert', { token, line: '  PR #12 is merged.\n', link: 'https://github.com/acme/web/pull/12' });
    expect(alerted.alert).toEqual({ id: expect.any(Number), line: 'PR #12 is merged.', link: 'https://github.com/acme/web/pull/12', at: expect.any(String), banner: true, folded: 0 });
    // Not a request: no flag, nothing in Needs you.
    expect(alerted.flag).toBeNull();
    expect(needsYouKind(alerted, 'explicit')).toBeNull();
    expect((await untilAgent(setup, agent.sessionId, (a) => a.alert !== undefined)).alert?.line).toBe('PR #12 is merged.');
  });

  it('refuses a blank line, a line too long and a link that is not https', async () => {
    const setup = await alertDaemon();
    const { token, connection } = await agentOf(setup);
    await expect(connection.call('board.alert', { token, line: '   ' })).rejects.toThrow(/must not be blank/);
    await expect(connection.call('board.alert', { token, line: 'x'.repeat(MAX_ALERT_LENGTH + 1) })).rejects.toThrow(/at most/);
    await expect(connection.call('board.alert', { token, line: 'Done', link: 'file:///etc/passwd' })).rejects.toThrow(/an https URL/);
    // The app opens https links only, so an http one would be a button that does nothing.
    await expect(connection.call('board.alert', { token, line: 'Done', link: 'http://example.com/pr/1' })).rejects.toThrow(/an https URL/);
  });

  it('raises one banner every interval, folding every unread alert into its row', async () => {
    const clock = createFakeClock(new Date());
    const setup = await alertDaemon(clock);
    const { token, connection } = await agentOf(setup);

    const first = (await connection.call('board.alert', { token, line: 'Tests pass' })).alert!;
    expect(first).toMatchObject({ banner: true, folded: 0 });
    clock.advance(ALERT_INTERVAL_MS - 1000);
    const second = (await connection.call('board.alert', { token, line: 'Docs written' })).alert!;
    expect(second).toMatchObject({ line: 'Docs written', banner: false, folded: 1, link: null });
    expect(second.id).not.toBe(first.id);
    const third = (await connection.call('board.alert', { token, line: 'Lint clean' })).alert!;
    expect(third).toMatchObject({ banner: false, folded: 2 });

    clock.advance(1000);
    // A banner again, still counting the alerts before it that were never read.
    expect((await connection.call('board.alert', { token, line: 'PR open' })).alert).toMatchObject({ banner: true, folded: 3 });
  });

  it('is read when the user opens its session, not when they touch or focus it shown already', async () => {
    const setup = await alertDaemon();
    const { agent, token, connection } = await agentOf(setup);
    await connection.call('board.alert', { token, line: 'The release notes are written' });
    // A click in its pane, or the window coming back to the front: the alert isn't drawn there, so it stays.
    expect((await setup.client.call('agent.markSeen', { sessionId: agent.sessionId })).alert?.line).toBe('The release notes are written');
    expect((await setup.client.call('agent.markSeen', { sessionId: agent.sessionId, opened: true })).alert).toBeUndefined();
    // Read, its next alert counts none before it.
    expect((await connection.call('board.alert', { token, line: 'Tagged' })).alert).toMatchObject({ folded: 0 });
  });

  it("alerts from the agent's own MCP call, as the fake harness's `Alert:` prompt makes it", async () => {
    const setup = await alertDaemon();
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness: 'claude', prompt: 'Alert: Docs are written | https://example.com/docs', ...SIZE });
    expect((await untilAgent(setup, agent.sessionId, (a) => a.alert !== undefined)).alert).toMatchObject({ line: 'Docs are written', link: 'https://example.com/docs', banner: true });
  });

  it('alerts over the CLI', async () => {
    const setup = await alertDaemon();
    const { agent, token } = await agentOf(setup);
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token };
    const run = async (args: string[]) => {
      let out = '';
      const code = await runBoardCommand('alert', args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };

    expect(await run(['--link', 'https://example.com/pr/3', '--', 'PR', '#3', 'is', 'open'])).toEqual({ code: 0, out: expect.stringContaining('with a banner') });
    const listed = (await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId);
    expect(listed?.alert).toMatchObject({ line: 'PR #3 is open', link: 'https://example.com/pr/3' });
    expect(await run(['Docs', 'done'])).toEqual({ code: 0, out: expect.stringContaining('No banner') });
    expect(await run([])).toMatchObject({ code: 2, out: expect.stringContaining('give a line') });
  });

  it('alerts over `agent-board mcp` on stdio, as a Codex agent', async () => {
    const setup = await alertDaemon();
    const { agent, token } = await agentOf(setup, 'codex');
    const mcp = new McpClient(
      { command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token } },
      tempDataDir(),
    );
    expect(await mcp.callTool('alert', { line: 'The migration ran' })).toMatchObject({ text: expect.stringContaining('with a banner') });
    expect((await untilAgent(setup, agent.sessionId, (a) => a.alert !== undefined)).alert).toMatchObject({ line: 'The migration ran', banner: true });
  });
});
