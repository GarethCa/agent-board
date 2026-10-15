import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { BOARD_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type Harness } from '../src/protocol.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const SIZE = { cols: 120, rows: 40 };

/** A daemon whose agents run the fake harnesses' `ask-plan` scenario, and a zone to start them in. */
async function askDaemon({ mcpCancel = true } = {}) {
  const daemon = await startTestDaemon({ worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'ask-plan', home: tempDataDir(), mcpCancel }) });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'storefront' });
  const start = async (prompt: string, harness: Harness = 'claude') => {
    const agent = await client.call('agent.spawn', { zoneId: zone.id, harness, prompt, name: 'Pick a cache', ...SIZE });
    await client.call('session.attach', { sessionId: agent.sessionId });
    return agent;
  };
  /** The agent's latest update, once it matches. */
  const until = async (sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> => {
    const matching = (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent);
    await recorder.waitFor(matching);
    return recorder.events.filter(matching).at(-1)!.agent;
  };
  return { daemon, client, recorder, start, until };
}

describe('an agent asking the user through the board MCP', () => {
  it.each<Harness>(['claude', 'codex'])('lets a %s agent ask, waits in the inbox, and hands it the answer the user picks', async (harness) => {
    const { client, recorder, start, until } = await askDaemon();
    const agent = await start('Ask: Which cache should the product pages use? | Redis | In-memory LRU | CDN only', harness);

    const asking = await until(agent.sessionId, (seen) => seen.ask !== null);
    expect(asking.state).toBe('waiting');
    expect(asking.seen).toBe(false);
    expect(asking.ask).toMatchObject({ question: 'Which cache should the product pages use?', options: ['Redis', 'In-memory LRU', 'CDN only'], freeText: true });

    await client.call('ask.answer', { sessionId: agent.sessionId, askId: asking.ask!.id, answer: { option: 0 } });
    await recorder.waitForText(agent.sessionId, 'The user answered: Redis');
    expect((await until(agent.sessionId, (seen) => seen.ask === null)).ask).toBeNull();
    await expect(client.call('ask.answer', { sessionId: agent.sessionId, askId: asking.ask!.id, answer: { option: 0 } })).rejects.toThrow(/no longer asks/);
  });

  it('takes the user’s own words, and tells the agent when they skip it', async () => {
    const { client, recorder, start, until } = await askDaemon();
    const words = await start('Ask in words: What should the banner say?');
    const ask = (await until(words.sessionId, (seen) => seen.ask !== null)).ask!;
    expect(ask).toMatchObject({ options: [], freeText: true });
    await client.call('ask.answer', { sessionId: words.sessionId, askId: ask.id, answer: { text: 'Free shipping over £50' } });
    await recorder.waitForText(words.sessionId, 'The user answered: Free shipping over £50');

    const skipped = await start('Ask only: Which cache? | Redis | CDN only');
    const only = (await until(skipped.sessionId, (seen) => seen.ask !== null)).ask!;
    await expect(client.call('ask.answer', { sessionId: skipped.sessionId, askId: only.id, answer: { text: 'Memcached' } })).rejects.toThrow(/only its options/);
    await client.call('ask.answer', { sessionId: skipped.sessionId, askId: only.id, answer: { skip: true } });
    await recorder.waitForText(skipped.sessionId, 'The user skipped the question');
  });

  it('drops the question once the turn is interrupted: the harness cancels the call', async () => {
    const { client, start, until } = await askDaemon();
    const agent = await start('Ask in words: What should the banner say?');
    await until(agent.sessionId, (seen) => seen.ask !== null);

    await client.call('agent.interrupt', { sessionId: agent.sessionId });
    const after = await until(agent.sessionId, (seen) => seen.ask === null);
    expect(after.state).not.toBe('waiting');
  });

  it.each([['a question', 'Ask in words: What should the banner say?'], ['a plan', 'Plan: Cache product pages in Redis']])(
    'drops %s on an interrupt even when the harness just drops the call, sending no cancel',
    async (_, prompt) => {
      const { client, start, until } = await askDaemon({ mcpCancel: false });
      const agent = await start(prompt);
      await until(agent.sessionId, (seen) => seen.ask !== null || seen.plan?.decision === null);

      const interrupted = await client.call('agent.interrupt', { sessionId: agent.sessionId });
      expect(interrupted).toMatchObject({ ask: null, state: 'idle' });
      expect(interrupted.plan?.decision?.outcome ?? null).toBe(prompt.startsWith('Plan') ? 'withdrawn' : null);
    },
  );

  it('drops a question once the agent’s turn ends, as when its harness gave up on the call itself and sent no cancel', async () => {
    const { client, recorder, start, until } = await askDaemon();
    const agent = await start('Ask and give up: What should the banner say?');
    const { ask } = await until(agent.sessionId, (seen) => seen.ask !== null);

    await recorder.waitForText(agent.sessionId, 'MCP tool ask timed out');
    // Its Stop comes once it has said so: it is at its prompt, as after any turn, and asks nothing through the board.
    await expect.poll(async () => (await client.call('agent.list')).find((seen) => seen.sessionId === agent.sessionId)?.ask).toBeNull();
    await expect(client.call('ask.answer', { sessionId: agent.sessionId, askId: ask!.id, answer: { text: 'Free shipping' } })).rejects.toThrow(/no longer asks/);
  });

  it('keeps each plan as a version, and hands the agent the decision and comments', async () => {
    const { client, recorder, start, until } = await askDaemon();
    const agent = await start('Plan: Cache product pages in Redis');

    const first = await until(agent.sessionId, (seen) => seen.plan?.decision === null);
    expect(first.state).toBe('waiting');
    expect(first.plan).toMatchObject({ version: 1, title: 'Cache product pages in Redis', format: 'markdown' });
    await client.call('plan.decide', { sessionId: agent.sessionId, planId: first.plan!.id, outcome: 'changes-requested', comments: 'Also bust on the nightly stock import' });
    await recorder.waitForText(agent.sessionId, 'The user asked for changes to plan v1.');

    const second = await until(agent.sessionId, (seen) => seen.plan?.version === 2 && seen.plan.decision === null);
    await client.call('plan.decide', { sessionId: agent.sessionId, planId: second.plan!.id, outcome: 'approved' });
    await recorder.waitForText(agent.sessionId, 'The user approved plan v2. Go ahead with it.');

    const plans = await client.call('plan.list', { sessionId: agent.sessionId });
    expect(plans.map((plan) => [plan.version, plan.decision?.outcome, plan.decision?.comments])).toEqual([
      [1, 'changes-requested', 'Also bust on the nightly stock import'],
      [2, 'approved', ''],
    ]);
    expect(plans[1]!.body).toContain('3. Also bust on the nightly stock import');
    await expect(client.call('plan.decide', { sessionId: agent.sessionId, planId: second.plan!.id, outcome: 'rejected' })).rejects.toThrow(/decided already/);
  });

  it('keeps the answering to the user: a connection holding the agent’s board token can’t answer, decide or read plans', async () => {
    const { daemon, client, recorder, start, until } = await askDaemon();
    const agent = await start('Identify, then ask: Which cache? | Redis | CDN only');
    const { ask } = await until(agent.sessionId, (seen) => seen.ask !== null);
    const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
    const asAgent = await connectTestClient(daemon);
    await asAgent.call('board.identify', { token });

    const refused = { code: BOARD_ERROR.notAllowed };
    await expect(asAgent.call('ask.answer', { sessionId: agent.sessionId, askId: ask!.id, answer: { option: 0 } })).rejects.toMatchObject(refused);
    await expect(asAgent.call('plan.decide', { sessionId: agent.sessionId, planId: 'p', outcome: 'approved' })).rejects.toMatchObject(refused);
    await expect(asAgent.call('plan.list', { sessionId: agent.sessionId })).rejects.toMatchObject(refused);
    expect((await client.call('agent.list'))[0]!.ask?.id).toBe(ask!.id);

    // The user's own connection answers it.
    await client.call('ask.answer', { sessionId: agent.sessionId, askId: ask!.id, answer: { option: 1 } });
    await recorder.waitForText(agent.sessionId, 'The user answered: CDN only');
  });
});
