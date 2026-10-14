import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_HELP, COMMAND_HELP, runBoardCommand } from '../src/board-cli.ts';
import { runAgentBoardCli } from '../src/cli.ts';
import { paneIds } from '../src/pane-layout.ts';
import type { AgentUpdatedEvent, DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** Runs `agent-board <command> <args>` in this process with `env`, and what it printed. */
async function run(env: NodeJS.ProcessEnv, command: string, ...args: string[]) {
  let out = '';
  let err = '';
  const code = await runBoardCommand(command, args, { out: (text) => (out += text), err: (text) => (err += text), env });
  return { code, out, err };
}

/**
 * A board with a repo zone `web` holding an agent `fix-tests` and a shell, a group `Ideas` holding a sticky note, a
 * loose agent also called `web`, a loose shell, and an edge from `fix-tests` to `web`.
 */
async function board() {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo('webapp');
  const web = await client.call('zone.add', { path: repo, x: 0, y: 0, name: 'web' });
  const ideas = await client.call('zone.addUnbound', { name: 'Ideas', x: 1000, y: 0 });
  const fixTests = await client.call('agent.spawn', { zoneId: web.id, prompt: 'Fix the flaky tests', name: 'fix-tests', ...SIZE });
  const webAgent = await client.call('agent.spawn', {
    zoneId: null,
    repo: { path: repo },
    position: { x: 3000, y: 0 },
    prompt: 'Polish the web app',
    name: 'web',
    ...SIZE,
  });
  for (const agent of [fixTests, webAgent]) {
    await recorder.waitFor(
      (event: DaemonEvent): event is AgentUpdatedEvent =>
        event.type === 'agent.updated' && event.agent.sessionId === agent.sessionId && event.agent.state === 'waiting',
    );
  }
  const shell = await client.call('shell.create', { zoneId: web.id });
  const loose = await client.call('shell.create', { zoneId: null, position: { x: 4000, y: 0 } });
  const note = await client.call('item.create', {
    kind: 'sticky',
    zoneId: ideas.id,
    x: 10,
    y: 20,
    width: 200,
    height: 180,
    data: { text: 'Ship by Friday', color: '#fff3a3' },
  });
  const edge = await client.call('flowEdge.create', { from: fixTests.sessionId, to: webAgent.sessionId });
  const env = { AGENT_BOARD_SOCKET: daemon.socketPath };
  return { daemon, client, recorder, repo, web, ideas, fixTests, webAgent, shell, loose, note, edge, env };
}

/** `kind:` and the first four characters of `id`: its ref while nothing else of its kind starts the same way. */
const ref = (kind: string, id: string) => `${kind}:${id.slice(0, 4)}`;

describe('agent-board --help', () => {
  it('teaches the concepts, refs and commands', () => {
    expect(BOARD_HELP).toMatchSnapshot();
  });

  it.each(Object.keys(COMMAND_HELP))('has help for %s', async (command) => {
    const { code, out } = await run({}, command, '--help');
    expect(code).toBe(0);
    expect(out).toMatchSnapshot();
  });

  it('prints the board help with no command, --help or help, and a command’s with help <command>', async () => {
    let out = '';
    const write = process.stdout.write;
    process.stdout.write = ((text: string) => (out += text, true)) as typeof process.stdout.write;
    try {
      for (const argv of [[], ['--help'], ['help']]) expect(await runAgentBoardCli(argv)).toBe(0);
      expect(await runAgentBoardCli(['help', 'tree'])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(out).toBe(`${BOARD_HELP}${BOARD_HELP}${BOARD_HELP}usage: ${COMMAND_HELP.tree!.usage}\n\n${COMMAND_HELP.tree!.text}\n`);
  });
});

describe('reading the board', () => {
  it('shows every zone with its tiles and items, then what is loose, as text and JSON', async () => {
    const { env, repo, web, ideas, fixTests, webAgent, shell, loose, note } = await board();

    const { code, out } = await run(env, 'tree');

    expect(code).toBe(0);
    const lines = out.trimEnd().split('\n');
    expect(lines).toEqual([
      `${ref('zone', web.id)}  web  (repo ${repo})`,
      `  ${ref('agent', fixTests.sessionId)}  fix-tests  [waiting]  task: Fix the flaky tests`,
      `  ${ref('shell', shell.id)}  ${shell.name}  [shell]  in ${repo}`,
      `${ref('zone', ideas.id)}  Ideas  (group)`,
      `  ${ref('item', note.id)}  sticky  "Ship by Friday"`,
      'loose on the board',
      `  ${ref('agent', webAgent.sessionId)}  web  [waiting]  task: Polish the web app`,
      `  ${ref('shell', loose.id)}  ${loose.name}  [shell]  in ${loose.cwd}`,
    ]);

    const json = JSON.parse((await run(env, 'tree', '--json')).out);
    expect(json.zones.map((zone: { ref: string; kind: string }) => [zone.ref, zone.kind])).toEqual([
      [ref('zone', web.id), 'repo'],
      [ref('zone', ideas.id), 'group'],
    ]);
    expect(json.zones[0].tiles[0]).toMatchObject({
      ref: ref('agent', fixTests.sessionId),
      id: fixTests.sessionId,
      kind: 'agent',
      name: 'fix-tests',
      state: 'waiting',
      status: null,
      task: 'Fix the flaky tests',
      zone: ref('zone', web.id),
      you: false,
    });
    expect(json.zones[1].items).toEqual([{ ref: ref('item', note.id), id: note.id, kind: 'sticky', zone: ref('zone', ideas.id), text: 'Ship by Friday' }]);
    expect(json.loose.tiles.map((tile: { ref: string }) => tile.ref)).toEqual([ref('agent', webAgent.sessionId), ref('shell', loose.id)]);
  });

  it('shows one thing by ref, by whole id or by unique name, as text and JSON', async () => {
    const { env, web, fixTests, webAgent, edge } = await board();

    const byRef = await run(env, 'show', ref('agent', fixTests.sessionId));
    expect(byRef.code).toBe(0);
    expect(byRef.out).toContain(`${ref('agent', fixTests.sessionId)}  fix-tests\n  state      waiting\n  status     not set\n`);
    expect(byRef.out).toContain(`  branch     ${fixTests.branch}\n`);
    expect(byRef.out).toContain(`    ${ref('edge', edge.id)}  ${ref('agent', fixTests.sessionId)} fix-tests [waiting] → ${ref('agent', webAgent.sessionId)} web [waiting]\n`);
    expect(byRef.out).toContain('      carries its final message when it hands off, or else as its turn ends; never delivered');
    expect((await run(env, 'show', 'fix-tests')).out).toBe(byRef.out);
    expect((await run(env, 'show', fixTests.sessionId)).out).toBe(byRef.out);
    expect((await run(env, 'show', 'agent:FIX-TESTS')).out).toBe(byRef.out);

    const zone = JSON.parse((await run(env, 'show', 'zone:web', '--json')).out);
    expect(zone).toMatchObject({ ref: ref('zone', web.id), name: 'web', kind: 'repo', boardMcp: true, tiles: 2, items: 0 });
  });

  it('refuses a name more than one thing has, listing them by ref, and a name nothing has', async () => {
    const { env, web, webAgent } = await board();

    const ambiguous = await run(env, 'show', 'web');
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toBe(
      `agent-board show: "web" could be any of 2 things; use a ref:\n` +
        `  ${ref('zone', web.id)}  zone web\n  ${ref('agent', webAgent.sessionId)}  agent web (waiting)\n`,
    );

    const missing = await run(env, 'show', 'agent:nobody');
    expect(missing).toMatchObject({ code: 1, err: expect.stringContaining('nothing on the board is called "agent:nobody"') });
    expect((await run(env, 'show')).code).toBe(2);
  });

  it('lists zones, agents, shells and edges', async () => {
    const { env, web, ideas, fixTests, webAgent, edge } = await board();

    expect((await run(env, 'zones')).out).toBe(`${ref('zone', web.id)}  web  (repo ${web.repoRoot})  2 tiles\n${ref('zone', ideas.id)}  Ideas  (group)  0 tiles\n`);
    expect((await run(env, 'ls')).out).toBe((await run(env, 'agents')).out);
    expect((await run(env, 'agents')).out).toContain(`fix-tests  [waiting]  task: Fix the flaky tests  (in ${ref('zone', web.id)} web)\n`);
    expect((await run(env, 'edges')).out).toBe(
      `${ref('edge', edge.id)}  ${ref('agent', fixTests.sessionId)} fix-tests [waiting] → ${ref('agent', webAgent.sessionId)} web [waiting]\n` +
        '  carries its final message when it hands off, or else as its turn ends; never delivered\n',
    );
    expect(JSON.parse((await run(env, 'shells', '--json')).out)).toHaveLength(2);
  });
});

describe('who is calling', () => {
  it('reads the board without a token, but sets no status', async () => {
    const { env } = await board();

    expect((await run(env, 'identify')).out).toMatch(/^You are not in an agent-board session/);
    expect(await run(env, 'status', 'set', 'Doing things')).toMatchObject({
      code: 1,
      err: expect.stringContaining('Only an agent in an agent-board session can set its status'),
    });
  });

  it('refuses a board token no live session holds', async () => {
    const { env } = await board();
    expect(await run({ ...env, AGENT_BOARD_IDENTITY: 'forged' }, 'tree')).toMatchObject({
      code: 1,
      err: expect.stringContaining("AGENT_BOARD_IDENTITY is not a live session's board token"),
    });
  });

  it('says when no daemon answers', async () => {
    const result = await run({ AGENT_BOARD_DATA_DIR: tempDataDir() }, 'tree');
    expect(result).toMatchObject({ code: 1, err: expect.stringContaining("agent-board isn't running") });
  });

  it('prints the board help for help --help', async () => {
    expect(await run({}, 'help', '--help')).toMatchObject({ code: 0, out: BOARD_HELP });
  });

  it('checks arguments before it connects', async () => {
    expect(await run({}, 'tree', 'extra')).toMatchObject({ code: 2, err: expect.stringContaining('unexpected extra') });
    expect(await run({}, 'status', 'set', 'x', '--progress', '120')).toMatchObject({ code: 2 });
    expect(await run({}, 'rpc', 'daemon.health', '{nope')).toMatchObject({ code: 2, err: expect.stringContaining('JSON') });
  });

  it('calls a daemon method with rpc', async () => {
    const { env, daemon } = await board();
    const health = JSON.parse((await run(env, 'rpc', 'daemon.health')).out);
    expect(health.cliPath).toBe((await (await connectTestClient(daemon)).call('daemon.health')).cliPath);
  });

  it('runs on a shell tile’s PATH, and tells the shell it is that tile, in its zone', async () => {
    const { client, recorder, web, shell } = await board();
    const pane = paneIds(shell.layout)[0]!;
    await client.call('session.attach', { sessionId: pane });

    await client.call('session.write', { sessionId: pane, data: 'agent-board identify\r' });

    await recorder.waitForText(pane, 'daemon ');
    const screen = recorder.screenText(pane).replace(/\r/g, '');
    expect(screen).toContain(`you      ${ref('shell', shell.id)}  ${shell.name}  (a shell tile)\n`);
    expect(screen).toContain(`zone     ${ref('zone', web.id)}  web  (repo ${web.repoRoot})\n`);
    expect(screen).toContain(`session  ${pane}\n`);
  });
});

describe('orchestrating from the command line', () => {
  it('lets the user turn orchestrating on and off for an agent, and shows it', async () => {
    const { env, client, fixTests } = await board();

    expect(await run(env, 'orchestrate', 'on', 'fix-tests', '--scope', 'repo')).toMatchObject({
      code: 0,
      out: `${ref('agent', fixTests.sessionId)} fix-tests may orchestrate in its repo now.\n`,
    });
    expect((await client.call('agent.list')).find((agent) => agent.name === 'fix-tests')!.orchestrate).toBe('repo');
    expect((await run(env, 'show', 'fix-tests')).out).toContain('  orchestrates agents in its repo\n');
    expect((await run(env, 'orchestrate', 'off', 'fix-tests')).out).toBe(`${ref('agent', fixTests.sessionId)} fix-tests may not orchestrate now.\n`);
    expect((await client.call('agent.list')).find((agent) => agent.name === 'fix-tests')!.orchestrate).toBeNull();
  });

  it('refuses the orchestrator commands outside a session, and shows an empty activity log', async () => {
    const { env } = await board();

    expect(await run(env, 'new', '--', 'Do something')).toMatchObject({
      code: 1,
      err: expect.stringContaining('The orchestrator commands work only for an agent in an agent-board session'),
    });
    expect(await run(env, 'activity')).toMatchObject({ code: 0, out: 'No orchestrator has done anything yet.\n' });
  });

  it('checks each command’s options before it connects', async () => {
    expect(await run({}, 'send', 'agent:1234', '--remove', 'hi')).toMatchObject({ code: 2, err: expect.stringContaining('--remove is not an option of send') });
    expect(await run({}, 'tree', '--progress', '5')).toMatchObject({ code: 2, err: expect.stringContaining('--progress is only for `status set`') });
    expect(await run({}, 'wait')).toMatchObject({ code: 2, err: expect.stringContaining('give one or more agent refs') });
    expect(await run({}, 'wait', 'agent:1234', '--until', 'sleeping')).toMatchObject({ code: 2, err: expect.stringContaining('sleeping is not a state') });
    expect(await run({}, 'orchestrate', 'maybe', 'agent:1234')).toMatchObject({ code: 2 });
    expect(await run({}, 'orchestrate', 'on', 'agent:1234', '--scope', 'galaxy')).toMatchObject({ code: 2 });
    expect(await run({}, 'send', 'agent:1234')).toMatchObject({ code: 2, err: expect.stringContaining('give a message') });
  });
});

describe('hand-offs and edges from the command line', () => {
  it('checks their arguments before it connects', async () => {
    expect(await run({}, 'handoff', '--data', '{nope')).toMatchObject({ code: 2, err: expect.stringContaining('--data must be JSON') });
    expect(await run({}, 'handoff', 'agent:1234')).toMatchObject({ code: 2, err: expect.stringContaining('unexpected agent:1234') });
    expect(await run({}, 'edge', 'add', 'a', 'b')).toMatchObject({ code: 2, err: expect.stringContaining('carries must be message, handover, json') });
    expect(await run({}, 'edge', 'add', 'a', '--carries', 'message')).toMatchObject({ code: 2, err: expect.stringContaining('give the agent it flows from') });
    expect(await run({}, 'edge', 'add', 'a', 'b', '--carries', 'message', '--trigger', 'soon')).toMatchObject({ code: 2 });
    expect(await run({}, 'edge', 'add', 'a', 'b', '--carries', 'message', '--condition', 'gate')).toMatchObject({
      code: 2,
      err: expect.stringContaining('a gate condition needs a command'),
    });
    expect(await run({}, 'edge', 'add', 'a', 'b', '--carries', 'message', '--condition', 'vibes:good')).toMatchObject({ code: 2 });
    expect(await run({}, 'edge', 'list', '--carries', 'json')).toMatchObject({ code: 2, err: expect.stringContaining('--carries is only for `edge add`') });
    expect(await run({}, 'edge', 'drop', 'edge:1234')).toMatchObject({ code: 2 });
  });

  it('lists edges with `edge list`, and refuses a hand-off or a new edge outside a session', async () => {
    const { env, edge } = await board();

    expect((await run(env, 'edge', 'list')).out).toContain(ref('edge', edge.id));
    expect(await run(env, 'handoff', '--message', 'done')).toMatchObject({ code: 1, err: expect.stringContaining('Only an agent in an agent-board session can hand off') });
    expect(await run(env, 'edge', 'add', 'fix-tests', 'web', '--carries', 'handover', '--condition', 'gate:pnpm check:local')).toMatchObject({
      code: 1,
      err: expect.stringContaining('The orchestrator commands work only for an agent'),
    });
  });
});
