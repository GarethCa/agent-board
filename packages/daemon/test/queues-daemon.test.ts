import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { daemonPaths } from '../src/paths.ts';
import { BOARD_ERROR, type Agent, type AgentUpdatedEvent, type BoardItem, type DaemonEvent, type QueueData, QUEUE_LATER } from '../src/protocol.ts';
import { overlaps } from '../src/board-layout.ts';
import { connectTestClient, onCheckout, recordEvents, startTestDaemon, tempDataDir, tempRepo, TEST_CLI_LAUNCHER, tileOf } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents run the fake `ask-plan` scenario: `Queue: <title>` puts one up, `Print your board identity` only prints the agent's token. */
async function boardDaemon() {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'ask-plan', home: tempDataDir() }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'storefront' });
  const idle = async (sessionId: string) => {
    const matching = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && e.agent.state === 'idle';
    await recorder.waitFor(matching);
  };
  /** Starts an agent with `prompt`, waits for its turn to end, and gives its board token and a connection as it. */
  const start = async (prompt: string, zoneId = zone.id, name = 'Impl') => {
    const agent = await client.call('agent.spawn', { zoneId, harness: 'claude', prompt, name, ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    await idle(agent.sessionId);
    await recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    const connection = await connectTestClient(daemon);
    await connection.call('board.identify', { token });
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: token };
    return { agent, token, connection, env };
  };
  const cardOf = async (kind: 'queue', agent: Agent): Promise<BoardItem> => {
    const found = (await client.call('item.list')).find((item) => item.kind === kind && (item.data as unknown as QueueData).madeBy.kind === 'agent' && JSON.stringify(item.data).includes(agent.sessionId));
    if (found === undefined) throw new Error(`no ${kind} of ${agent.name}`);
    return found;
  };
  return { daemon, dataDir, client, recorder, zone, start, cardOf };
}

/** Runs `agent-board <command> <args>` with `env`: what it printed and its exit code. */
async function cli(env: NodeJS.ProcessEnv, command: string, ...args: string[]) {
  let out = '';
  let err = '';
  const code = await runBoardCommand(command, args, { out: (text) => (out += text), err: (text) => (err += text), env });
  return { code, out, err };
}

