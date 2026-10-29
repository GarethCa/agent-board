import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_HELP, COMMAND_HELP, runBoardCommand } from '../src/board-cli.ts';
import { runAgentBoardCli } from '../src/cli.ts';
import { paneIds } from '../src/pane-layout.ts';
import { daemonPaths, defaultDataDir } from '../src/paths.ts';
import { AGENT_NOTE_SIZE, newShapeData, type AgentUpdatedEvent, type DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

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

  it('says doc --plan returns at once, the decision coming to the prompt later', () => {
    expect(COMMAND_HELP.doc!.text).toMatch(/returns at once/);
    expect(COMMAND_HELP.doc!.text).toMatch(/typed at your prompt/);
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
  it("cuts a long note's text on whole characters, so it never prints half an emoji", async () => {
    const { env, client, ideas } = await board();
    // Cut at 60 characters, the 59th and 60th UTF-16 units are the two halves of the 🤖.
    await client.call('item.create', { kind: 'sticky', zoneId: ideas.id, x: 300, y: 20, width: 200, height: 180, data: { text: `${'x'.repeat(58)}🤖 signed by lead`, color: '#fff3a3' } });
    const { out } = await run(env, 'tree');
    expect(out).toContain(`"${'x'.repeat(58)}🤖…"`);
    expect(out).not.toMatch(/\\ud8/);
  });

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

  it("sizes an agent note with `note edit --size`, which the user's own sticky refuses", async () => {
    const { client, env, ideas, fixTests } = await board();
    const author = { sessionId: fixTests.sessionId, name: 'fix-tests', harness: 'claude', role: null };
    const note = await client.call('item.create', {
      kind: 'agent-note',
      zoneId: ideas.id,
      x: 300,
      y: 20,
      ...AGENT_NOTE_SIZE,
      data: { text: 'Digest', agent: author, writtenAt: new Date().toISOString(), editedByUser: false },
    });
    expect(await run(env, 'note', 'edit', ref('item', note.id), '--size', '400x300')).toMatchObject({ code: 0 });
    expect((await client.call('item.list')).find((item) => item.id === note.id)).toMatchObject({ width: 400, height: 300, data: { text: 'Digest', userSized: true } });
    expect(await run(env, 'note', 'edit', ref('item', note.id), '--size', '320,200', '--text', 'Digest two')).toMatchObject({ code: 0 });
    expect((await client.call('item.list')).find((item) => item.id === note.id)).toMatchObject({ width: 320, height: 200, data: { text: 'Digest two' } });
    const sticky = (await client.call('item.list')).find((item) => item.kind === 'sticky')!;
    expect(await run(env, 'note', 'edit', ref('item', sticky.id), '--size', '400x300')).toMatchObject({ code: 1, err: expect.stringContaining('only an agent note can be given a size') });
  });

  it("shows an agent note's kind and the agent that wrote it, in the tree and by ref", async () => {
    const { client, env, ideas, fixTests } = await board();
    const author = { sessionId: fixTests.sessionId, name: 'fix-tests', harness: 'claude', role: null };
    const note = await client.call('item.create', {
      kind: 'agent-note',
      zoneId: ideas.id,
      x: 300,
      y: 20,
      ...AGENT_NOTE_SIZE,
      data: { text: '**Round 2**\n\n- fixing', agent: author, writtenAt: new Date().toISOString(), editedByUser: false },
    });

    expect((await run(env, 'tree')).out).toContain(`  ${ref('item', note.id)}  agent-note  "**Round 2** - fixing"  by ${ref('agent', fixTests.sessionId)} fix-tests\n`);
    const json = JSON.parse((await run(env, 'tree', '--json')).out);
    expect(json.zones[1].items[1]).toMatchObject({ kind: 'agent-note', by: ref('agent', fixTests.sessionId), text: '**Round 2**\n\n- fixing' });
    expect((await run(env, 'show', ref('item', note.id))).out).toContain(`${ref('item', note.id)}  agent-note\n  zone       (in ${ref('zone', ideas.id)} Ideas)\n  by         ${ref('agent', fixTests.sessionId)} fix-tests\n`);
  });

  it('shows one thing by ref, by whole id or by unique name, as text and JSON', async () => {
    const { env, web, fixTests, webAgent, edge } = await board();

    const byRef = await run(env, 'show', ref('agent', fixTests.sessionId));
    expect(byRef.code).toBe(0);
    expect(byRef.out).toContain(`${ref('agent', fixTests.sessionId)}  fix-tests\n  state      waiting\n  status     not set\n  task       Fix the flaky tests\n`);
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

  it("refuses the app's own daemon under a test, however it was found", async () => {
    const live = daemonPaths(defaultDataDir({ HOME: userInfo().homedir })).socket;
    // Neither a socket nor a data dir: the CLI would fall back to the app's own daemon, the live board.
    for (const env of [{}, { AGENT_BOARD_SOCKET: live }]) {
      expect(await run(env, 'tree')).toMatchObject({ code: 1, err: expect.stringContaining("refusing the app's own daemon") });
    }
    // A test that swaps HOME still has the real one's daemon refused, and its own fallback is merely not running.
    expect(await run({ HOME: tempDataDir() }, 'tree')).toMatchObject({ code: 1, err: expect.stringContaining("agent-board isn't running") });
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

describe('an agent that changes its branch', () => {
  it('is shown on its new name, and `new --base agent:<ref>` starts from it; from a detached HEAD it is refused', async () => {
    const { env, client, web, fixTests } = await board();
    git(fixTests.worktree, 'branch', '-m', 'renamed-one');

    expect((await run(env, 'show', 'fix-tests')).out).toContain('  branch     renamed-one\n');
    const started = await run(env, 'new', '--zone', ref('zone', web.id), '--name', 'follow-up', '--base', ref('agent', fixTests.sessionId), '--', 'Carry on');
    expect(started).toMatchObject({ code: 0, err: '' });
    const follow = (await client.call('agent.list')).find((each) => each.name === 'follow-up')!;
    expect(git(follow.worktree, 'merge-base', 'renamed-one', 'HEAD')).toBe(git(follow.worktree, 'rev-parse', 'HEAD'));

    git(fixTests.worktree, 'checkout', '--detach');
    const refused = await run(env, 'new', '--zone', ref('zone', web.id), '--base', ref('agent', fixTests.sessionId), '--', 'Again');
    expect(refused).toMatchObject({ code: 1, err: expect.stringContaining('detached HEAD') });
    expect((await run(env, 'show', 'fix-tests')).out).toContain('(detached, last on renamed-one)');
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

  it('runs the orchestrator commands as the user outside a session, logged as you', async () => {
    const { env, client, web } = await board();
    expect(await run(env, 'activity')).toMatchObject({ code: 0, out: 'No orchestrator has done anything yet.\n' });

    expect(await run(env, 'new', '--', 'Do something')).toMatchObject({ code: 1, err: expect.stringContaining('name the zone to start the agent in') });
    const started = await run(env, 'new', '--zone', ref('zone', web.id), '--name', 'by-hand', '--', 'Do something');
    expect(started).toMatchObject({ code: 0, err: '' });
    const agent = (await client.call('agent.list')).find((each) => each.name === 'by-hand')!;
    expect(agent.spawnedBy).toBeNull();
    expect(await run(env, 'close', 'by-hand')).toMatchObject({ code: 0 });
    expect((await run(env, 'activity')).out).toMatch(/you {2}close by-hand\n.*you {2}spawn by-hand/s);
  });

  it('checks each command’s options before it connects', async () => {
    expect(await run({}, 'send', 'agent:1234', '--remove', 'hi')).toMatchObject({ code: 2, err: expect.stringContaining('--remove is not an option of send') });
    expect(await run({}, 'tree', '--progress', '5')).toMatchObject({ code: 2, err: expect.stringContaining('--progress is only for `status set`') });
    expect(await run({}, 'watch', '--since', '12')).toMatchObject({ code: 2, err: expect.stringContaining('--since takes a line\'s cursor') });
    expect(await run({}, 'watch', '--only', 'naps')).toMatchObject({ code: 2, err: expect.stringContaining('naps is not a kind') });
    expect(await run({}, 'agents', '--done')).toMatchObject({ code: 2, err: expect.stringContaining('--done is only for `status set`') });
    expect(await run({}, 'wait', 'agent:1234', '--until', 'sleeping')).toMatchObject({ code: 2, err: expect.stringContaining('sleeping is not a state') });
    expect(await run({}, 'orchestrate', 'maybe', 'agent:1234')).toMatchObject({ code: 2 });
    expect(await run({}, 'orchestrate', 'on', 'agent:1234', '--scope', 'galaxy')).toMatchObject({ code: 2 });
    expect(await run({}, 'send', 'agent:1234')).toMatchObject({ code: 2, err: expect.stringContaining('give a message') });
  });
});

describe('watching a crew from the command line', () => {
  it('hears an agent that ends two turns while its gate runs, then hands off, finish once, and waits until then', async () => {
    const daemon = await startTestDaemon({
      worktreesDir: tempDataDir(),
      agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }),
    });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo('gated'), x: 0, y: 0, name: 'gated' });
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath };
    // The user's side: every agent is its crew. From the daemon's start, so nothing is missed.
    const watched = run(env, 'watch', '--crew', '--since', 'all', '--count', '3', '--timeout', '60');

    expect(await run(env, 'new', '--zone', ref('zone', zone.id), '--name', 'gate', '--', 'Gate in the background')).toMatchObject({ code: 0 });
    const waited = await run(env, 'wait', 'gate', '--until', 'finished', '--timeout', '60');
    const [gate] = await client.call('agent.list');
    expect(waited).toMatchObject({ code: 0, out: expect.stringContaining(`${ref('agent', gate!.sessionId)}  gate  [`) });
    expect(waited.out).toContain(', finished]');
    expect(gate!.workFinishedAt).not.toBeNull();
    // No refs is the whole crew, as for the MCP tool: on the user's side, every agent.
    expect(await run(env, 'wait', '--until', 'finished', '--timeout', '5')).toMatchObject({ code: 0, out: expect.stringContaining('  gate  [') });

    const lines = (await watched).out.trimEnd().split('\n');
    expect(lines.map((line) => line.replace(/^\[[0-9a-z]+\.\d+\] agent:\w+ /, ''))).toEqual(['gate  turn-ended', 'gate  turn-ended', 'gate  finished']);
    // Its idle prompt after the last turn, and its turn ending finished, add nothing.
    const cursor = /^\[([0-9a-z]+\.\d+)\]/.exec(lines.at(-1)!)![1]!;
    expect(await run(env, 'watch', '--since', cursor, '--timeout', '1')).toEqual({ code: 0, out: '', err: '' });
    // From now by default: what came before is not news.
    expect(await run(env, 'watch', '--timeout', '1')).toEqual({ code: 0, out: '', err: '' });
    expect(await run(env, 'watch', '--since', 'all', '--only', 'finished', '--count', '1', '--json')).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^\{"cursor":"[0-9a-z]+\.\d+",.*"kind":"finished".*\}\n$/),
    });
    // A cursor from before a restart (another run's) gets every line since, saying some were missed.
    const replayed = await run(env, 'watch', '--since', 'zz0.1', '--count', '1', '--timeout', '5');
    expect(replayed.out.split('\n').slice(0, 2)).toEqual([expect.stringContaining('Some lines were missed'), expect.stringContaining('gate  turn-ended')]);
  });
});

describe('waiting from the command line', () => {
  it('exits 3, not 0, when a wait gives up, takes a duration, and refuses a bad one before it connects', async () => {
    const daemon = await startTestDaemon({
      worktreesDir: tempDataDir(),
      agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir() }),
    });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo('slow'), x: 0, y: 0, name: 'slow' });
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath };
    expect(await run(env, 'new', '--zone', ref('zone', zone.id), '--name', 'plain', '--', 'Do the work')).toMatchObject({ code: 0 });

    // Its turn ends, but it never says it finished: the wait for that gives up.
    const early = await run(env, 'wait', 'plain', '--until', 'finished', '--timeout', '1s');
    expect(early).toMatchObject({ code: 3, out: expect.stringContaining('Timed out: not all are there yet') });
    expect(await run(env, 'wait', 'plain', '--until', 'finished', '--timeout', '0', '--json')).toMatchObject({ code: 3, out: expect.stringContaining('"timedOut": true') });
    // So `&&` stops there, and a wait that is answered exits 0.
    expect(await run(env, 'wait', 'plain', '--timeout', '1m')).toMatchObject({ code: 0, out: expect.not.stringContaining('Timed out') });
  });

  it('takes seconds, or a number with s, m or h, up to the longest wait', async () => {
    for (const bad of ['soon', '-1', '1.5', '2d', '31m', '9999999999999999999h']) {
      expect(await run({}, 'wait', `--timeout=${bad}`)).toMatchObject({ code: 2, err: expect.stringContaining('--timeout must be a duration') });
    }
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

  it('lists edges with `edge list`, refuses a hand-off outside a session, and adds an edge there as the user', async () => {
    const { env, edge, webAgent } = await board();

    expect((await run(env, 'edge', 'list')).out).toContain(ref('edge', edge.id));
    expect(await run(env, 'handoff', '--message', 'done')).toMatchObject({ code: 1, err: expect.stringContaining('Only an agent in an agent-board session can hand off') });
    expect(await run(env, 'open-pr')).toMatchObject({ code: 1, err: expect.stringContaining('Only an agent in an agent-board session can open a pull request') });
    expect(await run(env, 'edge', 'add', ref('agent', webAgent.sessionId), 'fix-tests', '--carries', 'handover', '--trigger', 'manual', '--condition', 'gate:pnpm check:local')).toMatchObject({
      code: 0,
      err: '', out: expect.stringContaining('runs nothing until the user approves it'),
    });
  });
});

