import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { CREW_PLAN_PATH, CREW_QUESTION_PATH, MAX_FLAG_LENGTH, RPC_ERROR, type Agent, type AgentUpdatedEvent, type DaemonEvent, type SettingsUpdatedEvent } from '../src/protocol.ts';
import { runBoardCommand } from '../src/board-cli.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from '../src/board-env.ts';
import { connectTestClient, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';
import { createFakeClock } from './fake-clock.ts';
import type { Clock } from '../src/clock.ts';

const SIZE = { cols: 120, rows: 40 };

/**
 * A daemon whose agents play the fake harnesses' `orchestrate` scenario, with one zone whose agents may orchestrate.
 * With `noSessionStart`, its fakes fire no `SessionStart`; with `trustScreen`, they show Claude's trust screen first;
 * with `loseEnters` (after `loseEntersAfter` lines), they lose Enters, each pressed again `submitConfirmMs` later.
 */
async function flagDaemon(
  options: { clock?: Clock; noSessionStart?: boolean; trustScreen?: boolean; loseEnters?: number; loseEntersAfter?: number; submitConfirmMs?: number } = {},
) {
  const daemon = await startTestDaemon({
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({
      scenario: 'orchestrate',
      home: tempDataDir(),
      idleNotifyMs: 200,
      noSessionStart: options.noSessionStart,
      trustScreen: options.trustScreen,
      loseEnters: options.loseEnters,
      loseEntersAfter: options.loseEntersAfter,
    }),
    submitConfirmMs: options.submitConfirmMs,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone };
}

type Setup = Awaited<ReturnType<typeof flagDaemon>>;

async function untilAgent(recorder: Setup['recorder'], sessionId: string, match: (agent: Agent) => boolean): Promise<Agent> {
  const event = await recorder.waitFor(
    (e: DaemonEvent): e is AgentUpdatedEvent => e.type === 'agent.updated' && e.agent.sessionId === sessionId && match(e.agent),
  );
  return event.agent;
}

/** Connects as the agent `sessionId`, started with the prompt `Print your board identity`: its board token presented. */
async function agentSideOf(setup: Setup, sessionId: string) {
  const { daemon, client, recorder } = setup;
  await client.call('session.attach', { sessionId });
  await recorder.waitForText(sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { token, connection };
}

/** Starts an agent the user owns that prints its board token, and connects as it. */
async function topLevel(setup: Setup, harness: 'claude' | 'codex' = 'claude') {
  const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, harness, prompt: 'Print your board identity', ...SIZE });
  return { agent, ...(await agentSideOf(setup, agent.sessionId)) };
}

describe('an agent flagging the user', () => {
  it('reaches the user with its reason, replaces an earlier flag, and clears itself', async () => {
    const setup = await flagDaemon();
    const { agent, token, connection } = await topLevel(setup);
    expect(agent.flag).toBeNull();

    const flagged = await connection.call('board.needsYou', { token, reason: '  PR #241 is ready for review.\n' });
    expect(flagged.flag).toEqual({ id: expect.any(Number), reason: 'PR #241 is ready for review.', at: expect.any(String), to: 'user', via: null });
    expect((await untilAgent(setup.recorder, agent.sessionId, (a) => a.flag !== null)).flag?.to).toBe('user');

    const again = await connection.call('board.needsYou', { token, reason: 'Decision needed on the cache' });
    expect(again.flag?.reason).toBe('Decision needed on the cache');

    expect((await connection.call('board.needsYou', { token, clear: true })).flag).toBeNull();
  });

  it('flags and clears over the CLI', async () => {
    const setup = await flagDaemon();
    const { agent, token } = await topLevel(setup);
    const env = { [BOARD_SOCKET_ENV]: setup.daemon.socketPath, [BOARD_TOKEN_ENV]: token };
    const run = async (args: string[]) => {
      let out = '';
      const code = await runBoardCommand('needs-you', args, { out: (text) => (out += text), err: (text) => (out += text), env });
      return { code, out };
    };

    expect(await run(['--', 'Ready', 'for', 'review'])).toEqual({ code: 0, out: expect.stringContaining('Flagged for the user in Needs you: "Ready for review"') });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === agent.sessionId)?.flag?.reason).toBe('Ready for review');
    expect(await run(['--clear'])).toEqual({ code: 0, out: expect.stringContaining('Your flag is cleared.') });
    expect(await run([])).toMatchObject({ code: 2, out: expect.stringContaining('give a reason, or --clear') });
  });

  it('works the same for a Codex agent, over `agent-board mcp` on stdio', async () => {
    const setup = await flagDaemon();
    const { agent, token } = await topLevel(setup, 'codex');
    const mcp = new McpClient(
      {
        command: TEST_CLI_LAUNCHER.command,
        args: [...TEST_CLI_LAUNCHER.args, 'mcp'],
        env: { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: token },
      },
      tempDataDir(),
    );
    expect(await mcp.callTool('needs_you', { reason: 'Decision needed: Postgres or SQLite?' })).toMatchObject({
      text: expect.stringContaining('Flagged for the user in Needs you'),
    });
    const flagged = await untilAgent(setup.recorder, agent.sessionId, (a) => a.flag !== null);
    expect(flagged).toMatchObject({ harness: 'codex', flag: { to: 'user', reason: 'Decision needed: Postgres or SQLite?' } });
    expect(await mcp.callTool('needs_you', { clear: true })).toMatchObject({ text: 'Your flag is cleared.' });
  });

  it('is cleared when the user opens its session', async () => {
    const setup = await flagDaemon();
    const { agent, token, connection } = await topLevel(setup);
    await connection.call('board.needsYou', { token, reason: 'Blocked on a flaky test' });
    expect((await setup.client.call('agent.markSeen', { sessionId: agent.sessionId })).flag).toBeNull();
  });

  it("keeps its own flag when its first prompt stalls after it, and when that prompt is sent", async () => {
    const clock = createFakeClock(new Date());
    const setup = await flagDaemon({ clock, noSessionStart: true });
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Tidy the docs', ...SIZE });
    // The user types at it by hand before its first prompt is given up on, and it flags them in that turn.
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Print your board identity\r' });
    const { token, connection } = await agentSideOf(setup, agent.sessionId);
    const own = (await connection.call('board.needsYou', { token, reason: 'Which docs?' })).flag;

    clock.advance(60_000);
    const stalled = await untilAgent(setup.recorder, agent.sessionId, (a) => a.untypedPrompt !== null);
    expect(stalled.flag).toEqual(own);
    expect((await setup.client.call('agent.typeFirstPrompt', { sessionId: agent.sessionId })).flag).toEqual(own);
  });

  /**
   * An agent that flagged the user, whose first prompt was left unsent and a message queued behind it never delivered:
   * its flags then stand one in place of another.
   */
  const unsentAndUndelivered = async () => {
    const clock = createFakeClock(new Date());
    // Its own line goes up; every Enter after it is lost, so its first prompt stays unsent.
    const setup = await flagDaemon({ clock, noSessionStart: true, loseEnters: 10, loseEntersAfter: 1, submitConfirmMs: 100 });
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Tidy the docs', ...SIZE });
    await setup.client.call('session.write', { sessionId: agent.sessionId, data: 'Print your board identity\r' });
    const { token, connection } = await agentSideOf(setup, agent.sessionId);
    const own = (await connection.call('board.needsYou', { token, reason: 'Which docs?' })).flag!;
    expect(await setup.client.call('agent.answer', { sessionId: agent.sessionId, text: 'Also lint' })).toEqual({ queued: true });

    clock.advance(60_000);
    await untilAgent(setup.recorder, agent.sessionId, (a) => a.untypedPrompt !== null);
    await setup.client.call('agent.typeFirstPrompt', { sessionId: agent.sessionId });
    const lost = await untilAgent(setup.recorder, agent.sessionId, (a) => a.undelivered.length > 0);
    expect(lost.unsent).toBe('Its first prompt');
    expect(lost.flag).toMatchObject({ to: 'user', reason: expect.stringMatching(/not delivered.*Also: .*not sent.*Also: Which docs\?$/) });
    return { setup, agent, own };
  };

  it('keeps its own flag beside a message never delivered behind a first prompt left unsent, and stands alone again once both are cleared', async () => {
    const { setup, agent, own } = await unsentAndUndelivered();

    // Its first prompt still sits unsent: that flag stands again, carrying its own, until it is cleared too.
    const cleared = await setup.client.call('agent.clearUndelivered', { sessionId: agent.sessionId });
    expect(cleared.flag).toMatchObject({ to: 'user', reason: expect.stringMatching(/^Its first prompt was typed at its prompt but not sent .*Also: Which docs\?$/) });
    expect((await setup.client.call('agent.clearUnsent', { sessionId: agent.sessionId })).flag).toEqual(own);
  });

  it('never puts back a flag for a first prompt no longer unsent, whichever is cleared first', async () => {
    const { setup, agent, own } = await unsentAndUndelivered();

    // Nothing sits unsent now: what was never delivered says so alone, beside its own.
    const cleared = await setup.client.call('agent.clearUnsent', { sessionId: agent.sessionId });
    expect(cleared).toMatchObject({ unsent: null, flag: { to: 'user', reason: expect.stringMatching(/^A message sent before it was up was not delivered .*Resend on its tile\. Also: Which docs\?$/) } });
    expect((await setup.client.call('agent.clearUndelivered', { sessionId: agent.sessionId })).flag).toEqual(own);
  });

  it('refuses a blank or overlong reason', async () => {
    const setup = await flagDaemon();
    const { token, connection } = await topLevel(setup);
    await expect(connection.call('board.needsYou', { token, reason: '   ' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(connection.call('board.needsYou', { token, reason: 'x'.repeat(MAX_FLAG_LENGTH + 1) })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('is gone once its session ends', async () => {
    const setup = await flagDaemon();
    const { agent, token, connection } = await topLevel(setup);
    await connection.call('board.needsYou', { token, reason: 'Look at this' });
    await setup.client.call('agent.stop', { sessionId: agent.sessionId });
    expect((await untilAgent(setup.recorder, agent.sessionId, (a) => a.endedAt !== null)).flag).toBeNull();
  });
});

describe("a crew member's flag", () => {
  /** An orchestrator the user started, and a crew member it started that prints its token, both connected as themselves. */
  async function crew() {
    const setup = await flagDaemon();
    const lead = await topLevel(setup);
    const member = await lead.connection.call('orchestrator.spawn', { token: lead.token, prompt: 'Print your board identity', name: 'flaky fixer' });
    return { setup, lead, member: { agent: member, ...(await agentSideOf(setup, member.sessionId)) } };
  }

  it('goes to its orchestrator: typed at its prompt, and heard as a crew event', async () => {
    const { setup, lead, member } = await crew();
    const since = (await lead.connection.call('orchestrator.wait', { token: lead.token, since: 'now', crew: true, timeoutMs: 10 })).cursor;

    const flagged = await member.connection.call('board.needsYou', { token: member.token, reason: "can't reproduce it on CI, only locally" });
    expect(flagged.flag).toMatchObject({ to: 'orchestrator' });

    await setup.recorder.waitForText(lead.agent.sessionId, 'needs you:');
    const screen = setup.recorder.screenText(lead.agent.sessionId);
    expect(screen).toContain(`[agent-board] flaky fixer (agent:${member.agent.sessionId.slice(0, 8)}) needs you: can't reproduce it on CI`);

    const heard = await lead.connection.call('orchestrator.wait', { token: lead.token, since, crew: true, timeoutMs: 2000 });
    expect(heard.events).toContainEqual(expect.objectContaining({ kind: 'flagged', sessionId: member.agent.sessionId, detail: "can't reproduce it on CI, only locally" }));
  });

  it('goes to its orchestrator when its first prompt stalls, whose send waits, leaving the flag, until the user sends it', async () => {
    const clock = createFakeClock(new Date());
    const setup = await flagDaemon({ clock, noSessionStart: true });
    // No session says it is up: the lead's first prompt is given up on too, and the user sends it.
    const leadAgent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', ...SIZE });
    clock.advance(60_000);
    await untilAgent(setup.recorder, leadAgent.sessionId, (a) => a.untypedPrompt !== null);
    await setup.client.call('agent.typeFirstPrompt', { sessionId: leadAgent.sessionId });
    const lead = { agent: leadAgent, ...(await agentSideOf(setup, leadAgent.sessionId)) };
    const member = await lead.connection.call('orchestrator.spawn', { token: lead.token, prompt: 'Fix the flaky test', name: 'flaky fixer' });

    clock.advance(60_000);
    const stalled = await untilAgent(setup.recorder, member.sessionId, (a) => a.untypedPrompt !== null);
    expect(stalled.flag).toMatchObject({ to: 'orchestrator', reason: expect.stringContaining('first prompt') });
    await setup.recorder.waitForText(lead.agent.sessionId, 'flaky fixer');
    expect(setup.recorder.screenText(lead.agent.sessionId)).toContain("needs you: its session never said it was up, so its first prompt isn't typed");

    // Its orchestrator can't type it: its message waits until it is up, and the flag stays for it to pass on.
    await setup.client.call('session.attach', { sessionId: member.sessionId });
    const sent = await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: member.sessionId, text: 'Go on' });
    expect(sent.queuedUntilUp).toBe(1);
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === member.sessionId)?.flag).toEqual(stalled.flag);

    expect((await setup.client.call('agent.typeFirstPrompt', { sessionId: member.sessionId })).flag).toBeNull();
    await setup.recorder.waitForText(member.sessionId, '> Fix the flaky test');
  });

  it("goes to the user, never its orchestrator, when a crew member waits on Claude's trust screen", async () => {
    const setup = await flagDaemon({ trustScreen: true });
    const leadAgent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', ...SIZE });
    await untilAgent(setup.recorder, leadAgent.sessionId, (a) => a.trustFolder !== null);
    await setup.client.call('agent.trustFolder', { sessionId: leadAgent.sessionId });
    const lead = { agent: leadAgent, ...(await agentSideOf(setup, leadAgent.sessionId)) };
    const member = await lead.connection.call('orchestrator.spawn', { token: lead.token, prompt: 'Fix the flaky test', name: 'flaky fixer' });

    const asking = await untilAgent(setup.recorder, member.sessionId, (a) => a.trustFolder !== null);
    expect(asking.flag).toMatchObject({ to: 'user', reason: `Claude is asking whether to trust this folder: ${member.cwd}` });
    expect(setup.recorder.screenText(lead.agent.sessionId)).not.toContain('flaky fixer');

    await setup.client.call('session.attach', { sessionId: member.sessionId });
    await setup.client.call('agent.trustFolder', { sessionId: member.sessionId });
    await setup.recorder.waitForText(member.sessionId, '> Fix the flaky test');
    expect((await setup.client.call('agent.list')).find((a) => a.sessionId === member.sessionId)).toMatchObject({ trustFolder: null, flag: null });
  });

  it("waits for its orchestrator to be ready, as a hand-off does: never typed over the user's half-typed line", async () => {
    const { setup, lead, member } = await crew();
    const leadId = lead.agent.sessionId;
    await untilAgent(setup.recorder, leadId, (a) => a.state === 'idle' || a.state === 'waiting');
    await setup.client.call('session.write', { sessionId: leadId, data: 'half a tho' });

    await member.connection.call('board.needsYou', { token: member.token, reason: 'Which fixture?' });
    // The flag's own update, and the lead's, come and go with the draft still there.
    await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.flag !== null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(setup.recorder.screenText(leadId)).not.toContain('needs you:');

    // The user sends the draft: once that turn is over, the flag is told.
    await setup.client.call('session.write', { sessionId: leadId, data: 'ught\r' });
    await setup.recorder.waitForText(leadId, 'needs you: Which fixture?');
    expect(setup.recorder.screenText(leadId)).not.toMatch(/half a tho\S*\s*\[agent-board\]/);
  });

  it('carries its questions and plans to its orchestrator, not to the user: nothing waits', async () => {
    const { setup, lead, member } = await crew();
    const asked = await member.connection.call('board.ask', { token: member.token, question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] });
    expect(asked).toEqual({ sentTo: 'orchestrator', name: lead.agent.name });
    const flagged = await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.flag !== null);
    expect(flagged).toMatchObject({ ask: null, flag: { to: 'orchestrator', reason: 'asks: Postgres or SQLite? (Postgres · SQLite)' } });
    await setup.recorder.waitForText(lead.agent.sessionId, 'needs you: asks: Postgres or SQLite?');

    const planned = await member.connection.call('board.presentPlan', { token: member.token, title: 'Cache in Redis', body: '# Cache\n\n1. Wrap it.', format: 'markdown' });
    expect(planned).toEqual({ sentTo: 'orchestrator', name: lead.agent.name });
    expect(readFileSync(join(member.agent.worktree, CREW_PLAN_PATH.markdown), 'utf8')).toBe('# Cache\n\n1. Wrap it.');
    const replanned = await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.flag?.reason.startsWith('plan') === true);
    expect(replanned).toMatchObject({ plan: null, flag: { reason: `plan to review, in ${CREW_PLAN_PATH.markdown}: Cache in Redis` } });
    // Its orchestrator reads the plan where the flag says.
    expect((await lead.connection.call('orchestrator.read', { token: lead.token, sessionId: member.agent.sessionId, path: CREW_PLAN_PATH.markdown })).text).toBe('# Cache\n\n1. Wrap it.');
  });

  it('carries a question too long for a flag in full, every option with it, in a file its flag points to', async () => {
    const { setup, lead, member } = await crew();
    const question = `Which cache should the product pages use? ${'They are read far more than written, and stale prices cost money. '.repeat(8)}Pick one.`;
    const options = ['Redis, with a five-minute TTL busted on product.updated', 'An in-memory LRU per instance', 'CDN only, with surrogate keys'];
    expect(await member.connection.call('board.ask', { token: member.token, question, options })).toEqual({ sentTo: 'orchestrator', name: lead.agent.name });

    const { flag } = await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.flag !== null);
    expect(flag!.reason.length).toBeLessThanOrEqual(MAX_FLAG_LENGTH);
    expect(flag!.reason).toMatch(new RegExp(`^asks \\(in full, with its 3 options, in ${CREW_QUESTION_PATH.replaceAll('.', '\\.')}\\): Which cache should the product pages use\\?`));
    await setup.recorder.waitForText(lead.agent.sessionId, CREW_QUESTION_PATH);

    // Nothing is lost: the orchestrator reads the whole question and every option where the flag says.
    const { text } = await lead.connection.call('orchestrator.read', { token: lead.token, sessionId: member.agent.sessionId, path: CREW_QUESTION_PATH });
    expect(text).toBe(`${question}\n\nOptions:\n\n1. ${options[0]}\n2. ${options[1]}\n3. ${options[2]}\n`);
  });

  it("asks the user once its orchestrator has ended, as any agent's question does", async () => {
    const { setup, lead, member } = await crew();
    await setup.client.call('agent.stop', { sessionId: lead.agent.sessionId });
    await untilAgent(setup.recorder, lead.agent.sessionId, (a) => a.endedAt !== null);
    const answer = member.connection.call('board.ask', { token: member.token, question: 'Still there?', timeoutMs: 300 });
    expect((await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.ask !== null)).ask?.question).toBe('Still there?');
    expect(await answer).toEqual({ outcome: 'timed-out', answer: null });
  });

  it('is cleared when its orchestrator sends it a message', async () => {
    const { setup, lead, member } = await crew();
    await member.connection.call('board.needsYou', { token: member.token, reason: 'Which fixture?' });
    await setup.recorder.waitForText(lead.agent.sessionId, 'needs you:');
    await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.state === 'idle' || a.state === 'waiting');
    const sent = await lead.connection.call('orchestrator.send', { token: lead.token, sessionId: member.agent.sessionId, text: 'Use the fake clock' });
    expect(sent.flag).toBeNull();
  });

  it('reaches the user once its orchestrator has ended', async () => {
    const { setup, lead, member } = await crew();
    await member.connection.call('board.needsYou', { token: member.token, reason: 'Still blocked' });
    await setup.client.call('agent.stop', { sessionId: lead.agent.sessionId });
    expect((await untilAgent(setup.recorder, member.agent.sessionId, (a) => a.flag?.to === 'user')).flag?.reason).toBe('Still blocked');
  });

  it('lets the orchestrator pass it on to the user, naming the crew member', async () => {
    const { lead, member } = await crew();
    const passed = await lead.connection.call('board.needsYou', { token: lead.token, reason: 'Skip the flake for 1.4?', via: member.agent.sessionId });
    expect(passed.flag).toMatchObject({ to: 'user', via: 'flaky fixer' });
    await expect(lead.connection.call('board.needsYou', { token: lead.token, reason: 'x', via: lead.agent.sessionId })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/not an agent you started/),
    });
  });
});

describe('the needs-you settings', () => {
  it('default to explicit requests only, with notifications on but not while the app is in front, and tell every client', async () => {
    const setup = await flagDaemon();
    expect(await setup.client.call('settings.get')).toMatchObject({ needsYouShows: 'explicit', notifications: true, notifyInFront: false });

    const now = await setup.client.call('settings.set', { needsYouShows: 'turns', notifyInFront: true });
    expect(now).toMatchObject({ needsYouShows: 'turns', notifications: true, notifyInFront: true });
    const event = await setup.recorder.waitFor((e: DaemonEvent): e is SettingsUpdatedEvent => e.type === 'settings.updated');
    expect(event.settings).toEqual(now);

    await expect(setup.client.call('settings.set', { needsYouShows: 'all' as 'turns' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(setup.client.call('settings.set', { notifications: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
  });
});