describe('queues', () => {
  it('queues jobs and notes that agents take, drop back with a count, and finish', async () => {
    const { client, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    expect(card.data).toMatchObject({ title: 'Backlog', audience: 'agents', count: 0 });

    const added = await cli(lead.env, 'queue', 'add', 'Backlog', '--', '- Fix the login -> https://example.test/1', 'Write the docs');
    expect(added.out).toContain('Queued 2 tasks on “Backlog”');
    await cli(lead.env, 'queue', 'add', 'Backlog', '--kind', 'note', 'Ask before touching billing');
    await cli(lead.env, 'queue', 'add', 'Backlog', '--front', 'Hotfix first');

    const impl = await start('Queue: Mine', undefined, 'Impl');
    const take = (job?: string) => impl.connection.call('board.changeQueue', { token: impl.token, id: card.id, change: { action: 'take', ...(job === undefined ? {} : { job }) } });
    const { job: first } = await take();
    expect(first).toMatchObject({ text: 'Hotfix first', state: 'taken', takenBy: { kind: 'agent', sessionId: impl.agent.sessionId } });

    // Another agent can't take, finish or drop it while it is held.
    const ref = first!.id.slice(0, 6);
    await expect(lead.connection.call('board.changeQueue', { token: lead.token, id: card.id, change: { action: 'take', job: ref } })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    expect((await cli(lead.env, 'queue', 'done', 'Backlog', ref)).err).toContain('Impl has job');

    // Dropped, it goes back to the front, counted.
    expect((await cli(impl.env, 'queue', 'drop', 'Backlog', ref)).out).toContain('back at the front');
    const { job: again } = await take();
    expect(again).toMatchObject({ id: first!.id, drops: 1 });
    // Done, it says what is left and what comes next, notes aside.
    expect((await cli(impl.env, 'queue', 'done', 'Backlog', ref)).out).toContain('2 jobs waiting; next: “Fix the login”');

    const { job: next } = await take();
    expect(next).toMatchObject({ text: 'Fix the login', link: 'https://example.test/1' });
    const read = await cli(impl.env, 'queue', 'read', 'Backlog');
    expect(read.out).toContain('“Backlog”  3 open');
    expect(read.out).toContain('taken by');
    expect(read.out).toContain('info  to read, not to take');
    expect(read.out).toContain('1 job done: `agent-board queue read item:');
    expect((await cli(impl.env, 'queue', 'read', 'Backlog', '--done')).out).toContain('dropped once');

    // A note is never taken.
    const note = (await client.call('queue.read', { id: card.id })).jobs.find((job) => job.kind === 'info')!;
    await expect(take(note.id)).rejects.toThrow(/is info/);

    // Its taker's session ends mid-job: the job goes back to the front, counted again.
    await client.call('agent.stop', { sessionId: impl.agent.sessionId });
    await expect
      .poll(async () => (await client.call('queue.read', { id: card.id })).jobs.find((job) => job.id === next!.id))
      .toMatchObject({ state: 'queued', drops: 1, takenBy: null });
    const order = (await client.call('queue.read', { id: card.id })).jobs.filter((job) => job.state === 'queued').map((job) => job.text);
    expect(order[0]).toBe('Fix the login');
    // An agent reorders them: last, before another, then back to the top.
    const queued = async () => (await client.call('queue.read', { id: card.id })).jobs.filter((job) => job.state === 'queued').map((job) => job.text);
    const moving = next!.id.slice(0, 8);
    expect((await cli(lead.env, 'queue', 'move', 'Backlog', moving, 'last')).out).toContain('to the end of “Backlog”');
    expect((await queued()).at(-1)).toBe('Fix the login');
    const front = (await client.call('queue.read', { id: card.id })).jobs.find((job) => job.state === 'queued')!;
    expect((await cli(lead.env, 'queue', 'move', 'Backlog', moving, 'top')).out).toContain('to the top of');
    expect((await queued())[0]).toBe('Fix the login');
    await cli(lead.env, 'queue', 'move', 'Backlog', front.id.slice(0, 8), moving);
    expect((await queued()).slice(0, 2)).toEqual([front.text, 'Fix the login']);
    expect((await cli(lead.env, 'queue', 'move', 'Backlog', moving)).err).toContain('give the queue, the job, and where');
  });

  it('counts down the waiting jobs to none, and says how to make a queue when there is none to read', async () => {
    const { client, start } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    await cli(lead.env, 'queue', 'add', 'Backlog', 'First job');
    await cli(lead.env, 'queue', 'add', 'Backlog', 'Last job');
    const doneNext = async () => {
      const job = (await cli(lead.env, 'queue', 'take', 'Backlog')).out.match(/You have job #?(\w+)/)![1]!;
      return (await cli(lead.env, 'queue', 'done', 'Backlog', job)).out;
    };
    expect(await doneNext()).toMatch(/1 job waiting; next: “Last job” \(#\w{8}\)\./);
    expect(await doneNext()).toContain('No job waiting.');

    const billing = await client.call('zone.add', { path: tempRepo('billing'), x: 4000, y: 0, name: 'billing' });
    const impl = await start('Print your board identity', billing.id, 'Impl');
    expect((await cli(impl.env, 'queue', 'ls')).out).toMatch(/^No queues you can read\. `agent-board queue new "<title>"` puts one beside your tile/);
    // Over the MCP, the same answers name the tool and its argument.
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, ...impl.env } }, tempDataDir());
    expect((await mcp.callTool('queue_read', {})).text).toMatch(/^No queues you can read\. `queue_new` with `title` puts one beside your tile/);
    expect((await mcp.callTool('queue_new', { title: 'Ideas' })).text).toMatch(/^Put .* beside your tile\. `queue_update` with `action: "add"` queues a job\.$/);
  });

  it('keeps a job through a pause, and puts it back once its taker is deleted with no exit to come', async () => {
    const { client, recorder, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'One', 'Two');
    const impl = await start('Print your board identity', undefined, 'Impl');
    const take = () => impl.connection.call('board.changeQueue', { token: impl.token, id: card.id, change: { action: 'take' } });
    const jobOf = async (id: string) => (await client.call('queue.read', { id: card.id })).jobs.find((job) => job.id === id)!;
    const paused = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === impl.agent.sessionId && e.agent.state === 'hibernated';

    // Paused, it keeps its job, and has it still once woken.
    const { job: one } = await take();
    await client.call('agent.pause', { sessionId: impl.agent.sessionId });
    await recorder.waitFor(paused);
    expect(await jobOf(one!.id)).toMatchObject({ state: 'taken', drops: 0 });
    await client.call('agent.resume', { sessionId: impl.agent.sessionId });
    await recorder.waitFor((e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === impl.agent.sessionId && e.agent.endedAt === null && e.agent.hibernated === null);
    expect(await jobOf(one!.id)).toMatchObject({ state: 'taken', takenBy: { kind: 'agent', sessionId: impl.agent.sessionId } });
    await client.call('queue.change', { id: card.id, change: { action: 'done', job: one!.id } });

    // Paused with a job, then deleted: the job goes back to the front, counted.
    const other = await start('Print your board identity', undefined, 'Other');
    const { job: two } = await other.connection.call('board.changeQueue', { token: other.token, id: card.id, change: { action: 'take' } });
    await client.call('agent.pause', { sessionId: other.agent.sessionId });
    await expect.poll(async () => (await client.call('agent.list')).find((agent) => agent.sessionId === other.agent.sessionId)?.hibernated ?? null).not.toBeNull();
    await client.call('agent.delete', { sessionId: other.agent.sessionId, force: true });
    await expect.poll(() => jobOf(two!.id)).toMatchObject({ state: 'queued', drops: 1, takenBy: null });
    // The drop is credited to the agent that held it, for the card to say so.
    expect(await jobOf(two!.id)).toMatchObject({ changedBy: { kind: 'agent', name: 'Other' }, lastChange: 'drop' });
    // Removed and put back from its history, it keeps its drops: it is still on its 2nd try.
    await client.call('queue.change', { id: card.id, change: { action: 'remove', job: two!.id } });
    const kept = (await client.call('queue.history', { id: card.id, job: two!.id })).find((version) => version.value !== null)!;
    const { job: back } = await client.call('queue.change', { id: card.id, change: { action: 'restore', job: two!.id, version: kept.version } });
    expect(back).toMatchObject({ drops: 1, changedBy: { kind: 'user' }, lastChange: 'restore' });
    const { job: taken } = await lead.connection.call('board.changeQueue', { token: lead.token, id: card.id, change: { action: 'take' } });
    expect(taken).toMatchObject({ id: two!.id, changedBy: { kind: 'agent', name: 'Lead' }, lastChange: 'take' });
    // The user's queue takes no job from agents: a queue one is held from stays theirs.
    await expect(client.call('item.update', { id: card.id, data: { audience: 'user' } })).rejects.toThrow(/an agent holds a job from this queue/);
  });

  it('puts back, as the daemon starts, a job whose taker is no longer on the board', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const client = await connectTestClient(first);
    const card = await client.call('item.create', {
      kind: 'queue',
      zoneId: null,
      x: 0,
      y: 0,
      width: 300,
      height: 160,
      data: { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 },
    });
    const { job } = await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Orphaned' } });
    await first.stop();
    // Taken by an agent the board no longer has: deleted while the daemon was away.
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    db.prepare('UPDATE queue_jobs SET taken_by = ?, taken_at = ? WHERE id = ?').run(JSON.stringify({ kind: 'agent', sessionId: 'gone-agent', name: 'Gone' }), new Date().toISOString(), job!.id);
    db.close();

    const second = await startTestDaemon({ dataDir });
    const again = await connectTestClient(second);
    await expect.poll(async () => (await again.call('queue.read', { id: card.id })).jobs[0]).toMatchObject({ state: 'queued', drops: 1, takenBy: null });
  });

  it("keeps the user's queue for the user: agents add to it, and none takes from it", async () => {
    const { client, start } = await boardDaemon();
    const { env, token, connection } = await start('Print your board identity');
    const made = await cli(env, 'queue', 'new', '--for-user', 'To look at');
    expect(made.out).toContain('for the user');
    const card = (await client.call('item.list')).find((item) => item.kind === 'queue')!;
    expect((card.data as unknown as QueueData).audience).toBe('user');
    await cli(env, 'queue', 'add', 'To look at', 'PR #12 is ready -> https://example.test/pr/12');
    await expect(connection.call('board.changeQueue', { token, id: card.id, change: { action: 'take' } })).rejects.toThrow(/the user's queue/);
    const { jobs } = await client.call('queue.read', { id: card.id });
    await client.call('queue.change', { id: card.id, change: { action: 'done', job: jobs[0]!.id } });
    await expect(client.call('queue.change', { id: card.id, change: { action: 'take' } })).rejects.toThrow(/the user takes no job/);
    // The user's own methods are not the agent's.
    await expect(connection.call('queue.change', { id: card.id, change: { action: 'remove', job: jobs[0]!.id } })).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });
});

describe('kinds of queue row', () => {
  it("gives an agents' queue tasks, requests, prompts and info, and the user's backlog, reviews, questions and things to read", async () => {
    const { client, start } = await boardDaemon();
    const { env } = await start('Queue: Backlog');
    await cli(env, 'queue', 'new', '--for-user', 'To look at');
    const cards = (await client.call('item.list')).filter((item) => item.kind === 'queue');
    const work = cards.find((item) => (item.data as unknown as QueueData).audience === 'agents')!;
    const mine = cards.find((item) => (item.data as unknown as QueueData).audience === 'user')!;
    const kinds = async (id: string) => (await client.call('queue.read', { id })).jobs.map((job) => [job.kind, job.text]);

    // No kind is the queue's own: a task, or backlog on the user's. job and note still work.
    await cli(env, 'queue', 'add', 'Backlog', 'Fix the login');
    await cli(env, 'queue', 'add', 'Backlog', '--kind', 'request', 'Look over the schema');
    await cli(env, 'queue', 'add', 'Backlog', '--kind', 'prompt', 'Run the release checklist');
    await cli(env, 'queue', 'add', 'Backlog', '--kind', 'note', 'Staging is down');
    await cli(env, 'queue', 'add', 'Backlog', '--kind', 'job', 'Write the docs');
    expect(await kinds(work.id)).toEqual([
      ['task', 'Fix the login'],
      ['request', 'Look over the schema'],
      ['prompt', 'Run the release checklist'],
      ['info', 'Staging is down'],
      ['task', 'Write the docs'],
    ]);
    await cli(env, 'queue', 'add', 'To look at', 'Pick a name');
    await cli(env, 'queue', 'add', 'To look at', '--kind', 'review', 'PR #12 -> https://example.test/pr/12');
    expect((await cli(env, 'queue', 'add', 'To look at', '--kind', 'note', 'Load-test findings')).out).toContain('Queued 1 thing to read on “To look at”');
    expect(await kinds(mine.id)).toEqual([
      ['backlog', 'Pick a name'],
      ['review', 'PR #12'],
      ['read', 'Load-test findings'],
    ]);
    // Each queue takes its own kinds.
    const wrong = await cli(env, 'queue', 'add', 'Backlog', '--kind', 'review', 'Look at this');
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain('kind must be one of task, request, prompt, info');
    await expect(client.call('queue.change', { id: mine.id, change: { action: 'add', kind: 'task', text: 'Do it' } })).rejects.toThrow(/review, questions, backlog, read on the user's queue/);
    expect((await cli(env, 'queue', 'add', 'Backlog', '--kind', 'chore', 'x')).err).toContain('kind is one of');
  });

  it('takes a headline with a body as one job, and keeps what its finisher says as it is done', async () => {
    const { client, start, cardOf } = await boardDaemon();
    const { agent, env } = await start('Queue: Backlog');
    const card = await cardOf('queue', agent);
    const added = await cli(env, 'queue', 'add', 'Backlog', '--body', 'The token expires early.\n\nSee the logs.', 'Fix the login');
    expect(added.code).toBe(0);
    const [job] = (await client.call('queue.read', { id: card.id })).jobs;
    expect(job).toMatchObject({ kind: 'task', text: 'Fix the login\n\nThe token expires early.\n\nSee the logs.' });
    expect((await cli(env, 'queue', 'add', 'Backlog', '--body', 'x', 'one\ntwo')).err).toContain('give one headline');
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, ...env } }, tempDataDir());
    expect(await mcp.callTool('queue_update', { queue: 'Backlog', action: 'add', headline: 'one\ntwo', body: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('give one headline') });
    const long = 'x'.repeat(81);
    expect((await cli(env, 'queue', 'add', 'Backlog', '--body', 'x', long)).err).toContain('a headline is one line of 1 to 80 characters');
    await expect(client.call('queue.change', { id: card.id, change: { action: 'add', text: 'a', headline: 'b' } })).rejects.toThrow(/not both/);
    await expect(client.call('queue.change', { id: card.id, change: { action: 'add', body: 'b' } })).rejects.toThrow(/a body goes with a headline/);

    // Taken, the job comes back whole; done, its result stays with it, and `read` shows it.
    expect((await cli(env, 'queue', 'take', 'Backlog')).out).toContain('See the logs.');
    const done = await cli(env, 'queue', 'done', 'Backlog', job!.id.slice(0, 8), '--result', 'Moved the expiry to 1h; PR #40.');
    expect(done.code).toBe(0);
    expect((await client.call('queue.read', { id: card.id })).jobs[0]).toMatchObject({ state: 'done', result: 'Moved the expiry to 1h; PR #40.' });
    expect((await cli(env, 'queue', 'read', 'Backlog', '--done')).out).toContain('result: Moved the expiry to 1h; PR #40.');
    expect((await cli(env, 'queue', 'take', 'Backlog', '--result', 'x')).err).toContain('--result is not for `queue take`');
    await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Two' } });
    const two = (await client.call('queue.read', { id: card.id })).jobs.find((each) => each.text === 'Two')!;
    await expect(client.call('queue.change', { id: card.id, change: { action: 'done', job: two.id, result: 'y'.repeat(2_001) } })).rejects.toThrow(/at most 2000 characters/);
  });

  it('reads open jobs as their headlines and done jobs as a count, one job whole, and the done ones on request', async () => {
    const { start } = await boardDaemon();
    const { env } = await start('Queue: Backlog');
    await cli(env, 'queue', 'add', 'Backlog', '--body', 'The token expires early.\n\nSee the logs.', 'Fix the login -> https://example.test/1');
    await cli(env, 'queue', 'add', 'Backlog', 'Write the docs');
    const taken = (await cli(env, 'queue', 'take', 'Backlog')).out.match(/You have job #?(\w+)/)![1]!;
    await cli(env, 'queue', 'done', 'Backlog', taken, '--result', 'Moved the expiry to 1h.');
    await cli(env, 'queue', 'add', 'Backlog', '--body', 'All of chapter two.', 'Proofread the guide');

    const read = (await cli(env, 'queue', 'read', 'Backlog')).out;
    expect(read).toContain('Write the docs\n');
    expect(read).toContain('Proofread the guide  [more]');
    expect(read).not.toContain('All of chapter two.');
    expect(read).not.toContain('Fix the login');
    expect(read).not.toContain('Moved the expiry');
    expect(read).toMatch(/`agent-board queue read item:\w+ <job>` shows one whole\./);
    expect(read).toMatch(/1 job done: `agent-board queue read item:\w+ --done` lists them\./);

    const proofread = /#(\w{8}) {2}task {2}queued\n {5}Proofread/.exec(read)![1]!;
    const whole = (await cli(env, 'queue', 'read', 'Backlog', proofread)).out;
    expect(whole).toContain('Proofread the guide\n     \n     All of chapter two.');
    expect(whole).toMatch(/^From “Backlog” \(item:\w+\):\n {2}2\. #/);
    const done = (await cli(env, 'queue', 'read', 'Backlog', '--done')).out;
    expect(done).toMatch(/^Done on “Backlog” \(item:\w+\), newest first:\n {2}✓ #\w{8} {2}task {2}done by /);
    expect(done).toContain('Fix the login  [more]\n     -> https://example.test/1\n     result: Moved the expiry to 1h.');
    expect(done).not.toContain('See the logs.');
    expect(done).toMatch(/`agent-board queue read item:\w+ <job>` shows one whole\.\n$/);
    expect((await cli(env, 'queue', 'read', 'Backlog', taken)).out).toContain('See the logs.');
    expect((await cli(env, 'queue', 'read', 'Backlog', 'ffffffff')).err).toContain('“Backlog” has no job ffffffff');
    expect((await cli(env, 'queue', 'read', 'Backlog', taken, '--done')).err).toContain('give a job or --done, not both');

    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env: { ...process.env, ...env } }, tempDataDir());
    // The MCP's hints name the tool and its argument, where the CLI's name the command.
    const named = (text: string) =>
      text
        .trimEnd()
        .replace(/`agent-board queue read item:\w+ <job>`/g, '`queue_read` with `job` and `whole: true`')
        .replace(/`agent-board queue read item:\w+ --done`/, '`queue_read` with `done: true`');
    expect((await mcp.callTool('queue_read', { queue: 'Backlog' })).text).toBe(named(read));
    // Following the hint reads the job whole.
    expect(named(read)).toContain('`queue_read` with `job` and `whole: true` shows one whole.');
    expect((await mcp.callTool('queue_read', { queue: 'Backlog', job: proofread, whole: true })).text).toBe(whole.trimEnd());
    expect((await mcp.callTool('queue_read', { queue: 'Backlog', done: true })).text).toBe(named(done));
    expect((await mcp.callTool('queue_read', { queue: 'Backlog', job: proofread })).text).toContain('History of');
    expect(await mcp.callTool('queue_read', { queue: 'Backlog', whole: true })).toMatchObject({ isError: true, text: expect.stringContaining('whole goes with a job') });
    expect(await mcp.callTool('queue_read', { queue: 'Backlog', done: true, whole: true })).toMatchObject({ isError: true, text: expect.stringContaining('not both') });
    expect(await mcp.callTool('queue_read', { whole: true })).toMatchObject({ isError: true, text: expect.stringContaining('give `queue`') });
    expect((await mcp.callTool('queue_read', { queue: 'nope' })).text).toContain('nothing on the board is called "nope". `board` with `zone: "all"` lists what is.');
  });

  it("lets the user put off or skip a row of their own queue, and no one else's", async () => {
    const { client, start } = await boardDaemon();
    const { env, token, connection } = await start('Queue: Backlog');
    await cli(env, 'queue', 'new', '--for-user', 'To look at');
    const cards = (await client.call('item.list')).filter((item) => item.kind === 'queue');
    const work = cards.find((item) => (item.data as unknown as QueueData).audience === 'agents')!;
    const mine = cards.find((item) => (item.data as unknown as QueueData).audience === 'user')!;
    for (const text of ['One', 'Two', 'Three']) await cli(env, 'queue', 'add', 'To look at', text);
    const rows = async () => (await client.call('queue.read', { id: mine.id })).jobs;
    const idOf = async (text: string) => (await rows()).find((job) => job.text === text)!.id;

    // Skipped, a row goes behind the next open one; the last stays where it is.
    await client.call('queue.change', { id: mine.id, change: { action: 'skip', job: await idOf('One') } });
    expect((await rows()).map((job) => job.text)).toEqual(['Two', 'One', 'Three']);
    await client.call('queue.change', { id: mine.id, change: { action: 'skip', job: await idOf('Three') } });
    expect((await rows()).map((job) => job.text)).toEqual(['Two', 'One', 'Three']);

    // Put off, it says until when; null shows it again.
    await client.call('queue.change', { id: mine.id, change: { action: 'later', job: await idOf('Two'), until: '2026-11-13T09:00:00+00:00' } });
    expect((await rows()).find((job) => job.text === 'Two')).toMatchObject({ hiddenUntil: '2026-11-13T09:00:00.000Z', lastChange: 'add' });
    // It makes no version: the row's history holds only its text.
    expect((await client.call('queue.history', { id: mine.id, job: await idOf('Two') })).map((version) => version.action)).toEqual(['add']);
    await expect(client.call('queue.change', { id: mine.id, change: { action: 'later', job: await idOf('Two'), until: 'soon' } })).rejects.toThrow(/until must be a time/);
    await client.call('queue.change', { id: mine.id, change: { action: 'later', job: await idOf('Two'), until: null } });
    expect((await rows()).find((job) => job.text === 'Two')).toMatchObject({ hiddenUntil: null });

    // A skip goes past the rows put off, so the front changes: with Two put off, One skips behind Three.
    await client.call('queue.change', { id: mine.id, change: { action: 'later', job: await idOf('Two'), until: '2099-01-01T00:00:00Z' } });
    await client.call('queue.change', { id: mine.id, change: { action: 'skip', job: await idOf('One') } });
    expect((await rows()).map((job) => job.text)).toEqual(['Two', 'Three', 'One']);
    // A row put off isn't skipped: it is shown again first.
    await expect(client.call('queue.change', { id: mine.id, change: { action: 'skip', job: await idOf('Two') } })).rejects.toThrow(/is put off until .*: show it again to skip it/);
    await client.call('queue.change', { id: mine.id, change: { action: 'later', job: await idOf('Two'), until: null } });

    // Only on the user's queue, only by the user, only an open one.
    await client.call('queue.change', { id: work.id, change: { action: 'add', text: 'Task' } });
    const task = (await client.call('queue.read', { id: work.id })).jobs[0]!;
    await expect(client.call('queue.change', { id: work.id, change: { action: 'skip', job: task.id } })).rejects.toThrow(/is for agents: only the user's queue has skip/);
    await expect(connection.call('board.changeQueue', { token, id: mine.id, change: { action: 'skip', job: await idOf('One') } })).rejects.toThrow(/only the user skips/);
    await client.call('queue.change', { id: mine.id, change: { action: 'done', job: await idOf('One') } });
    await expect(client.call('queue.change', { id: mine.id, change: { action: 'later', job: await idOf('One'), until: null } })).rejects.toThrow(/is done: only an open one is put off/);
  });

  it("marks a waiting job Later on an agents' queue, which no take without a job starts until it is moved up", async () => {
    const { client, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'One', 'Two', 'Three');
    const rows = async () => (await client.call('queue.read', { id: card.id })).jobs;
    const idOf = async (text: string) => (await rows()).find((job) => job.text === text)!.id;
    const ref = async (text: string) => (await idOf(text)).slice(0, 8);

    // The user marks One Later: no time, and no version.
    await client.call('queue.change', { id: card.id, change: { action: 'later', job: await idOf('One') } });
    expect((await rows()).find((job) => job.text === 'One')).toMatchObject({ hiddenUntil: QUEUE_LATER, state: 'queued', lastChange: 'add' });
    expect((await client.call('queue.history', { id: card.id, job: await idOf('One') })).map((version) => version.action)).toEqual(['add']);
    // An agent marks Two Later too, from the command line, and the read says so.
    expect((await cli(lead.env, 'queue', 'later', 'Backlog', await ref('Two'))).out).toContain('Marked');
    const read = (await cli(lead.env, 'queue', 'read', 'Backlog')).out;
    expect(read.match(/ later/g)).toHaveLength(2);

    // take without a job passes them by; named, a Later job is refused until moved up.
    const impl = await start('Queue: Mine', undefined, 'Impl');
    const take = (job?: string) => impl.connection.call('board.changeQueue', { token: impl.token, id: card.id, change: { action: 'take', ...(job === undefined ? {} : { job }) } });
    expect((await take()).job).toMatchObject({ text: 'Three', state: 'taken' });
    await expect(take()).rejects.toThrow(/has no job waiting to be taken/);
    await expect(take(await idOf('One'))).rejects.toThrow(/is marked Later: move it up first/);
    // A taken job isn't put off: it is its taker's until done or dropped.
    expect((await cli(impl.env, 'queue', 'later', 'Backlog', await ref('Three'))).err).toContain('is taken');
    // done tells the finisher nothing waits: the Later jobs aren't waiting.
    expect((await cli(impl.env, 'queue', 'done', 'Backlog', await ref('Three'))).out).toContain('No job waiting.');

    // Moved up (the MCP tool's way, as the CLI's), it is the next taken.
    expect((await cli(impl.env, 'queue', 'up', 'Backlog', await ref('One'))).out).toContain('Moved');
    expect((await rows()).find((job) => job.text === 'One')).toMatchObject({ hiddenUntil: null });
    expect((await take()).job).toMatchObject({ text: 'One' });

    // An agents' queue has no put-off until a time, and no skip.
    await expect(client.call('queue.change', { id: card.id, change: { action: 'later', job: await idOf('Two'), until: '2099-01-01T00:00:00Z' } })).rejects.toThrow(/Later, with no time/);
    // An agent that moves up a job not marked Later, or marks a thing to read, is told so: not that it worked.
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'Four');
    expect((await cli(lead.env, 'queue', 'up', 'Backlog', await ref('Four'))).err).toContain("isn't marked Later");
    await cli(lead.env, 'queue', 'add', 'Backlog', '--kind', 'note', 'Read the style guide');
    expect((await cli(lead.env, 'queue', 'later', 'Backlog', await ref('Read the style guide'))).err).toContain('only a task, a request or a prompt is marked Later');
  });

  it('swaps its rows for the kinds of the queue when it changes hands, so a thing to read is never taken', async () => {
    const { client, zone, start, cardOf } = await boardDaemon();
    const { agent, token, connection } = await start('Queue: Backlog');
    const data = { title: 'To look at', madeBy: { kind: 'user' }, audience: 'user', noAgents: false, count: 0 };
    const mine = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 400, width: 340, height: 244, data });
    const kinds = async (id: string) => (await client.call('queue.read', { id })).jobs.map((job) => [job.kind, job.text, job.state]);
    await client.call('queue.change', { id: mine.id, change: { action: 'add', kind: 'note', text: 'Load-test findings' } });
    await client.call('queue.change', { id: mine.id, change: { action: 'add', kind: 'questions', text: 'Pick a launch date' } });

    // Made the agents', the thing to read is info, which no agent takes and no drain starts an agent for.
    await client.call('item.update', { id: mine.id, data: { audience: 'agents' } });
    expect(await kinds(mine.id)).toEqual([
      ['info', 'Load-test findings', 'queued'],
      ['request', 'Pick a launch date', 'queued'],
    ]);
    await client.call('queue.change', { id: mine.id, change: { action: 'remove', job: (await client.call('queue.read', { id: mine.id })).jobs[1]!.id } });
    await expect(connection.call('board.changeQueue', { token, id: mine.id, change: { action: 'take' } })).rejects.toThrow(/has no job waiting to be taken/);
    await client.call('queue.change', { id: mine.id, change: { action: 'add', text: 'Fix the login' } });
    const live = async () => (await client.call('agent.list')).filter((each) => each.endedAt === null).map((each) => each.name);
    await client.call('item.update', { id: mine.id, data: { drain: { harness: 'claude', model: null, role: null, closeWhenDone: false, most: 3, started: [], on: true } } });
    await expect.poll(live, { timeout: 15_000 }).toContain('Fix the login');
    await expect.poll(async () => ((await client.call('queue.read', { id: mine.id })).item.data as unknown as QueueData).drain?.started.length).toBe(1);
    expect(await live()).not.toContain('Load-test findings');
    expect((await kinds(mine.id))[0]).toEqual(['info', 'Load-test findings', 'queued']);

    // Made the user's, info is a thing to read and a task is backlog, which the user finishes.
    const work = await cardOf('queue', agent);
    await client.call('queue.change', { id: work.id, change: { action: 'add', kind: 'info', text: 'Staging is down' } });
    await client.call('queue.change', { id: work.id, change: { action: 'add', text: 'Write the docs' } });
    await client.call('item.update', { id: work.id, data: { audience: 'user' } });
    expect(await kinds(work.id)).toEqual([
      ['read', 'Staging is down', 'queued'],
      ['backlog', 'Write the docs', 'queued'],
    ]);
    const [read] = (await client.call('queue.read', { id: work.id })).jobs;
    expect((await client.call('queue.change', { id: work.id, change: { action: 'done', job: read!.id } })).job).toMatchObject({ kind: 'read', state: 'done' });
  });
});

describe('handing a job on', () => {
  it("takes a waiting job for an idle agent in scope and types only the user's text; the takers' tiles read it back", async () => {
    const { client, recorder, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'Fix the login -> https://example.test/1', 'Write the docs');
    await cli(lead.env, 'queue', 'add', 'Backlog', '--kind', 'note', 'Ask before touching billing');
    const impl = await start('Print your board identity', undefined, 'Impl');
    const { jobs } = await client.call('queue.read', { id: card.id });
    const [fix, docs, note] = jobs;
    const hand = (job: string, sessionId: string, text = 'Fix the login, please') => client.call('queue.hand', { id: card.id, job, sessionId, text });

    const { job } = await hand(fix!.id, impl.agent.sessionId);
    expect(job).toMatchObject({ state: 'taken', takenBy: { kind: 'agent', sessionId: impl.agent.sessionId }, changedBy: { kind: 'user' }, lastChange: 'take' });
    await recorder.waitForText(impl.agent.sessionId, 'Fix the login, please');
    // Only what the user wrote: no brief of the board's, nothing added.
    expect(recorder.screenText(impl.agent.sessionId)).not.toContain('This is job #');
    expect(await client.call('queue.taken')).toEqual([expect.objectContaining({ sessionId: impl.agent.sessionId, queueId: card.id, queueTitle: 'Backlog', job: expect.objectContaining({ id: fix!.id }) })]);

    // Only a waiting job, not a note, to a live agent in its scope, and only from a queue for agents.
    await expect(hand(fix!.id, lead.agent.sessionId)).rejects.toThrow(/only a waiting job/);
    await expect(hand(note!.id, lead.agent.sessionId)).rejects.toThrow(/is info/);
    await expect(hand(docs!.id, lead.agent.sessionId, '  ')).rejects.toThrow(/the message is 1 to/);
    const elsewhere = await client.call('zone.add', { path: tempRepo(), x: 2000, y: 0, name: 'web' });
    const outsider = await start('Print your board identity', elsewhere.id, 'Outsider');
    await expect(hand(docs!.id, outsider.agent.sessionId)).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    // An agent asking the user something is busy: the daemon refuses, whatever the app shows.
    const asking = await client.call('agent.spawn', { zoneId: impl.agent.zoneId, harness: 'claude', prompt: 'Ask: Which cache? | Redis | LRU', name: 'Asking', ...SIZE });
    await expect.poll(async () => (await client.call('agent.list')).find((each) => each.sessionId === asking.sessionId)?.ask ?? null, { timeout: 15_000 }).not.toBeNull();
    await expect(hand(docs!.id, asking.sessionId)).rejects.toThrow(/busy or asking you something/);
    expect((await client.call('queue.read', { id: card.id })).jobs.find((each) => each.id === docs!.id)).toMatchObject({ state: 'queued' });

    // Marked Later, a job is handed on to no one until it is moved up.
    await client.call('queue.change', { id: card.id, change: { action: 'later', job: docs!.id } });
    await expect(hand(docs!.id, lead.agent.sessionId, 'Write the docs, please')).rejects.toThrow(/is marked Later: move it up first/);
    expect((await client.call('queue.read', { id: card.id })).jobs.find((each) => each.id === docs!.id)).toMatchObject({ state: 'queued', takenBy: null });
    await client.call('queue.change', { id: card.id, change: { action: 'later', job: docs!.id, until: null } });
    expect((await hand(docs!.id, lead.agent.sessionId, 'Write the docs, please')).job).toMatchObject({ state: 'taken', takenBy: { kind: 'agent', sessionId: lead.agent.sessionId } });
  });
});

describe('a hand-on its agent never gets', () => {
  it('is undone: the job waits again with no take in its history, and nothing is left typed at the agent', async () => {
    // The fake loses the Enters of the message after its first: typed, and never sent (`unsent`).
    const daemon = await startTestDaemon({
      worktreesDir: tempDataDir(),
      agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200, loseEnters: 3, loseEntersAfter: 1 }),
      submitConfirmMs: 100,
    });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
    const data = { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 80, width: 340, height: 244, data });
    const { job } = await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Fix the login' } });
    const worker = await client.call('agent.spawn', { zoneId: zone.id, name: 'worker', prompt: 'Write the handover', ...SIZE });
    await client.call('session.attach', { sessionId: worker.sessionId });
    const agentNow = async () => (await client.call('agent.list')).find((each) => each.sessionId === worker.sessionId)!;
    await expect.poll(async () => (await agentNow()).state, { timeout: 15_000 }).toMatch(/idle|waiting/);

    await expect(client.call('queue.hand', { id: card.id, job: job!.id, sessionId: worker.sessionId, text: 'Fix the login, please' })).rejects.toThrow(/didn't get it/);
    expect((await client.call('queue.read', { id: card.id })).jobs[0]).toMatchObject({ state: 'queued', takenBy: null });
    expect((await client.call('queue.history', { id: card.id, job: job!.id })).map((version) => version.action)).not.toContain('take');
    expect((await agentNow()).unsent).toBeNull();
  });
});