describe('laying out the board from the command line', () => {
  it('checks the layout commands’ arguments before it connects', async () => {
    const usage = async (args: string[], message: string) =>
      expect(await run({}, args[0]!, ...args.slice(1))).toMatchObject({ code: 2, err: expect.stringContaining(message) });
    await usage(['move'], 'give one tile or note ref');
    await usage(['move', 'a', '--at', 'here'], '--at is x,y');
    await usage(['move', 'a', '--side', 'right'], '--side is only with --near');
    await usage(['move', 'a', '--near', 'b', '--side', 'under'], '--side must be below, right, left, above');
    await usage(['move', 'a', '--near', 'b', '--at', '1,2'], 'give --at or --near, not both');
    await usage(['arrange', '--by', 'mood'], '--by must be issue, role, state');
    await usage(['arrange', '--layout', 'spiral'], '--layout must be rows, columns, cards, grid');
    await usage(['arrange', 'a', 'b'], 'give at most one zone ref');
    await usage(['zone', 'add', '--name', 'x'], 'give --group');
    await usage(['zone', 'add', '--group'], 'give the group --name');
    await usage(['zone', 'add', '--group', '--name', 'x', '--size', 'big'], '--size is width,height');
    await usage(['zone', 'rename', 'zone:1'], 'give the group ref and its new name');
    await usage(['zone', 'resize', 'zone:1'], 'give its new --size');
    await usage(['zone', 'resize', 'zone:1', '--name', 'x'], '--name is not an option of `zone resize`');
    await usage(['zone', 'bind', 'zone:1'], 'the zone commands are');
    await usage(['note', 'add'], 'give the note its text');
    await usage(['note', 'add', '--kind', 'poster', '--', 'hi'], '--kind must be sticky or text');
    await usage(['note', 'edit', 'item:1'], 'give its new --text, --color or --size');
    await usage(['note', 'edit', 'item:1', '--size', 'big'], '--size is <width>x<height>');
    await usage(['note', 'edit', 'item:1', '--size', '100x50'], '--size is at least 200x96');
    await usage(['note', 'edit', 'item:1', '--size', '3600x2400'], '--size is at most 1200x1440');
    await usage(['note', 'add', '--size', '300x200', '--', 'hi'], '--size is only for `note edit`');
    await usage(['note', 'edit', 'item:1', '--near', 'a'], '--near is only for `note add`');
    await usage(['note', 'remove'], 'give one note ref');
  });

  it('arranges the whole board, its zones and loose tiles, and arranged, moves nothing', async () => {
    const { env, client } = await board();
    await client.call('zone.addUnbound', { name: 'far', x: 6000, y: 0 });
    expect(await run(env, 'arrange', 'board')).toMatchObject({ code: 0, out: expect.stringMatching(/^Arranged the board:\n[^]*zone:\S+ far at /) });
    expect(await run(env, 'arrange', 'board')).toMatchObject({ code: 0, out: 'The board was arranged already: nothing moved.\n' });
    expect(await run(env, 'arrange', 'board', '--by', 'role')).toMatchObject({ code: 1, err: expect.stringContaining('arrange board takes no --by') });
  });

  it('makes, changes and removes a group, moves a tile into it, arranges it and puts a note in it, as the user', async () => {
    const { env, client, shell } = await board();

    const made = await run(env, 'zone', 'add', '--group', '--name', 'Done', '--at', '0,2000', '--size', '900,500');
    expect(made).toMatchObject({ code: 0, out: expect.stringMatching(/^Made zone:\S+ {2}Done {2}\(group\) at 0,2000, 900×500\.\n$/) });
    const group = (await client.call('zone.list')).find((zone) => zone.name === 'Done')!;
    // A new zone is roomy: the first slot is its padding and perch in.
    expect(await run(env, 'move', ref('shell', shell.id), '--to', 'Done')).toMatchObject({ code: 0, out: expect.stringMatching(/\(in zone:\S+ Done\) at 32,56\./) });
    expect(await run(env, 'arrange', 'Done', '--json')).toMatchObject({ code: 0, out: expect.stringContaining(`"zoneId": "${group.id}"`) });
    expect(await run(env, 'note', 'add', '--to', 'Done', '--color', 'pink', '--', 'Shipped *today*')).toMatchObject({ code: 0, out: expect.stringContaining('sticky  "Shipped *today*"') });
    const note = (await client.call('item.list')).find((item) => item.zoneId === group.id)!;
    expect(await run(env, 'note', 'edit', ref('item', note.id), '--text', 'Shipped')).toMatchObject({ code: 0, out: expect.stringContaining('"Shipped"') });
    expect(await run(env, 'zone', 'rename', 'Done', 'Shipped', 'work')).toMatchObject({ code: 0, out: expect.stringContaining('Shipped work') });
    expect(await run(env, 'zone', 'resize', ref('zone', group.id), '--size', '1000,600')).toMatchObject({ code: 0, out: expect.stringContaining('1000×600') });
    expect(await run(env, 'note', 'remove', ref('item', note.id))).toMatchObject({ code: 0 });
    expect(await run(env, 'zone', 'remove', ref('zone', group.id))).toMatchObject({ code: 0, out: expect.stringContaining('loose on the board') });
    expect((await client.call('shell.list')).find((each) => each.id === shell.id)).toMatchObject({ zoneId: null });
    expect(await run(env, 'zone', 'remove', 'zone:web')).toMatchObject({ code: 1, err: expect.stringContaining('only groups') });
    expect((await run(env, 'activity')).out).toMatch(/you {2}remove-zone Shipped work.*you {2}add-zone Done/s);
  });
});

