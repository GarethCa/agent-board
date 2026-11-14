import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { daemonPaths } from '../src/paths.ts';
import { BOARD_ERROR, STICKY_SIZE, type Agent, type AgentNoteData, type BoardItem } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

// What an agent owns on the board: the agent notes it writes go when it is removed, unless it passes them to another
// agent first; the user's notes, and agent notes the user has edited, never go with an agent.

const SIZE = { cols: 120, rows: 40 };

async function ownersDaemon() {
  const daemon = await startTestDaemon({
    dataDir: tempDataDir(),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, width: 1200, height: 600, name: 'web' });
  /** An agent the user started, connected as itself: its board token presented. */
  const agent = async (name: string) => {
    const started = await client.call('agent.spawn', { zoneId: zone.id, name, prompt: 'Print your board identity', ...SIZE });
    await client.call('session.attach', { sessionId: started.sessionId });
    await recorder.waitForText(started.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(started.sessionId))![1]!;
    const connection = await connectTestClient(daemon);
    await connection.call('board.identify', { token });
    return { agent: started, token, connection };
  };
  const note = (me: Awaited<ReturnType<typeof agent>>, text: string) => me.connection.call('orchestrator.addNote', { token: me.token, text, zoneId: zone.id });
  const items = async () => (await client.call('item.list')).map((item) => item.id).sort();
  const item = async (id: string) => (await client.call('item.list')).find((each) => each.id === id);
  return { daemon, client, zone, agent, note, items, item };
}

const noteData = (item: BoardItem | undefined) => item?.data as unknown as AgentNoteData & { passedFrom?: AgentNoteData['agent'] };

