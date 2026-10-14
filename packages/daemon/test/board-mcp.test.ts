import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { BOARD_MCP_INSTRUCTIONS } from '../src/board-mcp.ts';
import type { Agent, AgentUpdatedEvent, DaemonEvent, Harness } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents run the fake harnesses' `board` scenario, and a zone to start them in. */
async function boardDaemon() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'board', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

/** Waits for an update in which the agent matches `match`. */
async function untilAgent(recorder: ReturnType<typeof recordEvents>, sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

describe('the board MCP server in an agent', () => {
  it.each<Harness>(['claude', 'codex'])('lets a %s agent learn where it is and set its own status', async (harness) => {
    const { client, recorder, zone } = await boardDaemon();
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness, prompt: 'Moving session ids to the daemon', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });

    // First set_status over MCP, then `agent-board status set` in its shell.
    for (const progress of [10, 20]) {
      const updated = await untilAgent(recorder, agent.sessionId, (seen) => seen.status?.progress === progress);
      expect(updated.status).toMatchObject({ summary: 'Moving session ids to the daemon', progress });
    }

    await recorder.waitForText(agent.sessionId, 'I know where I am.');
    const screen = recorder.screenText(agent.sessionId).replace(/\r/g, '');
    expect(screen).toContain(`The board says: ${BOARD_MCP_INSTRUCTIONS}`);
    // whoami, over MCP, and `agent-board identify`, in its shell, both find it in its zone.
    expect(screen.match(/you {6}agent:\w+ {2}Moving session ids to the daemon {2}\(an agent\)\n/g)).toHaveLength(2);
    expect(screen).toContain(`zone     zone:${zone.id.slice(0, 4)}`);
    expect(screen).toContain('Your tile now says: Moving session ids to the daemon · 10%');
    expect(screen).toContain('status set: Moving session ids to the daemon · 20%');
  });

  it('keeps the hook URL and token out of a Codex agent’s shell commands', async () => {
    const { client, recorder, zone } = await boardDaemon();
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness: 'codex', prompt: 'Look around', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });

    await recorder.waitForText(agent.sessionId, 'I know where I am.');
    // The URL is in no default exclude of Codex's: only the daemon's own exclude keeps it out.
    expect(recorder.screenText(agent.sessionId)).toContain('hook env: none none');
  });

  it('starts no board MCP server in a zone that turns it off; the CLI still works', async () => {
    const { client, recorder, zone } = await boardDaemon();
    await client.call('zone.configure', { id: zone.id, boardMcp: false });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Look around', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });

    await recorder.waitForText(agent.sessionId, 'I know where I am.');
    const screen = recorder.screenText(agent.sessionId).replace(/\r/g, '');
    expect(screen).toContain('There is no agent-board MCP server here.');
    expect(screen).toContain('(an agent)');
    // Only `agent-board status set`, in its shell, set its status.
    expect((await client.call('agent.list'))[0]!.status).toMatchObject({ summary: 'Look around', progress: 20 });
  });
});

describe('agent-board mcp over stdio', () => {
  /** Starts `agent-board mcp` from source with `env`, as a harness would. */
  function startMcp(env: NodeJS.ProcessEnv) {
    return new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, ...env } }, tempDataDir());
  }

  it('says once where you are, and reads the board without a token', async () => {
    const { daemon } = await boardDaemon();
    const mcp = startMcp({ AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: '' });

    expect((await mcp.initialize()).instructions).toBe(BOARD_MCP_INSTRUCTIONS);
    expect(await mcp.callTool('board', {})).toEqual({ text: expect.stringMatching(/^zone:\w+ {2}web {2}\(repo /), isError: false });
    expect(await mcp.callTool('whoami', {})).toMatchObject({ text: expect.stringMatching(/^You are not in an agent-board session/) });
    expect(await mcp.callTool('set_status', { summary: 'Sneaky' })).toMatchObject({
      text: expect.stringContaining('Only an agent in an agent-board session can set its status'),
      isError: true,
    });
  });

  it('refuses every tool with a token no live session holds', async () => {
    const { daemon } = await boardDaemon();
    const mcp = startMcp({ AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: 'forged' });

    for (const tool of ['whoami', 'board', 'connections']) {
      expect(await mcp.callTool(tool, {})).toMatchObject({ text: expect.stringContaining('not a live session'), isError: true });
    }
  });
});