describe('drawing a diagram from the command line', () => {
  it('checks the diagram commands’ arguments before it connects', async () => {
    const usage = async (args: string[], message: string) =>
      expect(await run({}, args[0]!, ...args.slice(1))).toMatchObject({ code: 2, err: expect.stringContaining(message) });
    await usage(['shape', 'add'], 'give the kind of shape');
    await usage(['shape', 'add', 'blob', 'Order'], 'the shape is one of rectangle');
    await usage(['shape', 'add', '--kind', 'class', 'Order'], 'give the kind as the first word');
    await usage(['shape', 'add', 'class', 'Order', '--text', 'Order'], 'give the text or --text, not both');
    await usage(['shape', 'edit', 'item:1'], 'give its new --kind');
    await usage(['shape', 'edit', 'item:1', '--near', 'a'], '--near is only for `shape add`');
    await usage(['shape', 'remove', 'item:1', '--text', 'x'], '`shape remove` takes no options');
    await usage(['shape', 'draw'], 'the shape commands are');
    await usage(['connect', 'item:1'], 'give the two items to join');
    await usage(['connect', 'item:1', 'item:2', '--relation', 'friendship'], 'the relation is one of association');
    await usage(['connect', 'item:1', 'item:2', '--style', 'wavy'], 'the style is one of straight');
    await usage(['connector', 'edit', 'connector:1'], 'give its new --relation');
    await usage(['connector', 'remove', 'connector:1', '--label', 'x'], '`connector remove` takes no options');
    await usage(['connector', 'bend', 'connector:1'], 'the connector commands are');
    await usage(['diagram', 'add'], 'give the Mermaid text after --');
    await usage(['diagram', 'add', '--near', 'a', '--at', '1,2', '--', 'flowchart TD'], 'give --at or --near, not both');
    await usage(['diagram', 'export', '--to', 'web'], '--to is only for `diagram add`');
    await usage(['diagram', 'draw'], 'the diagram commands are');
  });

  it('draws a class diagram, reads it back in the tree, by ref and in the zone map, changes it and removes it, as the user', async () => {
    const daemon = await startTestDaemon({ worktreesDir: tempDataDir() });
    const client = await connectTestClient(daemon);
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath };
    const zone = await client.call('zone.add', { path: tempRepo('shop'), x: 0, y: 0, width: 1400, height: 800, name: 'shop' });
    const shapeIn = async (text: string) => (await client.call('item.list')).find((item) => item.kind === 'shape' && item.data.text === text)!;

    expect(await run(env, 'shape', 'add', 'class', 'Order', '--to', 'shop', '--attribute', '+ id: UUID', '--attribute', '+ placed: Date', '--method', '+ total(): Money')).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^Added item:\S+ {2}shape class {2}"Order" {2}\(2 attributes, 1 method\) \(in zone:\S+ shop\) at \d+,\d+\.\n$/),
    });
    const order = await shapeIn('Order');
    expect(order).toMatchObject({ zoneId: zone.id, data: { shape: 'class', attributes: '+ id: UUID\n+ placed: Date', methods: '+ total(): Money' } });
    expect(await run(env, 'shape', 'add', 'class', '--near', ref('item', order.id), '--side', 'right', '--', 'LineItem')).toMatchObject({ code: 0 });
    const line = await shapeIn('LineItem');
    expect(line.x).toBeGreaterThan(order.x + order.width);
    expect(await run(env, 'shape', 'add', 'rectangle', 'Cart', '--to', 'shop', '--method', 'x')).toMatchObject({ code: 1, err: expect.stringContaining('a rectangle has no methods') });

    const joined = await run(env, 'connect', ref('item', order.id), ref('item', line.id), '--relation', 'composition', '--from-label', '1', '--to-label', '1..*', '--label', 'holds');
    expect(joined).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^Connected connector:\S+ {2}item:\S+ "Order" → item:\S+ "LineItem" {2}composition {2}\(label "holds", from "1", to "1\.\.\*"\)\.\n$/),
    });
    const [connector] = await client.call('connector.list');
    // Side by side, they are joined right to left, a filled diamond by the whole.
    expect(connector).toMatchObject({ from: { id: order.id, side: 'right' }, to: { id: line.id, side: 'left' }, startEnd: 'filled-diamond', endEnd: 'none', startLabel: '1', endLabel: '1..*' });

    const tree = await run(env, 'tree');
    expect(tree.out).toContain(`${ref('connector', connector!.id)}  ${ref('item', order.id)} "Order" → ${ref('item', line.id)} "LineItem"  composition`);
    expect(JSON.parse((await run(env, 'tree', '--json')).out).zones[0]).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ kind: 'shape', shape: 'class', text: 'Order', attributes: ['+ id: UUID', '+ placed: Date'], methods: ['+ total(): Money'] })]),
      connectors: [expect.objectContaining({ relation: 'composition', startLabel: '1', endLabel: '1..*', label: 'holds' })],
    });
    const shown = await run(env, 'show', ref('item', order.id));
    expect(shown.out).toContain('shape class');
    expect(shown.out).toMatch(/ {2}Order\n {2}── attributes\n {2}\+ id: UUID\n {2}\+ placed: Date\n {2}── methods\n {2}\+ total\(\): Money\n {2}connectors\n {4}connector:/);
    const connectorShown = await run(env, 'show', ref('connector', connector!.id));
    expect(connectorShown.out).toMatch(/relation {3}composition\n.*label {6}holds\n {2}from label 1\n {2}to label {3}1\.\.\*/s);
    const map = await run(env, 'zone', 'map', 'shop');
    expect(map.out).toMatch(/\ndiagram {2}\(2 shapes, 1 connector; members with --sections[^\n]*\n {2}item:\S+ {2}shape class {2}"Order" {2}\(2 attributes, 1 method\)\n {2}item:\S+ {2}shape class {2}"LineItem"[^\n]*\n {2}connector:\S+ /);
    expect((await run(env, 'zone', 'map', 'shop', '--sections')).out).toMatch(
      /\n {2}item:\S+ {2}shape class {2}"Order"[^\n]*\n {4}── attributes\n {4}\+ id: UUID\n {4}\+ placed: Date\n {4}── methods\n {4}\+ total\(\): Money\n {2}item:\S+ {2}shape class {2}"LineItem"[^\n]*\n {4}── attributes\n {4}\(none\)\n/,
    );

    expect(await run(env, 'shape', 'edit', ref('item', line.id), '--attribute', 'qty: int')).toMatchObject({ code: 0, out: expect.stringContaining('(1 attribute, 0 methods)') });
    expect(await run(env, 'connector', 'edit', ref('connector', connector!.id), '--relation', 'aggregation', '--label', '')).toMatchObject({ code: 0, out: expect.stringContaining('aggregation  (from "1", to "1..*")') });
    expect(await run(env, 'shape', 'edit', ref('item', line.id), '--kind', 'rectangle')).toMatchObject({ code: 0 });
    expect((await shapeIn('LineItem')).data).toMatchObject({ shape: 'rectangle', attributes: '' });
    expect(await run(env, 'connector', 'remove', ref('connector', connector!.id))).toMatchObject({ code: 0 });
    expect(await client.call('connector.list')).toEqual([]);
    expect(await run(env, 'shape', 'remove', ref('item', order.id))).toMatchObject({ code: 0 });
    expect(await run(env, 'note', 'remove', ref('item', line.id))).toMatchObject({ code: 1, err: expect.stringContaining('the note commands change only notes') });
    expect((await run(env, 'activity')).out).toMatch(/you {2}remove-shape shape “Order”.*you {2}remove-connector .*you {2}connect shape “Order” → shape “LineItem”.*you {2}add-shape /s);
  });

  it('draws a Mermaid flowchart from a file, and exports a zone of it as Mermaid', async () => {
    const daemon = await startTestDaemon({ worktreesDir: tempDataDir() });
    const client = await connectTestClient(daemon);
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath };
    await client.call('zone.add', { path: tempRepo('flow'), x: 0, y: 0, width: 1400, height: 800, name: 'flow' });
    const file = join(tempDataDir(), 'flow.mmd');
    writeFileSync(file, 'flowchart LR\r\n  a([Start]) -->|go| b{Ok?}\r\n  b -.-> c[(Store)]\r\n');

    expect(await run(env, 'diagram', 'add', '--file', file, '--to', 'flow')).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^Drew 3 shapes and 2 connectors \(in zone:\S+ flow\):\n {2}item:\S+ {2}shape terminator {2}"Start"\n/),
    });
    expect(await run(env, 'diagram', 'export', 'flow')).toMatchObject({
      code: 0,
      out: 'flowchart LR\n  n1(["Start"])\n  n2{"Ok?"}\n  n3[("Store")]\n  n1 -->|"go"| n2\n  n2 -.-> n3\n',
    });
    expect(await run(env, 'diagram', 'export')).toMatchObject({ code: 1, err: expect.stringContaining('give the zone, or the shapes, to export') });
    expect(await run(env, 'diagram', 'add', '--', 'not a diagram')).toMatchObject({ code: 1, err: expect.stringContaining('not a Mermaid flowchart or class diagram') });
  });

  it('keeps a big diagram short in the zone map, and out of what arrange prints', async () => {
    const daemon = await startTestDaemon({ worktreesDir: tempDataDir() });
    const client = await connectTestClient(daemon);
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath };
    const zone = await client.call('zone.add', { path: tempRepo('big'), x: 0, y: 0, width: 4000, height: 4000, name: 'big' });
    const members = (what: string) => Array.from({ length: 30 }, (_, n) => `+ ${what}${n}: ${'x'.repeat(300)}`).join('\n');
    const shapes = [];
    for (let n = 0; n < 60; n++) {
      const data = { ...newShapeData('class'), text: `Class${n} ${'y'.repeat(200)}`, attributes: members('field'), methods: members('call') };
      shapes.push(await client.call('item.create', { kind: 'shape', zoneId: zone.id, x: (n % 10) * 300, y: Math.floor(n / 10) * 400, width: 200, height: 300, data }));
    }
    for (let n = 1; n < 60; n++) await client.call('connector.create', { from: { type: 'item', id: shapes[n]!.id, side: 'left' }, to: { type: 'item', id: shapes[n - 1]!.id, side: 'right' } });

    const map = (await run(env, 'zone', 'map', 'big')).out;
    const diagram = map.slice(map.indexOf('\ndiagram'));
    expect(diagram).toContain('(60 shapes, 59 connectors;');
    expect(diagram.split('\n').length).toBeLessThan(45);
    // Cut short, shapes and connectors share the lines: half the relations still show.
    expect(diagram.match(/^ {2}item:/gm)).toHaveLength(20);
    expect(diagram.match(/^ {2}connector:/gm)).toHaveLength(20);
    expect(diagram).toContain('… and 40 more shapes and 39 more connectors: `agent-board tree --json` lists them all');
    expect(Math.max(...diagram.split('\n').map((line) => line.length))).toBeLessThan(200);
    const withSections = (await run(env, 'zone', 'map', 'big', '--sections')).out;
    const sections = withSections.slice(withSections.indexOf('\ndiagram'));
    expect(sections.split('\n').length).toBeLessThan(210);
    expect(sections).toContain('… and 18 more');
    expect(Math.max(...sections.split('\n').map((line) => line.length))).toBeLessThan(200);
    expect((await run(env, 'arrange', 'big')).out).not.toContain('diagram');
  });
});

