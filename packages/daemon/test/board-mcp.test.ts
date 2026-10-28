import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { COMMAND_HELP, COMMAND_OPTIONS } from '../src/board-cli.ts';
import { BOARD_MCP_INSTRUCTIONS, BOARD_MCP_TOOLS, ORCHESTRATOR_MCP_TOOLS } from '../src/board-mcp.ts';
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

/** The command lines of every process under `pid`, however deep. */
function descendants(pid: number): string[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, child, parent, command]) => ({ pid: Number(child), ppid: Number(parent), command: command! }));
  const under = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (under.has(row.ppid) && !under.has(row.pid)) {
        under.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => row.pid !== pid && under.has(row.pid)).map((row) => row.command);
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
    // A Claude agent's MCP calls went to the daemon over HTTP: it started no `agent-board mcp` of its own.
    // Codex keeps its stdio server until a real Codex has been seen calling the HTTP one.
    const { pid } = (await client.call('session.list')).find((session) => session.id === agent.sessionId)!;
    expect(descendants(pid).filter((command) => / mcp$/.test(command))).toHaveLength(harness === 'claude' ? 0 : 1);

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
    // (A finished turn drops the progress, so watch the update that carried it rather than the list afterwards.)
    const updated = await untilAgent(recorder, agent.sessionId, (seen) => seen.status?.progress === 20);
    expect(updated.status).toMatchObject({ summary: 'Look around', progress: 20 });
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

