import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { RPC_ERROR, type ChatEntry, type Harness } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 100, rows: 30 };

/** Runs the fake harness's `subagent` scenario; resolves once its transcript has the turn's final message. */
async function finishedSubagentRun(harness: Harness) {
  const home = tempDataDir();
  const daemon = await startTestDaemon({
    dataDir: tempDataDir(),
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'subagent', home, idleNotifyMs: 60_000 }),
  });
  const client = await connectTestClient(daemon);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
  const agent = await client.call('agent.spawn', { zoneId: zone.id, harness, prompt: 'Map the code', ...SIZE });
  await vi.waitFor(
    async () => {
      const { entries } = await client.call('agent.transcript', { sessionId: agent.sessionId });
      expect(entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'The explorer found where sessions are created.' });
    },
    { timeout: RUN_TIMEOUT - 5000, interval: 100 },
  );
  return { client, agent, home };
}

const kinds = (entries: ChatEntry[]) => entries.map((entry) => entry.kind);

/** A fake harness run, under load, can take a while. */
const RUN_TIMEOUT = 30_000;

describe("an agent's conversation, from its transcript", () => {
  it('reads a Claude agent from the transcript its hooks named, and its subagent from that one', async () => {
    const { client, agent } = await finishedSubagentRun('claude');
    const chunk = await client.call('agent.transcript', { sessionId: agent.sessionId, since: 0 });
    expect(chunk.status).toBe('ok');
    expect(kinds(chunk.entries)).toEqual(['user', 'assistant', 'tool-call', 'tool-result', 'assistant']);
    expect(chunk.entries[0]).toMatchObject({ kind: 'user', text: 'Map the code' });
    const call = chunk.entries[2] as Extract<ChatEntry, { kind: 'tool-call' }>;
    expect(call).toMatchObject({ name: 'Agent', input: { subagent_type: 'Explore' } });

    // Nothing new since.
    expect(await client.call('agent.transcript', { sessionId: agent.sessionId, since: 5, generation: chunk.generation })).toMatchObject({
      from: 5,
      entries: [],
    });

    const subagent = await client.call('agent.subagentTranscript', { sessionId: agent.sessionId, toolUseId: call.id });
    expect(subagent.entries).toMatchObject([
      { kind: 'user', text: 'Find where sessions are created' },
      { kind: 'assistant', text: 'Sessions are created in src/daemon/sessions.ts.' },
    ]);
  }, RUN_TIMEOUT);

  it("reads a Codex agent's rollout, with its subagent's messages in it", async () => {
    const { client, agent } = await finishedSubagentRun('codex');
    const chunk = await client.call('agent.transcript', { sessionId: agent.sessionId });
    expect(chunk.status).toBe('ok');
    expect(kinds(chunk.entries)).toEqual(['user', 'assistant', 'tool-call', 'subagent-message', 'subagent-message', 'tool-result', 'assistant']);
    expect(chunk.entries[4]).toMatchObject({ kind: 'subagent-message', from: '/root/Explore', to: '/root', text: 'Sessions are created in src/daemon/sessions.ts.' });
  }, RUN_TIMEOUT);

  it("tells every client once a transcript it has read is written to, so the chat reads it at once", async () => {
    const { client, agent, home } = await finishedSubagentRun('claude');
    const heard: string[] = [];
    client.onEvent((event) => {
      if (event.type === 'agent.transcriptChanged') heard.push(event.sessionId);
    });
    // Its transcript, written to as its harness would.
    const projects = join(home, '.claude/projects');
    const path = readdirSync(projects, { recursive: true, encoding: 'utf8' }).find((file) => file.endsWith('.jsonl') && !file.includes('subagents'));
    appendFileSync(join(projects, path!), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'One more thing' } })}\n`);
    await vi.waitFor(() => expect(heard).toEqual([agent.sessionId]), { timeout: 5000, interval: 20 });
  }, RUN_TIMEOUT);

  it('fails for an agent that does not exist, or a bad since', async () => {
    const daemon = await startTestDaemon({ dataDir: tempDataDir() });
    const client = await connectTestClient(daemon);
    await expect(client.call('agent.transcript', { sessionId: 'nope' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(client.call('agent.transcript', { sessionId: 'nope', since: -1 })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });
});