describe('draining a queue', () => {
  /** A queue of one job, drained one at a time and closing its agent when done; the agent it started, once it waits. */
  const drained = async (setup: Awaited<ReturnType<typeof boardDaemon>>, before?: (card: BoardItem) => Promise<unknown>) => {
    const { client, recorder, zone } = setup;
    const data = { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 80, width: 340, height: 244, data });
    await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Fix the login' } });
    await before?.(card);
    await client.call('item.update', { id: card.id, data: { drain: { on: true, harness: 'claude', model: null, role: null, closeWhenDone: true, most: 1, started: [] } } });
    const named = async () => (await client.call('agent.list')).find((agent) => agent.name === 'Fix the login');
    await expect.poll(named, { timeout: 15_000 }).toBeDefined();
    const agent = (await named())!;
    await client.call('session.attach', { sessionId: agent.sessionId });
    await recorder.waitForText(agent.sessionId, `agent-board queue done item:${card.id}`);
    return { card, agent };
  };

  it('starts its agent clear of what is in its zone, the queue and a note under it too', async () => {
    const setup = await boardDaemon();
    let note: BoardItem | undefined;
    const { card, agent } = await drained(setup, async () => {
      note = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: 40, y: 348, width: 240, height: 200, data: { text: 'Under the queue', color: '#fff3a3' } });
    });
    const tile = tileOf(agent);
    expect(overlaps(tile, card)).toBe(false);
    expect(overlaps(tile, note!)).toBe(false);
  });

  it('closes an agent done with its job with its reviewers', async () => {
    const setup = await boardDaemon();
    const { client } = setup;
    const { card, agent } = await drained(setup);
    const round = await client.call('review.start', { sessionId: agent.sessionId, ...SIZE });
    expect(round.reviewer).toEqual(expect.any(String));

    const [job] = (await client.call('queue.read', { id: card.id })).jobs;
    await client.call('queue.change', { id: card.id, change: { action: 'done', job: job!.id } });
    await client.call('agent.answer', { sessionId: agent.sessionId, text: 'Thanks' });
    await expect.poll(async () => (await client.call('agent.list')).map((each) => each.sessionId), { timeout: 15_000 }).toEqual([]);
    // The round goes with its implementer.
    expect((await client.call('review.list')).find((each) => each.id === round.id)).toBeUndefined();
  });

  it('starts a fresh agent for each waiting job while fewer than most are taken, and closes one done with its job', async () => {
    const { client, recorder, zone } = await boardDaemon();
    const data = { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 80, width: 340, height: 244, data });
    for (const text of ['Fix the login', 'Write the docs']) await client.call('queue.change', { id: card.id, change: { action: 'add', text } });
    const jobs = async () => (await client.call('queue.read', { id: card.id })).jobs;
    const agentNamed = async (name: string) => (await client.call('agent.list')).find((agent) => agent.name === name && agent.endedAt === null);
    const drain = { harness: 'claude', model: null, role: null, closeWhenDone: true, most: 1, started: [] };
    await expect(client.call('item.update', { id: card.id, data: { drain: { ...drain, most: 4 } } })).rejects.toThrow(/most \(1 to 3\)/);

    // On: one agent, for the first job, taken for it, its task the job and how to finish it.
    await client.call('item.update', { id: card.id, data: { drain: { ...drain, on: true } } });
    await expect.poll(() => agentNamed('Fix the login'), { timeout: 15_000 }).toBeDefined();
    const first = (await agentNamed('Fix the login'))!;
    expect(first.zoneId).toBe(zone.id);
    await expect.poll(async () => (await jobs())[0]).toMatchObject({ state: 'taken', takenBy: { sessionId: first.sessionId } });
    await client.call('session.attach', { sessionId: first.sessionId });
    await recorder.waitForText(first.sessionId, `agent-board queue done item:${card.id}`);
    expect(await agentNamed('Write the docs')).toBeUndefined();

    // Its job done, the next starts; at its turn's end, the first is closed.
    await client.call('queue.change', { id: card.id, change: { action: 'done', job: (await jobs())[0]!.id } });
    await expect.poll(() => agentNamed('Write the docs'), { timeout: 15_000 }).toBeDefined();
    await client.call('agent.answer', { sessionId: first.sessionId, text: 'Thanks' });
    await expect.poll(() => agentNamed('Fix the login'), { timeout: 15_000 }).toBeUndefined();
    expect(((await client.call('queue.read', { id: card.id })).item.data as unknown as QueueData).drain?.started).toHaveLength(2);

    // The started list is the daemon's: a user's update (the sheet, an undo) sending an old one keeps it.
    await client.call('item.update', { id: card.id, data: { drain: { ...drain, on: true, started: [] } } });
    expect(((await client.call('queue.read', { id: card.id })).item.data as unknown as QueueData).drain?.started).toHaveLength(2);
  });

  it('keeps no more than most at work, and leaves a job dropped twice for a person', async () => {
    const { client, recorder, zone, dataDir } = await boardDaemon();
    const data = { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 80, width: 340, height: 244, data });
    for (const text of ['One', 'Two', 'Three']) await client.call('queue.change', { id: card.id, change: { action: 'add', text } });
    const jobs = async () => (await client.call('queue.read', { id: card.id })).jobs;
    const live = async () => (await client.call('agent.list')).filter((agent) => agent.endedAt === null).map((agent) => agent.name);
    await client.call('item.update', { id: card.id, data: { drain: { harness: 'claude', model: null, role: null, closeWhenDone: false, most: 2, started: [], on: true } } });
    await expect.poll(live, { timeout: 15_000 }).toEqual(expect.arrayContaining(['One', 'Two']));
    await expect.poll(async () => (await jobs()).filter((job) => job.state === 'taken').length).toBe(2);
    // Both starts saved, the pass has gone round again and stopped at its most: no third.
    await expect.poll(async () => ((await client.call('queue.read', { id: card.id })).item.data as unknown as QueueData).drain?.started.length).toBe(2);
    expect(await live()).not.toContain('Three');
    expect((await jobs()).find((job) => job.text === 'Three')).toMatchObject({ state: 'queued' });

    // Its brief names the queue by ref, so its commands work whatever the title.
    const one = (await client.call('agent.list')).find((agent) => agent.name === 'One')!;
    await client.call('session.attach', { sessionId: one.sessionId });
    await recorder.waitForText(one.sessionId, `agent-board queue done item:${card.id}`);

    // Dropped back twice (as two agents gave it up), a job is the user's to look at: drain starts no third.
    await client.call('item.update', { id: card.id, data: { drain: { harness: 'claude', model: null, role: null, closeWhenDone: false, most: 3, started: [], on: false } } });
    const three = (await jobs()).find((job) => job.text === 'Three')!;
    // As two agents' drops leave it: written straight to the store, as no one but an agent drops a job.
    const store = new DatabaseSync(daemonPaths(dataDir).database);
    store.prepare('UPDATE queue_jobs SET drops = 2 WHERE id = ?').run(three.id);
    store.close();
    await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Four' } });
    // On again with room for one more: it starts Four, after Three in the queue, so the pass that did passed Three by.
    await client.call('item.update', { id: card.id, data: { drain: { harness: 'claude', model: null, role: null, closeWhenDone: false, most: 3, started: [], on: true } } });
    await expect.poll(live, { timeout: 15_000 }).toContain('Four');
    expect(await live()).not.toContain('Three');
    expect((await jobs()).find((job) => job.text === 'Three')).toMatchObject({ state: 'queued', drops: 2 });
  });

  it('starts no agent for a job marked Later, and starts one once it is moved up', async () => {
    const { client, zone } = await boardDaemon();
    const data = { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 80, width: 340, height: 244, data });
    await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Someday' } });
    const job = (await client.call('queue.read', { id: card.id })).jobs[0]!;
    await client.call('queue.change', { id: card.id, change: { action: 'later', job: job.id } });
    await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Now' } });
    const live = async () => (await client.call('agent.list')).filter((agent) => agent.endedAt === null).map((agent) => agent.name);
    await client.call('item.update', { id: card.id, data: { drain: { harness: 'claude', model: null, role: null, closeWhenDone: false, most: 3, started: [], on: true } } });
    await expect.poll(live, { timeout: 15_000 }).toContain('Now');
    // The pass has gone round again (both starts saved would be two): Someday waits.
    await expect.poll(async () => ((await client.call('queue.read', { id: card.id })).item.data as unknown as QueueData).drain?.started.length).toBe(1);
    expect(await live()).not.toContain('Someday');

    // Moved up, the drain starts it.
    await client.call('queue.change', { id: card.id, change: { action: 'later', job: job.id, until: null } });
    await expect.poll(live, { timeout: 15_000 }).toContain('Someday');
  });

  it('refuses to mark Later a job it is starting an agent for, which the agent then takes', async () => {
    const { client } = await boardDaemon();
    const repo = tempRepo();
    const zone = await client.call('zone.add', { path: repo, x: 2000, y: 0, name: 'web' });
    // The drained agent's worktree is checked out with a filter that holds the start open until the test lets it go.
    const flags = tempDataDir();
    const [checkingOut, go] = [join(flags, 'checking-out'), join(flags, 'go')];
    onTestFinished(() => writeFileSync(go, ''));
    onCheckout(repo, `touch '${checkingOut}'; while [ ! -e '${go}' ]; do sleep 0.05; done`);
    const data = { title: 'Backlog', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: zone.id, x: 40, y: 80, width: 340, height: 244, data });
    const { job } = await client.call('queue.change', { id: card.id, change: { action: 'add', text: 'Fix the login' } });
    await client.call('item.update', { id: card.id, data: { drain: { harness: 'claude', model: null, role: null, closeWhenDone: false, most: 1, started: [], on: true } } });
    await expect.poll(() => existsSync(checkingOut), { timeout: 15_000 }).toBe(true);

    await expect(client.call('queue.change', { id: card.id, change: { action: 'later', job: job!.id } })).rejects.toThrow(/an agent is starting for job/);
    writeFileSync(go, '');
    await expect.poll(async () => (await client.call('queue.read', { id: card.id })).jobs[0]?.state, { timeout: 15_000 }).toBe('taken');
    expect((await client.call('queue.read', { id: card.id })).jobs[0]).toMatchObject({ hiddenUntil: null });
  });

  it('is turned on by the agent that made the queue, with no role, and never by another', async () => {
    const { client, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'Fix the login');
    const other = await start('Print your board identity', undefined, 'Other');
    expect((await cli(other.env, 'queue', 'drain', 'Backlog', 'on')).err).toContain("isn't yours");
    expect((await cli(lead.env, 'queue', 'drain', 'Backlog', 'on', '--most', '4')).err).toContain('most is 1, 2 or 3');
    expect((await cli(lead.env, 'queue', 'drain', 'Backlog', 'on', '--most', '1')).out).toContain('at most 1 at once');
    await expect.poll(async () => (await client.call('agent.list')).some((agent) => agent.name === 'Fix the login'), { timeout: 15_000 }).toBe(true);
    expect((await cli(lead.env, 'queue', 'drain', 'Backlog', 'off')).out).toContain('starts no more agents');
    expect(((await client.call('queue.read', { id: card.id })).item.data as unknown as QueueData).drain).toMatchObject({ on: false, most: 1, harness: 'claude' });
  });
});