describe('schedules from the command line', () => {
  it('checks the schedule commands’ arguments before it connects', async () => {
    const usage = async (args: string[], message: string) =>
      expect(await run({}, 'schedule', ...args)).toMatchObject({ code: 2, err: expect.stringContaining(message) });
    await usage(['add'], "give the schedule's cron expression");
    await usage(['add', '61 * * * *', '--to', 'a', '--', 'Go'], 'bad minute field');
    await usage(['add', '@daily', '--to', 'a'], 'give the schedule its prompt');
    await usage(['add', '@daily', '--', 'Go'], 'give --to <agent> to message one, or --fresh');
    await usage(['add', '@daily', '--to', 'a', '--fresh', '--', 'Go'], 'give --to <agent> to message one, or --fresh');
    await usage(['add', '@daily', '--to', 'a', '--role', 'x', '--', 'Go'], '--role is only for --fresh');
    await usage(['add', '@daily', '--fresh', '--result', 'email', '--', 'Go'], '--result must be history, note, handoff');
    await usage(['add', '@daily', '--fresh', '--result', 'handoff', '--', 'Go'], '--result handoff goes with --handoff-to');
    await usage(['list', '--to', 'a'], '--to is only for `schedule add`');
    await usage(['remove'], 'give one schedule ref');
    await usage(['pause', 'item:1'], 'the schedule commands are');
  });

  it('adds a clock that messages an agent beside its tile and one that starts fresh agents, lists them and removes them, as the user', async () => {
    const { env, client, fixTests, web } = await board();

    const message = await run(env, 'schedule', 'add', '0 9 * * 1-5', '--to', 'fix-tests', '--', 'Check the nightly build');
    expect(message).toMatchObject({ code: 0, out: expect.stringMatching(/^Added item:\S+ {2}Weekdays 09:00 \(0 9 \* \* 1-5\) {2}messages agent:\S+ fix-tests {2}next \S+/) });
    expect((await client.call('agent.list')).find((agent) => agent.sessionId === fixTests.sessionId)!.schedule).toMatchObject({ cron: '0 9 * * 1-5', prompt: 'Check the nightly build' });
    const fresh = await run(env, 'schedule', 'add', '@daily', '--fresh', '--zone', 'web', '--role', 'reviewer', '--keep', '--json', '--', 'Sweep the logs');
    expect(fresh.code).toBe(0);
    const { item } = JSON.parse(fresh.out) as { item: { id: string; zoneId: string; data: unknown } };
    expect(item).toMatchObject({ zoneId: web.id, data: { does: 'fresh', agent: null, fresh: { role: 'reviewer', closeWhenDone: false }, result: 'history' } });

    const listed = await run(env, 'schedule', 'list');
    expect(listed.out).toContain('messages agent:');
    expect(listed.out).toMatch(/Daily 00:00 \(@daily\) {2}starts a fresh reviewer {2}next /);
    expect(listed.out).toContain('"Sweep the logs"');

    expect(await run(env, 'schedule', 'remove', ref('item', item.id))).toMatchObject({ code: 0, out: expect.stringContaining('Removed item:') });
    expect(await run(env, 'schedule', 'remove', 'fix-tests')).toMatchObject({ code: 1, err: expect.stringContaining('is not a schedule') });
    expect((await client.call('item.list')).filter((each) => each.kind === 'clock')).toHaveLength(1);
    expect((await run(env, 'activity')).out).toMatch(/you {2}remove-clock clock Daily 00:00.*you {2}add-clock clock Daily 00:00.*you {2}add-clock clock Weekdays 09:00/s);
  });
});