describe('the board MCP tools and the agent-board CLI', () => {
  /**
   * Each tool's CLI command, with the tool arguments that are positional there (no option) and the ones the CLI spells
   * differently. `options` is the CLI options it takes when that isn't the command's own.
   */
  const PARITY: { tool: string; command: string; positional?: string[]; renamed?: Record<string, string>; options?: string[] }[] = [
    { tool: 'whoami', command: 'identify' },
    { tool: 'board', command: 'tree' },
    { tool: 'handoff', command: 'handoff', renamed: { handover_path: 'handover', json: 'data' } },
    { tool: 'set_status', command: 'status', positional: ['summary'] },
    { tool: 'needs_you', command: 'needs-you', positional: ['reason'] },
    { tool: 'open_pr', command: 'open-pr' },
    // With plan, it is present_plan, which waits on the user longer than a shell command runs: the tool's alone.
    { tool: 'show_doc', command: 'doc', positional: ['path'], renamed: { on_board: 'board' }, options: ['title', 'board', 'plan', 'timeout_minutes'] },
    { tool: 'record_pr', command: 'record', positional: ['url'], options: ['title'] },
    { tool: 'record_doc', command: 'record', positional: ['path'], renamed: { for_orchestrator: 'for' }, options: ['for'] },
    { tool: 'pin', command: 'pin', positional: ['path', 'url'], renamed: { for_orchestrator: 'for' } },
    { tool: 'unpin', command: 'unpin', positional: ['path', 'url'], renamed: { for_orchestrator: 'for' } },
    { tool: 'new_agent', command: 'new', renamed: { prompt: 'file', template: 'no-template' } },
    { tool: 'send', command: 'send', positional: ['agent'], renamed: { text: 'file' } },
    // With since, the tool is one round of `watch`, so it takes watch's --since and --only too.
    {
      tool: 'wait',
      command: 'wait',
      positional: ['agents'],
      renamed: { timeout_seconds: 'timeout', kinds: 'only' },
      options: ['until', 'any', 'timeout', 'crew', 'since', 'only'],
    },
    { tool: 'read', command: 'read', positional: ['agent', 'path'] },
    { tool: 'interrupt', command: 'interrupt', positional: ['agent'] },
    { tool: 'continue_on_credits', command: 'continue', positional: ['agent'] },
    { tool: 'restart', command: 'restart', positional: ['agent'], renamed: { prompt: 'file' } },
    { tool: 'pause', command: 'pause', positional: ['agent'] },
    { tool: 'wake', command: 'wake', positional: ['agent'] },
    { tool: 'close', command: 'close', positional: ['agent'] },
    { tool: 'add_edge', command: 'edge', positional: ['from', 'to'], renamed: { conditions: 'condition' } },
    { tool: 'list_edges', command: 'edges' },
    { tool: 'remove_edge', command: 'edge', positional: ['edge'], options: [] },
    { tool: 'move', command: 'move', positional: ['tile'] },
    { tool: 'arrange', command: 'arrange', positional: ['zone'] },
    // `zone map` and `zone screenshot` alone: the other zone commands change groups, the CLI's alone.
    { tool: 'map', command: 'zone', positional: ['zone'], options: ['boxes', 'sections'] },
    // The CLI writes the picture to a file (--out) as the tool hands it to the model.
    { tool: 'zone_screenshot', command: 'zone', positional: ['zone'], options: ['style'] },
    { tool: 'add_note', command: 'note', options: ['text', 'kind', 'color', 'to', 'at', 'near', 'side'] },
    { tool: 'edit_note', command: 'note', positional: ['note'], options: ['text', 'color', 'size'] },
    { tool: 'remove_note', command: 'note', positional: ['note'], options: [] },
    {
      tool: 'add_shape',
      command: 'shape',
      positional: ['shape'],
      renamed: { attributes: 'attribute', methods: 'method' },
      options: ['text', 'attribute', 'method', 'fill', 'to', 'at', 'near', 'side'],
    },
    {
      tool: 'edit_shape',
      command: 'shape',
      positional: ['item'],
      renamed: { shape: 'kind', attributes: 'attribute', methods: 'method' },
      options: ['kind', 'text', 'attribute', 'method', 'fill'],
    },
    { tool: 'remove_shape', command: 'shape', positional: ['item'], options: [] },
    { tool: 'add_diagram', command: 'diagram', positional: ['mermaid'], options: ['to', 'at', 'near', 'side'] },
    { tool: 'export_diagram', command: 'diagram', positional: ['refs'], options: [] },
    { tool: 'connect', command: 'connect', positional: ['from', 'to'], renamed: { from_label: 'from-label', to_label: 'to-label' } },
    { tool: 'edit_connector', command: 'connector', positional: ['connector'], renamed: { from_label: 'from-label', to_label: 'to-label' } },
    { tool: 'remove_connector', command: 'connector', positional: ['connector'], options: [] },
    { tool: 'add_schedule', command: 'schedule', positional: ['cron'], renamed: { prompt: 'file', handoff_to: 'handoff-to' } },
    { tool: 'list_schedules', command: 'schedule', options: [] },
    { tool: 'remove_schedule', command: 'schedule', positional: ['schedule'], options: [] },
    { tool: 'roles', command: 'roles', options: [] },
    { tool: 'set_role', command: 'roles', positional: ['name'], renamed: { template: 'file' } },
    { tool: 'remove_role', command: 'roles', positional: ['name'], options: ['zone'] },
  ];
  /** Tools with no command of their own, and commands with no tool, each for a reason. */
  // A question and a plan wait minutes for the user: longer than a harness lets a shell command run.
  const MCP_ONLY = ['connections', 'ask', 'present_plan'];
  // `watch` prints as things happen, as no tool call can: the wait tool with since is one round of it.
  const CLI_ONLY = ['zones', 'agents', 'shells', 'show', 'mcp', 'orchestrate', 'activity', 'rpc', 'watch'];

  const tools = [...BOARD_MCP_TOOLS, ...ORCHESTRATOR_MCP_TOOLS];
  const toolProperties = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema.properties as object | undefined) ?? {});

  it('pairs every tool with a command, and every command with a tool', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...PARITY.map((p) => p.tool), ...MCP_ONLY].sort());
    expect(Object.keys(COMMAND_HELP).sort()).toEqual([...new Set(PARITY.map((p) => p.command)), ...CLI_ONLY].sort());
  });

  it.each(PARITY)('gives $tool the options of `agent-board $command`', ({ tool, command, positional = [], renamed = {}, options }) => {
    const fromTool = toolProperties(tool)
      .filter((name) => !positional.includes(name))
      .map((name) => renamed[name] ?? name)
      .sort();
    expect(fromTool).toEqual([...(options ?? COMMAND_OPTIONS[command] ?? [])].sort());
  });
});