describe('a queue made on the board', () => {
  it('takes the user’s jobs and notes, moves them, folds, and keeps its count its open rows’', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);
    const data = { title: 'Jobs', madeBy: { kind: 'user' }, audience: 'agents', noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'queue', zoneId: null, x: 0, y: 0, width: 340, height: 244, data });
    for (const text of ['One', 'Two', 'Three']) await client.call('queue.change', { id: card.id, change: { action: 'add', text } });
    await client.call('queue.change', { id: card.id, change: { action: 'add', kind: 'note', text: 'Ask first' } });
    const texts = async () => (await client.call('queue.read', { id: card.id })).jobs.filter((job) => job.state !== 'done').map((job) => job.text);
    const idOf = async (text: string) => (await client.call('queue.read', { id: card.id })).jobs.find((job) => job.text === text)!.id;
    expect(await texts()).toEqual(['One', 'Two', 'Three', 'Ask first']);

    // Before another open one, or last; a done one doesn't move, nor has one moved before it.
    await client.call('queue.change', { id: card.id, change: { action: 'move', job: await idOf('Three'), before: await idOf('One') } });
    expect(await texts()).toEqual(['Three', 'One', 'Two', 'Ask first']);
    await client.call('queue.change', { id: card.id, change: { action: 'move', job: await idOf('Three'), before: null } });
    expect(await texts()).toEqual(['One', 'Two', 'Ask first', 'Three']);
    await client.call('queue.change', { id: card.id, change: { action: 'done', job: await idOf('One') } });
    await expect(client.call('queue.change', { id: card.id, change: { action: 'move', job: await idOf('One'), before: null } })).rejects.toThrow(/only an open one moves/);
    await expect(client.call('queue.change', { id: card.id, change: { action: 'move', job: await idOf('Two'), before: await idOf('One') } })).rejects.toThrow(/before an open one/);
    // The take order is the order as moved.
    await client.call('queue.change', { id: card.id, change: { action: 'move', job: await idOf('Three'), before: await idOf('Two') } });
    expect(await texts()).toEqual(['Three', 'Two', 'Ask first']);

    const folded = await client.call('item.update', { id: card.id, data: { folded: true }, width: 128, height: 140 });
    expect(folded.data).toMatchObject({ folded: true, count: 3, audience: 'agents' });
    await expect(client.call('item.update', { id: card.id, data: { folded: 1 } })).rejects.toThrow(/folded must be true or false/);
    await expect(client.call('item.update', { id: card.id, data: { openSize: { width: 0, height: 300 } } })).rejects.toThrow(/openSize must be \{ width, height \}/);
    // An undo's stale count is put right.
    expect((await client.call('item.update', { id: card.id, data: { ...folded.data, count: 9 } })).data).toMatchObject({ count: 3 });

    // The user's queue starts no agents: made the user's, a drain that was on must go off with it.
    const drain = { on: true, harness: 'claude', model: null, role: null, closeWhenDone: true, most: 1, started: [] };
    await client.call('item.update', { id: card.id, data: { drain: { ...drain, on: false } } });
    await expect(client.call('item.update', { id: card.id, data: { audience: 'user', drain } })).rejects.toThrow(/starts no agents/);
    expect((await client.call('item.update', { id: card.id, data: { audience: 'user', drain: { ...drain, on: false } } })).data).toMatchObject({ audience: 'user', drain: { on: false } });
  });
});
