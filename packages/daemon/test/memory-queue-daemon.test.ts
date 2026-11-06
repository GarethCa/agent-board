import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { daemonPaths } from '../src/paths.ts';
import { BOARD_ERROR, MAX_MEMORY_VALUE, type Agent, type AgentUpdatedEvent, type BoardItem, type DaemonEvent, type MemoryData, type QueueData } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents run the fake `ask-plan` scenario: `Memory: <title>` or `Queue: <title>` puts one up. */
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
  const cardOf = async (kind: 'memory' | 'queue', agent: Agent): Promise<BoardItem> => {
    const found = (await client.call('item.list')).find((item) => item.kind === kind && (item.data as unknown as MemoryData).madeBy.kind === 'agent' && JSON.stringify(item.data).includes(agent.sessionId));
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

describe('memories', () => {
  it('holds keyed values, notes and whole files that an agent remembers, reads, searches and changes', async () => {
    const { client, recorder, start, cardOf } = await boardDaemon();
    const { agent, env } = await start('Memory: Release notes');
    await recorder.waitForText(agent.sessionId, 'beside your tile');
    const card = await cardOf('memory', agent);
    expect(card.zoneId).toBe(agent.zoneId);
    expect(card.data).toMatchObject({ title: 'Release notes', noAgents: false, count: 0 });

    expect((await cli(env, 'memory', 'add', 'Release notes', 'db-host: pg.internal')).out).toContain('Remembered db-host in “Release notes”');
    await cli(env, 'memory', 'add', 'Release notes', 'db-host: pg2.internal');
    await cli(env, 'memory', 'add', 'Release notes', '--no-key', 'Note: the cache is cold on Mondays');
    await cli(env, 'memory', 'add', 'Release notes', '--key', 'ship day', 'Friday');
    const dir = tempDataDir();
    writeFileSync(join(dir, 'plan.md'), '# Plan\n\nline 1\nline 2\nline 3\nline 4\n');
    const file = await cli({ ...env }, 'memory', 'add', 'Release notes', '--file', join(dir, 'plan.md'));
    expect(file.code).toBe(0);

    const { entries, item } = await client.call('memory.read', { id: card.id });
    expect(item.data).toMatchObject({ count: 4 });
    expect(entries.map((entry) => [entry.key, entry.file])).toEqual(
      expect.arrayContaining([
        ['db-host', false],
        [null, false],
        ['ship day', false],
        ['plan.md', true],
      ]),
    );
    // A key set again is replaced, not piled up beside the old value.
    expect(entries.find((entry) => entry.key === 'db-host')!.text).toBe('pg2.internal');

    const read = await cli(env, 'memory', 'read', 'Release notes');
    expect(read.out).toContain('“Release notes”  4 entries');
    expect(read.out).toContain('db-host: pg2.internal');
    expect(read.out).toContain('file plan.md');
    expect(read.out).not.toContain('line 4');
    expect((await cli(env, 'memory', 'read', 'Release notes', 'plan.md')).out).toContain('line 4');
    const searched = await cli(env, 'memory', 'read', 'Release notes', '--search', 'MONDAYS');
    expect(searched.out).toContain('the cache is cold');
    expect(searched.out).not.toContain('db-host');

    expect((await cli(env, 'memory', 'edit', 'Release notes', 'ship day', '--pin')).code).toBe(0);
    expect((await client.call('memory.read', { id: card.id })).entries[0]!.key).toBe('ship day');

    const tooLong = await cli(env, 'memory', 'add', 'Release notes', `big: ${'x'.repeat(MAX_MEMORY_VALUE + 1)}`);
    expect(tooLong.code).not.toBe(0);
    expect(tooLong.err).toContain('keep a longer text as a file');
  });

  it('says when a key set again replaces a value, and keeps only text files', async () => {
    const { start } = await boardDaemon();
    const { env } = await start('Memory: Notes');
    await cli(env, 'memory', 'add', 'Notes', 'Decision: use Postgres');
    const again = await cli(env, 'memory', 'add', 'Notes', 'Decision: ship on Friday');
    expect(again.out).toContain('Replaced Decision in “Notes”');
    expect(again.out).toContain('it was “use Postgres”');
    expect(again.out).toMatch(/memory restore item:\w+ Decision v\d+` puts it back/);
    const dir = tempDataDir();
    writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 0xfe]));
    const binary = await cli(env, 'memory', 'add', 'Notes', '--file', join(dir, 'shot.png'));
    expect(binary.code).not.toBe(0);
    expect(binary.err).toContain('keeps only text files');
  });

  it("keeps a memory's history within its cap, the versions of removed entries going first", async () => {
    const { client, start, cardOf } = await boardDaemon();
    const { agent } = await start('Memory: Big');
    const card = await cardOf('memory', agent);
    const body = 'x'.repeat(1000 * 1024);
    for (let at = 0; at < 10; at += 1) {
      await client.call('memory.change', { id: card.id, change: { action: 'add', key: `f${at}`, text: body, file: true } });
      await client.call('memory.change', { id: card.id, change: { action: 'remove', entry: `f${at}` } });
    }
    await client.call('memory.change', { id: card.id, change: { action: 'add', key: 'kept', text: 'still here' } });
    // The oldest removed files' versions went; the newest, and the live entry's, are kept.
    await expect(client.call('memory.history', { id: card.id, entry: 'f0' })).rejects.toThrow(/has no entry f0, nor any history of one/);
    expect((await client.call('memory.history', { id: card.id, entry: 'f9' })).map((version) => version.action)).toEqual(['remove', 'add']);
    expect((await client.call('memory.history', { id: card.id, entry: 'kept' })).map((version) => version.action)).toEqual(['add']);
  });

  it("lets any agent change the user's entry, and history takes the change back", async () => {
    const { client, start, cardOf } = await boardDaemon();
    const { agent, env } = await start('Memory: Decisions');
    const card = await cardOf('memory', agent);
    const { entry } = await client.call('memory.change', { id: card.id, change: { action: 'add', key: 'store', text: 'Postgres' } });
    expect(entry!.madeBy).toEqual({ kind: 'user' });

    await cli(env, 'memory', 'edit', 'Decisions', 'store', 'SQLite');
    const changed = (await client.call('memory.read', { id: card.id })).entries[0]!;
    expect(changed).toMatchObject({ text: 'SQLite', madeBy: { kind: 'user' }, changedBy: { kind: 'agent', sessionId: agent.sessionId } });

    const history = await client.call('memory.history', { id: card.id, entry: 'store' });
    expect(history.map((version) => [version.action, version.value?.text])).toEqual([
      ['edit', 'SQLite'],
      ['add', 'Postgres'],
    ]);
    await client.call('memory.change', { id: card.id, change: { action: 'restore', entry: 'store', version: history[1]!.version } });
    expect((await client.call('memory.read', { id: card.id })).entries[0]!.text).toBe('Postgres');

    // Removed, it can still be put back from its history.
    expect((await cli(env, 'memory', 'rm', 'Decisions', 'store')).out).toContain('Removed store from “Decisions”');
    const versions = await cli(env, 'memory', 'history', 'Decisions', 'store');
    expect(versions.out).toContain('remove  by');
    await cli(env, 'memory', 'restore', 'Decisions', 'store', `v${history[1]!.version}`);
    expect((await client.call('memory.read', { id: card.id })).entries.map((each) => each.text)).toEqual(['Postgres']);
  });

  it("keeps a memory to its scope: its zone's, every agent's once loose, and no one's set to No agents", async () => {
    const { client, start, cardOf } = await boardDaemon();
    const { agent } = await start('Memory: Storefront facts');
    const card = await cardOf('memory', agent);
    const billing = await client.call('zone.add', { path: tempRepo('billing'), x: 4000, y: 0, name: 'billing' });
    const stranger = await start('Memory: Billing facts', billing.id, 'Billing');
    const listed = await stranger.connection.call('board.listMemories', { token: stranger.token });
    expect(listed.map((each) => each.id)).toEqual([(await cardOf('memory', stranger.agent)).id]);
    await expect(stranger.connection.call('board.readMemory', { token: stranger.token, id: card.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await expect(stranger.connection.call('board.changeMemory', { token: stranger.token, id: card.id, change: { action: 'add', text: 'sneaky' } })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect((await stranger.connection.call('item.list')).some((item) => item.id === card.id)).toBe(false);

    // An orchestrator whose scope reaches the zone reads it.
    await client.call('agent.setOrchestrate', { sessionId: stranger.agent.sessionId, scope: 'board' });
    expect((await stranger.connection.call('board.readMemory', { token: stranger.token, id: card.id })).item.id).toBe(card.id);
    await client.call('agent.setOrchestrate', { sessionId: stranger.agent.sessionId, scope: null });

    // Loose, every agent writes to it.
    await client.call('item.update', { id: card.id, zoneId: null, x: 9000, y: 0 });
    await stranger.connection.call('board.changeMemory', { token: stranger.token, id: card.id, change: { action: 'add', text: 'billing was here' } });

    // No agents: only the user reads it.
    await client.call('item.update', { id: card.id, data: { noAgents: true } });
    await expect(stranger.connection.call('board.readMemory', { token: stranger.token, id: card.id })).rejects.toThrow(/No agents/);
    expect((await client.call('memory.read', { id: card.id })).entries).toHaveLength(1);
  });

  it("turns a deleted zone's memory to No agents, and keeps its entries", async () => {
    const { client } = await boardDaemon();
    const empty = await client.call('zone.add', { path: tempRepo('scratch'), x: 4000, y: 0, name: 'scratch' });
    const card = await client.call('item.create', {
      kind: 'memory',
      zoneId: empty.id,
      x: 10,
      y: 10,
      width: 300,
      height: 160,
      data: { title: 'Scratch', madeBy: { kind: 'user' }, noAgents: false, count: 0 },
    });
    await client.call('memory.change', { id: card.id, change: { action: 'add', key: 'k', text: 'v' } });
    await client.call('zone.remove', { id: empty.id });
    const after = (await client.call('item.list')).find((item) => item.id === card.id)!;
    expect(after).toMatchObject({ zoneId: null, data: { noAgents: true } });
    expect((await client.call('memory.read', { id: card.id })).entries).toHaveLength(1);

    // Deleting the card and making it again, as undo does, finds its entries again.
    await client.call('item.delete', { id: card.id });
    await client.call('item.create', { kind: after.kind, zoneId: after.zoneId, x: after.x, y: after.y, width: after.width, height: after.height, data: after.data, id: card.id });
    expect((await client.call('memory.read', { id: card.id })).entries.map((entry) => entry.text)).toEqual(['v']);
  });
});

describe('queues', () => {
  it('queues jobs and notes that agents take, drop back with a count, and finish', async () => {
    const { client, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    expect(card.data).toMatchObject({ title: 'Backlog', audience: 'agents', count: 0 });

    const added = await cli(lead.env, 'queue', 'add', 'Backlog', '--', '- Fix the login -> https://example.test/1', 'Write the docs');
    expect(added.out).toContain('Queued 2 jobs on “Backlog”');
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
    expect((await cli(impl.env, 'queue', 'done', 'Backlog', ref)).out).toContain('Done:');

    const { job: next } = await take();
    expect(next).toMatchObject({ text: 'Fix the login', link: 'https://example.test/1' });
    const read = await cli(impl.env, 'queue', 'read', 'Backlog');
    expect(read.out).toContain('“Backlog”  3 open');
    expect(read.out).toContain('taken by');
    expect(read.out).toContain('note');
    expect(read.out).toContain('Done:');
    expect(read.out).toContain('dropped once');

    // A note is never taken.
    const note = (await client.call('queue.read', { id: card.id })).jobs.find((job) => job.kind === 'note')!;
    await expect(take(note.id)).rejects.toThrow(/is a note/);

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

  it('keeps a job through a pause, and puts it back once its taker is deleted with no exit to come', async () => {
    const { client, recorder, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'One', 'Two');
    const impl = await start('Memory: Mine', undefined, 'Impl');
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
    const other = await start('Memory: Theirs', undefined, 'Other');
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
    const { env, token, connection } = await start('Memory: Scratch');
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

describe('a memory made on the board', () => {
  it('is made by the user as any item is, takes their entries, and folds to its icon and back', async () => {
    const daemon = await startTestDaemon();
    const client = await connectTestClient(daemon);
    const data = { title: 'Notes', madeBy: { kind: 'user' }, noAgents: false, count: 0 };
    const card = await client.call('item.create', { kind: 'memory', zoneId: null, x: 0, y: 0, width: 340, height: 220, data });
    await client.call('memory.change', { id: card.id, change: { action: 'add', key: 'deploy.day', text: 'Tuesdays' } });
    const { item, entries } = await client.call('memory.read', { id: card.id });
    expect(item.data).toMatchObject({ count: 1 });
    expect(entries.map(({ key, text, madeBy }) => ({ key, text, madeBy }))).toEqual([{ key: 'deploy.day', text: 'Tuesdays', madeBy: { kind: 'user' } }]);

    // Removed by its id, as the board does, it comes back from its history by that id.
    const id = entries[0]!.id;
    await client.call('memory.change', { id: card.id, change: { action: 'remove', entry: id } });
    const kept = (await client.call('memory.history', { id: card.id, entry: id })).find((version) => version.value !== null)!;
    await client.call('memory.change', { id: card.id, change: { action: 'restore', entry: id, version: kept.version } });
    expect((await client.call('memory.read', { id: card.id })).entries.map((entry) => entry.text)).toEqual(['Tuesdays']);

    const folded = await client.call('item.update', { id: card.id, data: { folded: true }, width: 128, height: 132 });
    expect(folded.data).toMatchObject({ folded: true, count: 1, title: 'Notes' });
    await expect(client.call('item.update', { id: card.id, data: { folded: 'yes' } })).rejects.toThrow(/folded must be true or false/);

    // An undo sends the card's whole data back, its count as it was then: the count stays its entries'.
    expect((await client.call('item.update', { id: card.id, data: { ...folded.data, count: 7 } })).data).toMatchObject({ count: 1 });
    await client.call('item.delete', { id: card.id });
    expect((await client.call('item.create', { kind: 'memory', zoneId: null, x: 0, y: 0, width: 340, height: 220, data: { ...data, count: 0 }, id: card.id })).data).toMatchObject({ count: 1 });
  });
});

describe('handing a job on', () => {
  it("takes a waiting job for an idle agent in scope and types only the user's text; the takers' tiles read it back", async () => {
    const { client, recorder, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'Fix the login -> https://example.test/1', 'Write the docs');
    await cli(lead.env, 'queue', 'add', 'Backlog', '--kind', 'note', 'Ask before touching billing');
    const impl = await start('Memory: Mine', undefined, 'Impl');
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
    await expect(hand(note!.id, lead.agent.sessionId)).rejects.toThrow(/is a note/);
    await expect(hand(docs!.id, lead.agent.sessionId, '  ')).rejects.toThrow(/the message is 1 to/);
    const elsewhere = await client.call('zone.add', { path: tempRepo(), x: 2000, y: 0, name: 'web' });
    const outsider = await start('Memory: Theirs', elsewhere.id, 'Outsider');
    await expect(hand(docs!.id, outsider.agent.sessionId)).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    // An agent asking the user something is busy: the daemon refuses, whatever the app shows.
    const asking = await client.call('agent.spawn', { zoneId: impl.agent.zoneId, harness: 'claude', prompt: 'Ask: Which cache? | Redis | LRU', name: 'Asking', ...SIZE });
    await expect.poll(async () => (await client.call('agent.list')).find((each) => each.sessionId === asking.sessionId)?.ask ?? null, { timeout: 15_000 }).not.toBeNull();
    await expect(hand(docs!.id, asking.sessionId)).rejects.toThrow(/busy or asking you something/);
    expect((await client.call('queue.read', { id: card.id })).jobs.find((each) => each.id === docs!.id)).toMatchObject({ state: 'queued' });
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

  it('is turned on by an orchestrator for a queue it made, never by an agent that does not orchestrate, nor by another', async () => {
    const { client, start, cardOf } = await boardDaemon();
    const lead = await start('Queue: Backlog', undefined, 'Lead');
    const card = await cardOf('queue', lead.agent);
    await cli(lead.env, 'queue', 'add', 'Backlog', '--', 'Fix the login');
    // Only an orchestrator turns a drain on: the maker that doesn't orchestrate is refused.
    await client.call('agent.setOrchestrate', { sessionId: lead.agent.sessionId, scope: null });
    expect((await cli(lead.env, 'queue', 'drain', 'Backlog', 'on')).err).toContain('only for an orchestrator');
    await client.call('agent.setOrchestrate', { sessionId: lead.agent.sessionId, scope: 'zone' });
    const other = await start('Memory: Mine', undefined, 'Other');
    await client.call('agent.setOrchestrate', { sessionId: other.agent.sessionId, scope: 'zone' });
    expect((await cli(other.env, 'queue', 'drain', 'Backlog', 'on')).err).toContain("isn't yours");
    expect((await cli(lead.env, 'queue', 'drain', 'Backlog', 'on', '--most', '4')).err).toContain('--most is 1, 2 or 3');
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
    // An undo's stale count is put right, as a memory's is.
    expect((await client.call('item.update', { id: card.id, data: { ...folded.data, count: 9 } })).data).toMatchObject({ count: 3 });

    // The user's queue starts no agents: made the user's, a drain that was on must go off with it.
    const drain = { on: true, harness: 'claude', model: null, role: null, closeWhenDone: true, most: 1, started: [] };
    await client.call('item.update', { id: card.id, data: { drain: { ...drain, on: false } } });
    await expect(client.call('item.update', { id: card.id, data: { audience: 'user', drain } })).rejects.toThrow(/starts no agents/);
    expect((await client.call('item.update', { id: card.id, data: { audience: 'user', drain: { ...drain, on: false } } })).data).toMatchObject({ audience: 'user', drain: { on: false } });
  });
});
