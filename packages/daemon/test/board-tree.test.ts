// `tree` and the board tool: the caller's own zone by default, its quiet agents folded into one count line, and the whole
// board with `all`.
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BoardError, BoardRefs, readBoard, treeView } from '../src/board-ops.ts';
import type { Agent, AgentUpdatedEvent, BoardCaller, DaemonEvent } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A board read from a daemon: a zone `web` with a waiting agent `live` and copies of it hibernated, ended and finished,
 * a group `Ideas` holding a note, and a loose shell.
 */
async function board() {
  const daemon = await startTestDaemon({ worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir(), idleNotifyMs: 200 }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const web = await client.call('zone.add', { path: tempRepo('webapp'), x: 0, y: 0, name: 'web' });
  const ideas = await client.call('zone.addUnbound', { name: 'Ideas', x: 1000, y: 0 });
  const live = await client.call('agent.spawn', { zoneId: web.id, prompt: 'Fix the flaky tests', name: 'live', ...SIZE });
  await recorder.waitFor(
    (event: DaemonEvent): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === live.sessionId && event.agent.state === 'waiting',
  );
  const note = await client.call('item.create', { kind: 'sticky', zoneId: ideas.id, x: 10, y: 20, width: 200, height: 180, data: { text: 'Ship by Friday', color: '#fff3a3' } });
  await client.call('shell.create', { zoneId: null, position: { x: 4000, y: 0 } });
  const read = await readBoard(client);
  const base = read.agents.find((agent) => agent.sessionId === live.sessionId)!;
  const copy = (name: string, fields: Partial<Agent>): Agent => ({ ...base, sessionId: `${name}-0000-0000`, name, ...fields });
  const quiet = [
    copy('sleepy', { state: 'hibernated' }),
    copy('gone', { state: 'done', endedAt: '2026-11-27T09:00:00.000Z' }),
    copy('done', { state: 'idle', workFinishedAt: '2026-11-27T10:00:00.000Z' }),
    copy('dozy', { state: 'hibernated' }),
  ];
  // Each said it is finished, but has not come to rest: they stay listed.
  const FINISHED = '2026-11-27T10:00:00.000Z';
  const unrested = [copy('broken', { state: 'failed', workFinishedAt: FINISHED }), copy('asking', { state: 'needs-permission', workFinishedAt: FINISHED }), copy('busy', { state: 'running', workFinishedAt: FINISHED })];
  const refs = new BoardRefs({ ...read, agents: [...read.agents, ...quiet, ...unrested] });
  const caller: BoardCaller = { sessionId: live.sessionId, kind: 'agent', tileId: live.sessionId, name: 'live', zoneId: web.id, side: 'agent', orchestrates: true };
  return { refs, read, caller, web, ideas, note, quiet, unrested };
}

describe('tree', () => {
  it("shows the caller's zone, its hibernated, finished and ended agents folded into one line", async () => {
    const { refs, caller, ideas, note } = await board();
    const text = treeView(refs, caller).text;
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^zone:\w+ {2}web /);
    expect(lines[1]).toMatch(/ live {2}\[waiting\]/);
    expect(lines).toContain('  +4 more: 2 hibernated, 1 finished, 1 ended. `agent-board tree --zone all` lists them.');
    expect(text).not.toMatch(/sleepy|gone|dozy| done /);
    for (const name of ['broken  [failed', 'asking  [needs-permission', 'busy  [running']) expect(text).toContain(` ${name}`);
    expect(text).not.toContain(refs.of('zone', ideas.id));
    expect(text).not.toContain(refs.of('item', note.id));
    expect(lines).not.toContain('loose on the board');
    expect(lines.at(-1)).toBe('1 other zone and 1 loose on the board: `agent-board tree --zone all` shows the whole board.');
  });

  it('never folds the caller, finished or not', async () => {
    const { read, caller } = await board();
    const finishedMe = read.agents.map((agent) => (agent.sessionId === caller.tileId ? { ...agent, state: 'idle' as const, workFinishedAt: '2026-11-27T10:00:00.000Z' } : agent));
    const text = treeView(new BoardRefs({ ...read, agents: finishedMe }), caller).text;
    expect(text).toMatch(/ live {2}\[idle, finished\].*← you/);
    expect(text).not.toContain('more:');
  });

  it('names the board tool\'s option on the MCP face', async () => {
    const { refs, caller } = await board();
    const text = treeView(refs, caller, { face: 'mcp' }).text;
    expect(text).toContain('+4 more: 2 hibernated, 1 finished, 1 ended. `board` with `zone: "all"` lists them.');
    expect(text).toContain('shows the whole board.');
  });

  it('shows every zone, nothing folded, then what is loose, with all, or for a caller in no zone', async () => {
    const { refs, caller, ideas, note, quiet } = await board();
    for (const text of [treeView(refs, caller, { zone: 'all' }).text, treeView(refs, { ...caller, zoneId: null }).text, treeView(refs, null).text]) {
      for (const agent of quiet) expect(text).toContain(` ${agent.name}  [`);
      expect(text).toContain(refs.of('zone', ideas.id));
      expect(text).toContain(refs.of('item', note.id));
      expect(text).toContain('loose on the board');
      expect(text).not.toMatch(/more:|whole board/);
    }
  });

  it('shows another zone by its ref, and refuses a ref that is no zone', async () => {
    const { refs, caller, ideas, note } = await board();
    const view = treeView(refs, caller, { zone: refs.of('zone', ideas.id) });
    expect(view.text.split('\n').slice(0, 2)).toEqual([expect.stringMatching(/ Ideas {2}\(group\)$/), expect.stringContaining(refs.of('item', note.id))]);
    expect(view.json).toMatchObject({ scope: refs.of('zone', ideas.id), zones: [{ name: 'Ideas' }], loose: { tiles: [], items: [], connectors: [] } });
    expect(() => treeView(refs, caller, { zone: 'live' })).toThrow(BoardError);
    expect(() => treeView(refs, caller, { zone: 'live' })).toThrow(/not a zone/);
  });
});
