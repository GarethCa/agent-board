import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_ERROR, DOCUMENT_BAR_HEIGHT, type Agent, type AgentUpdatedEvent, type DaemonEvent, type DocumentCardData, type Harness } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents run the fake harnesses' `ask-plan` scenario, which shows documents by prompt. */
async function docDaemon(dataDir = tempDataDir(), worktreesDir = tempDataDir()) {
  const daemon = await startTestDaemon({ dataDir, worktreesDir, agentEnv: fakeHarnessEnv({ scenario: 'ask-plan', home: tempDataDir() }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'storefront' });
  const start = async (prompt: string, harness: Harness = 'claude') => {
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness, prompt, name: 'Write the plan', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    return agent;
  };
  const until = async (sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> => {
    const matching = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent);
    await recorder.waitFor(matching);
    return recorder.events.filter(matching).at(-1)!.agent;
  };
  return { daemon, client, recorder, start, until, zone };
}

describe('documents an agent shows the user through the board MCP', () => {
  it.each<Harness>(['claude', 'codex'])('lets a %s agent show a Markdown file, which the user edits and the agent is told of', async (harness) => {
    const { client, recorder, start, until } = await docDaemon();
    const agent = await start('Doc: docs/release-plan.md', harness);
    await recorder.waitForText(agent.sessionId, 'Showing “Release 1.4 plan” (v1) to the user as a Document tab in your window.');
    const shown = (await until(agent.sessionId, (seen) => seen.docs.length === 1 && seen.state === 'idle')).docs[0]!;
    const path = join(agent.worktree, 'docs/release-plan.md');
    expect(shown).toMatchObject({ path, title: 'Release 1.4 plan', format: 'markdown', version: 1, writtenBy: 'agent' });
    expect((await client.call('doc.read', { documentId: shown.id })).text).toBe('# Release 1.4 plan\n\n## Order\nMerge the flake fix first, then the pin bump.\n');

    await client.call('doc.save', { documentId: shown.id, text: '# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5.\n', baseVersion: 1 });
    expect(readFileSync(path, 'utf8')).toBe('# Release 1.4 plan\n\n## Order\nHold the pin bump to 1.5.\n');
    await recorder.waitForText(agent.sessionId, 'The user edited docs/release-plan.md (v2)');
    await recorder.waitForText(agent.sessionId, '+ Hold the pin bump to 1.5.');
    expect((await until(agent.sessionId, (seen) => seen.docs[0]?.version === 2)).docs[0]).toMatchObject({ writtenBy: 'user' });
  });

  it('puts a card beside the agent’s tile for a document shown on the board, and takes it away with the agent', async () => {
    const { client, recorder, start, until } = await docDaemon();
    const agent = await start('Doc on the board: notes/bench.html');
    await recorder.waitForText(agent.sessionId, 'a Document tab in your window and a card beside your tile');
    const shown = (await until(agent.sessionId, (seen) => seen.docs.length === 1)).docs[0]!;
    const cards = (await client.call('item.list')).filter((item) => item.kind === 'document');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.data as unknown as DocumentCardData).toMatchObject({ documentId: shown.id, title: 'Cache benchmark', format: 'html', collapsed: false, agent: { sessionId: agent.sessionId } });
    expect(cards[0]!.zoneId).toBe(agent.zoneId);
    await expect(client.call('doc.save', { documentId: shown.id, text: '<p>no</p>', baseVersion: 1 })).rejects.toThrow(/view-only/);

    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    await expect.poll(async () => (await client.call('item.list')).filter((item) => item.kind === 'document')).toEqual([]);
  });

  it('keeps a card collapsed to a bar, and the document when the card is taken off the board, across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const worktreesDir = tempDataDir();
    const first = await docDaemon(dataDir, worktreesDir);
    const agent = await first.start('Doc on the board: docs/release-plan.md');
    await first.recorder.waitForText(agent.sessionId, 'a card beside your tile');
    const shown = (await first.until(agent.sessionId, (seen) => seen.docs.length === 1)).docs[0]!;
    const [card] = (await first.client.call('item.list')).filter((item) => item.kind === 'document');

    // Collapsing sends only `collapsed`: the rest of its data stays.
    await first.client.call('item.update', { id: card!.id, height: DOCUMENT_BAR_HEIGHT, data: { collapsed: true } });
    await first.daemon.stop();

    const second = await docDaemon(dataDir, worktreesDir);
    const [kept] = (await second.client.call('item.list')).filter((item) => item.kind === 'document');
    expect(kept).toMatchObject({ id: card!.id, height: DOCUMENT_BAR_HEIGHT });
    expect(kept!.data as unknown as DocumentCardData).toMatchObject({ documentId: shown.id, collapsed: true, title: 'Release 1.4 plan', agent: { sessionId: agent.sessionId } });
    const after = (await second.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!;
    expect(after.docs.map((each) => each.id)).toEqual([shown.id]);
    expect((await second.client.call('doc.read', { documentId: shown.id })).text).toContain('Merge the flake fix first');

    // Off the board, the document stays its agent's.
    await second.client.call('item.delete', { id: card!.id });
    expect((await second.client.call('item.list')).filter((item) => item.kind === 'document')).toEqual([]);
    expect((await second.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)!.docs).toHaveLength(1);
  });

  it('sees the agent write the file again as a new version', async () => {
    const { start, until, recorder } = await docDaemon();
    const agent = await start('Doc: plan.md');
    await recorder.waitForText(agent.sessionId, 'Showing “Release 1.4 plan”');
    await until(agent.sessionId, (seen) => seen.docs.length === 1);
    const path = join(agent.worktree, 'plan.md');
    writeFileSync(path, '# Release 1.5 plan\n');
    const later = new Date(Date.now() + 10_000);
    utimesSync(path, later, later);
    expect((await until(agent.sessionId, (seen) => seen.docs[0]?.version === 2)).docs[0]).toMatchObject({ title: 'Release 1.5 plan', writtenBy: 'agent' });
  });

  it('keeps editing to the user: a connection holding the agent’s board token can’t save, read or comment', async () => {
    const { daemon, client, recorder, start, until } = await docDaemon();
    const agent = await start('Identify, then ask: Ready? | Yes');
    const { ask } = await until(agent.sessionId, (seen) => seen.ask !== null);
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    const asAgent = await connectTestClient(daemon);
    await asAgent.call('board.identify', { token });
    const refused = { code: BOARD_ERROR.notAllowed };
    await expect(asAgent.call('doc.save', { documentId: 'd', text: 'x', baseVersion: 1 })).rejects.toMatchObject(refused);
    await expect(asAgent.call('doc.read', { documentId: 'd' })).rejects.toMatchObject(refused);
    await expect(asAgent.call('doc.comment', { documentId: 'd', text: 'x' })).rejects.toMatchObject(refused);
    await expect(asAgent.call('board.showDoc', { token, path: 'relative.md' })).rejects.toThrow(/absolute/);
    await client.call('ask.answer', { sessionId: agent.sessionId, askId: ask!.id, answer: { option: 0 } });
  });
});
