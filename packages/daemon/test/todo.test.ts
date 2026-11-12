import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { runBoardCommand } from '../src/board-cli.ts';
import { AGENT_TILE_SIZE } from '../src/board-layout.ts';
import { spotBesideAgent, type DaemonCall } from '../src/orchestrator-layout.ts';
import { BOARD_ERROR, MAX_TODO_LINES, TODO_CARD_SIZE, type AgentUpdatedEvent, type BoardItem, type DaemonEvent, type DaemonMethod, type StepsWho, type TodoData, type TodoLine } from '../src/protocol.ts';
import { changeTodoLines, checkTodoData } from '../src/todos.ts';
import { clockText } from '../src/todo-ops.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };
const USER: StepsWho = { kind: 'user' };
const AT = '2026-11-11T14:06:00.000Z';

const linesOf = (item: BoardItem) => (item.data as unknown as TodoData).lines;

/** A daemon whose agents run the fake `ask-plan` scenario: `Remind: <line> ;; …` adds those to-dos through MCP. */
async function boardDaemon(dataDir = tempDataDir()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'ask-plan', home: tempDataDir() }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'storefront' });
  /** Starts an agent with `prompt`, waits for its turn to end, and gives its board token, env and a connection as it. */
  const start = async (prompt: string, zoneId = zone.id, name = 'Impl') => {
    const agent = await client.call('agent.spawn', { zoneId, harness: 'claude', prompt, name, ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    const idle = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === agent.sessionId && e.agent.state === 'idle';
    await recorder.waitFor(idle);
    await recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    const connection = await connectTestClient(daemon);
    await connection.call('board.identify', { token });
    const env = { AGENT_BOARD_SOCKET: daemon.socketPath, AGENT_BOARD_IDENTITY: token };
    return { agent, token, connection, env };
  };
  const lists = async () => (await client.call('item.list')).filter((item) => item.kind === 'todo');
  return { daemon, dataDir, client, recorder, zone, start, lists };
}

/** Runs `agent-board <command> <args>` with `env`: what it printed and its exit code. */
async function cli(env: NodeJS.ProcessEnv, command: string, ...args: string[]) {
  let out = '';
  let err = '';
  const code = await runBoardCommand(command, args, { out: (text) => (out += text), err: (text) => (err += text), env });
  return { code, out, err };
}

describe('to-do lines', () => {
  const line = (id: string, text: string, done: TodoLine['done'] = null): TodoLine => ({ id, text, by: USER, at: AT, done });
  const ids = (lines: TodoLine[]) => lines.map((each) => each.id);
  const three = [line('a', 'Send the PR'), line('b', 'Restart the app', { by: USER, at: AT }), line('c', 'Reply on the CLA')];

  it('adds, edits, ticks, moves, takes off, clears and puts back a line', () => {
    const added = changeTodoLines(three, { action: 'add', text: '  Run the\n capture  ', after: 'a' }, USER, AT, () => 'n');
    expect(added.map((each) => each.text)).toEqual(['Send the PR', 'Run the capture', 'Restart the app', 'Reply on the CLA']);
    expect(ids(changeTodoLines(three, { action: 'add', text: 'Last' }, USER, AT, () => 'n'))).toEqual(['a', 'b', 'c', 'n']);
    expect(changeTodoLines(three, { action: 'edit', line: 'c', text: 'Reply on #539' }, USER, AT)[2]!.text).toBe('Reply on #539');
    const ticked = changeTodoLines(three, { action: 'tick', line: 'a', done: true }, USER, '2026-11-11T15:00:00.000Z')[0]!;
    expect(ticked.done).toEqual({ by: USER, at: '2026-11-11T15:00:00.000Z' });
    // Ticked again, it keeps when it was first ticked; unticked, it is open.
    expect(changeTodoLines(three, { action: 'tick', line: 'b', done: true }, USER, 'later')[1]!.done!.at).toBe(AT);
    expect(changeTodoLines(three, { action: 'tick', line: 'b', done: false }, USER, AT)[1]!.done).toBeNull();
    expect(ids(changeTodoLines(three, { action: 'move', line: 'c', to: 0 }, USER, AT))).toEqual(['c', 'a', 'b']);
    expect(ids(changeTodoLines(three, { action: 'remove', line: 'b' }, USER, AT))).toEqual(['a', 'c']);
    expect(ids(changeTodoLines(three, { action: 'clear' }, USER, AT))).toEqual(['a', 'c']);
    const gone = changeTodoLines(three, { action: 'remove', line: 'b' }, USER, AT);
    expect(changeTodoLines(gone, { action: 'restore', line: three[1]!, at: 1 }, USER, AT)).toEqual(three);
    // Put back twice, it is there once.
    expect(changeTodoLines(three, { action: 'restore', line: three[1]!, at: 1 }, USER, AT)).toEqual(three);
  });

  it('refuses an empty or long line, a line it lacks, and one past the most a list holds', () => {
    expect(() => changeTodoLines(three, { action: 'add', text: ' \n ' }, USER, AT)).toThrow(/needs some text/);
    expect(() => changeTodoLines(three, { action: 'add', text: 'x'.repeat(501) }, USER, AT)).toThrow(/at most 500/);
    expect(() => changeTodoLines(three, { action: 'edit', line: 'zz', text: 'x' }, USER, AT)).toThrow(/no line zz/);
    expect(() => changeTodoLines(three, { action: 'move', line: 'a', to: 3 }, USER, AT)).toThrow(/from 0 to 2/);
    const full = Array.from({ length: MAX_TODO_LINES }, (_, at) => line(`l${at}`, `Line ${at}`));
    expect(() => changeTodoLines(full, { action: 'add', text: 'one more' }, USER, AT)).toThrow(/at most 100 lines/);
  });

  it("checks a list's data as it is saved", () => {
    expect(() => checkTodoData({ owner: USER, lines: three })).not.toThrow();
    expect(() => checkTodoData({ owner: { kind: 'agent' }, lines: [] })).toThrow(/owner/);
    expect(() => checkTodoData({ owner: USER, lines: [line('a', 'x'), line('a', 'y')] })).toThrow(/an id of their own/);
    expect(() => checkTodoData({ owner: USER, lines: [{ ...line('a', 'x'), done: 'yes' }] })).toThrow(/line 1/);
    expect(() => checkTodoData({ owner: USER, lines: [], folded: 'no' })).toThrow(/folded/);
  });

  it("shows a time today as the clock, and another day's with its date", () => {
    const now = new Date(2026, 10, 11, 18, 0);
    expect(clockText(new Date(2026, 10, 11, 14, 6).toISOString(), now)).toBe('14:06');
    expect(clockText(new Date(2026, 10, 10, 9, 5).toISOString(), now)).toBe('2026-11-10 09:05');
  });
});

describe('to-do lists', () => {
  it("makes an agent's list under its tile with its first to-do, adds the next to it, and tells it nothing of a tick", async () => {
    const { client, recorder, start, lists } = await boardDaemon();
    const { agent, env } = await start('Remind: Send the PR for approval ;; Restart the app');
    await recorder.waitForText(agent.sessionId, 'under your tile');
    const [list] = await lists();
    expect(list!.zoneId).toBe(agent.zoneId);
    // Under the tile: left of, and lower than, the spot to its right.
    const right = (await spotBesideAgent(((method: DaemonMethod, params: unknown) => client.call(method, params as never)) as DaemonCall, agent.sessionId, TODO_CARD_SIZE))!;
    expect(list!.x).toBeLessThan(right.x);
    expect(list!.y).toBeGreaterThanOrEqual(right.y + AGENT_TILE_SIZE.height);
    expect(list!.data).toMatchObject({ owner: { kind: 'agent', sessionId: agent.sessionId, name: 'Impl' } });
    expect(linesOf(list!).map((line) => [line.text, line.by.kind, line.done])).toEqual([
      ['Send the PR for approval', 'agent', null],
      ['Restart the app', 'agent', null],
    ]);

    // The next to-do goes on the same list; one list per agent.
    expect((await cli(env, 'remind', 'Reply to the CLA question')).out).toMatch(/^Added 1 to-do to your list item:\w+ under your tile: 3 open for the user\./);
    expect(await lists()).toHaveLength(1);

    // The user ticks a line: saved with who and when, and nothing typed at the agent.
    const screen = recorder.screenText(agent.sessionId);
    const stateOf = async () => (await client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.state;
    const before = await stateOf();
    const first = linesOf(list!)[0]!;
    const ticked = await client.call('todo.change', { id: list!.id, change: { action: 'tick', line: first.id, done: true } });
    expect(linesOf(ticked)[0]!.done).toMatchObject({ by: { kind: 'user' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(recorder.screenText(agent.sessionId)).toBe(screen);
    expect(await stateOf()).toBe(before);

    // It reads its list when it wants to know.
    const mine = await cli(env, 'remind', 'ls', '--mine');
    expect(mine.out).toContain('To do, yours  2 to do of 3');
    expect(mine.out).toContain(`1. [x] Send the PR for approval · you, ${clockText(linesOf(ticked)[0]!.done!.at)}`);
    expect(mine.out).toContain('2. [ ] Restart the app');
  });

  it("lets an agent tick and take off only lines it wrote on its own list, and the user change any line", async () => {
    const { client, recorder, start, lists } = await boardDaemon();
    const { agent, env, token, connection } = await start('Remind: Send the PR');
    await recorder.waitForText(agent.sessionId, 'under your tile');
    const [list] = await lists();
    const yours = await client.call('todo.change', { id: list!.id, change: { action: 'add', text: 'Check the screenshots' } });
    expect(linesOf(yours)[1]!.by).toEqual({ kind: 'user' });

    expect((await cli(env, 'remind', 'done', '1')).out).toContain('Ticked “Send the PR”.');
    expect((await cli(env, 'remind', 'undo', '1')).out).toContain('Unticked “Send the PR”.');
    const theirs = await cli(env, 'remind', 'rm', '2');
    expect(theirs.code).not.toBe(0);
    expect(theirs.err).toContain('the user wrote that line');
    await expect(connection.call('board.changeTodo', { token, change: { action: 'remove', line: linesOf(yours)[1]!.id } })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    // Only a tick or a take-off: an agent doesn't rewrite the user's list.
    await expect(connection.call('board.changeTodo', { token, change: { action: 'clear' } as never })).rejects.toThrow(/change must be/);
    expect((await cli(env, 'remind', 'rm', '1')).out).toContain('Took off “Send the PR”.');
    expect(linesOf((await lists())[0]!).map((line) => line.text)).toEqual(['Check the screenshots']);
    expect((await cli(env, 'remind', 'rm', '5')).err).toContain('give a line from 1 to 1');
  });

  it("keeps a list to its scope: another zone's agent neither reads it nor hears of it", async () => {
    const { client, recorder, start, lists } = await boardDaemon();
    const { agent } = await start('Remind: Send the PR');
    await recorder.waitForText(agent.sessionId, 'under your tile');
    const [list] = await lists();
    const billing = await client.call('zone.add', { path: tempRepo('billing'), x: 4000, y: 0, name: 'billing' });
    const stranger = await start('Remind: Rotate the key', billing.id, 'Billing');
    await recorder.waitForText(stranger.agent.sessionId, 'under your tile');
    const read = await stranger.connection.call('board.readTodos', { token: stranger.token });
    expect(read.map((each) => each.id)).not.toContain(list!.id);
    expect(read).toHaveLength(1);
    expect((await stranger.connection.call('item.list')).some((item) => item.id === list!.id)).toBe(false);
    expect((await cli(stranger.env, 'remind', 'ls')).out).not.toContain('Send the PR');
    // Its own list, under its own tile.
    expect(await lists()).toHaveLength(2);

    // An orchestrator whose scope reaches the zone reads it.
    await client.call('agent.setOrchestrate', { sessionId: stranger.agent.sessionId, scope: 'board' });
    expect((await stranger.connection.call('board.readTodos', { token: stranger.token })).map((each) => each.id)).toContain(list!.id);
  });

  it("keeps the user's own list, and every line's tick, through a restart", async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const client = await connectTestClient(first);
    const list = await client.call('item.create', { kind: 'todo', zoneId: null, x: 0, y: 0, width: 300, height: 196, data: { owner: { kind: 'user' }, lines: [] } });
    await client.call('todo.change', { id: list.id, change: { action: 'add', text: 'Send the PR' } });
    const added = await client.call('todo.change', { id: list.id, change: { action: 'add', text: 'Restart the app' } });
    await client.call('todo.change', { id: list.id, change: { action: 'tick', line: linesOf(added)[0]!.id, done: true } });
    await expect(client.call('item.create', { kind: 'todo', zoneId: null, x: 0, y: 0, width: 300, height: 196, data: { owner: { kind: 'user' } } })).rejects.toThrow(/lines must be a list/);
    await first.stop();

    const second = await startTestDaemon({ dataDir });
    const again = await connectTestClient(second);
    const kept = (await again.call('item.list')).find((item) => item.id === list.id)!;
    expect(linesOf(kept).map((line) => [line.text, line.done?.by.kind ?? null])).toEqual([
      ['Send the PR', 'user'],
      ['Restart the app', null],
    ]);
  });

  it('loses no line when the user and an agent change one list at once', async () => {
    const { client, recorder, start, lists } = await boardDaemon();
    const { agent, env } = await start('Remind: First');
    await recorder.waitForText(agent.sessionId, 'under your tile');
    const [list] = await lists();
    await Promise.all([
      ...Array.from({ length: 5 }, (_, at) => cli(env, 'remind', `Agent ${at}`)),
      ...Array.from({ length: 5 }, (_, at) => client.call('todo.change', { id: list!.id, change: { action: 'add', text: `User ${at}` } })),
      client.call('todo.change', { id: list!.id, change: { action: 'tick', line: linesOf(list!)[0]!.id, done: true } }),
    ]);
    const lines = linesOf((await lists())[0]!);
    expect(lines).toHaveLength(11);
    expect(lines[0]!.done).not.toBeNull();
  });
});