describe('the app’s default roles from the command line', () => {
  it('checks the roles commands’ arguments before it connects', async () => {
    const usage = async (args: string[], message: string) =>
      expect(await run({}, 'roles', ...args)).toMatchObject({ code: 2, err: expect.stringContaining(message) });
    await usage(['list', 'extra'], 'unexpected extra');
    await usage(['set'], 'give the role’s name and its template');
    await usage(['set', 'designer'], 'give the role’s name and its template');
    await usage(['remove'], 'give one role name');
    await usage(['rename', 'x'], 'the roles commands are `roles list`, `roles set` and `roles remove`');
    await usage(['remove', 'designer', '--file', 'x'], '--file is only for `roles set`');
    await usage(['list', '--zone', 'zone:1'], '--zone is only for `roles set` and `roles remove`');
  });

  it('lists, sets and removes them, and an agent started in one there starts with its template', async () => {
    const { client, web, env } = await board();

    expect((await run(env, 'roles')).out).toContain('The app has no default roles');
    expect(await run(env, 'roles', 'set', 'release prep', '--', 'Prep the release.\nThen tag it.')).toMatchObject({
      code: 0,
      out: expect.stringContaining('Set the default role release prep'),
    });
    expect((await run(env, 'roles', 'list')).out).toBe('release prep  Prep the release.\n');
    expect(JSON.parse((await run(env, 'roles', '--json')).out)).toMatchObject([{ name: 'release prep', body: 'Prep the release.\nThen tag it.' }]);

    const started = await run(env, 'new', '--zone', ref('zone', web.id), '--role', 'release prep', '--name', 'prep', '--', 'Go');
    expect(started.out).toMatch(/prep {2}\[\S+\] {2}\(release prep\)/);
    expect((await client.call('zone.roleTemplates', { id: web.id })).find((each) => each.role === 'release prep')).toMatchObject({ appDefault: true });

    expect(await run(env, 'roles', 'set', 'qa', '--zone', ref('zone', web.id), '--', 'Test {{branch}}.')).toMatchObject({
      code: 0,
      out: expect.stringContaining("Set web's template for qa"),
    });
    expect((await client.call('zone.roleTemplates', { id: web.id })).find((each) => each.role === 'qa')).toMatchObject({ body: 'Test {{branch}}.' });
    expect(await run(env, 'roles', 'set', 'qa', '--', '!rm -rf ~')).toMatchObject({ code: 1, err: expect.stringContaining('may not start an agent') });

    expect((await run(env, 'roles', 'remove', 'release prep')).out).toContain('Removed the default role release prep');
    expect(await run(env, 'roles', 'remove', 'release prep')).toMatchObject({ code: 1, err: expect.stringContaining('no default role release prep') });
  });
});