describe("an agent's notes", () => {
  it('go with their agent, but never the user’s notes nor an agent note the user edited', async () => {
    const { client, zone, agent, note, items } = await ownersDaemon();
    const lead = await agent('lead');
    const other = await agent('other');
    const plain = await note(lead, 'Waiting on review');
    const edited = await note(lead, 'Merge after the pin bump');
    await client.call('item.update', { id: edited.id, data: { text: 'Merge after the pin bump: mine now', editedByUser: true } });
    const others = await note(other, 'Not mine to take');
    const sticky = await client.call('item.create', { kind: 'sticky', zoneId: zone.id, x: 600, y: 400, ...STICKY_SIZE, data: { text: 'the user’s', color: '#fff3a3' } });

    await client.call('agent.delete', { sessionId: lead.agent.sessionId, force: true });
    await expect.poll(items).not.toContain(plain.id);
    expect(await items()).toEqual([edited.id, others.id, sticky.id].sort());
  });

  it('can be passed to another agent, which then owns it: it stays when its writer goes, and goes with its new owner', async () => {
    const { client, agent, note, items, item } = await ownersDaemon();
    const lead = await agent('lead');
    const impl = await lead.connection.call('orchestrator.spawn', { token: lead.token, name: 'impl' });
    const kept = await note(lead, 'The flake is in the retry loop');

    const passed = await lead.connection.call('orchestrator.passItem', { token: lead.token, id: kept.id, to: impl.sessionId });
    expect(noteData(passed)).toMatchObject({
      text: 'The flake is in the retry loop',
      agent: { sessionId: impl.sessionId, name: 'impl' },
      passedFrom: { sessionId: lead.agent.sessionId, name: 'lead' },
    });
    const [line] = await client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ action: 'pass', outcome: 'done', detail: expect.stringContaining('to impl') });

    await client.call('agent.delete', { sessionId: lead.agent.sessionId, force: true });
    expect(noteData(await item(kept.id))?.agent.sessionId).toBe(impl.sessionId);
    await client.call('agent.delete', { sessionId: impl.sessionId, force: true });
    await expect.poll(items).not.toContain(kept.id);
  });

  it('are passed by any agent or the user, only to an agent, and never the user’s own', async () => {
    const { client, zone, agent, note } = await ownersDaemon();
    const lead = await agent('lead');
    const other = await agent('other');
    const mine = await note(lead, 'Mine');
    const author = noteData(mine).agent;
    const sticky = await client.call('item.create', { kind: 'sticky', zoneId: zone.id, x: 600, y: 400, ...STICKY_SIZE, data: { text: 'the user’s', color: '#fff3a3' } });
    const shape = await client.call('orchestrator.addShape', { shape: 'rectangle', text: 'box', zoneId: zone.id });
    // An agent note no agent holds, as a clock's result is.
    const unheld = await client.call('item.create', {
      kind: 'agent-note',
      zoneId: zone.id,
      x: 600,
      y: 200,
      ...STICKY_SIZE,
      data: { text: 'Clock ran', agent: author, writtenAt: new Date().toISOString(), editedByUser: false },
    });

    // The user's notes, and one no agent holds, are never an agent's to pass.
    await expect(lead.connection.call('orchestrator.passItem', { token: lead.token, id: unheld.id, to: other.agent.sessionId })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    for (const theirs of [sticky, shape]) {
      await expect(lead.connection.call('orchestrator.passItem', { token: lead.token, id: theirs.id, to: other.agent.sessionId })).rejects.toThrow(/only an agent note or a document/);
    }
    await expect(lead.connection.call('orchestrator.passItem', { token: lead.token, id: mine.id, to: lead.agent.sessionId })).rejects.toThrow(/holds it already/);
    await expect(lead.connection.call('orchestrator.passItem', { token: lead.token, id: mine.id, to: 'no-such-agent' })).rejects.toThrow(/no agent/);
    const [line] = await client.call('orchestrator.activity', { limit: 1 });
    expect(line).toMatchObject({ action: 'pass', outcome: 'refused' });

    // It passes to any agent, one the user started by hand too; and any agent takes what another holds.
    const given = await lead.connection.call('orchestrator.passItem', { token: lead.token, id: mine.id, to: other.agent.sessionId });
    expect(noteData(given).agent.sessionId).toBe((other.agent as Agent).sessionId);
    const taken = await lead.connection.call('orchestrator.passItem', { token: lead.token, id: mine.id, to: lead.agent.sessionId });
    expect(noteData(taken).agent.sessionId).toBe((lead.agent as Agent).sessionId);

    // The user passes any agent's note.
    const passed = await client.call('orchestrator.passItem', { id: mine.id, to: other.agent.sessionId });
    expect(noteData(passed).agent.sessionId).toBe((other.agent as Agent).sessionId);
  });

  it('held by an agent that has ended are passed on by any agent, and reach the Captain', async () => {
    const { client, agent, note, item } = await ownersDaemon();
    const lead = await agent('lead');
    const other = await agent('other');
    const crew = await other.connection.call('orchestrator.spawn', { token: other.token, name: 'crew' });
    const theirs = await note(lead, 'The user’s agent’s');
    await client.call('agent.stop', { sessionId: lead.agent.sessionId });

    await other.connection.call('orchestrator.passItem', { token: other.token, id: theirs.id, to: crew.sessionId });
    expect(noteData(await item(theirs.id)).agent.sessionId).toBe(crew.sessionId);

    // The Captain too.
    const captain = await client.call('master.start', SIZE);
    const mine = await note(other, 'For the Captain');
    const passed = await other.connection.call('orchestrator.passItem', { token: other.token, id: mine.id, to: captain.sessionId });
    expect(noteData(passed).agent.sessionId).toBe(captain.sessionId);
  });

  it('of an agent no longer on the board go when the daemon starts, but not one the user edited nor a lane’s note', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const client = await connectTestClient(first);
    const author = { sessionId: 'gone-agent', name: 'gone', harness: 'claude', role: null };
    const agentNote = (text: string, extra: Record<string, unknown> = {}) =>
      client.call('item.create', { kind: 'agent-note', zoneId: null, x: 0, y: 0, ...STICKY_SIZE, data: { text, agent: author, writtenAt: new Date().toISOString(), editedByUser: false, ...extra } });
    const left = await agentNote('Left behind');
    const edited = await agentNote('The user’s now', { editedByUser: true });
    const lane = await agentNote('lane: impl', { arrange: 'lane:impl:note' });
    const unheld = await agentNote('Clock ran');
    client.close();
    await first.stop();
    // Its agent was removed before its notes were taken away.
    const db = new DatabaseSync(daemonPaths(dataDir).database);
    for (const each of [left, edited, lane]) db.prepare('UPDATE board_items SET made_by = ? WHERE id = ?').run('gone-agent', each.id);
    db.close();

    const second = await connectTestClient(await startTestDaemon({ dataDir }));
    const items = async () => (await second.call('item.list')).map((item) => item.id).sort();
    await expect.poll(items).not.toContain(left.id);
    expect(await items()).toEqual([edited.id, lane.id, unheld.id].sort());
  });
});
